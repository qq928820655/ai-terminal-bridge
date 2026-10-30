'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const WebSocket = require('ws');

const PORT = 8900 + Math.floor(Math.random() * 400);
const TOKEN = 'test_' + Math.random().toString(36).slice(2);
const TOKENS_FILE = path.join(os.tmpdir(), `aitb-tokens-${process.pid}-${Date.now()}.json`);
const ACCOUNTS_FILE = path.join(os.tmpdir(), `aitb-accounts-${process.pid}-${Date.now()}.json`);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

function api(method, p, body, token = TOKEN) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return fetch(BASE + p, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    body: payload,
  }).then(async (res) => {
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  });
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: {
      ...process.env,
      AITB_PORT: String(PORT),
      AITB_TOKEN: TOKEN,
      AITB_HOST: '127.0.0.1',
      AITB_TOKENS_FILE: TOKENS_FILE,
      AITB_ACCOUNTS_FILE: ACCOUNTS_FILE,
      AITB_AUDIT_FILE: path.join(os.tmpdir(), `aitb-audit-${process.pid}-${Date.now()}.json`),
      AITB_MAX_TTL_MS: String(7 * 24 * 60 * 60 * 1000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 8000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });
});

test.after(() => {
  if (child) child.kill('SIGTERM');
  try {
    fs.unlinkSync(TOKENS_FILE);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(ACCOUNTS_FILE);
  } catch {
    /* ignore */
  }
});

test('health endpoint is public', async () => {
  const res = await fetch(BASE + '/api/health');
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.service, 'ai-terminal-bridge');
});

test('api rejects missing token', async () => {
  const res = await fetch(BASE + '/api/sessions');
  assert.equal(res.status, 401);
});

test('api rejects wrong token', async () => {
  const res = await fetch(BASE + '/api/sessions', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401);
});

test('one-shot exec captures stdout and exit code', async () => {
  const { status, data } = await api('POST', '/api/exec', { command: 'echo hello; echo err >&2; exit 7' });
  assert.equal(status, 200);
  assert.match(data.output, /hello/);
  assert.match(data.output, /err/);
  assert.equal(data.exitCode, 7);
});

test('one-shot exec honors cwd', async () => {
  const { data } = await api('POST', '/api/exec', { command: 'pwd', cwd: '/tmp' });
  assert.match(data.output, /\/tmp/);
});

test('session lifecycle: create, exec, read, delete', async () => {
  const created = await api('POST', '/api/sessions', { cwd: '/tmp', name: 'unit' });
  assert.equal(created.status, 201);
  const id = created.data.session.id;
  assert.ok(id);

  const exec = await api('POST', `/api/sessions/${id}/exec`, { command: 'cd /usr && pwd', wait: 400 });
  assert.equal(exec.status, 200);
  assert.match(exec.data.output, /\/usr/);

  const read = await api('GET', `/api/sessions/${id}?offset=0`);
  assert.equal(read.status, 200);
  assert.match(read.data.session.data, /\/usr/);

  const input = await api('POST', `/api/sessions/${id}/input`, { data: 'echo INJECT\n' });
  assert.equal(input.status, 200);
  assert.equal(input.data.ok, true);

  const removed = await api('DELETE', `/api/sessions/${id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.ok, true);

  const gone = await api('GET', `/api/sessions/${id}`);
  assert.equal(gone.status, 404);
});

test('session not found returns 404', async () => {
  const res = await api('POST', '/api/sessions/doesnotexist/exec', { command: 'ls' });
  assert.equal(res.status, 404);
});

test('websocket streams output and replays snapshot', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws timeout')), 6000);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'snapshot') {
        ws.send(JSON.stringify({ type: 'input', data: 'echo WS_MARK\n' }));
      } else if (msg.type === 'output' && msg.data.includes('WS_MARK')) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
});

test('websocket rejects bad token', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=bad`);
  const code = await new Promise((resolve) => {
    ws.on('error', () => resolve('error'));
    ws.on('close', () => resolve('close'));
    setTimeout(() => resolve('timeout'), 3000);
  });
  assert.notEqual(code, 'timeout');
});

test('static index is served', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /AI Terminal Bridge/);
});

test('bootstrap token can create a static token', async () => {
  const { status, data } = await api('POST', '/api/tokens', { name: 'fixed', scopes: ['exec', 'session'] });
  assert.equal(status, 201);
  assert.equal(data.token.kind, 'static');
  assert.equal(data.token.expiresAt, 0);
  assert.match(data.token.token, /^aitb_[0-9a-f]{48}$/);
});

test('static token is usable and respects scopes', async () => {
  const created = await api('POST', '/api/tokens', { name: 'scoped', scopes: ['exec'] });
  const token = created.data.token.token;

  const ok = await api('POST', '/api/exec', { command: 'echo scoped-ok' }, token);
  assert.equal(ok.status, 200);
  assert.match(ok.data.output, /scoped-ok/);

  const denied = await api('POST', '/api/sessions', {}, token);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.requiredScope, 'session');

  const noAdmin = await api('GET', '/api/tokens', undefined, token);
  assert.equal(noAdmin.status, 403);
});

test('ephemeral token expires and is rejected afterwards', async () => {
  const created = await api('POST', '/api/tokens', { name: 'short', ttlMs: 400, scopes: ['exec'] });
  assert.equal(created.status, 201);
  assert.equal(created.data.token.kind, 'ephemeral');
  assert.ok(created.data.token.expiresAt > Date.now());

  const before = await api('POST', '/api/exec', { command: 'echo alive' }, created.data.token.token);
  assert.equal(before.status, 200);

  await new Promise((r) => setTimeout(r, 600));
  const after = await api('POST', '/api/exec', { command: 'echo alive' }, created.data.token.token);
  assert.equal(after.status, 401);
});

test('token ttl above maximum is rejected', async () => {
  const { status } = await api('POST', '/api/tokens', { name: 'long', ttlMs: 30 * 24 * 60 * 60 * 1000 });
  assert.equal(status, 400);
});

test('token list hides raw values', async () => {
  await api('POST', '/api/tokens', { name: 'masked' });
  const { data } = await api('GET', '/api/tokens');
  for (const t of data.tokens) {
    assert.equal(t.token, undefined);
    assert.ok(t.masked.includes('****'));
  }
});

test('revoking a token invalidates it', async () => {
  const created = await api('POST', '/api/tokens', { name: 'doomed', scopes: ['exec'] });
  const id = created.data.token.id;
  const token = created.data.token.token;

  const removed = await api('DELETE', `/api/tokens/${id}`);
  assert.equal(removed.status, 200);

  const after = await api('POST', '/api/exec', { command: 'echo x' }, token);
  assert.equal(after.status, 401);
});

test('rotate returns a new value and invalidates the old one', async () => {
  const created = await api('POST', '/api/tokens', { name: 'rot', scopes: ['exec'] });
  const id = created.data.token.id;
  const oldToken = created.data.token.token;

  const rotated = await api('POST', `/api/tokens/${id}/rotate`, {});
  assert.equal(rotated.status, 200);
  const newToken = rotated.data.token.token;
  assert.notEqual(newToken, oldToken);

  const oldUse = await api('POST', '/api/exec', { command: 'echo x' }, oldToken);
  assert.equal(oldUse.status, 401);

  const newUse = await api('POST', '/api/exec', { command: 'echo y' }, newToken);
  assert.equal(newUse.status, 200);
});

test('disable and enable toggle a token', async () => {
  const created = await api('POST', '/api/tokens', { name: 'toggle', scopes: ['exec'] });
  const id = created.data.token.id;
  const token = created.data.token.token;

  await api('POST', `/api/tokens/${id}/disable`, {});
  const off = await api('POST', '/api/exec', { command: 'echo x' }, token);
  assert.equal(off.status, 401);

  await api('POST', `/api/tokens/${id}/enable`, {});
  const on = await api('POST', '/api/exec', { command: 'echo y' }, token);
  assert.equal(on.status, 200);
});

test('token verify reports identity and scopes', async () => {
  const created = await api('POST', '/api/tokens', { name: 'whoami', scopes: ['exec'] });
  const token = created.data.token.token;
  const { status, data } = await api('GET', '/api/token/verify', undefined, token);
  assert.equal(status, 200);
  assert.equal(data.token.name, 'whoami');
  assert.deepEqual(data.token.scopes, ['exec']);
  assert.equal(data.token.token, undefined);
});

test('bootstrap token is always admin', async () => {
  const { status, data } = await api('GET', '/api/token/verify');
  assert.equal(status, 200);
  assert.equal(data.token.bootstrap, true);
  assert.ok(data.token.scopes.includes('admin'));
});

async function login(username, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  return { status: res.status, data };
}

test('login with the initial login token forces a password change', async () => {
  const { status, data } = await login('admin', TOKEN);
  assert.equal(status, 200);
  assert.equal(data.mustChangePassword, true);
  assert.ok(data.sessionToken.startsWith('sess_'));
});

test('login rejects wrong password', async () => {
  const { status } = await login('admin', 'definitely-wrong');
  assert.equal(status, 401);
});

test('password change clears the forced flag and new password works', async () => {
  const first = await login('admin', TOKEN);
  assert.equal(first.data.mustChangePassword, true);

  const bad = await fetch(BASE + '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${first.data.sessionToken}` },
    body: JSON.stringify({ username: 'admin', currentPassword: 'nope', newPassword: 'newpass123' }),
  });
  assert.equal(bad.status, 400);

  const weak = await fetch(BASE + '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${first.data.sessionToken}` },
    body: JSON.stringify({ username: 'admin', currentPassword: TOKEN, newPassword: '123' }),
  });
  assert.equal(weak.status, 400);

  const ok = await fetch(BASE + '/api/auth/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${first.data.sessionToken}` },
    body: JSON.stringify({ username: 'admin', currentPassword: TOKEN, newPassword: 'newpass123' }),
  });
  assert.equal(ok.status, 200);

  const me = await fetch(BASE + '/api/auth/me', {
    headers: { authorization: `Bearer ${first.data.sessionToken}` },
  });
  const meData = await me.json();
  assert.equal(meData.account.mustChangePassword, false);

  const again = await login('admin', 'newpass123');
  assert.equal(again.status, 200);
  assert.equal(again.data.mustChangePassword, false);

  const oldPassword = await login('admin', TOKEN);
  assert.equal(oldPassword.status, 401);
});

test('session token grants api access and logout revokes it', async () => {
  const { data } = await login('admin', 'newpass123');
  const session = data.sessionToken;

  const ok = await api('GET', '/api/sessions', undefined, session);
  assert.equal(ok.status, 200);

  const me = await fetch(BASE + '/api/auth/me', { headers: { authorization: `Bearer ${session}` } });
  const meData = await me.json();
  assert.equal(meData.kind, 'session');
  assert.equal(meData.username, 'admin');

  const out = await fetch(BASE + '/api/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(out.status, 200);

  const after = await api('GET', '/api/sessions', undefined, session);
  assert.equal(after.status, 401);
});

test('managed api token still works as a login password', async () => {
  const created = await api('POST', '/api/tokens', { name: 'ui', scopes: ['exec'] });
  const { status, data } = await login('whatever', created.data.token.token);
  assert.equal(status, 200);
  assert.equal(data.mustChangePassword, false);

  const denied = await api('GET', '/api/tokens', undefined, data.sessionToken);
  assert.equal(denied.status, 403);
});

test('same password is allowed on change', async () => {
  const { data } = await login('admin', 'newpass123');
  assert.equal(data.mustChangePassword, false);

  const same = await api('POST', '/api/auth/password', {
    username: 'admin',
    currentPassword: 'newpass123',
    newPassword: 'newpass123',
  }, data.sessionToken);
  assert.equal(same.status, 200);

  const again = await login('admin', 'newpass123');
  assert.equal(again.status, 200);
});

test('token reveal returns the full value', async () => {
  const created = await api('POST', '/api/tokens', { name: 'reveal-me', token: 'aitb_revealtest123' });
  const id = created.data.token.id;
  const r = await api('GET', `/api/tokens/${encodeURIComponent(id)}/reveal`);
  assert.equal(r.status, 200);
  assert.equal(r.data.token.token, 'aitb_revealtest123');
  assert.equal(r.data.token.masked.includes('****'), true);
});

test('audit log records token terminal access', async () => {
  const created = await api('POST', '/api/tokens', { name: 'audited', scopes: ['exec', 'session'] });
  const tok = created.data.token.token;

  await api('POST', '/api/exec', { command: 'echo audit-check' }, tok);
  await new Promise((r) => setTimeout(r, 200));

  const list = await api('GET', '/api/audit?limit=100');
  assert.equal(list.status, 200);
  assert.equal(list.data.info.count > 0, true);
  const kinds = list.data.events.map((e) => e.kind);
  assert.equal(kinds.includes('api'), true);

  const denied = await fetch(BASE + '/api/audit');
  assert.equal(denied.status, 401);

  const pruned = await api('DELETE', '/api/audit');
  assert.equal(pruned.status, 200);
  assert.equal(typeof pruned.data.removed, 'number');
});

test('session exec returns real exit code and clean output', async () => {
  const created = await api('POST', '/api/sessions', { name: 'exec-test' });
  const sid = created.data.session.id;

  const ok = await api('POST', `/api/sessions/${sid}/exec`, { command: 'echo SENTINEL_OK' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.exitCode, 0);
  assert.equal(ok.data.truncated, false);
  assert.equal(ok.data.output.includes('SENTINEL_OK'), true);
  assert.equal(ok.data.output.includes('echo SENTINEL_OK'), false);

  const bad = await api('POST', `/api/sessions/${sid}/exec`, { command: 'false' });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.exitCode, 1);

  const slow = await api('POST', `/api/sessions/${sid}/exec`, {
    command: 'echo INNER_A; sleep 2; echo INNER_B',
    timeoutMs: 20000,
  });
  assert.equal(slow.status, 200);
  assert.equal(slow.data.exitCode, 0);
  assert.equal(slow.data.truncated, false);
  assert.equal(slow.data.output.includes('INNER_A'), true);
  assert.equal(slow.data.output.includes('INNER_B'), true);

  assert.equal(slow.data.output.includes('\x1b'), false, 'ansi leaked');
  assert.equal(slow.data.output.includes('\r'), false, 'CR leaked');

  const dup = await api('POST', `/api/sessions/${sid}/exec`, {
    command: 'echo IDEMPOTENT_CHECK',
    requestId: 'req-test-001',
  });
  assert.equal(dup.status, 200);
  const replay = await api('POST', `/api/sessions/${sid}/exec`, {
    command: 'echo IDEMPOTENT_CHECK',
    requestId: 'req-test-001',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.cached, true);
  assert.deepEqual(replay.data.output, dup.data.output);

  await api('DELETE', `/api/sessions/${sid}`);
});

test('exec sessions are ephemeral and purgeable', async () => {
  const r = await api('POST', '/api/exec', { command: 'echo ephemeral-check' });
  assert.equal(r.status, 200);
  assert.equal(r.data.exitCode, 0);
  assert.equal(r.data.truncated, false);

  const purge = await api('POST', '/api/sessions/purge?ephemeral=1');
  assert.equal(purge.status, 200);
  assert.equal(Array.isArray(purge.data.removed), true);

  const list = await api('GET', '/api/sessions');
  assert.equal(list.data.sessions.some((s) => s.ephemeral), false);
});

test('closed sessions reopen with history and cwd', async () => {
  const created = await api('POST', '/api/sessions', { name: 'reopen-me', cwd: '/tmp' });
  assert.equal(created.status, 201);
  const sid = created.data.session.id;

  await api('POST', `/api/sessions/${sid}/input`, { data: 'echo MARKER_BEFORE_CLOSE\r' });
  await new Promise((r) => setTimeout(r, 300));

  await api('POST', `/api/sessions/${sid}/kill`);
  let dead = false;
  for (let i = 0; i < 20 && !dead; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const info = await api('GET', `/api/sessions/${sid}`);
    dead = info.data.session.alive === false;
  }
  assert.equal(dead, true);

  const again = await api('POST', '/api/sessions', { name: 'reopen-me' });
  assert.equal(again.status, 200);
  assert.equal(again.data.reused, true);
  assert.equal(again.data.session.id, sid);
  assert.equal(again.data.session.alive, true);

  const snap = await api('GET', `/api/sessions/${sid}?strip=1`);
  assert.equal(snap.status, 200);
  assert.equal(snap.data.session.data.includes('MARKER_BEFORE_CLOSE'), true);
  assert.equal(snap.data.session.cwd, '/tmp');

  const list = await api('GET', '/api/sessions');
  assert.equal(list.data.sessions.some((s) => s.id === sid), true);

  await api('DELETE', `/api/sessions/${sid}`);
});

test('ws upgrade with invalid token returns 401 json', async () => {
  await new Promise((resolve, reject) => {
    const req = http.request(`${BASE}/ws?token=aitb_bogus_token`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    });
    req.on('upgrade', () => reject(new Error('should not upgrade')));
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 401);
          assert.equal(JSON.parse(body).error, 'invalid_token');
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
});

test('named sessions are reused and http operators are visible', async () => {
  const tok = await api('POST', '/api/tokens', { name: 'op-worker', scopes: ['exec', 'session'] });
  const tokVal = tok.data.token.token;

  const first = await api('POST', '/api/sessions', { name: 'ai-work' });
  assert.equal(first.status, 201);
  const sid = first.data.session.id;

  const again = await api('POST', '/api/sessions', { name: 'ai-work' });
  assert.equal(again.status, 200);
  assert.equal(again.data.reused, true);
  assert.equal(again.data.session.id, sid);

  await api('POST', `/api/sessions/${sid}/input`, { data: 'echo operator-check\n' }, tokVal);
  const list = await api('GET', '/api/sessions');
  const target = list.data.sessions.find((s) => s.id === sid);
  assert.equal(target.viewers.some((v) => v.startsWith('op-worker')), true);
  assert.equal(target.lastOperator && target.lastOperator.startsWith('op-worker'), true);
  assert.equal(target.lastOperatorAt > 0, true);

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?token=${tokVal}&name=ai-work`);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'snapshot') {
        try {
          assert.equal(msg.session.id, sid);
          ws.close();
          resolve();
        } catch (err) {
          ws.close();
          reject(err);
        }
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws name attach timeout')), 5000);
  });

  await api('DELETE', `/api/sessions/${sid}`);
});
