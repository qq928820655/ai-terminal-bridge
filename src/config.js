'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const STATE_DIR = process.env.AITB_STATE_DIR || path.join(os.homedir(), '.ai-terminal-bridge');

function resolveToken() {
  if (process.env.AITB_TOKEN) return process.env.AITB_TOKEN.trim();
  const tokenFile = path.join(STATE_DIR, 'token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const token = 'admin';
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  return token;
}

function load(envFile = path.join(__dirname, '..', '.env')) {
  loadDotEnv(envFile);
  const int = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const tokensFile = process.env.AITB_TOKENS_FILE || path.join(STATE_DIR, 'tokens.json');
  const accountsFile = process.env.AITB_ACCOUNTS_FILE || path.join(STATE_DIR, 'accounts.json');
  const auditMaxAgeDays = int(process.env.AITB_AUDIT_MAX_AGE_DAYS, 30);
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const connIdleKillMs = num(process.env.AITB_CONN_IDLE_KILL_MS, 60 * 60 * 1000);
  const connIdlePurgeMs = num(process.env.AITB_CONN_PURGE_MS, 3 * 24 * 60 * 60 * 1000);
  const connSweepMs = num(process.env.AITB_CONN_SWEEP_MS, 60 * 1000);
  return {
    host: process.env.AITB_HOST || '127.0.0.1',
    port: int(process.env.AITB_PORT, 8787),
    token: resolveToken(),
    tokensFile,
    accountsFile,
    auditFile: process.env.AITB_AUDIT_FILE || path.join(STATE_DIR, 'audit.json'),
    auditMaxAgeMs: auditMaxAgeDays * 24 * 60 * 60 * 1000,
    auditMaxAgeDays,
    connIdleKillMs,
    connIdlePurgeMs,
    connSweepMs,
    loginUser: process.env.AITB_LOGIN_USER || 'admin',
    shell: process.env.AITB_SHELL || '/bin/bash',
    cwd: process.env.AITB_CWD || process.cwd(),
    maxSessions: int(process.env.AITB_MAX_SESSIONS, 8),
    sessionIdleMs: int(process.env.AITB_SESSION_IDLE_MS, 30 * 60 * 1000),
    defaultTtlMs: int(process.env.AITB_DEFAULT_TTL_MS, 60 * 60 * 1000),
    maxTtlMs: int(process.env.AITB_MAX_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    cors: process.env.AITB_CORS === undefined ? '*' : process.env.AITB_CORS,
    stateDir: STATE_DIR,
    tokenFile: path.join(STATE_DIR, 'token'),
  };
}

module.exports = { load, loadDotEnv, STATE_DIR };
