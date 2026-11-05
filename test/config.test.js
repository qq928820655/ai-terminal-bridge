'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const STATE_DIR = path.join(os.tmpdir(), `aitb-config-${process.pid}-${Date.now()}`);

function loadWith(env) {
  const saved = {};
  const keys = [
    'AITB_CONN_IDLE_KILL_MS',
    'AITB_CONN_IDLE_KILL_MINUTES',
    'AITB_CONN_PURGE_MS',
    'AITB_CONN_PURGE_DAYS',
    'AITB_CONN_SWEEP_MS',
  ];
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AITB_STATE_DIR = STATE_DIR;
  process.env.AITB_TOKEN = 'test_config_token';
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/config')];
  const settings = require('../src/config').load();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  return settings;
}

test('conn lifecycle defaults to 60 minutes and 3 days', () => {
  const s = loadWith({});
  assert.equal(s.connIdleKillMs, 60 * 60 * 1000);
  assert.equal(s.connIdlePurgeMs, 3 * 24 * 60 * 60 * 1000);
  assert.equal(s.connSweepMs, 60 * 1000);
});

test('documented minute/day variables are honored', () => {
  const s = loadWith({
    AITB_CONN_IDLE_KILL_MINUTES: '7',
    AITB_CONN_PURGE_DAYS: '2',
    AITB_CONN_SWEEP_MS: '5000',
  });
  assert.equal(s.connIdleKillMs, 7 * 60 * 1000);
  assert.equal(s.connIdlePurgeMs, 2 * 24 * 60 * 60 * 1000);
  assert.equal(s.connSweepMs, 5000);
});

test('explicit millisecond variables win over minute/day ones', () => {
  const s = loadWith({
    AITB_CONN_IDLE_KILL_MS: '12345',
    AITB_CONN_IDLE_KILL_MINUTES: '99',
    AITB_CONN_PURGE_MS: '99999',
    AITB_CONN_PURGE_DAYS: '99',
  });
  assert.equal(s.connIdleKillMs, 12345);
  assert.equal(s.connIdlePurgeMs, 99999);
});

test('invalid values fall back to defaults', () => {
  const s = loadWith({
    AITB_CONN_IDLE_KILL_MINUTES: 'nope',
    AITB_CONN_PURGE_DAYS: '-3',
  });
  assert.equal(s.connIdleKillMs, 60 * 60 * 1000);
  assert.equal(s.connIdlePurgeMs, 3 * 24 * 60 * 60 * 1000);
});
