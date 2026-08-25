// B-04: ref:<code> is an eventually-consistent projection. A whole-row write
// that began under an expired lease can physically land after a newer payout;
// every production read must reconstruct counters, auth, and reward routing
// from the D1 journal instead of reporting that stale object.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  adminReferralLookup,
  referralStatus
} from '../backend/src/referrals.js';

class D1Adapter {
  constructor(schema) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schema);
  }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    const wrap = (args = []) => ({
      async run() {
        return { meta: { changes: Number(statement.run(...args).changes) } };
      },
      async first(column) {
        const row = statement.get(...args) || null;
        return column && row ? row[column] : row;
      },
      async all() { return { results: statement.all(...args) }; }
    });
    return { ...wrap(), bind: (...args) => wrap(args) };
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

const schema = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const DB = new D1Adapter(schema);
const LICENSES = new FakeKV();
const env = { DB, LICENSES };
const code = 'REF-RACE-0001';
const rewardKey = 'SMESH-REF-RACE-REWARD';
const device = '77777777-7777-4777-8777-777777777777';
const auth = 'A'.repeat(43);
const authHash = [...new Uint8Array(await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(auth)
))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

DB.db.prepare(
  'INSERT INTO referral_auth_claims (auth_hash, code, created_at) VALUES (?, ?, ?)'
).run(authHash, code, 1);
for (const [licenseKey, createdAt, expiry] of [
  ['SMESH-PAID-RACE-ONE', 10, '2030-01-08T00:00:00.000Z'],
  ['SMESH-PAID-RACE-TWO', 20, '2030-01-15T00:00:00.000Z']
]) {
  DB.db.prepare(
    `INSERT INTO referral_credit_state
       (license_key, ref_code, days, status, created_at, applied_at,
        materialized_at, target_kind, target_key, target_expiry)
     VALUES (?, ?, 7, 'applied', ?, ?, ?, 'reward', ?, ?)`
  ).run(licenseKey, code, createdAt, createdAt + 1, createdAt + 2, rewardKey, expiry);
}

await LICENSES.put(`refauth:${authHash}`, code);
await LICENSES.put(rewardKey, JSON.stringify({
  key: rewardKey,
  type: 'subscription',
  status: 'active',
  expires_at: '2030-01-15T00:00:00.000Z',
  device_ids: []
}));

// This is the delayed, obsolete object that physically lands last in KV.
await LICENSES.put(`ref:${code}`, JSON.stringify({
  code,
  owner_device_id: device,
  owner_license_key: null,
  purchases: 0,
  days_earned: 0,
  reward_key: null
}));

const status = await referralStatus(env, device, auth);
assert.equal(status.ok, true);
assert.equal(status.code, code);
assert.equal(status.purchases, 2);
assert.equal(status.days_earned, 14);
assert.equal(status.reward_key, rewardKey);
assert.equal(status.reward_expires_at, '2030-01-15T00:00:00.000Z');

const inspected = await adminReferralLookup(env, { code });
assert.equal(inspected.ref.auth_hash, authHash,
  'the D1 capability claim must restore auth erased by an older KV writer');
assert.equal(inspected.ref.purchases, 2);
assert.equal(inspected.ref.days_earned, 14);
assert.equal(inspected.ref.reward_key, rewardKey);

console.log('referral materialized-read regressions passed');
