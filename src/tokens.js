'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ALL_SCOPES = ['exec', 'session', 'admin'];
const DEFAULT_SCOPES = ['exec', 'session'];

function generateToken() {
  return 'aitb_' + crypto.randomBytes(24).toString('hex');
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 16) return token.slice(0, 4) + '****';
  return token.slice(0, 9) + '****' + token.slice(-4);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return DEFAULT_SCOPES.slice();
  const picked = scopes.filter((s) => ALL_SCOPES.includes(s));
  return picked.length ? Array.from(new Set(picked)) : DEFAULT_SCOPES.slice();
}

function validateTokenValue(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (text.length < 8 || text.length > 128) return null;
  if (/[\s\x00-\x1f\x7f]/.test(text)) return null;
  return text;
}

class TokenStore {
  constructor({ file, bootstrap, now = () => Date.now() }) {
    this.file = file;
    this.bootstrap = bootstrap || '';
    this.now = now;
    this.entries = [];
    this._dirty = false;
    this.load();
    this._timer = setInterval(() => this.flush(), 60 * 1000);
    this._timer.unref();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.entries = Array.isArray(data.tokens) ? data.tokens : [];
    } catch {
      this.entries = [];
    }
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tokens: this.entries }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  prune() {
    const now = this.now();
    const kept = this.entries.filter((e) => !e.expiresAt || e.expiresAt > now);
    if (kept.length !== this.entries.length) {
      this.entries = kept;
      this._dirty = true;
      this.flush();
    }
  }

  bootstrapEntry() {
    return {
      id: 'bootstrap',
      name: 'bootstrap (AITB_TOKEN)',
      token: this.bootstrap,
      kind: 'static',
      scopes: ALL_SCOPES.slice(),
      createdAt: null,
      expiresAt: 0,
      lastUsedAt: null,
      enabled: true,
      bootstrap: true,
    };
  }

  verify(token) {
    if (!token) return null;
    if (this.bootstrap && safeEqual(token, this.bootstrap)) {
      return this.bootstrapEntry();
    }
    return this.verifyManaged(token);
  }

  verifyManaged(token) {
    if (!token) return null;
    this.prune();
    const found = this.entries.find((e) => e.enabled && safeEqual(e.token, token));
    if (!found) return null;
    if (found.expiresAt && found.expiresAt <= this.now()) return null;
    found.lastUsedAt = this.now();
    this._dirty = true;
    return { ...found, scopes: found.scopes.slice() };
  }

  _assertValueAvailable(rawValue) {
    const value = validateTokenValue(rawValue);
    if (!value) {
      throw Object.assign(
        new Error('invalid token value: 8-128 chars, no whitespace or control characters'),
        { status: 400 }
      );
    }
    if (this.bootstrap && safeEqual(value, this.bootstrap)) {
      throw Object.assign(new Error('token value collides with the bootstrap token'), { status: 409 });
    }
    if (this.entries.some((e) => safeEqual(e.token, value))) {
      throw Object.assign(new Error('token value already exists'), { status: 409 });
    }
    return value;
  }

  create(options = {}) {
    const now = this.now();
    let expiresAt = 0;
    if (options.expiresAt) {
      expiresAt = Number(options.expiresAt);
    } else if (options.ttlMs) {
      expiresAt = now + Number(options.ttlMs);
    }
    const kind = expiresAt ? 'ephemeral' : 'static';
    const entry = {
      id: 'tok_' + crypto.randomBytes(8).toString('hex'),
      name: String(options.name || (kind === 'ephemeral' ? 'ephemeral' : 'static')).slice(0, 64),
      token: options.token ? this._assertValueAvailable(options.token) : generateToken(),
      kind,
      scopes: sanitizeScopes(options.scopes),
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      enabled: true,
    };
    this.entries.push(entry);
    this._dirty = true;
    this.flush();
    return { ...entry, scopes: entry.scopes.slice() };
  }

  list() {
    this.prune();
    const now = this.now();
    return this.entries.map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind,
      scopes: e.scopes.slice(),
      masked: maskToken(e.token),
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      expiresInMs: e.expiresAt ? Math.max(0, e.expiresAt - now) : null,
      lastUsedAt: e.lastUsedAt,
      enabled: e.enabled,
    }));
  }

  revoke(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    this.entries.splice(idx, 1);
    this._dirty = true;
    this.flush();
    return true;
  }

  rotate(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.token = generateToken();
    this._dirty = true;
    this.flush();
    return { ...entry, scopes: entry.scopes.slice() };
  }

  reveal(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    return { ...entry, scopes: entry.scopes.slice() };
  }

  rename(id, name) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    const next = String(name === undefined || name === null ? '' : name).trim();
    if (!next) return null;
    entry.name = next.slice(0, 64);
    this._dirty = true;
    this.flush();
    return { ...entry, scopes: entry.scopes.slice() };
  }

  setValue(id, rawValue) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.token = this._assertValueAvailable(rawValue);
    this._dirty = true;
    this.flush();
    return { ...entry, scopes: entry.scopes.slice() };
  }

  setEnabled(id, enabled) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return null;
    entry.enabled = Boolean(enabled);
    this._dirty = true;
    this.flush();
    return { ...entry, scopes: entry.scopes.slice() };
  }
}

function hasScope(entry, scope) {
  if (!entry) return false;
  if (entry.scopes.includes('admin')) return true;
  return entry.scopes.includes(scope);
}

function publicToken(entry, { reveal = false } = {}) {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
    scopes: entry.scopes,
    token: reveal ? entry.token : undefined,
    masked: maskToken(entry.token),
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    lastUsedAt: entry.lastUsedAt,
    enabled: entry.enabled,
    bootstrap: Boolean(entry.bootstrap),
  };
}

module.exports = {
  TokenStore,
  ALL_SCOPES,
  DEFAULT_SCOPES,
  generateToken,
  maskToken,
  safeEqual,
  hasScope,
  publicToken,
  validateTokenValue,
};
