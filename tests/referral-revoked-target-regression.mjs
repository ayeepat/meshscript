import assert from 'node:assert/strict';
import { creditReferrerForPurchase } from '../backend/src/referrals.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class ReferralD1 {
  referralClaims = new Map();
  states = new Map();
  referralLocks = new Map();
  payments = new Map();
  paymentKeys = new Set();
  materialized = new Set();
  kvLocks = new Map();
  revocations = new Set();
  revocationReads = 0;
  revokeFirstMintOnIntent = false;
  revokeSourceOnIntent = false;

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
            if (sql.includes('INSERT OR IGNORE INTO referral_credit_state')) {
              const [licenseKey, refCode, days, createdAt] = args;
              if (db.referralClaims.has(licenseKey) || db.states.has(licenseKey)) {
                return { meta: { changes: 0 } };
              }
              db.states.set(licenseKey, {
                license_key: licenseKey,
                ref_code: refCode,
                days,
                status: 'pending',
                created_at: createdAt,
                applied_at: null,
                materialized_at: null,
                target_kind: null,
                target_key: null,
                target_expiry: null,
                target_generation: 0,
                retry_attempts: 0,
                retry_after: 0,
                last_error_at: null
              });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO referral_credits')) {
              const [licenseKey, refCode, claimedAt] = args;
              if (db.referralClaims.has(licenseKey)) return { meta: { changes: 0 } };
              db.referralClaims.set(licenseKey, { ref_code: refCode, claimed_at: claimedAt });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET target_kind = ?2')) {
              const [licenseKey, kind, targetKey, expiry] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'pending' || state.target_key) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, {
                target_kind: kind,
                target_key: targetKey,
                target_expiry: expiry
              });
              if (kind === 'reward' && db.revokeFirstMintOnIntent &&
                  state.target_generation === 0) {
                db.revokeFirstMintOnIntent = false;
                db.revocations.add(targetKey);
              }
              if (db.revokeSourceOnIntent) {
                db.revokeSourceOnIntent = false;
                db.revocations.add(licenseKey);
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET target_kind = NULL')) {
              const [licenseKey, targetKey] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'pending' || state.target_key !== targetKey) {
                return { meta: { changes: 0 } };
              }
              Object.assign(state, {
                target_kind: null,
                target_key: null,
                target_expiry: null,
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
              state.status = 'applied';
              state.applied_at = appliedAt;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'cancelled'")) {
              const state = db.states.get(args[0]);
              if (!state || state.status !== 'pending') return { meta: { changes: 0 } };
              Object.assign(state, {
                status: 'cancelled', target_kind: null, target_key: null,
                target_expiry: null, retry_after: 0, last_error_at: args[1]
              });
              return { meta: { changes: 1 } };
            }
            // Materialization is row-scoped (WHERE license_key = ?1) so a sweep
            // cannot clear the retry state of a row it failed to settle.
            if (sql.includes('SET materialized_at = ?2')) {
              const [licenseKey, materializedAt] = args;
              const state = db.states.get(licenseKey);
              if (!state || state.status !== 'applied' || state.materialized_at != null) {
                return { meta: { changes: 0 } };
              }
              state.materialized_at = materializedAt;
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
            return { meta: { changes: 1 } }; // purchases analytics mirror
          },
          async first() {
            if (sql.includes('SELECT license_json FROM payment_issuance')) {
              return db.payments.get(`${args[0]}|${args[1]}`) || null;
            }
            if (sql.includes('SELECT revoked_at, reason FROM license_revocations')) {
              db.revocationReads += 1;
              return db.revocations.has(args[0])
                ? { revoked_at: Date.now(), reason: 'refund' }
                : null;
            }
            if (sql.includes('MAX(target_expiry)')) {
              let expiry = null;
              for (const state of db.states.values()) {
                if (state.target_key === args[0] && state.target_expiry &&
                    (!expiry || state.target_expiry > expiry)) {
                  expiry = state.target_expiry;
                }
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
            if (sql.includes('FROM referral_credit_state') &&
                sql.includes('WHERE ref_code = ?1') &&
                sql.includes('ORDER BY created_at')) {
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

const kv = new FakeKV();
const db = new ReferralD1();
const ownerKey = 'SMESH-OWNER-0001';
const buyerKey = 'SMESH-BUYER-0001';
const ownerExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const owner = {
  key: ownerKey,
  type: 'subscription',
  status: 'active', // deliberately stale: D1 already revoked it
  expires_at: ownerExpiry,
  device_ids: []
};
const ref = {
  code: 'REF-2222-2222',
  owner_device_id: 'device-owner-0001',
  owner_license_key: ownerKey,
  created_at: new Date().toISOString(),
  purchases: 0,
  days_earned: 0,
  reward_key: null
};
await kv.put(ownerKey, JSON.stringify(owner));
await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
db.revocations.add(ownerKey);

const result = await creditReferrerForPurchase({ LICENSES: kv, DB: db }, ref, buyerKey);
assert.deepEqual(result, { credited: true, days: 7 });
assert.equal(JSON.parse(await kv.get(ownerKey)).expires_at, ownerExpiry,
  'a stale-active KV owner row must not receive or consume the reward');

const storedRef = JSON.parse(await kv.get(`ref:${ref.code}`));
assert.ok(storedRef.reward_key && storedRef.reward_key !== ownerKey,
  'the payout must retarget to a fresh usable reward subscription');
const reward = JSON.parse(await kv.get(storedRef.reward_key));
assert.equal(reward.status, 'active');
assert.equal(reward.type, 'subscription');
assert.ok(Date.parse(reward.expires_at) > Date.now());
assert.equal(db.states.get(buyerKey).target_key, storedRef.reward_key);
assert.equal(db.states.get(buyerKey).status, 'applied');
assert.ok(db.revocationReads >= 2, 'target selection and application must consult D1 revocations');

// A reward revoked after mint/intent but before the applied-state linearization
// must advance to a fresh deterministic payment claim. Reusing generation zero
// forever would recover the same revoked snapshot on every retry.
{
  const raceKv = new FakeKV();
  const raceDb = new ReferralD1();
  raceDb.revokeFirstMintOnIntent = true;
  const raceBuyer = 'SMESH-BUYER-MINT-RACE';
  const raceRef = {
    code: 'REF-3333-3333',
    owner_device_id: 'device-owner-0002',
    owner_license_key: null,
    created_at: new Date().toISOString(),
    purchases: 0,
    days_earned: 0,
    reward_key: null
  };
  await raceKv.put(`ref:${raceRef.code}`, JSON.stringify(raceRef));

  const credited = await creditReferrerForPurchase(
    { LICENSES: raceKv, DB: raceDb },
    raceRef,
    raceBuyer
  );
  assert.deepEqual(credited, { credited: true, days: 7 });

  const firstClaim = raceDb.payments.get(`referral|referral:${raceBuyer}`);
  const secondClaim = raceDb.payments.get(`referral|referral:${raceBuyer}:g1`);
  assert.ok(firstClaim && secondClaim,
    'revocation must durably advance the recovery identity to generation one');
  const firstReward = JSON.parse(firstClaim.license_json);
  const secondReward = JSON.parse(secondClaim.license_json);
  assert.notEqual(firstReward.key, secondReward.key);
  assert.ok(raceDb.revocations.has(firstReward.key), 'the injected first reward is revoked');
  const finalRef = JSON.parse(await raceKv.get(`ref:${raceRef.code}`));
  assert.equal(finalRef.reward_key, secondReward.key,
    'the user-visible reward pointer must attach to the live replacement');
  assert.equal(raceDb.states.get(raceBuyer).target_generation, 1);
  assert.equal(raceDb.states.get(raceBuyer).status, 'applied');
}

// A refund/source revocation that lands after reward reservation but before
// the D1 application CAS must cancel the credit without ever publishing the
// reserved bearer license. This is the historical refund→cron vesting race.
{
  const sourceKv = new FakeKV();
  const sourceDb = new ReferralD1();
  sourceDb.revokeSourceOnIntent = true;
  const sourceBuyer = 'SMESH-SOURCE-REFUNDED';
  const sourceRef = {
    code: 'REF-4444-4444', owner_license_key: null,
    purchases: 0, days_earned: 0, reward_key: null
  };
  await sourceKv.put(`ref:${sourceRef.code}`, JSON.stringify(sourceRef));
  const outcome = await creditReferrerForPurchase(
    { LICENSES: sourceKv, DB: sourceDb }, sourceRef, sourceBuyer
  );
  assert.deepEqual(outcome, { credited: false, reason: 'pending' });
  const sourceState = sourceDb.states.get(sourceBuyer);
  assert.equal(sourceState.status, 'cancelled');
  const reserved = JSON.parse(
    sourceDb.payments.get(`referral|referral:${sourceBuyer}`).license_json
  );
  assert.equal(await sourceKv.get(reserved.key), null,
    'a reward reserved for a revoked purchase must never become a bearer entitlement');
  assert.equal(JSON.parse(await sourceKv.get(`ref:${sourceRef.code}`)).reward_key, null);
}

console.log('referral revoked-target regressions passed');
