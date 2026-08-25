/**
 * One referral credit whose target died must not strand the referrer's others.
 *
 * A row can end up `status='applied'` with `materialized_at IS NULL` (a crash
 * between the D1 linearization and the KV write). If its target is revoked
 * before the recovery sweep reaches it, applyCreditIntent used to call
 * clearCreditIntent — whose `status='pending'` guard matched zero rows and
 * threw. That exception aborted the ENTIRE per-code batch, so every later
 * credit for that referrer stayed unsettled behind one dead target, forever.
 *
 * Now: the dead row is recorded as stalled and given its own backoff, and the
 * sweep keeps going. The referrer's other credits still land.
 */
import assert from 'node:assert/strict';
import { retryPendingReferralCredits } from '../backend/src/referrals.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class ReferralD1 {
  states = new Map();
  referralClaims = new Map();
  referralLocks = new Map();
  payments = new Map();
  paymentKeys = new Set();
  materialized = new Set();
  kvLocks = new Map();
  revocations = new Set();

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO payment_issuance')) {
              const [gateway, paymentId, licenseKey, licenseJson] = args;
              const id = `${gateway}|${paymentId}`;
              if (db.payments.has(id) || db.paymentKeys.has(licenseKey)) {
                return { meta: { changes: 0 } };
              }
              db.payments.set(id, { license_json: licenseJson });
              db.paymentKeys.add(licenseKey);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET target_kind = ?2')) {
              const [licenseKey, kind, targetKey, expiry] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'pending' || state.target_key) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, { target_kind: kind, target_key: targetKey, target_expiry: expiry });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET target_kind = NULL')) {
              const [licenseKey, targetKey] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'pending' || state.target_key !== targetKey) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, {
                target_kind: null, target_key: null, target_expiry: null,
                target_generation: state.target_generation + 1
              });
              return { meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE referral_credit_state SET status = 'applied'")) {
              const [licenseKey, appliedAt, targetKey] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'pending' || state.target_key !== targetKey ||
                  db.revocations.has(targetKey) || db.revocations.has(licenseKey)) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, { status: 'applied', applied_at: appliedAt });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET materialized_at = ?2')) {
              const [licenseKey, materializedAt] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'applied' || state.materialized_at != null) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, {
                materialized_at: materializedAt, retry_attempts: 0,
                retry_after: 0, last_error_at: null
              });
              return { meta: { changes: 1 } };
            }
            // Row-scoped backoff for a credit this pass could not settle.
            if (sql.includes('SET retry_attempts = ?2')) {
              const [licenseKey, attempts, retryAfter, lastErrorAt] = args;
              const state = db.states.get(licenseKey);
              if (!state || !(state.status === 'pending' ||
                  (state.status === 'applied' && state.materialized_at == null))) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, {
                retry_attempts: attempts, retry_after: retryAfter, last_error_at: lastErrorAt
              });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO kv_materializations')) {
              db.materialized.add(args[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM referral_apply_locks')) {
              if (db.referralLocks.get(args[0]) === args[1]) db.referralLocks.delete(args[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM kv_apply_locks')) {
              if (db.kvLocks.get(args[0]) === args[1]) db.kvLocks.delete(args[0]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('SELECT license_json FROM payment_issuance')) {
              return db.payments.get(`${args[0]}|${args[1]}`) || null;
            }
            if (sql.includes('SELECT revoked_at, reason FROM license_revocations')) {
              return db.revocations.has(args[0]) ? { revoked_at: Date.now(), reason: 'refund' } : null;
            }
            if (sql.includes('MAX(target_expiry)')) {
              let expiry = null;
              for (const state of db.states.values()) {
                if (state.target_key === args[0] && state.target_expiry &&
                    (!expiry || state.target_expiry > expiry)) expiry = state.target_expiry;
              }
              return { expiry };
            }
            if (sql.includes('SELECT target_key FROM referral_credit_state')) {
              const reward = [...db.states.values()].find((state) =>
                state.ref_code === args[0] && state.target_kind === 'reward' && state.target_key);
              return reward ? { target_key: reward.target_key } : null;
            }
            if (sql.includes('COALESCE(SUM(days), 0) AS days_earned')) {
              const applied = [...db.states.values()].filter((state) =>
                state.ref_code === args[0] && state.status === 'applied');
              return {
                purchases: applied.length,
                days_earned: applied.reduce((sum, state) => sum + Number(state.days), 0)
              };
            }
            if (sql.includes('SELECT COUNT(*) AS count')) {
              return { count: [...db.states.values()].filter((state) =>
                state.ref_code === args[0] && (state.status === 'pending' ||
                  (state.status === 'applied' && state.materialized_at == null))).length };
            }
            if (sql.includes('SELECT retry_attempts FROM referral_credit_state')) {
              const state = db.states.get(args[0]);
              return state ? { retry_attempts: state.retry_attempts } : null;
            }
            if (sql.includes('FROM referral_credit_state WHERE license_key = ?1')) {
              return db.states.get(args[0]) || null;
            }
            if (sql.includes('SELECT 1 AS done FROM kv_materializations')) {
              return db.materialized.has(args[0]) ? { done: 1 } : null;
            }
            if (sql.includes('INSERT INTO referral_apply_locks')) {
              const [name, leaseUntil, now] = args;
              if ((db.referralLocks.get(name) || 0) >= now) return null;
              db.referralLocks.set(name, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('UPDATE referral_apply_locks SET lease_until')) {
              const [name, oldLease, newLease, now] = args;
              if (db.referralLocks.get(name) !== oldLease || oldLease < now) return null;
              db.referralLocks.set(name, newLease);
              return { lease_until: newLease };
            }
            if (sql.includes('INSERT INTO kv_apply_locks')) {
              const [name, leaseUntil, now] = args;
              if ((db.kvLocks.get(name) || 0) >= now) return null;
              db.kvLocks.set(name, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('UPDATE kv_apply_locks SET lease_until')) {
              const [name, oldLease, newLease, now] = args;
              if (db.kvLocks.get(name) !== oldLease || oldLease < now) return null;
              db.kvLocks.set(name, newLease);
              return { lease_until: newLease };
            }
            return null;
          },
          async all() {
            if (sql.includes('SELECT ref_code FROM referral_credit_state')) {
              const codes = new Set();
              for (const state of db.states.values()) {
                const unsettled = state.status === 'pending' ||
                  (state.status === 'applied' && state.materialized_at == null);
                if (unsettled && state.retry_after <= args[0]) codes.add(state.ref_code);
              }
              return { results: [...codes].map((ref_code) => ({ ref_code })) };
            }
            if (sql.includes('FROM referral_credit_state') &&
                sql.includes('WHERE ref_code = ?1') && sql.includes('ORDER BY created_at')) {
              return {
                results: [...db.states.values()]
                  .filter((state) => state.ref_code === args[0] &&
                    (state.status === 'pending' ||
                     (state.status === 'applied' && state.materialized_at == null)))
                  .sort((a, b) => a.created_at - b.created_at ||
                    a.license_key.localeCompare(b.license_key))
                  .slice(0, args[1])
                  .map((state) => ({ ...state }))
              };
            }
            return { results: [] };
          }
        };
      }
    };
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const CODE = 'REF-STUK-0001';
const DEAD_TARGET = 'SMESH-DEAD-TARGET';
const STUCK = 'SMESH-STUCK-0001';
const FRESH = 'SMESH-FRESH-0002';

const kv = new FakeKV();
const db = new ReferralD1();
const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };

await kv.put(`ref:${CODE}`, JSON.stringify({
  code: CODE, owner_device_id: 'device-referrer', owner_license_key: null,
  purchases: 0, days_earned: 0, reward_key: null
}));

// The dead target still EXISTS in KV (a stale-active mirror) but D1 has revoked
// it — the exact state referralTargetEligible refuses.
await kv.put(DEAD_TARGET, JSON.stringify({
  key: DEAD_TARGET, type: 'subscription', status: 'active',
  expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  device_ids: []
}));
db.revocations.add(DEAD_TARGET);

const base = Date.now() - 60_000;
// Older row: earned, linearized, never materialized, target since revoked.
db.states.set(STUCK, {
  license_key: STUCK, ref_code: CODE, days: 7, status: 'applied',
  created_at: base, applied_at: base, materialized_at: null,
  target_kind: 'reward', target_key: DEAD_TARGET,
  target_expiry: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  target_generation: 0, retry_attempts: 0, retry_after: 0, last_error_at: null
});
// Newer row: an ordinary pending credit that must NOT be held hostage by it.
db.states.set(FRESH, {
  license_key: FRESH, ref_code: CODE, days: 7, status: 'pending',
  created_at: base + 1000, applied_at: null, materialized_at: null,
  target_kind: null, target_key: null, target_expiry: null,
  target_generation: 0, retry_attempts: 0, retry_after: 0, last_error_at: null
});

const before = Date.now();
const result = await retryPendingReferralCredits(env);

assert.equal(result.codes, 1);
assert.equal(result.stalled, 1, 'the dead-target credit must be reported as stalled');
assert.equal(result.applied, 1, 'the healthy credit behind it must still be applied');

const stuck = db.states.get(STUCK);
assert.equal(stuck.status, 'applied', 'an earned credit is never downgraded');
assert.equal(stuck.materialized_at, null,
  'a credit that could not be written must stay on the operator worklist');
assert.ok(stuck.retry_attempts >= 1, 'the stalled row must record an attempt');
assert.ok(stuck.retry_after > before,
  'the stalled row must be backed off, not retried in a tight loop');

const fresh = db.states.get(FRESH);
assert.equal(fresh.status, 'applied',
  'the later credit must apply even though an older one is wedged');
assert.ok(fresh.materialized_at != null,
  'the later credit must be materialized, not left unsettled by the stalled row');
assert.notEqual(fresh.target_key, DEAD_TARGET,
  'a fresh credit must retarget away from the revoked reward license');
assert.equal(fresh.retry_attempts, 0,
  'a settled row must not inherit the stalled row’s backoff');

// The referrer's public record reflects only what really landed.
const record = JSON.parse(await kv.get(`ref:${CODE}`));
assert.equal(record.purchases, 2, 'both applied credits count toward the journal totals');
assert.equal(record.days_earned, 14);

console.log('referral stalled target regression passed');
