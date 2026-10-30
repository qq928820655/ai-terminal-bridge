#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_DIR = process.env.AITB_STATE_DIR || path.join(os.homedir(), '.ai-terminal-bridge');

function readToken() {
  if (process.env.AITB_TOKEN) return process.env.AITB_TOKEN.trim();
  try {
    return fs.readFileSync(path.join(STATE_DIR, 'token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function baseUrl() {
  if (process.env.AITB_URL) return process.env.AITB_URL.replace(/\/+$/, '');
  const host = process.env.AITB_HOST === '0.0.0.0' ? '127.0.0.1' : process.env.AITB_HOST || '127.0.0.1';
  const port = process.env.AITB_PORT || '8787';
  return `http://${host}:${port}`;
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl() + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: {
          authorization: `Bearer ${readToken()}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          if (res.statusCode >= 400) {
            const err = new Error(data.error || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            err.data = data;
            reject(err);
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function flag(args, name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1] !== undefined) return args[idx + 1];
  return fallback;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function nonFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

const USAGE = `ai-terminal-bridge cli

usage:
  aitb exec "<command>" [--cwd DIR] [--timeout MS] [--quiet MS] [--keep] [--json]
  aitb new [--cwd DIR] [--name NAME] [--cols N] [--rows N]
  aitb ls [--json]
  aitb sh <sessionId> "<command>" [--timeout MS] [--wait MS] [--wait-exit]
  aitb tail <sessionId> [--offset N] [--json]
  aitb input <sessionId> "<data>"
  aitb kill <sessionId>
  aitb rm <sessionId>
  aitb health

  aitb token new [--name NAME] [--ttl 30m|2h|7d|3600] [--scopes exec,session] [--value TOKEN]
  aitb token ls [--json]
  aitb token rm <tokenId>
  aitb token rotate <tokenId>
  aitb token rename <tokenId> <name>
  aitb token setvalue <tokenId> <newValue>
  aitb token disable <tokenId>
  aitb token enable <tokenId>
  aitb token verify [--token TOKEN]

env:
  AITB_URL    base url, default http://127.0.0.1:8787
  AITB_TOKEN  token, default read from ~/.ai-terminal-bridge/token
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = argv.slice(1);

  if (!cmd || hasFlag(args, 'help') || cmd === 'help' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (cmd === 'health') {
    const data = await request('GET', '/api/health');
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'exec') {
    const command = nonFlags(args).join(' ');
    if (!command) throw new Error('command required');
    const data = await request('POST', '/api/exec', {
      command,
      cwd: flag(args, 'cwd'),
      timeoutMs: flag(args, 'timeout') ? Number(flag(args, 'timeout')) : undefined,
      quietMs: flag(args, 'quiet') ? Number(flag(args, 'quiet')) : undefined,
      keep: hasFlag(args, 'keep'),
    });
    if (hasFlag(args, 'json')) {
      console.log(JSON.stringify(data, null, 2));
    } else if (data.output !== undefined) {
      process.stdout.write(data.output);
      if (data.exitCode !== null && data.exitCode !== undefined) process.stderr.write(`\n[exit ${data.exitCode}]\n`);
      if (data.sessionId) process.stderr.write(`[session ${data.sessionId}]\n`);
    }
    if (data.exitCode) process.exitCode = data.exitCode;
    return;
  }

  if (cmd === 'new') {
    const data = await request('POST', '/api/sessions', {
      cwd: flag(args, 'cwd'),
      name: flag(args, 'name'),
      cols: flag(args, 'cols') ? Number(flag(args, 'cols')) : undefined,
      rows: flag(args, 'rows') ? Number(flag(args, 'rows')) : undefined,
    });
    console.log(JSON.stringify(data.session, null, 2));
    return;
  }

  if (cmd === 'ls') {
    const data = await request('GET', '/api/sessions');
    if (hasFlag(args, 'json')) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }
    for (const s of data.sessions) {
      console.log(`${s.id}\t${s.alive ? 'alive' : 'dead'}\t${s.cwd}\t${s.name}`);
    }
    return;
  }

  if (cmd === 'sh') {
    const [id, ...rest] = nonFlags(args);
    const command = rest.join(' ');
    if (!id || !command) throw new Error('usage: aitb sh <sessionId> "<command>"');
    const data = await request('POST', `/api/sessions/${encodeURIComponent(id)}/exec`, {
      command,
      timeoutMs: flag(args, 'timeout') ? Number(flag(args, 'timeout')) : undefined,
      waitMs: flag(args, 'wait') ? Number(flag(args, 'wait')) : undefined,
      waitExit: hasFlag(args, 'wait-exit'),
    });
    process.stdout.write(data.output || '');
    if (data.exitCode !== null && data.exitCode !== undefined) process.stderr.write(`\n[exit ${data.exitCode}]\n`);
    return;
  }

  if (cmd === 'tail') {
    const [id] = nonFlags(args);
    if (!id) throw new Error('usage: aitb tail <sessionId>');
    const offset = flag(args, 'offset', '0');
    const data = await request('GET', `/api/sessions/${encodeURIComponent(id)}?offset=${encodeURIComponent(offset)}`);
    if (hasFlag(args, 'json')) {
      console.log(JSON.stringify(data.session, null, 2));
    } else {
      process.stdout.write(data.session.data);
    }
    return;
  }

  if (cmd === 'input') {
    const [id, ...rest] = nonFlags(args);
    const data = rest.join(' ');
    if (!id || !data) throw new Error('usage: aitb input <sessionId> "<data>"');
    const out = await request('POST', `/api/sessions/${encodeURIComponent(id)}/input`, { data });
    console.log(JSON.stringify(out));
    return;
  }

  if (cmd === 'kill') {
    const [id] = nonFlags(args);
    if (!id) throw new Error('usage: aitb kill <sessionId>');
    const out = await request('POST', `/api/sessions/${encodeURIComponent(id)}/kill`, {});
    console.log(JSON.stringify(out));
    return;
  }

  if (cmd === 'rm') {
    const [id] = nonFlags(args);
    if (!id) throw new Error('usage: aitb rm <sessionId>');
    const out = await request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
    console.log(JSON.stringify(out));
    return;
  }

  if (cmd === 'token') {
    const sub = args[0];
    const rest = args.slice(1);

    const parseTtl = (raw) => {
      if (raw === undefined) return undefined;
      const text = String(raw).trim().toLowerCase();
      if (/^\d+$/.test(text)) return Number(text) * 1000;
      const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/);
      if (!match) throw new Error(`invalid ttl: ${raw} (use 90s, 30m, 2h, 7d or seconds)`);
      const factors = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
      return Math.round(Number(match[1]) * factors[match[2]]);
    };

    if (sub === 'new' || sub === 'create') {
      const ttlMs = parseTtl(flag(rest, 'ttl'));
      const scopes = flag(rest, 'scopes');
      const data = await request('POST', '/api/tokens', {
        name: flag(rest, 'name'),
        ttlMs,
        scopes: scopes ? scopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        token: flag(rest, 'value'),
      });
      const token = data.token;
      if (hasFlag(rest, 'json')) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(`id:      ${token.id}`);
        console.log(`name:    ${token.name}`);
        console.log(`kind:    ${token.kind}`);
        console.log(`scopes:  ${token.scopes.join(',')}`);
        if (token.expiresAt) console.log(`expires: ${new Date(token.expiresAt).toISOString()}`);
        else console.log('expires: never');
        console.log(`token:   ${token.token}`);
        console.log('');
        console.log('保存这一行，之后不会再显示完整值。');
      }
      return;
    }

    if (sub === 'ls' || sub === 'list') {
      const data = await request('GET', '/api/tokens');
      if (hasFlag(rest, 'json')) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (!data.tokens.length) {
        console.log('(no managed tokens)');
        return;
      }
      for (const t of data.tokens) {
        const exp = t.expiresAt ? `${Math.round(t.expiresInMs / 1000)}s left` : 'never';
        console.log(`${t.id}\t${t.enabled ? 'on' : 'off'}\t${t.kind}\t${exp}\t${t.scopes.join(',')}\t${t.masked}\t${t.name}`);
      }
      return;
    }

    if (sub === 'rm' || sub === 'delete' || sub === 'revoke') {
      const id = rest.find((a) => !a.startsWith('--'));
      if (!id) throw new Error('usage: aitb token rm <tokenId>');
      const data = await request('DELETE', `/api/tokens/${encodeURIComponent(id)}`);
      console.log(JSON.stringify(data));
      return;
    }

    if (sub === 'rotate') {
      const id = rest.find((a) => !a.startsWith('--'));
      if (!id) throw new Error('usage: aitb token rotate <tokenId>');
      const data = await request('POST', `/api/tokens/${encodeURIComponent(id)}/rotate`, {});
      console.log(`id:    ${data.token.id}`);
      console.log(`token: ${data.token.token}`);
      return;
    }

    if (sub === 'rename') {
      const positional = rest.filter((a) => !a.startsWith('--') && (rest.indexOf(a) === 0 || rest[rest.indexOf(a) - 1] !== '--name'));
      const id = positional[0];
      const name = positional.slice(1).join(' ');
      if (!id || !name) throw new Error('usage: aitb token rename <tokenId> <name>');
      const data = await request('POST', `/api/tokens/${encodeURIComponent(id)}/rename`, { name });
      console.log(`id:   ${data.token.id}`);
      console.log(`name: ${data.token.name}`);
      return;
    }

    if (sub === 'setvalue') {
      const positional = rest.filter((a) => !a.startsWith('--'));
      const id = positional[0];
      const value = positional[1];
      if (!id || !value) throw new Error('usage: aitb token setvalue <tokenId> <newValue>');
      const data = await request('POST', `/api/tokens/${encodeURIComponent(id)}/value`, { token: value });
      console.log(`id:    ${data.token.id}`);
      console.log(`token: ${data.token.token}`);
      return;
    }

    if (sub === 'disable' || sub === 'enable') {
      const id = rest.find((a) => !a.startsWith('--'));
      if (!id) throw new Error(`usage: aitb token ${sub} <tokenId>`);
      const data = await request('POST', `/api/tokens/${encodeURIComponent(id)}/${sub}`, {});
      console.log(JSON.stringify(data.token));
      return;
    }

    if (sub === 'verify') {
      const probe = flag(rest, 'token') || readToken();
      const data = await new Promise((resolve, reject) => {
        const url = new URL(baseUrl() + '/api/token/verify');
        const req = http.request(url, { method: 'GET', headers: { authorization: `Bearer ${probe}` } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body;
            try {
              body = text ? JSON.parse(text) : {};
            } catch {
              body = { raw: text };
            }
            if (res.statusCode >= 400) return reject(new Error(body.error || `HTTP ${res.statusCode}`));
            resolve(body);
          });
        });
        req.on('error', reject);
        req.end();
      });
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    throw new Error(`unknown token subcommand: ${sub || '(none)'}`);
  }

  throw new Error(`unknown command: ${cmd}`);
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  if (err.status === 401) process.stderr.write('hint: token mismatch, see ~/.ai-terminal-bridge/token\n');
  process.exit(1);
});
