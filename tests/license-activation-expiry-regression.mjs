import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { deactivateLicense, verifyLicense } from '../backend/src/licenses.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');

class MemoryKV {
  store = new Map();
  failNextPut = false;
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('simulated first activation projection failure');
    }
    this.store.set(key, value);
  }
}

class SqliteD1 {
  constructor(db) { this.db = db; }
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
      }
    });
    return statement();
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  const kv = new MemoryKV();
  return { sqlite, kv, env: { LICENSES: kv, DB: new SqliteD1(sqlite), DEVICE_LIMIT: '1' } };
}

function seed(kv, key, patch) {
  kv.store.set(key, JSON.stringify({
    key,
    type: 'subscription',
    status: 'active',
    gateway: 'robokassa',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    subscription_days: null,
    subscription_duration_ms: null,
    subscription_started_at: null,
    device_ids: [],
    ...patch
  }));
}

const realDateNow = Date.now;
let clock = Date.parse('2026-08-25T12:00:00.000Z');
Date.now = () => clock;
try {
  // Monthly time starts once and survives an explicit device transfer.
  {
    const { sqlite, kv, env } = environment();
    const key = 'SMESH-MONTH-ACTIVATION';
    seed(kv, key, { subscription_days: 30, subscription_duration_ms: 30 * DAY_MS });
    kv.failNextPut = true;

    const first = await verifyLicense(env, key, 'monthly-device-0001');
    assert.equal(first.ok, true);
    assert.equal(first.expires_at, new Date(clock + 30 * DAY_MS).toISOString());
    assert.match(first.activation_token, /^[A-Za-z0-9_-]{43}$/);
    let stored = JSON.parse(await kv.get(key));
    assert.equal(stored.subscription_started_at, new Date(clock).toISOString());
    assert.equal(stored.expires_at, first.expires_at);
    assert.deepEqual(stored.device_ids, ['monthly-device-0001'],
      'the recovery write must merge both activation terms and device history');
    const originalStart = sqlite.prepare(
      'SELECT activated_at FROM license_activations WHERE license_key = ?'
    ).get(key).activated_at;

    clock += 5 * DAY_MS;
    assert.equal((await deactivateLicense(
      env, key, 'monthly-device-0001', first.activation_token
    )).ok, true);
    clock += 5 * DAY_MS;
    const moved = await verifyLicense(env, key, 'monthly-device-0002');
    assert.equal(moved.ok, true);
    assert.equal(moved.expires_at, first.expires_at,
      'deactivate/reactivate must not restart the paid clock');
    assert.equal(sqlite.prepare(
      'SELECT activated_at FROM license_activations WHERE license_key = ?'
    ).get(key).activated_at, originalStart);

    clock = Date.parse(first.expires_at) - 1;
    assert.equal((await verifyLicense(
      env, key, 'monthly-device-0002', moved.activation_token
    )).ok, true);
    clock += 1;
    assert.equal((await verifyLicense(
      env, key, 'monthly-device-0002', moved.activation_token
    )).reason, 'expired', 'the entitlement ends at the exact deadline');
    sqlite.close();
  }

  // The school plan is exactly 273 days from activation, regardless of season.
  {
    const { sqlite, kv, env } = environment();
    const key = 'SMESH-SCHOOL-ACTIVATION';
    clock = Date.parse('2027-06-15T09:30:00.000Z');
    seed(kv, key, { subscription_days: 273, subscription_duration_ms: 273 * DAY_MS });
    const activated = await verifyLicense(env, key, 'school-device-0001');
    assert.equal(activated.ok, true);
    assert.equal(activated.expires_at, new Date(clock + 273 * DAY_MS).toISOString());
    assert.equal((Date.parse(activated.expires_at) - clock) / DAY_MS, 273,
      'summer days are included; the plan does not pause or snap to May');
    sqlite.close();
  }

  // Unused Robokassa keys minted before this fix recover their bought period
  // from issued_at -> old expires_at and receive it in full on first activation.
  {
    const { sqlite, kv, env } = environment();
    const key = 'SMESH-PREFIX-COMPAT';
    const issuedAt = Date.parse('2026-01-01T00:00:00.000Z');
    seed(kv, key, {
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + 30 * DAY_MS).toISOString()
    });
    clock = Date.parse('2026-08-25T15:00:00.000Z');
    const activated = await verifyLicense(env, key, 'compat-device-0001');
    assert.equal(activated.ok, true);
    assert.equal(activated.expires_at, new Date(clock + 30 * DAY_MS).toISOString());
    const repaired = JSON.parse(await kv.get(key));
    assert.equal(repaired.subscription_duration_ms, 30 * DAY_MS);
    assert.equal(repaired.subscription_started_at, new Date(clock).toISOString());
    sqlite.close();
  }
} finally {
  Date.now = realDateNow;
}

console.log('license activation-expiry regressions passed');
