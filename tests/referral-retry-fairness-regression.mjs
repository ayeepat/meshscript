// A permanently broken old referral code must not occupy every bounded cron
// batch and starve newer, valid paid credits forever. Failed codes receive a
// persisted exponential backoff; the next sweep can immediately reach another
// code while the entitlement journal remains retryable.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { retryPendingReferralCredits } from '../backend/src/referrals.js';

class D1Adapter {
  constructor(schema) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schema);
  }

  prepare(sql) {
    const statement = this.db.prepare(sql);
    const wrap = (args = []) => ({
      async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
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
const env = { DB, LICENSES, REFERRAL_PAID_DAYS: '7' };
const targetKey = 'SMESH-FAIR-TARGET';
const goodCode = 'REF-GOOD-0001';
const poisonCode = 'REF-BAD0-0001';

await LICENSES.put(targetKey, JSON.stringify({
  key: targetKey,
  type: 'subscription',
  status: 'active',
  expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  device_ids: []
}));
await LICENSES.put(`ref:${goodCode}`, JSON.stringify({
  code: goodCode,
  owner_device_id: '11111111-1111-4111-8111-111111111111',
  owner_license_key: targetKey,
  purchases: 0,
  days_earned: 0,
  reward_key: null
}));

const insert = DB.db.prepare(
  `INSERT INTO referral_credit_state
     (license_key, ref_code, days, status, created_at)
   VALUES (?, ?, 7, 'pending', ?)`
);
insert.run('SMESH-POISON-CREDIT', poisonCode, 1);
insert.run('SMESH-GOOD-CREDIT', goodCode, 2);

const first = await retryPendingReferralCredits(env, 1);
assert.equal(first.codes, 1);
const poison = DB.db.prepare(
  `SELECT status, retry_attempts, retry_after
   FROM referral_credit_state WHERE license_key = ?`
).get('SMESH-POISON-CREDIT');
assert.equal(poison.status, 'pending');
assert.equal(poison.retry_attempts, 1);
assert.ok(poison.retry_after > Date.now(),
  'the poison code must be deferred instead of winning every oldest-first batch');

const second = await retryPendingReferralCredits(env, 1);
assert.deepEqual(second, { codes: 1, applied: 1, still_pending: 0, stalled: 0 });
const good = DB.db.prepare(
  `SELECT status, materialized_at
   FROM referral_credit_state WHERE license_key = ?`
).get('SMESH-GOOD-CREDIT');
assert.equal(good.status, 'applied');
assert.ok(good.materialized_at);
assert.equal(
  JSON.parse(await LICENSES.get(`ref:${goodCode}`)).purchases,
  1,
  'the newer valid credit must become user-visible while the old code backs off'
);

console.log('referral retry fairness regression passed');
