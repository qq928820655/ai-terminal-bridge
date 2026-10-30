'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
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
const OPERATOR_TTL_MS = 60 * 1000;

function markOperator(id, actor) {
  if (!actor) return;
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
  return manager.remove(id);
}

function createOrReuseSession(options, actor, ip) {
  if (options.name) {
    const existing = manager.getByName(options.name);
    if (existing) {
      trackSession(existing, actor, ip);
      return { session: existing, reused: true };
    }
    manager.removeDeadByName(options.name);
  }
  const session = manager.create(options);
  trackSession(session, actor, ip);
  return { session, reused: false };
}

function trackSession(session, actor, ip) {
  if (session._tracked) return;
  session._tracked = true;
  audit.add({ kind: 'session_create', actor, ip, sessionId: session.id, detail: session.id });
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

function corsHeaders(req) {
  if (!settings.cors) return {};
  const origin = req.headers.origin || settings.cors;
  return {
    'access-control-allow-origin': settings.cors === '*' ? '*' : origin,
    'access-control-allow-headers': 'authorization,content-type,x-aitb-token',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
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
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
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
        reject(Object.assign(new Error('invalid json body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireSession(id) {
  const session = manager.get(id);
  if (!session) {
    throw Object.assign(new Error(`session not found: ${id}`), { status: 404 });
  }
  return session;
}

function waitForOutput(session, { since, waitMs = 800, quietMs = 250, mustExit = false }) {
  const deadline = Date.now() + waitMs;
  return new Promise((resolve) => {
    let lastLen = session.buffer.length;
    let lastChange = Date.now();
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      session.removeListener('data', onData);
      session.removeListener('exit', onExit);
      clearInterval(timer);
      resolve(session.snapshot(since, { strip: true }));
    };

    const onData = () => {
      lastLen = session.buffer.length;
      lastChange = Date.now();
    };
    const onExit = () => finish();

    session.on('data', onData);
    session.on('exit', onExit);

    const timer = setInterval(() => {
      const idleFor = Date.now() - lastChange;
      if (mustExit && !session.alive) return finish();
      if (lastLen !== session.buffer.length) {
        lastLen = session.buffer.length;
        lastChange = Date.now();
      }
      if (idleFor >= quietMs) return finish();
      if (Date.now() >= deadline) return finish();
    }, 30);
    timer.unref();
  });
}

function escapeRx(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function stripEcho(region, sent) {
  const rx = new RegExp(sent.split('').map(escapeRx).join('(?:\\r?\\n)*'), 'g');
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
      return sendJson(res, 429, { error: 'too many failed attempts, retry in a minute' }, corsHeaders(req));
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
    return sendJson(res, 401, { error: 'wrong username or password' }, corsHeaders(req));
  }

  const auth = authenticate(req, url);
  if (!auth) {
    return sendJson(res, 401, { error: 'unauthorized', hint: 'send Authorization: Bearer <token>' }, corsHeaders(req));
  }

  const need = (scope) => {
    if (hasScope(auth, scope)) return true;
    audit.add({ kind: 'forbidden', actor: actorOf(auth), ip: req.socket.remoteAddress, detail: `${method} ${pathname}` });
    sendJson(res, 403, { error: 'forbidden', requiredScope: scope, scopes: auth.scopes }, corsHeaders(req));
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
      return sendJson(res, 400, { error: 'command is required' }, corsHeaders(req));
    }
    const shell = body.shell || settings.shell;
    const cmdLabel = body.command.replace(/\s+/g, ' ').trim().slice(0, 20) || 'cmd';
    const session = manager.create({
      cwd: body.cwd || settings.cwd,
      shell,
      cols: body.cols || 500,
      rows: body.rows || 50,
      name: `exec:${cmdLabel}`,
      argv: [shell, '-c', body.command],
      ephemeral: !body.keep,
    });
    let settled = false;
    const reap = () => {
      if (settled) return;
      settled = true;
      removeSession(session.id);
    };
    req.on('close', () => {
      if (!res.writableEnded) reap();
    });
    const hardTtl = setTimeout(reap, Math.min(Number(body.timeoutMs) || 15000, 120000) + 30000);
    hardTtl.unref();
    try {
      const timeoutMs = Math.min(Number(body.timeoutMs) || 15000, 120000);
      const quietMs = Math.min(Number(body.quietMs) || 1000, 30000);
      const result = await waitForOutput(session, {
        since: 0,
        waitMs: timeoutMs,
        quietMs: session.alive ? quietMs : 1,
        mustExit: true,
      });
      settled = true;
      clearTimeout(hardTtl);
      const payload = {
        exitCode: session.exitCode,
        output: String(result.data || '').replace(/\r\n/g, '\n'),
        truncated: session.alive,
      };
      if (body.keep) {
        return sendJson(res, 200, { sessionId: session.id, ...payload, kept: true }, corsHeaders(req));
      }
      setTimeout(() => removeSession(session.id), 50).unref();
      return sendJson(res, 200, payload, corsHeaders(req));
    } catch (err) {
      settled = true;
      clearTimeout(hardTtl);
      removeSession(session.id);
      throw err;
    }
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
        return sendJson(res, 400, { error: 'command is required' }, corsHeaders(req));
      }
      const baseline = session.buffer.length;
      const sent = body.command.replace(/\r?\n$/, '') + '; printf \'\\n__AITB_EC=%s__\\n\' "$?"';
      session.write(sent + '\r');
      markOperator(id, actorOf(auth));
      const waitMs = Math.min(Number(body.timeoutMs) || 30000, 120000);
      const result = await waitForSentinel(session, baseline, waitMs);
      let output = stripEcho(result.before, sent);
      if (result.found) output = output.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      const normalized = output.replace(/\r\n/g, '\n');
      return sendJson(res, 200, {
        sessionId: session.id,
        offset: session.buffer.length,
        output: normalized,
        alive: session.alive,
        exitCode: result.found ? result.exitCode : null,
        truncated: !result.found,
      }, corsHeaders(req));
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
      sendJson(res, status, { error: err.message || 'internal error' }, corsHeaders(req));
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
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
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

function shutdown() {
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

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

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
