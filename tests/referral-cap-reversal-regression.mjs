import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import {
  creditReferrerForPurchase,
  REFERRAL_REWARD_CAP_DAYS,
  retryPendingReferralCredits,
  reverseReferralCreditForPurchase,
} from '../backend/src/referrals.js';
import { revokeLicenseDurable } from '../backend/src/licenses.js';

class SqliteD1 {
  constructor(schema) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(schema);
  }
  prepare(sql) {
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = thisDb.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: thisDb.prepare(sql).all(...args) }; },
      async run() {
        const result = thisDb.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      },
    });
    const thisDb = this.db;
    return statement();
  }
  async batch(statements) {
    this.db.exec('SAVEPOINT referral_cap_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT referral_cap_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT referral_cap_batch');
      this.db.exec('RELEASE SAVEPOINT referral_cap_batch');
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

function environment() {
  const DB = new SqliteD1(schema);
  const LICENSES = new MemoryKV();
  return { DB, LICENSES, env: { DB, LICENSES, REFERRAL_PAID_DAYS: '7' } };
}

function activeSubscription(key, expiresAt) {
  return {
    key,
    type: 'subscription',
    status: 'active',
    email: null,
    telegram_user_id: null,
    issued_at: new Date().toISOString(),
    expires_at: expiresAt,
    payment_id: null,
    gateway: 'manual',
    amount_kopecks: null,
    amount_rub: null,
    is_preorder: false,
    referral_code: null,
    device_ids: [],
    note: null,
  };
}

// Five paid referrals award 7+7+7+7+2 days. A sixth cannot create either a
// pending claim or a reward. The D1 SUM is the concurrency authority, so this
// remains true even if KV counters are stale.
{
  const { DB, LICENSES, env } = environment();
  const code = 'REF-CAPX-0001';
  const targetKey = 'SMESH-CAP-TARGET';
  const ref = {
    code,
    owner_device_id: '11111111-1111-4111-8111-111111111111',
    owner_license_key: targetKey,
    purchases: 0,
    days_earned: 0,
    reward_key: null,
  };
  await LICENSES.put(`ref:${code}`, JSON.stringify(ref));
  await LICENSES.put(targetKey, JSON.stringify(activeSubscription(
    targetKey,
    new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
  )));

  const awards = [];
  for (let index = 1; index <= 6; index += 1) {
    const result = await creditReferrerForPurchase(env, ref, `SMESH-CAP-BUYER-${index}`);
    if (result.credited) awards.push(result.days);
  }
  assert.deepEqual(awards, [7, 7, 7, 7, 2]);
  const totals = DB.db.prepare(
    `SELECT COUNT(*) AS purchases, COALESCE(SUM(days), 0) AS days
     FROM referral_credit_state WHERE ref_code = ? AND status = 'applied'`
  ).get(code);
  assert.equal(totals.days, REFERRAL_REWARD_CAP_DAYS);
  assert.equal(totals.purchases, 5,
    'a purchase after the cap must not create a zero-day claim');
  assert.equal(DB.db.prepare(
    'SELECT COUNT(*) AS n FROM referral_credits WHERE ref_code = ?'
  ).get(code).n, 5);
}

// Refund/revocation removes the exact earned days, shifts every later absolute
// promise back by the same amount, updates the visible counters, and is
// idempotent on retry.
{
  const { DB, LICENSES, env } = environment();
  const code = 'REF-RVRS-0001';
  const targetKey = 'SMESH-REVERSAL-TARGET';
  const sourceKeys = ['SMESH-REV-SOURCE-1', 'SMESH-REV-SOURCE-2', 'SMESH-REV-SOURCE-3'];
  const expiries = [
    '2030-01-08T00:00:00.000Z',
    '2030-01-15T00:00:00.000Z',
    '2030-01-22T00:00:00.000Z',
  ];
  await LICENSES.put(targetKey, JSON.stringify(activeSubscription(targetKey, expiries[2])));
  await LICENSES.put(`ref:${code}`, JSON.stringify({
    code,
    owner_device_id: '22222222-2222-4222-8222-222222222222',
    owner_license_key: targetKey,
    purchases: 0,
    days_earned: 0,
    reward_key: null,
  }));
  for (let index = 0; index < sourceKeys.length; index += 1) {
    DB.db.prepare(
      `INSERT INTO referral_credit_state
         (license_key, ref_code, days, status, created_at, applied_at,
          materialized_at, target_kind, target_key, target_expiry)
       VALUES (?, ?, 7, 'applied', ?, ?, ?, 'owner', ?, ?)`
    ).run(sourceKeys[index], code, index + 1, index + 10, index + 20, targetKey, expiries[index]);
    DB.db.prepare(
      'INSERT INTO referral_credits (license_key, ref_code, claimed_at) VALUES (?, ?, ?)'
    ).run(sourceKeys[index], code, index + 1);
  }

  const first = await reverseReferralCreditForPurchase(env, sourceKeys[1]);
  assert.deepEqual(first, { reversed: true, days: 7 });
  const target = JSON.parse(await LICENSES.get(targetKey));
  assert.equal(target.expires_at, '2030-01-15T00:00:00.000Z');
  const rows = DB.db.prepare(
    `SELECT license_key, status, target_kind, target_expiry, materialized_at
     FROM referral_credit_state ORDER BY created_at`
  ).all();
  assert.equal(rows[1].status, 'cancelled');
  assert.equal(rows[1].target_kind, 'reversal');
  assert.ok(rows[1].materialized_at != null);
  assert.equal(rows[2].target_expiry, '2030-01-15T00:00:00.000Z',
    'later promises must shift back so revoked days cannot survive in KV');
  const ref = JSON.parse(await LICENSES.get(`ref:${code}`));
  assert.equal(ref.days_earned, 14);
  assert.equal(ref.purchases, 2);

  const retry = await reverseReferralCreditForPurchase(env, sourceKeys[1]);
  assert.deepEqual(retry, { reversed: false, reason: 'already' });
  assert.equal(JSON.parse(await LICENSES.get(targetKey)).expires_at,
    '2030-01-15T00:00:00.000Z', 'a retry must not subtract the reward twice');
}

// A crash/failure after D1 has frozen a reversal but before its absolute KV
// projection lands is resumed by the normal bounded cron sweep.
{
  const { DB, LICENSES, env } = environment();
  const code = 'REF-RETRY-0001';
  const targetKey = 'SMESH-REVERSAL-RETRY-TARGET';
  const sourceKey = 'SMESH-REVERSAL-RETRY-SOURCE';
  await LICENSES.put(targetKey, JSON.stringify(activeSubscription(
    targetKey, '2030-01-08T00:00:00.000Z'
  )));
  await LICENSES.put(`ref:${code}`, JSON.stringify({
    code,
    owner_device_id: '33333333-3333-4333-8333-333333333333',
    owner_license_key: targetKey,
    purchases: 1,
    days_earned: 7,
    legacy_purchases: 0,
    legacy_days_earned: 0,
    reward_key: null,
  }));
  DB.db.prepare(
    `INSERT INTO referral_credit_state
       (license_key, ref_code, days, status, created_at, applied_at,
        materialized_at, target_kind, target_key, target_expiry)
     VALUES (?, ?, 7, 'applied', 1, 2, 3, 'owner', ?, ?)`
  ).run(sourceKey, code, targetKey, '2030-01-08T00:00:00.000Z');

  const normalPut = LICENSES.put.bind(LICENSES);
  let failTargetOnce = true;
  let failReferralProjectionOnce = true;
  LICENSES.put = async (key, value) => {
    if (key === targetKey && failTargetOnce) {
      failTargetOnce = false;
      throw new Error('simulated KV interruption');
    }
    if (key === `ref:${code}` && failReferralProjectionOnce) {
      failReferralProjectionOnce = false;
      throw new Error('simulated referral projection interruption');
    }
    return normalPut(key, value);
  };
  await assert.rejects(reverseReferralCreditForPurchase(env, sourceKey),
    /simulated KV interruption/);
  const stranded = DB.db.prepare(
    'SELECT status, target_kind, materialized_at FROM referral_credit_state WHERE license_key = ?'
  ).get(sourceKey);
  assert.deepEqual({ ...stranded }, {
    status: 'cancelled', target_kind: 'reversal', materialized_at: null
  });

  const firstRetry = await retryPendingReferralCredits(env, 5);
  assert.equal(firstRetry.still_pending, 1,
    'a failed public-counter projection must remain in the cron worklist');
  assert.equal(DB.db.prepare(
    'SELECT materialized_at FROM referral_credit_state WHERE license_key = ?'
  ).get(sourceKey).materialized_at, null,
  'target expiry alone is not a fully materialized reversal');
  DB.db.prepare(
    'UPDATE referral_credit_state SET retry_after = 0 WHERE license_key = ?'
  ).run(sourceKey);
  const secondRetry = await retryPendingReferralCredits(env, 5);
  assert.equal(secondRetry.still_pending, 0);
  assert.equal(JSON.parse(await LICENSES.get(targetKey)).expires_at,
    '2030-01-01T00:00:00.000Z');
  assert.deepEqual(
    (({ purchases, days_earned }) => ({ purchases, days_earned }))(
      JSON.parse(await LICENSES.get(`ref:${code}`))
    ),
    { purchases: 0, days_earned: 0 }
  );
  assert.ok(DB.db.prepare(
    'SELECT materialized_at FROM referral_credit_state WHERE license_key = ?'
  ).get(sourceKey).materialized_at != null);
}

// revokeLicenseDurable cancels a still-pending credit in the same D1 batch as
// the revocation, and every caller (admin revoke + refund cron sweep) then
// reverses the referral for that purchase. That sequence must succeed — not
// throw "referral reversal state is invalid" — or /admin/revoke 500s after a
// committed revocation and a provider-finished refund can never finalize.
{
  const { DB, env } = environment();
  const sourceKey = 'SMESH-REVOKE-PENDING-SOURCE';
  DB.db.prepare(
    `INSERT INTO referral_credit_state
       (license_key, ref_code, days, status, created_at, applied_at,
        materialized_at, target_kind, target_key, target_expiry)
     VALUES (?, 'REF-RVKE-0001', 7, 'pending', 1, NULL, NULL, NULL, NULL, NULL)`
  ).run(sourceKey);
  const revocation = await revokeLicenseDurable(env, sourceKey, 'test_revoke');
  assert.equal(revocation.ok, true);
  const cancelled = DB.db.prepare(
    'SELECT status, target_kind, target_key, materialized_at, last_error_at FROM referral_credit_state WHERE license_key = ?'
  ).get(sourceKey);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.target_key, null);
  assert.ok(cancelled.materialized_at != null,
    'the revoke-time cancel must be terminal exactly like the reversal path');
  assert.equal(cancelled.last_error_at, null,
    'a terminal cancellation must not retain a misleading retry error');
  const reversed = await reverseReferralCreditForPurchase(env, sourceKey);
  assert.deepEqual(reversed, { reversed: false, reason: 'already' },
    'the revoke-time cancel already terminalized the row; reversal is a no-op, never a throw');
  const again = await reverseReferralCreditForPurchase(env, sourceKey);
  assert.deepEqual(again, { reversed: false, reason: 'already' },
    'repeated sweeps (the refund cron retry loop) must stay no-op');

  // Defense in depth: even a pre-existing row written by the OLD revoke shape
  // (cancelled, targets nulled, materialized_at NULL) must reverse cleanly.
  const legacyKey = 'SMESH-REVOKE-LEGACY-SOURCE';
  DB.db.prepare(
    `INSERT INTO referral_credit_state
       (license_key, ref_code, days, status, created_at, applied_at,
        materialized_at, target_kind, target_key, target_expiry)
     VALUES (?, 'REF-RVKE-0001', 7, 'cancelled', 1, NULL, NULL, NULL, NULL, NULL)`
  ).run(legacyKey);
  assert.deepEqual(await reverseReferralCreditForPurchase(env, legacyKey), { reversed: true, days: 0 });
  assert.deepEqual(await reverseReferralCreditForPurchase(env, legacyKey), { reversed: false, reason: 'already' },
    'the repaired legacy row must become terminal and idempotent');

  // The compatibility branch must remain fail-closed for a corrupt row that
  // claims it was applied but has lost its target pointer.
  const corruptKey = 'SMESH-REVOKE-CORRUPT-SOURCE';
  DB.db.prepare(
    `INSERT INTO referral_credit_state
       (license_key, ref_code, days, status, created_at, applied_at,
        materialized_at, target_kind, target_key, target_expiry)
     VALUES (?, 'REF-RVKE-0001', 7, 'cancelled', 1, 2, NULL, NULL, NULL, NULL)`
  ).run(corruptKey);
  await assert.rejects(reverseReferralCreditForPurchase(env, corruptKey),
    /referral reversal state is invalid/);
}

console.log('referral cap and reversal regressions passed');
