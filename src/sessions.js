'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const path = require('node:path');

const WORKER = path.join(__dirname, '..', 'bin', 'pty_worker.py');
const PYTHON = process.env.AITB_PYTHON || 'python3';
const MAX_BUFFER = 2 * 1024 * 1024;

const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  ].join('|'),
  'g'
);

function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '').replace(/\r(?!\n)/g, '');
}

function randomId(prefix) {
  return `${prefix}${crypto.randomBytes(6).toString('hex')}`;
}

class Session extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id;
    this.name = options.name || options.id;
    this.cwd = options.cwd;
    this.shell = options.shell;
    this.cols = options.cols;
    this.rows = options.rows;
    this.argv = options.argv || null;
    this.ephemeral = Boolean(options.ephemeral);
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.alive = true;
    this.buffer = '';
    this.totalBytes = 0;
    this.trimmedChars = 0;
    this._stdoutPending = '';
    this._start();
  }

  _start() {
    this.proc = spawn(PYTHON, ['-u', WORKER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AITB_SHELL: this.shell,
        AITB_CWD: this.cwd,
        AITB_COLS: String(this.cols),
        AITB_ROWS: String(this.rows),
        ...(this.argv ? { AITB_ARGV: JSON.stringify(this.argv) } : {}),
      },
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this._stdoutPending += chunk;
      let idx;
      while ((idx = this._stdoutPending.indexOf('\n')) >= 0) {
        const line = this._stdoutPending.slice(0, idx);
        this._stdoutPending = this._stdoutPending.slice(idx + 1);
        if (!line.trim()) continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        this._handleFrame(frame);
      }
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => this.emit('error', chunk.toString()));

    this.proc.on('exit', (code) => {
      if (this.exitCode === null) this.exitCode = code === null ? -1 : code;
      this.alive = false;
      this.emit('exit', this.exitCode);
    });

    this.proc.on('error', (err) => {
      this.emit('error', String(err && err.message));
      this.alive = false;
      this.emit('exit', -1);
    });
  }

  _handleFrame(frame) {
    if (frame.t === 'o') {
      const data = Buffer.from(frame.d || '', 'base64').toString('utf8');
      this._append(data);
      this.emit('data', data);
      this.lastActivity = Date.now();
    } else if (frame.t === 'x') {
      this.exitCode = frame.c;
      this.alive = false;
      this.emit('exit', frame.c);
    } else if (frame.t === 'e') {
      this.emit('error', frame.m || 'worker error');
    }
  }

  _append(data) {
    this.buffer += data;
    this.totalBytes += Buffer.byteLength(data);
    this.lastActivity = Date.now();
    if (this.buffer.length > MAX_BUFFER) {
      const drop = this.buffer.length - MAX_BUFFER;
      this.buffer = this.buffer.slice(drop);
      this.trimmedChars += drop;
    }
  }

  write(data) {
    if (!this.alive) return false;
    this._send({ t: 'i', d: Buffer.from(data, 'utf8').toString('base64') });
    this.lastActivity = Date.now();
    return true;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.alive) this._send({ t: 'r', c: cols, r: rows });
  }

  _send(frame) {
    try {
      this.proc.stdin.write(JSON.stringify(frame) + '\n');
    } catch {
      /* worker gone */
    }
  }

  kill(signal = 'SIGTERM') {
    if (!this.alive) return;
    this._send({ t: 'k' });
    const proc = this.proc;
    setTimeout(() => {
      if (!this.alive && proc) return;
      try {
        proc.kill(signal);
      } catch {
        /* already gone */
      }
    }, 400).unref();
  }

  snapshot(fromOffset = 0, options = {}) {
    const cleaned = options.strip ? stripAnsi(this.buffer) : this.buffer;
    const start = Math.max(0, Math.min(fromOffset, cleaned.length));
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      offset: cleaned.length,
      data: cleaned.slice(start),
    };
  }

  info() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      offset: this.buffer.length,
      bytes: this.totalBytes,
      ephemeral: this.ephemeral,
    };
  }
}

class SessionManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.maxSessions = options.maxSessions || 8;
    this.defaultShell = options.shell || '/bin/bash';
    this.defaultCwd = options.cwd || process.cwd();
    this.idleMs = options.idleMs || 30 * 60 * 1000;
    this._sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this._sweeper.unref();
  }

  sweep() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.alive && now - session.lastActivity > this.idleMs) {
        session.kill();
      }
    }
  }

  create(options = {}) {
    const alive = [...this.sessions.values()].filter((s) => s.alive);
    if (alive.length >= this.maxSessions) {
      const err = new Error(`session limit reached (${this.maxSessions})`);
      err.status = 429;
      throw err;
    }
    const id = options.id || randomId('s');
    if (this.sessions.has(id)) {
      const err = new Error('session id already exists');
      err.status = 409;
      throw err;
    }
    const session = new Session({
      id,
      name: options.name,
      cwd: options.cwd || this.defaultCwd,
      shell: options.shell || this.defaultShell,
      cols: Number(options.cols) || 120,
      rows: Number(options.rows) || 32,
      argv: Array.isArray(options.argv) && options.argv.length ? options.argv : null,
      ephemeral: options.ephemeral,
    });
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  getByName(name) {
    if (!name) return null;
    for (const s of this.sessions.values()) {
      if (s.name === name && s.alive) return s;
    }
    return null;
  }

  removeDeadByName(name) {
    if (!name) return;
    for (const [id, s] of this.sessions) {
      if (s.name === name && !s.alive) this.sessions.delete(id);
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  remove(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.alive) session.kill('SIGKILL');
    this.sessions.delete(id);
    return true;
  }

  removeAll() {
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }
}

module.exports = { Session, SessionManager, stripAnsi, randomId };
