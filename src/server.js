'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { WebSocketServer } = require('ws');
const { SessionManager, stripAnsi } = require('./sessions');
const config = require('./config');
const { TokenStore, hasScope, publicToken } = require('./tokens');
const { AccountStore } = require('./accounts');
const { AuditLog } = require('./audit');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_MAP = {
  '/vendor/xterm.js': path.join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': path.join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/vendor/addon-fit.js': path.join(ROOT, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
};

const settings = config.load();
const tokens = new TokenStore({ file: settings.tokensFile, bootstrap: settings.token });
const accounts = new AccountStore({
  file: settings.accountsFile,
  seedUser: settings.loginUser,
  seedPassword: settings.token,
});
const audit = new AuditLog({ file: settings.auditFile, maxAgeMs: settings.auditMaxAgeMs });
const manager = new SessionManager({
  maxSessions: settings.maxSessions,
  shell: settings.shell,
  cwd: settings.cwd,
  idleMs: settings.sessionIdleMs,
  hasConnection: (id) => {
    if (sessionViewers.get(id)?.size) return true;
    const ops = sessionOperators.get(id);
    if (!ops) return false;
    const now = Date.now();
    for (const ts of ops.values()) {
      if (now - ts <= OPERATOR_TTL_MS) return true;
    }
    return false;
  },
});

const startedAt = Date.now();

function tokenFromRequest(req, url) {
  const header = req.headers['authorization'];
  if (header && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const direct = req.headers['x-aitb-token'];
  if (direct) return String(direct);
  if (url && url.searchParams.get('token')) return url.searchParams.get('token');
  const cookie = req.headers['cookie'];
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)aitb_token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return '';
}

function authenticate(req, url) {
  const raw = tokenFromRequest(req, url);
  const session = accounts.verifySession(raw);
  if (session) {
    return {
      kind: 'session',
      username: session.username,
      display: session.display || '',
      scopes: Array.isArray(session.scopes) && session.scopes.length
        ? session.scopes
        : ['exec', 'session', 'admin'],
      sessionToken: raw,
    };
  }
  return tokens.verify(raw);
}

function actorOf(auth) {
  if (!auth) return 'anonymous';
  if (auth.kind === 'session') return auth.display || auth.username || 'session';
  if (auth.bootstrap) return 'bootstrap';
  return auth.name ? `${auth.name}(${auth.id})` : auth.id || 'token';
}

const sessionViewers = new Map();
const sessionOperators = new Map();
const sessionConn = new Map();
const OPERATOR_TTL_MS = 60 * 1000;

function touchConnection(id) {
  sessionConn.set(id, Date.now());
}

function markOperator(id, actor) {
  if (!actor) return;
  touchConnection(id);
  let m = sessionOperators.get(id);
  if (!m) {
    m = new Map();
    sessionOperators.set(id, m);
  }
  m.set(actor, Date.now());
}

function viewersOf(id) {
  const out = new Set();
  const set = sessionViewers.get(id);
  if (set) for (const a of set) out.add(a);
  const ops = sessionOperators.get(id);
  let lastOperator = null;
  let lastOperatorAt = 0;
  if (ops) {
    const now = Date.now();
    for (const [actor, ts] of ops) {
      if (now - ts <= OPERATOR_TTL_MS) out.add(actor);
      if (ts > lastOperatorAt) {
        lastOperatorAt = ts;
        lastOperator = actor;
      }
    }
  }
  return { viewers: [...out], lastOperator, lastOperatorAt };
}

function removeSession(id) {
  sessionViewers.delete(id);
  sessionOperators.delete(id);
  sessionConn.delete(id);
  return manager.remove(id);
}

function captureSessionEnd(session) {
  if (session.name === 'oneshot') return;
  session.once('exit', () => {
    audit.add({
      kind: 'session_end',
      actor: 'system',
      sessionId: session.id,
      detail: `${session.id} 退出码=${session.exitCode}`,
      output: stripAnsi(session.buffer).slice(-60000),
    });
  });
}

function reopenIfDead(session, actor, ip) {
  if (session.alive) return false;
  session.respawn();
  touchConnection(session.id);
  captureSessionEnd(session);
  audit.add({ kind: 'session_reopen', actor, ip, sessionId: session.id, detail: session.id });
  return true;
}

function createOrReuseSession(options, actor, ip) {
  if (options.name) {
    const existing = manager.getByName(options.name);
    if (existing) {
      trackSession(existing, actor, ip);
      return { session: existing, reused: true };
    }
    const dead = manager.getDeadByName(options.name);
    if (dead) {
      reopenIfDead(dead, actor, ip);
      return { session: dead, reused: true };
    }
    manager.removeDeadByName(options.name);
  }
  const session = manager.create(options);
  touchConnection(session.id);
  trackSession(session, actor, ip);
  return { session, reused: false };
}

setInterval(() => {
  const now = Date.now();
  for (const s of manager.list()) {
    const viewers = sessionViewers.get(s.id);
    const ops = sessionOperators.get(s.id);
    const operatorLive = ops ? [...ops.values()].some((ts) => now - ts <= OPERATOR_TTL_MS) : false;
    if ((viewers && viewers.size) || operatorLive) {
      sessionConn.set(s.id, now);
      continue;
    }
    const last = sessionConn.get(s.id) || s.createdAt;
    if (s.alive && now - last > settings.connIdleKillMs) {
      const target = manager.get(s.id);
      if (target) target.kill();
      audit.add({ kind: 'session_idle_kill', actor: 'system', sessionId: s.id, detail: `${s.id} 无人连接超时，已自动关闭` });
    } else if (!s.alive && now - last > settings.connIdlePurgeMs) {
      removeSession(s.id);
      audit.add({ kind: 'session_purge', actor: 'system', sessionId: s.id, detail: `${s.id} 长期未使用，已自动清除` });
    }
  }
}, settings.connSweepMs).unref();

function trackSession(session, actor, ip) {
  if (session._tracked) return;
  session._tracked = true;
  audit.add({ kind: 'session_create', actor, ip, sessionId: session.id, detail: session.id });
  captureSessionEnd(session);
}

const LOGIN_WINDOW_MS = 10 * 60 * 1000;const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 60 * 1000;
const loginFails = new Map();

function loginAllowed(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return true;
  if (rec.lockUntil && Date.now() < rec.lockUntil) return false;
  return true;
}

function recordLoginFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, firstAt: Date.now(), lockUntil: 0 };
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
    rec.count = 0;
    rec.firstAt = Date.now();
  }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.lockUntil = Date.now() + LOGIN_LOCK_MS;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
}

function recordLoginSuccess(ip) {
  loginFails.delete(ip);
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res, req, status, code, message, extra = {}) {
  return sendJson(res, status, { error: message, code, ...extra }, corsHeaders(req));
}

function corsHeaders(req) {
  if (!settings.cors) return {};
  const origin = req.headers.origin || settings.cors;
  return {
    'access-control-allow-origin': settings.cors === '*' ? '*' : origin,
    'access-control-allow-headers': 'authorization,content-type,x-aitb-token',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-max-age': '600',
  };
}

async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('invalid json body'), { status: 400, code: 'bad_json' }));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413, code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function requireSession(id) {
  const session = manager.get(id);
  if (!session) {
    throw Object.assign(new Error(`session not found: ${id}`), { status: 404, code: 'session_not_found' });
  }
  return session;
}

function waitForOutput(session, { since, waitMs = 800, quietMs = 250, mustExit = false }) {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    let lastLen = session.buffer.length;
    let lastChange = Date.now();
    let finished = false;

    const finish = (timedOut) => {
      if (finished) return;
      finished = true;
      session.removeListener('data', onData);
      session.removeListener('exit', onExit);
      clearInterval(timer);
      resolve({ ...session.snapshot(since, { strip: true }), timedOut: Boolean(timedOut) });
    };

    const onData = () => {
      lastLen = session.buffer.length;
      lastChange = Date.now();
    };
    const onExit = () => finish(false);

    session.on('data', onData);
    session.on('exit', onExit);

    const timer = setInterval(() => {
      // mustExit 模式只认进程退出或总超时，静默间隙（如脚本里的 sleep）不算完成
      if (mustExit) {
        if (!session.alive) return finish(false);
        if (Date.now() >= deadline) return finish(true);
        return;
      }
      if (lastLen !== session.buffer.length) {
        lastLen = session.buffer.length;
        lastChange = Date.now();
      }
      if (idleFor >= quietMs) return finish(false);
      if (Date.now() >= deadline) return finish(true);
    }, 30);
    timer.unref();
  });
}

function escapeRx(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CSI_RX = /\x1b\[[?0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

function cleanExecOutput(text) {
  return String(text || '')
    .replace(CSI_RX, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

const EC_SENTINEL_RX = /\n__AITB_EC=(-?\d+)__\r?\n/;

function waitForSentinel(session, baseline, waitMs) {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const region = session.buffer.slice(baseline);
      const m = EC_SENTINEL_RX.exec(region);
      if (m) {
        clearInterval(timer);
        resolve({
          found: true,
          exitCode: Number(m[1]),
          before: region.slice(0, m.index),
        });
      } else if (Date.now() >= deadline || !session.alive) {
        clearInterval(timer);
        resolve({ found: false, exitCode: null, before: region });
      }
    }, 40);
    timer.unref();
  });
}

const EXEC_CACHE_MAX = 200;
const execCache = new Map();
const execInflight = new Map();

function execCachePut(key, payload) {
  execCache.set(key, { payload, ts: Date.now() });
  if (execCache.size > EXEC_CACHE_MAX) {
    const oldest = [...execCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) execCache.delete(oldest[0]);
  }
}

function execCacheGet(key) {
  const hit = execCache.get(key);
  return hit ? hit.payload : null;
}

// 同一 requestId 的并发重复请求共用同一个在途 Promise：代理层重试不会重复执行命令
function execDedupe(key, run) {
  const hit = execCacheGet(key);
  if (hit) return Promise.resolve({ payload: hit, cached: true });
  const pending = execInflight.get(key);
  if (pending) return pending.then((payload) => ({ payload, cached: false }));
  const p = (async () => {
    try {
      const payload = await run();
      execCachePut(key, payload);
      return payload;
    } finally {
      execInflight.delete(key);
    }
  })();
  execInflight.set(key, p);
  return p.then((payload) => ({ payload, cached: false }));
}

// ---- detach 执行任务 ----
const execJobs = new Map(); // execId -> job
const execJobByRequest = new Map(); // requestId -> execId

function execJobStatus(job) {
  if (!job.finished) return 'running';
  return job.payload.status || 'exited';
}

function buildExecPayload(job, result) {
  const session = job.session;
  const timedOut = Boolean(result.timedOut);
  const raw = String(result.data || '');
  const output = cleanExecOutput(raw);
  const durationMs = Date.now() - job.startedAt;
  return {
    execId: job.id,
    requestId: job.requestId || undefined,
    commandLabel: job.label,
    status: timedOut ? 'timeout' : 'exited',
    exitCode: timedOut ? 124 : session.exitCode,
    output,
    truncated: timedOut,
    truncatedReason: timedOut ? 'timeout' : undefined,
    timedOut,
    killed: timedOut,
    bytesReturned: Buffer.byteLength(output),
    bytesTotal: Buffer.byteLength(raw),
    durationMs,
  };
}

function escalateKill(session) {
  // 先 SIGTERM 里面的命令，随后强杀 worker（pty 关闭连带子进程退出）
  session.kill('SIGTERM');
}

async function runDetachedJob(job) {
  const { session } = job;
  let spawnError = '';
  const onError = (msg) => {
    if (!spawnError) spawnError = String(msg);
  };
  session.on('error', onError);
  const result = await waitForOutput(session, {
    since: 0,
    waitMs: job.timeoutMs,
    quietMs: 0,
    mustExit: true,
  });
  session.removeListener('error', onError);
  if (result.timedOut) escalateKill(session);
  await new Promise((r) => setTimeout(r, result.timedOut ? 400 : 0));
  if (spawnError && !session.exitCode && !String(result.data || '').length) {
    job.finished = true;
    job.payload = {
      execId: job.id,
      requestId: job.requestId || undefined,
      commandLabel: job.label,
      status: 'failed',
      exitCode: null,
      output: '',
      truncated: false,
      timedOut: false,
      error: 'spawn_failed',
      detail: spawnError.slice(0, 500),
      bytesReturned: 0,
      bytesTotal: 0,
      durationMs: Date.now() - job.startedAt,
    };
  } else {
    job.payload = buildExecPayload(job, result);
    job.finished = true;
  }
  job.finishedAt = Date.now();
  // 从 manager 摘除（已退出，不影响 UI 会话列表与生命周期清扫），缓冲区仍留在 job 里供拉取
  manager.remove(job.id);
  if (job.requestId) execCachePut(`execid:${job.requestId}`, { execId: job.id });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of execJobs) {
    if (job.finished && now - (job.finishedAt || now) > settings.execJobTtlMs) {
      execJobs.delete(id);
      if (job.requestId) execJobByRequest.delete(job.requestId);
    }
  }
}, 30 * 1000).unref();

function stripEcho(region, sent) {  const rx = new RegExp(sent.split('').map(escapeRx).join('(?:\\r?\\n)*'), 'g');
  let last = null;
  let m;
  while ((m = rx.exec(region)) !== null) {
    last = m;
    if (m.index === rx.lastIndex) rx.lastIndex++;
  }
  if (!last) return region;
  let end = last.index + last[0].length;
  for (;;) {
    const rest = region.slice(end);
    const ansi = rest.match(/^\x1b\[[?0-9;]*[a-zA-Z]/);
    if (ansi) {
      end += ansi[0].length;
      continue;
    }
    if (rest.startsWith('\r')) {
      end += 1;
      continue;
    }
    if (rest.startsWith('\n')) {
      end += 1;
    }
    break;
  }
  return region.slice(end);
}

async function handleApi(req, res, url) {
  const { pathname } = url;  const method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'ai-terminal-bridge',
      version: require('../package.json').version,
      uptimeMs: Date.now() - startedAt,
      sessions: manager.list().length,
      shell: settings.shell,
      cwd: settings.cwd,
    }, corsHeaders(req));
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!loginAllowed(ip)) {
      return sendJson(res, 429, { error: 'too many failed attempts, retry in a minute', code: 'rate_limited' }, corsHeaders(req));
    }
    const body = await readBody(req);
    const username = String(body.username || settings.loginUser).trim() || settings.loginUser;
    const password = String(body.password === undefined || body.password === null ? '' : body.password);
    const account = accounts.verify(username, password);
    if (account) {
      recordLoginSuccess(ip);
      account.lastLoginAt = Date.now();
      accounts.save();
      const sessionToken = accounts.issueSession(username);
      audit.add({ kind: 'login', actor: username, ip, detail: 'account' });
      return sendJson(res, 200, {
        sessionToken,
        account: accounts.publicAccount(account),
        mustChangePassword: Boolean(account.mustChange),
      }, corsHeaders(req));
    }
    const tokenEntry = tokens.verifyManaged(password);
    if (tokenEntry) {
      recordLoginSuccess(ip);
      const sessionToken = accounts.issueSession(
        `token:${tokenEntry.id}`,
        tokenEntry.scopes,
        `${tokenEntry.name || tokenEntry.id}(${tokenEntry.id})`
      );
      audit.add({ kind: 'login', actor: tokenEntry.name || tokenEntry.id, ip, detail: 'token' });
      return sendJson(res, 200, {
        sessionToken,
        account: { username: tokenEntry.name || 'token', kind: 'token', mustChangePassword: false },
        mustChangePassword: false,
      }, corsHeaders(req));
    }
    recordLoginFail(ip);
    audit.add({ kind: 'login_fail', actor: username || '-', ip });
    return sendJson(res, 401, { error: 'wrong username or password', code: 'auth_failed' }, corsHeaders(req));
  }

  const auth = authenticate(req, url);
  if (!auth) {
    return sendJson(res, 401, { error: 'unauthorized', code: 'auth_failed', hint: 'send Authorization: Bearer <token>' }, corsHeaders(req));
  }

  const need = (scope) => {
    if (hasScope(auth, scope)) return true;
    audit.add({ kind: 'forbidden', actor: actorOf(auth), ip: req.socket.remoteAddress, detail: `${method} ${pathname}` });
    sendJson(res, 403, { error: 'forbidden', code: 'forbidden', requiredScope: scope, scopes: auth.scopes }, corsHeaders(req));
    return false;
  };

  if (method !== 'GET' || pathname === '/api/docs' || /\/reveal$/.test(pathname)) {
    audit.add({ kind: 'api', actor: actorOf(auth), ip: req.socket.remoteAddress || 'unknown', detail: `${method} ${pathname}` });
  }

  if (pathname === '/api/audit' && method === 'GET') {
    if (!need('admin')) return;
    const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
    const kind = url.searchParams.get('kind') || undefined;
    const actor = url.searchParams.get('actor') || undefined;
    return sendJson(res, 200, { events: audit.list({ limit, kind, actor }), info: audit.info() }, corsHeaders(req));
  }

  if (pathname === '/api/audit' && method === 'DELETE') {
    if (!need('admin')) return;
    const removed = audit.prune();
    return sendJson(res, 200, { ok: true, removed, info: audit.info() }, corsHeaders(req));
  }

  if (pathname === '/api/auth/me') {
    const info = { kind: auth.kind || 'token', username: auth.username || null, display: auth.display || null, scopes: auth.scopes };
    if (auth.kind === 'session') {
      const account = accounts.find(auth.username);
      if (account) info.account = accounts.publicAccount(account);
    }
    return sendJson(res, 200, info, corsHeaders(req));
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (auth.sessionToken) accounts.revokeSession(auth.sessionToken);
    return sendJson(res, 200, { ok: true }, corsHeaders(req));
  }

  if (pathname === '/api/auth/password' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || auth.username || '').trim();
    if (!username) return sendJson(res, 400, { error: 'username is required' }, corsHeaders(req));
    if (!accounts.find(username)) return sendJson(res, 404, { error: 'account not found' }, corsHeaders(req));
    const result = accounts.setPassword(username, body.currentPassword, body.newPassword);
    if (!result.ok) return sendJson(res, 400, { error: result.error }, corsHeaders(req));
    return sendJson(res, 200, { ok: true }, corsHeaders(req));
  }

  if (pathname === '/api/docs') {
    try {
      const md = fs.readFileSync(path.join(ROOT, 'docs', 'API.md'), 'utf8');
      return sendJson(res, 200, { markdown: md }, corsHeaders(req));
    } catch {
      return sendJson(res, 404, { error: 'docs not found' }, corsHeaders(req));
    }
  }

  if (pathname === '/api/token/verify') {
    return sendJson(res, 200, {
      ok: true,
      token: publicToken(auth),
    }, corsHeaders(req));
  }

  if (pathname === '/api/tokens' && method === 'GET') {
    if (!need('admin')) return;
    return sendJson(res, 200, { tokens: tokens.list() }, corsHeaders(req));
  }

  if (pathname === '/api/tokens' && method === 'POST') {
    if (!need('admin')) return;
    const body = await readBody(req);
    let ttlMs = body.ttlMs === undefined ? 0 : Number(body.ttlMs);
    if (body.ttlSeconds !== undefined) ttlMs = Number(body.ttlSeconds) * 1000;
    if (body.ttlMinutes !== undefined) ttlMs = Number(body.ttlMinutes) * 60 * 1000;
    if (body.ttlHours !== undefined) ttlMs = Number(body.ttlHours) * 60 * 60 * 1000;
    if (ttlMs && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      return sendJson(res, 400, { error: 'invalid ttl' }, corsHeaders(req));
    }
    if (ttlMs > settings.maxTtlMs) {
      return sendJson(res, 400, { error: `ttl exceeds maximum (${settings.maxTtlMs}ms)` }, corsHeaders(req));
    }
    const entry = tokens.create({
      name: body.name,
      ttlMs: ttlMs || 0,
      expiresAt: body.expiresAt,
      scopes: body.scopes,
      token: body.token,
    });
    return sendJson(res, 201, {
      token: publicToken(entry, { reveal: true }),
      hint: 'this is the only time the token is returned in full',
    }, corsHeaders(req));
  }

  const tokenMatch = pathname.match(/^\/api\/tokens\/([^/]+)(\/[a-z]+)?$/);
  if (tokenMatch) {
    if (!need('admin')) return;
    const tid = decodeURIComponent(tokenMatch[1]);
    const action = tokenMatch[2] || '';
    if (!action && method === 'DELETE') {
      const ok = tokens.revoke(tid);
      if (!ok) return sendJson(res, 404, { error: 'token not found' }, corsHeaders(req));
      return sendJson(res, 200, { ok: true, id: tid }, corsHeaders(req));
    }
    if (action === '/reveal' && method === 'GET') {
      const entry = tokens.reveal(tid);
      if (!entry) return sendJson(res, 404, { error: 'token not found' }, corsHeaders(req));
      return sendJson(res, 200, { token: publicToken(entry, { reveal: true }) }, corsHeaders(req));
    }
    if (action === '/rotate' && method === 'POST') {
      const entry = tokens.rotate(tid);
      if (!entry) return sendJson(res, 404, { error: 'token not found' }, corsHeaders(req));
      return sendJson(res, 200, { token: publicToken(entry, { reveal: true }) }, corsHeaders(req));
    }
    if (action === '/rename' && method === 'POST') {
      const body = await readBody(req);
      const entry = tokens.rename(tid, body.name);
      if (!entry) return sendJson(res, 404, { error: 'token not found or empty name' }, corsHeaders(req));
      return sendJson(res, 200, { token: publicToken(entry) }, corsHeaders(req));
    }
    if (action === '/value' && method === 'POST') {
      const body = await readBody(req);
      let entry;
      try {
        entry = tokens.setValue(tid, body.token);
      } catch (err) {
        return sendJson(res, err.status || 400, { error: err.message }, corsHeaders(req));
      }
      if (!entry) return sendJson(res, 404, { error: 'token not found' }, corsHeaders(req));
      return sendJson(res, 200, {
        token: publicToken(entry, { reveal: true }),
        hint: 'this is the only time the token is returned in full',
      }, corsHeaders(req));
    }
    if (action === '/disable' && method === 'POST') {
      const entry = tokens.setEnabled(tid, false);
      if (!entry) return sendJson(res, 404, { error: 'token not found' }, corsHeaders(req));
      return sendJson(res, 200, { token: publicToken(entry) }, corsHeaders(req));
    }
    if (action === '/enable' && method === 'POST') {
      const entry = tokens.setEnabled(tid, true);
      if (!entry) return sendJson(res, 404, { error: 'token not found' }, corsHeaders(req));
      return sendJson(res, 200, { token: publicToken(entry) }, corsHeaders(req));
    }
  }

  if (pathname === '/api/sessions' && method === 'GET') {
    if (!need('session')) return;
    return sendJson(res, 200, {
      sessions: manager.list().map((s) => {
        const v = viewersOf(s.id);
        return { ...s, viewers: v.viewers, lastOperator: v.lastOperator, lastOperatorAt: v.lastOperatorAt || null };
      }),
    }, corsHeaders(req));
  }

  if (pathname === '/api/sessions' && method === 'POST') {
    if (!need('session')) return;
    const body = await readBody(req);
    const actor = actorOf(auth);
    const { session, reused } = createOrReuseSession({
      name: body.name,
      cwd: body.cwd,
      shell: body.shell,
      cols: body.cols,
      rows: body.rows,
      id: body.id,
    }, actor, req.socket.remoteAddress || 'unknown');
    return sendJson(res, reused ? 200 : 201, {
      session: session.info(),
      reused,
    }, corsHeaders(req));
  }

  if (pathname === '/api/exec' && method === 'POST') {
    if (!need('exec')) return;
    const body = await readBody(req);
    if (!body.command || typeof body.command !== 'string') {
      return sendError(res, req, 400, 'bad_request', 'command is required');
    }
    const requestId = body.requestId ? String(body.requestId).slice(0, 128) : '';
    const shell = body.shell || settings.shell;
    const cmdLabel = body.command.replace(/\s+/g, ' ').trim().slice(0, 20) || 'cmd';

    const createExecSession = () =>
      manager.create({
        cwd: body.cwd || settings.cwd,
        shell,
        cols: body.cols || 500,
        rows: body.rows || 50,
        name: `exec:${cmdLabel}`,
        argv: [shell, '-c', body.command],
        ephemeral: !body.keep,
      });

    // ---- detach 模式：立即返回 execId，用 status/output 接口拉取 ----
    if (body.detach) {
      if (requestId) {
        const existingId = execJobByRequest.get(requestId);
        if (existingId) {
          const existing = execJobs.get(existingId);
          if (existing) {
            return sendJson(res, 200, {
              execId: existingId,
              detached: true,
              status: execJobStatus(existing),
              cached: true,
              requestId,
            }, corsHeaders(req));
          }
        }
      }
      const maxMs = Math.min(Number(body.timeoutMs) || 15000, settings.execMaxMs);
      const session = createExecSession();
      const job = {
        id: session.id,
        session,
        label: cmdLabel,
        requestId,
        startedAt: Date.now(),
        timeoutMs: maxMs,
        finished: false,
        payload: null,
      };
      execJobs.set(job.id, job);
      if (requestId) execJobByRequest.set(requestId, job.id);
      runDetachedJob(job).catch(() => {});
      return sendJson(res, 200, {
        execId: job.id,
        detached: true,
        status: 'running',
        requestId: requestId || undefined,
        pollStatus: `/api/exec/${job.id}/status`,
        pollOutput: `/api/exec/${job.id}/output?offset=0`,
      }, corsHeaders(req));
    }

    // ---- 同步模式：requestId 幂等（缓存重放 + 在途合并），代理重试不会重复执行 ----
    const runSync = async () => {
      const timeoutMs = Math.min(Number(body.timeoutMs) || 15000, 120000);
      const session = createExecSession();
      const startedAt = Date.now();
      let spawnError = '';
      const onError = (msg) => {
        if (!spawnError) spawnError = String(msg);
      };
      session.on('error', onError);
      let result;
      try {
        result = await waitForOutput(session, {
          since: 0,
          waitMs: timeoutMs,
          quietMs: 0,
          mustExit: true,
        });
      } finally {
        session.removeListener('error', onError);
      }
      if (result.timedOut) {
        escalateKill(session);
        await new Promise((r) => setTimeout(r, 400));
      }
      if (spawnError && session.exitCode === null && !String(result.data || '').length) {
        removeSession(session.id);
        const err = new Error(`exec spawn failed: ${spawnError.slice(0, 200)}`);
        err.status = 500;
        err.code = 'spawn_failed';
        throw err;
      }
      const payload = buildExecPayload({ id: session.id, requestId, session, label: cmdLabel, startedAt }, result);
      if (!body.keep) setTimeout(() => removeSession(session.id), 50).unref();
      return payload;
    };

    if (!requestId) {
      const payload = await runSync();
      if (body.keep) {
        return sendJson(res, 200, { ...payload, kept: true }, corsHeaders(req));
      }
      return sendJson(res, 200, payload, corsHeaders(req));
    }
    const { payload, cached } = await execDedupe(`exec:${requestId}`, runSync);
    if (body.keep) {
      return sendJson(res, 200, { ...payload, kept: true, cached: cached || undefined }, corsHeaders(req));
    }
    return sendJson(res, 200, { ...payload, cached: cached || undefined }, corsHeaders(req));
  }

  const execJobMatch = pathname.match(/^\/api\/exec\/([^/]+)(\/(status|output))?$/);
  if (execJobMatch && method === 'GET') {
    if (!need('exec')) return;
    const job = execJobs.get(decodeURIComponent(execJobMatch[1]));
    if (!job) {
      return sendError(res, req, 404, 'exec_not_found', `exec job not found (or expired): ${execJobMatch[1]}`);
    }
    const action = execJobMatch[3] || 'status';
    const session = job.session;
    if (action === 'status') {
      const base = {
        execId: job.id,
        requestId: job.requestId || undefined,
        commandLabel: job.label,
        status: execJobStatus(job),
        timedOut: job.finished ? Boolean(job.payload.timedOut) : false,
        exitCode: job.finished ? job.payload.exitCode : null,
        startedAt: job.startedAt,
        timeoutMs: job.timeoutMs,
        bytesTotal: session.buffer.length,
        durationMs: job.finished ? job.payload.durationMs : Date.now() - job.startedAt,
      };
      if (job.finished && job.payload.error) {
        base.error = job.payload.error;
        base.detail = job.payload.detail;
      }
      return sendJson(res, 200, base, corsHeaders(req));
    }
    // action === 'output'
    const offsetRaw = Number(url.searchParams.get('offset') || 0);
    const bufferStart = session.trimmedChars;
    const requested = Math.max(0, offsetRaw - bufferStart);
    const start = Math.min(Math.max(0, requested), session.buffer.length);
    // 清洗 CSI/CR，但不做边缘裁剪：offset 坐标以缓冲区为准，客户端始终回传服务端返回的 offset
    const data = stripAnsi(session.buffer.slice(start)).replace(/\r\n/g, '\n').replace(/\r/g, '');
    return sendJson(res, 200, {
      execId: job.id,
      status: execJobStatus(job),
      exitCode: job.finished ? job.payload.exitCode : null,
      timedOut: job.finished ? Boolean(job.payload.timedOut) : false,
      truncated: !job.finished,
      truncatedReason: !job.finished ? 'running' : job.payload.truncatedReason,
      bufferStart,
      offset: bufferStart + session.buffer.length,
      bytesTotal: session.buffer.length,
      bytesReturned: Buffer.byteLength(data),
      data,
    }, corsHeaders(req));
  }

  if (execJobMatch && method === 'DELETE') {
    if (!need('exec')) return;
    const job = execJobs.get(decodeURIComponent(execJobMatch[1]));
    if (!job) {
      return sendError(res, req, 404, 'exec_not_found', `exec job not found (or expired): ${execJobMatch[1]}`);
    }
    if (!job.finished) {
      escalateKill(job.session);
      job.finished = true;
      job.payload = {
        execId: job.id,
        requestId: job.requestId || undefined,
        commandLabel: job.label,
        status: 'killed',
        exitCode: 124,
        output: cleanExecOutput(stripAnsi(job.session.buffer)),
        truncated: true,
        truncatedReason: 'killed',
        timedOut: false,
        killed: true,
        bytesTotal: job.session.buffer.length,
        durationMs: Date.now() - job.startedAt,
      };
      job.finishedAt = Date.now();
      manager.remove(job.id);
    }
    return sendJson(res, 200, { ok: true, execId: job.id, status: execJobStatus(job) }, corsHeaders(req));
  }

  if (pathname === '/api/files' && (method === 'PUT' || method === 'POST' || method === 'GET')) {
    if (!need('exec')) return;
    const fp = url.searchParams.get('path');
    if (!fp || !path.isAbsolute(fp)) {
      return sendError(res, req, 400, 'bad_request', 'query parameter path (absolute) is required');
    }
    if (method === 'PUT' || method === 'POST') {
      let buf;
      try {
        buf = await readRaw(req, settings.uploadMaxBytes);
      } catch (err) {
        return sendError(res, req, err.status || 500, err.status === 413 ? 'payload_too_large' : 'upload_failed', err.message);
      }
      try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        const tmp = `${fp}.aitb-tmp-${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(tmp, buf, { mode: 0o644 });
        fs.renameSync(tmp, fp);
      } catch (err) {
        return sendError(res, req, 500, 'write_failed', String(err.message || err));
      }
      audit.add({ kind: 'file_upload', actor: actorOf(auth), ip: req.socket.remoteAddress || 'unknown', detail: `${fp} ${buf.length}B` });
      return sendJson(res, 200, { ok: true, path: fp, bytes: buf.length, sha256: sha256(buf) }, corsHeaders(req));
    }
    let st;
    try {
      st = fs.statSync(fp);
    } catch {
      return sendError(res, req, 404, 'file_not_found', `file not found: ${fp}`);
    }
    if (st.isDirectory()) {
      return sendError(res, req, 400, 'is_directory', `path is a directory: ${fp}`);
    }
    if (st.size > settings.uploadMaxBytes) {
      return sendError(res, req, 413, 'payload_too_large', `file exceeds ${settings.uploadMaxBytes} bytes`);
    }
    const buf = fs.readFileSync(fp);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': buf.length,
      'x-aitb-sha256': sha256(buf),
      'cache-control': 'no-store',
      ...corsHeaders(req),
    });
    return res.end(buf);
  }

  if (pathname === '/api/sessions/purge' && method === 'POST') {
    if (!need('session')) return;
    const ephemeralOnly = url.searchParams.get('ephemeral') !== '0';
    const targets = manager.list().filter((s) => (ephemeralOnly ? s.ephemeral : true));
    for (const s of targets) removeSession(s.id);
    return sendJson(res, 200, { ok: true, removed: targets.map((s) => s.id) }, corsHeaders(req));
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/[a-z]+)?$/);
  if (sessionMatch) {
    if (!need('session')) return;
    const id = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2] || '';
    const session = requireSession(id);

    if (!action && method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const strip = url.searchParams.get('strip') !== '0';
      return sendJson(res, 200, { session: session.snapshot(offset, { strip }) }, corsHeaders(req));
    }

    if (!action && method === 'DELETE') {
      removeSession(id);
      return sendJson(res, 200, { ok: true, id }, corsHeaders(req));
    }

    if (action === '/input' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.data !== 'string') {
        return sendJson(res, 400, { error: 'data (string) is required' }, corsHeaders(req));
      }
      markOperator(id, actorOf(auth));
      const ok = session.write(body.data);
      return sendJson(res, 200, { ok, offset: session.buffer.length }, corsHeaders(req));
    }

    if (action === '/resize' && method === 'POST') {
      const body = await readBody(req);
      const cols = Number(body.cols);
      const rows = Number(body.rows);
      if (!cols || !rows) return sendJson(res, 400, { error: 'cols and rows are required' }, corsHeaders(req));
      session.resize(cols, rows);
      return sendJson(res, 200, { ok: true, cols, rows }, corsHeaders(req));
    }

    if (action === '/exec' && method === 'POST') {
      const body = await readBody(req);
      if (!body.command || typeof body.command !== 'string') {
        return sendError(res, req, 400, 'bad_request', 'command is required');
      }
      const requestId = body.requestId ? String(body.requestId).slice(0, 128) : '';
      const runSessionExec = async () => {
        const baseline = session.buffer.length;
        const sent = body.command.replace(/\r?\n$/, '') + '; printf \'\\n__AITB_EC=%s__\\n\' "$?"';
        session.write(sent + '\r');
        markOperator(id, actorOf(auth));
        const waitMs = Math.min(Number(body.timeoutMs) || 30000, 120000);
        const result = await waitForSentinel(session, baseline, waitMs);
        let output = stripEcho(result.before, sent);
        if (result.found) output = output.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
        return {
          sessionId: session.id,
          requestId: requestId || undefined,
          offset: session.buffer.length,
          output: cleanExecOutput(output),
          alive: session.alive,
          exitCode: result.found ? result.exitCode : null,
          truncated: !result.found,
          truncatedReason: result.found ? undefined : 'timeout',
          timedOut: !result.found,
        };
      };
      if (!requestId) {
        return sendJson(res, 200, await runSessionExec(), corsHeaders(req));
      }
      const { payload, cached } = await execDedupe(`sexec:${session.id}:${requestId}`, runSessionExec);
      return sendJson(res, 200, { ...payload, cached: cached || undefined }, corsHeaders(req));
    }

    if (action === '/kill' && method === 'POST') {
      session.kill();
      return sendJson(res, 200, { ok: true }, corsHeaders(req));
    }
  }

  return sendJson(res, 404, { error: 'not found', path: pathname }, corsHeaders(req));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function serveStatic(req, res, pathname) {
  let filePath;
  if (VENDOR_MAP[pathname]) {
    filePath = VENDOR_MAP[pathname];
  } else {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': filePath.startsWith(PUBLIC_DIR) ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      const status = err.status || 500;
      const code = err.code || (status === 500 ? 'internal_error' : 'request_failed');
      sendJson(res, status, { error: err.message || 'internal error', code }, corsHeaders(req));
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  const auth = authenticate(req, url);
  if (!auth || !hasScope(auth, 'session')) {
    socket.write(
      'HTTP/1.1 401 Unauthorized\r\n' +
      'content-type: application/json; charset=utf-8\r\n' +
      'connection: close\r\n' +
      '\r\n' +
      '{"error":"invalid_token"}'
    );
    socket.end();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, url, auth));
});

wss.on('connection', (ws, req, url, auth) => {
  let session = null;
  const offset = Number(url.searchParams.get('offset') || 0);
  const sessionId = url.searchParams.get('session');

  const attach = (s) => {
    session = s;
    const snapshot = s.snapshot(offset, { strip: false });
    ws.send(JSON.stringify({ type: 'snapshot', session: s.info(), data: snapshot.data, offset: snapshot.offset }));
  };

  const onData = (data) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) return;
    ws.send(JSON.stringify({ type: 'output', data }));
  };
  const onExit = (code) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
  };
  const onError = (message) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message }));
  };

  const detach = () => {
    if (!session) return;
    session.removeListener('data', onData);
    session.removeListener('exit', onExit);
    session.removeListener('error', onError);
  };

  if (sessionId) {
    const existing = manager.get(sessionId);
    if (!existing) {
      ws.send(JSON.stringify({ type: 'error', message: `session not found: ${sessionId}` }));
      ws.close();
      return;
    }
    reopenIfDead(existing, actorOf(auth), req.socket.remoteAddress || 'unknown');
    attach(existing);
  } else {
    const wsName = (url.searchParams.get('name') || '').trim();
    try {
      const { session: target } = createOrReuseSession({
        name: wsName || undefined,
        cwd: url.searchParams.get('cwd') || settings.cwd,
      }, actorOf(auth), req.socket.remoteAddress || 'unknown');
      attach(target);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
      return;
    }
  }
  const wsIp = req.socket.remoteAddress || 'unknown';
  const wsActor = actorOf(auth);
  touchConnection(session.id);
  audit.add({ kind: 'ws_connect', actor: wsActor, ip: wsIp, sessionId: session.id, detail: session.id });
  if (!session.name || session.name !== 'oneshot') trackSession(session, wsActor, wsIp);
  let viewerSet = sessionViewers.get(session.id);
  if (!viewerSet) {
    viewerSet = new Set();
    sessionViewers.set(session.id, viewerSet);
  }
  viewerSet.add(wsActor);
  session.on('data', onData);
  session.on('exit', onExit);
  session.on('error', onError);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols && msg.rows) {
      session.resize(Number(msg.cols), Number(msg.rows));
    } else if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
    } else if (msg.type === 'kill') {
      audit.add({ kind: 'ws_kill', actor: wsActor, ip: wsIp, detail: session.id });
      session.kill();
    }
  });

  ws.on('close', () => {
    if (session) touchConnection(session.id);
    audit.add({ kind: 'ws_disconnect', actor: wsActor, ip: wsIp, sessionId: session ? session.id : '', detail: session ? session.id : '' });
    if (session && sessionViewers.has(session.id)) {
      const set = sessionViewers.get(session.id);
      set.delete(wsActor);
      if (!set.size) sessionViewers.delete(session.id);
    }
    detach();
  });
  ws.on('error', () => {
    detach();
  });
});

function logCrash(kind, err) {
  try {
    const line = `${new Date().toISOString()} [${kind}] ${(err && err.stack) || err}\n`;
    fs.mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(settings.stateDir, 'crash.log'), line);
  } catch {
    /* ignore */
  }
}

function shutdown(reason) {
  try {
    tokens.flush();
  } catch {
    /* ignore */
  }
  try {
    audit.flush();
  } catch {
    /* ignore */
  }
  manager.removeAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', () => {
  logCrash('signal', 'SIGINT received');
  shutdown();
});
process.on('SIGTERM', () => {
  logCrash('signal', 'SIGTERM received');
  shutdown();
});
process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  console.error('[aitb] uncaughtException, shutting down:', err.stack || err);
  shutdown();
});
process.on('unhandledRejection', (err) => {
  logCrash('unhandledRejection', err);
  console.error('[aitb] unhandledRejection:', (err && err.stack) || err);
});

if (require.main === module) {
  server.listen(settings.port, settings.host, () => {
    const masked = settings.token.slice(0, 9) + '****' + settings.token.slice(-4);
    console.log(`ai-terminal-bridge listening on http://${settings.host}:${settings.port}`);
    console.log(`bootstrap token: ${masked}  (full token in ${settings.tokenFile})`);
    console.log(`token store: ${settings.tokensFile}  (${tokens.list().length} managed token(s))`);
    console.log(`login account: ${settings.loginUser} / ${settings.token === 'admin' ? 'admin (default, change on first login)' : '<bootstrap token value>'}`);
    console.log(`web ui: http://${settings.host}:${settings.port}/?token=<token>`);
  });
}

module.exports = { server, manager, settings, tokens };
