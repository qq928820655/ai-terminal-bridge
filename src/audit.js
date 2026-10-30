'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 5000;

class AuditLog {
  constructor({ file, maxAgeMs = 30 * 24 * 60 * 60 * 1000, maxEntries = MAX_ENTRIES, now = () => Date.now() }) {
    this.file = file;
    this.maxAgeMs = maxAgeMs;
    this.maxEntries = maxEntries;
    this.events = [];
    this._dirty = false;
    this.now = now;
    this.load();
    this.prune();
    this._timer = setInterval(() => {
      this.prune();
      this.flush();
    }, 60 * 60 * 1000);
    this._timer.unref();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.events = Array.isArray(data.events) ? data.events : [];
    } catch {
      this.events = [];
    }
  }

  flush() {
    if (!this._dirty) return;
    this._dirty = false;
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, events: this.events }, null, 0) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  add(event) {
    const entry = { ts: this.now(), ...event };
    this.events.push(entry);
    if (this.events.length > this.maxEntries) {
      this.events = this.events.slice(this.events.length - this.maxEntries);
    }
    this._dirty = true;
    this.flush();
    return entry;
  }

  list({ limit = 200, kind, actor } = {}) {
    let items = this.events;
    if (kind) items = items.filter((e) => e.kind === kind);
    if (actor) items = items.filter((e) => e.actor === actor);
    return items.slice(Math.max(0, items.length - limit));
  }

  prune() {
    const cutoff = this.now() - this.maxAgeMs;
    const kept = this.events.filter((e) => (e.ts || 0) > cutoff);
    const removed = this.events.length - kept.length;
    if (removed > 0) {
      this.events = kept;
      this._dirty = true;
      this.flush();
    }
    return removed;
  }

  info() {
    const oldest = this.events.length ? this.events[0].ts : null;
    const newest = this.events.length ? this.events[this.events.length - 1].ts : null;
    return {
      count: this.events.length,
      oldest,
      newest,
      maxAgeMs: this.maxAgeMs,
      file: this.file,
    };
  }
}

module.exports = { AuditLog };
