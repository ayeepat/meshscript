import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import {
  issueErasureToken,
  verifyErasureToken,
  TELEMETRY_ERASURE_TOKEN_TTL_MS,
} from '../backend/src/telemetry-token.js';

class SqliteD1 {
  constructor(schema) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schema);
  }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      },
    });
    return statement();
  }
  async batch(statements) {
    this.db.exec('SAVEPOINT erasure_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT erasure_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT erasure_batch');
      this.db.exec('RELEASE SAVEPOINT erasure_batch');
      throw error;
    }
  }
}

class MemoryKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

const schema = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const DB = new SqliteD1(schema);
const DEVICE = 'aaaaaaaa-1111-4111-8111-111111111111';
const VICTIM = 'bbbbbbbb-2222-4222-8222-222222222222';
const SECRET = 'erasure-capability-test-secret-more-than-32-bytes';
const env = {
  DB,
  LICENSES: new MemoryKV(),
  OWNER_LICENSE_KEY: 'SMESH-OWNER-ERASURE',
  INGEST_KEY: SECRET,
  DEVICE_LIMIT: '1',
};
const ctx = { waitUntil() {} };

const verified = await worker.fetch(new Request('https://smeshapi.site/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.8' },
  body: JSON.stringify({ key: env.OWNER_LICENSE_KEY, device_id: DEVICE }),
}), env, ctx);
assert.equal(verified.status, 200);
const verdict = await verified.json();
assert.match(verdict.erasure_token, /^te1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.match(verdict.telemetry_token, /^tm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

const insertDevice = DB.db.prepare(
  `INSERT INTO devices (device_id, first_seen, last_seen, browser, version, license_type)
   VALUES (?, 1, 1, 'chrome', '0.5.0', 'lifetime')`
);
insertDevice.run(DEVICE);
insertDevice.run(VICTIM);

const erase = (token, bodyDevice = VICTIM) => worker.fetch(
  new Request('https://smeshapi.site/t/delete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.8',
      ...(token ? { 'x-erasure-token': token } : {}),
    },
    body: JSON.stringify({ device_id: bodyDevice }),
  }),
  env,
  ctx,
);

const anonymous = await erase('');
assert.equal(anonymous.status, 401,
  'a public device UUID must not authorize deletion of another installation');
assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE device_id = ?').get(VICTIM).n, 1);

const wrongTokenKind = await erase(verdict.telemetry_token);
assert.equal(wrongTokenKind.status, 401,
  'ordinary telemetry attestations must not gain erasure authority');

// The request body deliberately names the victim. The authenticated token is
// the sole authority, so only its bound installation is deleted.
const own = await erase(verdict.erasure_token, VICTIM);
assert.equal(own.status, 200);
assert.deepEqual(await own.json(), { ok: true, deleted: true });
assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE device_id = ?').get(DEVICE).n, 0);
assert.equal(DB.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE device_id = ?').get(VICTIM).n, 1,
  'body substitution must not redirect a valid erasure capability');

const repeated = await erase(verdict.erasure_token, VICTIM);
assert.equal(repeated.status, 200);
assert.deepEqual(await repeated.json(), { ok: true, deleted: false },
  'an empty retry must not manufacture another tombstone');

// Fill this IP's 20/day allowance. The rejected 21st call must not consume a
// global slot; otherwise one blocked source could exhaust erasure for everyone.
const globalUsed = () => DB.db.prepare(
  "SELECT count FROM telemetry_budget WHERE scope = 'erase_global' AND budget_key = 'all'"
).get().count;

for (let index = 0; index < 18; index += 1) {
  assert.equal((await erase(verdict.erasure_token)).status, 200);
}
// Only the single delete that actually erased something stays charged to the
// SHARED allowance. Every repeat above erased nothing and handed its global
// slot back — without that, ~100 sources replaying one long-lived capability
// (the token lives 400 days and has no replay protection) would spend the whole
// 2000/day budget and deny erasure to everyone else. The per-IP charge below
// still stands, because that is the anti-abuse control.
assert.equal(globalUsed(), 1,
  'a delete that erased nothing must not keep a shared erasure slot charged');

const beforeRejection = globalUsed();
assert.equal((await erase(verdict.erasure_token)).status, 429);
assert.equal(DB.db.prepare(
  "SELECT count FROM telemetry_budget WHERE scope = 'erase_ip' AND budget_key = ?"
).get('203.0.113.8').count, 20);
assert.equal(globalUsed(), beforeRejection,
  'an IP-level rejection must happen before the global reservation');

const issuedAt = 2_000_000_000_000;
const longLived = await issueErasureToken(env, DEVICE, issuedAt);
assert.equal(
  (await verifyErasureToken(env, longLived.token,
    issuedAt + TELEMETRY_ERASURE_TOKEN_TTL_MS - 1)).ok,
  true,
);
assert.deepEqual(
  await verifyErasureToken(env, longLived.token,
    issuedAt + TELEMETRY_ERASURE_TOKEN_TTL_MS),
  { ok: false, reason: 'expired_token' },
  'the deletion-only capability must expire at its exact signed boundary',
);

console.log('telemetry erasure-capability regressions passed');
