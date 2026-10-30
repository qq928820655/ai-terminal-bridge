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
  return `http://${host}:${process.env.AITB_PORT || '8787'}`;
}

function call(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl() + apiPath);
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
          if (res.statusCode >= 400) return reject(new Error(data.error || `HTTP ${res.statusCode}`));
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

const TOOLS = [
  {
    name: 'terminal_exec',
    description:
      'Run a shell command on the host through a pseudo terminal and return its output. A fresh terminal is created per call unless session_id is given.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command line to run.' },
        session_id: { type: 'string', description: 'Reuse an existing terminal session instead of a fresh one.' },
        cwd: { type: 'string', description: 'Working directory for a new session.' },
        timeout_ms: { type: 'number', description: 'Max wait in ms. Default 15000, max 120000.' },
        quiet_ms: { type: 'number', description: 'Stop waiting after this many ms without new output. Default 350.' },
        keep: { type: 'boolean', description: 'Keep the session alive after the command finishes.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'terminal_new',
    description: 'Create a persistent interactive terminal session and return its id.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Working directory.' },
        name: { type: 'string', description: 'Human readable label.' },
        cols: { type: 'number' },
        rows: { type: 'number' },
      },
    },
  },
  {
    name: 'terminal_list',
    description: 'List all terminal sessions with alive state, working directory and byte counters.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'terminal_send',
    description: 'Send raw input to a session. Use trailing \\n or \\r to submit a command line.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        data: { type: 'string', description: 'Raw text to write to the pty.' },
        wait_ms: { type: 'number', description: 'Wait this long and return the produced output.' },
        timeout_ms: { type: 'number' },
        quiet_ms: { type: 'number' },
      },
      required: ['session_id', 'data'],
    },
  },
  {
    name: 'terminal_read',
    description: 'Read buffered output from a session, optionally starting at a byte offset.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        offset: { type: 'number', description: 'Start offset in the session buffer. Default 0.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'terminal_kill',
    description: 'Terminate the shell process of a session (session record stays until removed).',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'terminal_remove',
    description: 'Kill and delete a session.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
];

function text(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

async function runTool(name, args) {
  if (name === 'terminal_exec') {
    if (args.session_id) {
      const data = await call('POST', `/api/sessions/${encodeURIComponent(args.session_id)}/exec`, {
        command: args.command,
        timeoutMs: args.timeout_ms,
        quietMs: args.quiet_ms,
      });
      return text({ session_id: args.session_id, exit_code: data.exitCode, output: data.output });
    }
    const data = await call('POST', '/api/exec', {
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeout_ms,
      quietMs: args.quiet_ms,
      keep: Boolean(args.keep),
    });
    return text({
      session_id: data.sessionId || null,
      exit_code: data.exitCode,
      output: data.output,
    });
  }
  if (name === 'terminal_new') {
    const data = await call('POST', '/api/sessions', {
      cwd: args.cwd,
      name: args.name,
      cols: args.cols,
      rows: args.rows,
    });
    return text(data.session);
  }
  if (name === 'terminal_list') {
    const data = await call('GET', '/api/sessions');
    return text(data.sessions);
  }
  if (name === 'terminal_send') {
    const data = await call('POST', `/api/sessions/${encodeURIComponent(args.session_id)}/exec`, {
      command: args.data.endsWith('\n') ? args.data : args.data + '\n',
      waitMs: args.wait_ms,
      timeoutMs: args.timeout_ms,
      quietMs: args.quiet_ms,
    });
    return text({ session_id: args.session_id, alive: data.alive, output: data.output });
  }
  if (name === 'terminal_read') {
    const offset = Number(args.offset) || 0;
    const data = await call('GET', `/api/sessions/${encodeURIComponent(args.session_id)}?offset=${offset}`);
    return text({ session_id: args.session_id, offset: data.session.offset, data: data.session.data });
  }
  if (name === 'terminal_kill') {
    const data = await call('POST', `/api/sessions/${encodeURIComponent(args.session_id)}/kill`, {});
    return text(data);
  }
  if (name === 'terminal_remove') {
    const data = await call('DELETE', `/api/sessions/${encodeURIComponent(args.session_id)}`);
    return text(data);
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const serverInfo = { name: 'ai-terminal-bridge', version: '1.0.0' };

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo,
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await runTool(name, args);
      reply(id, result);
    } catch (err) {
      reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
    return;
  }
  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg).catch((err) => {
      if (msg.id !== undefined) replyError(msg.id, -32603, err.message);
    });
  }
});
process.stdin.on('end', () => process.exit(0));
