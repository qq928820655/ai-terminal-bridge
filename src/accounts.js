'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 32).toString('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class AccountStore {
  constructor({ file, seedUser, seedPassword, now = () => Date.now() }) {
    this.file = file;
    this.accounts = [];
    this.sessions = new Map();
    this.now = now;
    this.load();
    this.seed(seedUser, seedPassword);
    this._timer = setInterval(() => this.cleanupSessions(), 60 * 1000);
    this._timer.unref();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    } catch {
      this.accounts = [];
    }
  }

  save() {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, accounts: this.accounts }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  seed(username, password) {
    if (this.accounts.length > 0) return;
    if (!username || !password) return;
    this.create(username, password, { mustChange: true });
  }

  create(username, password, options = {}) {
    const salt = crypto.randomBytes(16).toString('hex');
    const account = {
      username: String(username).slice(0, 64),
      salt,
      passwordHash: hashPassword(password, salt),
      mustChange: options.mustChange !== false,
      createdAt: this.now(),
      lastLoginAt: null,
    };
    this.accounts.push(account);
    this.save();
    return account;
  }

  find(username) {
    return this.accounts.find((a) => a.username === username) || null;
  }

  verify(username, password) {
    const account = this.find(username);
    if (!account) return null;
    const candidate = hashPassword(password, account.salt);
    if (!safeEqual(candidate, account.passwordHash)) return null;
    return account;
  }

  issueSession(username, scopes, display) {
    const token = 'sess_' + crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, {
      username,
      scopes: Array.isArray(scopes) && scopes.length ? scopes.slice() : ['exec', 'session', 'admin'],
      display: display || '',
      expiresAt: this.now() + SESSION_TTL_MS,
    });
    return token;
  }

  verifySession(token) {
    if (!token) return null;
    const entry = this.sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return { ...entry };
  }

  revokeSession(token) {
    return this.sessions.delete(token);
  }

  cleanupSessions() {
    const now = this.now();
    for (const [token, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(token);
    }
  }

  setPassword(username, currentPassword, newPassword) {
    const account = this.verify(username, currentPassword);
    if (!account) {
      return { ok: false, error: 'current password is wrong' };
    }
    const next = String(newPassword === undefined || newPassword === null ? '' : newPassword);
    if (next.length < 6 || next.length > 128) {
      return { ok: false, error: 'new password must be 6-128 characters' };
    }
    account.salt = crypto.randomBytes(16).toString('hex');
    account.passwordHash = hashPassword(next, account.salt);
    account.mustChange = false;
    this.save();
    return { ok: true };
  }

  publicAccount(account) {
    if (!account) return null;
    return {
      username: account.username,
      mustChangePassword: Boolean(account.mustChange),
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
    };
  }
}

module.exports = { AccountStore, hashPassword };
