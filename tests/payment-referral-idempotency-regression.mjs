import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { issueLicense, findByPayment, putLicense } from '../backend/src/licenses.js';
import {
  creditReferrerForPurchase, hasDurableCredit, resolveReferral,
  retryPendingReferralCredits, withBuyerBonus
} from '../backend/src/referrals.js';

class FakeKV {
  store = new Map();
  failNextPut = false;
  failNextRefPut = false;
  // KV is eventually consistent: a read may miss a row another colo already
  // wrote. staleNullReads[key] = N makes the next N reads of key return null.
  staleNullReads = new Map();
  scriptedReads = new Map();
  refReadCount = 0;
  refReadHook = null;
  async get(key) {
    await Promise.resolve();
    if (key.startsWith('ref:')) {
      this.refReadCount += 1;
      await this.refReadHook?.(key, this.refReadCount);
    }
    const scripted = this.scriptedReads.get(key);
    if (scripted?.length) {
      const value = scripted.shift();
      if (!scripted.length) this.scriptedReads.delete(key);
      return value;
    }
    const stale = this.staleNullReads.get(key) || 0;
    if (stale > 0) {
      this.staleNullReads.set(key, stale - 1);
      return null;
    }
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value) {
    await Promise.resolve();
    if (this.failNextRefPut && key.startsWith('ref:')) {
      this.failNextRefPut = false;
      throw new Error('injected referral record write failure');
    }
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('injected KV write failure');
    }
    this.store.set(key, value);
  }
}

class FakeD1 {
  payments = new Map();
  paymentKeys = new Set();
  referralClaims = new Set();
  referralStates = new Map();
  referralLocks = new Map();
  licenseDevices = new Map();
  kvLocks = new Map();
  kvMaterializations = new Set();
  referralAuthClaims = new Map();
  failNextBatch = false;
  failNextAppliedUpdate = false;

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        const statement = {
          sql,
          args,
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO payment_issuance')) {
              const [gateway, paymentId, licenseKey, licenseJson] = args;
              const id = `${gateway}|${paymentId}`;
              if (db.payments.has(id) || db.paymentKeys.has(licenseKey)) return { meta: { changes: 0 } };
              db.payments.set(id, { license_json: licenseJson });
              db.paymentKeys.add(licenseKey);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO referral_credits')) {
              const [licenseKey, refCode, claimedAt] = args;
              if (db.referralClaims.has(licenseKey)) return { meta: { changes: 0 } };
              db.referralClaims.add(licenseKey, { ref_code: refCode, claimed_at: claimedAt });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO referral_credit_state')) {
              const [licenseKey, refCode, days, createdAt] = args;
              if (db.referralClaims.has(licenseKey) || db.referralStates.has(licenseKey)) {
                return { meta: { changes: 0 } };
              }
              db.referralStates.set(licenseKey, {
                license_key: licenseKey, ref_code: refCode, days,
                status: 'pending', created_at: createdAt, applied_at: null,
                materialized_at: null, target_kind: null, target_key: null, target_expiry: null,
                target_generation: 0, retry_attempts: 0, retry_after: 0, last_error_at: null
              });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET target_kind = ?2')) {
              const [licenseKey, kind, key, expiry] = args;
              const state = db.referralStates.get(licenseKey);
              if (!state || state.status !== 'pending' || state.target_key) return { meta: { changes: 0 } };
              state.target_kind = kind;
              state.target_key = key;
              state.target_expiry = expiry;
              return { meta: { changes: 1 } };
            }
            if (sql.includes("UPDATE referral_credit_state SET status = 'applied'")) {
              if (db.failNextAppliedUpdate) {
                db.failNextAppliedUpdate = false;
                throw new Error('injected applied-state failure');
              }
              const [licenseKey, appliedAt] = args;
              const state = db.referralStates.get(licenseKey);
              if (!state || state.status !== 'pending') return { meta: { changes: 0 } };
              state.status = 'applied';
              state.applied_at = appliedAt;
              return { meta: { changes: 1 } };
            }
            // Materialization is row-scoped (WHERE license_key = ?1) so a sweep
            // cannot clear the retry state of a row it failed to settle.
            if (sql.includes('SET materialized_at = ?2')) {
              const [licenseKey, materializedAt] = args;
              const state = db.referralStates.get(licenseKey);
              if (!state || state.status !== 'applied' || state.materialized_at != null) {
                return { meta: { changes: 0 } };
              }
              state.materialized_at = materializedAt;
              state.retry_attempts = 0;
              state.retry_after = 0;
              state.last_error_at = null;
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM referral_apply_locks')) {
              const [refCode, leaseUntil] = args;
              if (db.referralLocks.get(refCode) !== leaseUntil) return { meta: { changes: 0 } };
              db.referralLocks.delete(refCode);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO referral_auth_claims')) {
              const [authHash, code] = args;
              if (db.referralAuthClaims.has(authHash)) return { meta: { changes: 0 } };
              db.referralAuthClaims.set(authHash, code);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO kv_materializations')) {
              const [name] = args;
              if (db.kvMaterializations.has(name)) return { meta: { changes: 0 } };
              db.kvMaterializations.add(name);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM kv_apply_locks')) {
              const [name, leaseUntil] = args;
              if (db.kvLocks.get(name) !== leaseUntil) return { meta: { changes: 0 } };
              db.kvLocks.delete(name);
              return { meta: { changes: 1 } };
            }
            // purchases analytics mirror
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('SELECT license_json FROM payment_issuance')) {
              return db.payments.get(`${args[0]}|${args[1]}`) || null;
            }
            if (sql.includes('COALESCE(SUM(days), 0) AS days_earned')) {
              const refCode = args[0];
              const applied = [...db.referralStates.values()].filter((state) =>
                state.ref_code === refCode && state.status === 'applied');
              return {
                purchases: applied.length,
                days_earned: applied.reduce((sum, state) => sum + Number(state.days || 0), 0)
              };
            }
            if (sql.includes('MAX(target_expiry)')) {
              let max = null;
              for (const state of db.referralStates.values()) {
                if (state.target_key === args[0] && state.target_expiry &&
                    (!max || state.target_expiry > max)) max = state.target_expiry;
              }
              return { expiry: max };
            }
            if (sql.includes('MAX(retry_attempts) AS attempts')) {
              const attempts = [...db.referralStates.values()]
                .filter((state) => state.ref_code === args[0])
                .reduce((max, state) => Math.max(max, Number(state.retry_attempts) || 0), 0);
              return { attempts };
            }
            if (sql.includes('SELECT target_key FROM referral_credit_state')) {
              const refCode = args[0];
              const reward = [...db.referralStates.values()].filter((state) =>
                state.ref_code === refCode && state.target_kind === 'reward' && state.target_key)
                .sort((left, right) => right.created_at - left.created_at)[0];
              return reward ? { target_key: reward.target_key } : null;
            }
            if (sql.includes('SELECT 1 AS durable FROM referral_credits')) {
              return db.referralClaims.has(args[0]) ? { durable: 1 } : null;
            }
            if (sql.includes('SELECT COUNT(*) AS count')) {
              const refCode = args[0];
              return { count: [...db.referralStates.values()].filter((state) =>
                state.ref_code === refCode && (state.status === 'pending' ||
                  (state.status === 'applied' && state.materialized_at == null))).length };
            }
            if (sql.includes('FROM referral_credit_state WHERE license_key = ?1')) {
              return db.referralStates.get(args[0]) || null;
            }
            if (sql.includes('INSERT INTO referral_apply_locks')) {
              const [refCode, leaseUntil, now] = args;
              const heldUntil = db.referralLocks.get(refCode) || 0;
              if (heldUntil >= now) return null;
              db.referralLocks.set(refCode, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('SELECT code FROM referral_auth_claims')) {
              const code = db.referralAuthClaims.get(args[0]);
              return code ? { code } : null;
            }
            if (sql.includes('SELECT 1 AS done FROM kv_materializations')) {
              return db.kvMaterializations.has(args[0]) ? { done: 1 } : null;
            }
            if (sql.includes('INSERT INTO kv_apply_locks')) {
              const [name, leaseUntil, now] = args;
              const heldUntil = db.kvLocks.get(name) || 0;
              if (heldUntil >= now) return null;
              db.kvLocks.set(name, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('UPDATE kv_apply_locks SET lease_until')) {
              const [name, oldLease, newLease, now] = args;
              if (db.kvLocks.get(name) !== oldLease || oldLease < now) return null;
              db.kvLocks.set(name, newLease);
              return { lease_until: newLease };
            }
            if (sql.includes('UPDATE referral_apply_locks SET lease_until')) {
              const [refCode, oldLease, newLease, now] = args;
              if (db.referralLocks.get(refCode) !== oldLease || oldLease < now) return null;
              db.referralLocks.set(refCode, newLease);
              return { lease_until: newLease };
            }
            return null;
          },
          async all() {
            if (sql.includes('SELECT license_key FROM license_devices')) {
              return { results: (db.licenseDevices.get(args[0]) || []).slice(0, 5)
                .map((license_key) => ({ license_key })) };
            }
            if (sql.includes('FROM referral_credit_state') &&
                sql.includes('WHERE ref_code = ?1') &&
                sql.includes('ORDER BY created_at')) {
              const results = [...db.referralStates.values()].filter((state) =>
                state.ref_code === args[0] && (state.status === 'pending' ||
                  (state.status === 'applied' && state.materialized_at == null)))
                .sort((left, right) => left.created_at - right.created_at)
                .map((state) => ({ ...state }));
              return { results };
            }
            if (sql.includes('GROUP BY ref_code') && sql.includes('MIN(retry_after)')) {
              const [now, limit] = args;
              const earliest = new Map();
              for (const state of db.referralStates.values()) {
                if (state.status !== 'pending' &&
                    !(state.status === 'applied' && state.materialized_at == null)) continue;
                if ((Number(state.retry_after) || 0) > now) continue;
                earliest.set(state.ref_code, Math.min(earliest.get(state.ref_code) ?? Infinity, state.created_at));
              }
              return { results: [...earliest].sort((a, b) => a[1] - b[1])
                .slice(0, limit).map(([ref_code]) => ({ ref_code })) };
            }
            return { results: [] };
          }
        };
        return statement;
      }
    };
  }

  async batch(statements) {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('injected D1 batch failure');
    }
    // Snapshot/restore gives the fake the same all-or-nothing contract as D1
    // if a statement itself throws while a future regression extends a batch.
    const snapshot = {
      payments: new Map(this.payments),
      paymentKeys: new Set(this.paymentKeys),
      referralClaims: new Set(this.referralClaims),
      referralStates: new Map([...this.referralStates].map(([key, value]) => [key, { ...value }])),
      referralLocks: new Map(this.referralLocks),
      licenseDevices: new Map([...this.licenseDevices].map(([key, value]) => [key, [...value]])),
      kvLocks: new Map(this.kvLocks),
      kvMaterializations: new Set(this.kvMaterializations),
      referralAuthClaims: new Map(this.referralAuthClaims)
    };
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }
}

// No D1 claim means the gateway must remain the retry channel.
{
  const env = { LICENSES: new FakeKV(), DB: new FakeD1() };
  assert.equal(await hasDurableCredit(env, 'SMESH-NOT-CLAIMED-KEY'), false);
  assert.equal(await hasDurableCredit({ LICENSES: env.LICENSES }, 'SMESH-NOT-CLAIMED-KEY'), false);
}

// Twenty simultaneous deliveries of one payment must all recover one D1
// winner, even though every invocation can miss the eventually-consistent KV
// payment index before any of them writes it.
{
  const env = { LICENSES: new FakeKV(), DB: new FakeD1() };
  const issued = await Promise.all(Array.from({ length: 20 }, () => issueLicense(env, {
    gateway: 'robokassa',
    payment_id: 'invoice-42',
    email: 'buyer@example.com',
    amount_rub: 1990
  })));
  assert.equal(new Set(issued.map((license) => license.key)).size, 1,
    'one payment must never mint multiple license keys');
  assert.equal(env.DB.payments.size, 1);
  assert.equal((await findByPayment(env, 'robokassa', 'invoice-42')).key, issued[0].key);
}

// A payment claim snapshot only repairs a missing KV row. Once the live row
// exists, webhook replay must preserve revocation, referral expiry, and device
// state accumulated after the original payment.
{
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new FakeD1() };
  const issued = await issueLicense(env, {
    gateway: 'robokassa', payment_id: 'invoice-live-state',
    email: 'buyer@example.com', amount_rub: 1990,
    type: 'subscription', expires_at: '2026-08-16T00:00:00.000Z'
  });
  const live = {
    ...issued,
    status: 'revoked',
    expires_at: '2026-09-30T00:00:00.000Z',
    device_ids: ['device-payment-replay']
  };
  await putLicense(env, live);

  const replayed = await issueLicense(env, {
    gateway: 'robokassa', payment_id: 'invoice-live-state',
    email: 'buyer@example.com', amount_rub: 1990
  });
  assert.equal(replayed.status, 'revoked');
  assert.equal(replayed.expires_at, live.expires_at);
  assert.deepEqual(replayed.device_ids, live.device_ids);
  assert.deepEqual(JSON.parse(await kv.get(issued.key)), live,
    'payment replay must not overwrite the live license with its D1 snapshot');
  assert.deepEqual(await findByPayment(env, 'robokassa', 'invoice-live-state'), live,
    'payment lookup must prefer the live KV row too');

  // Once the row is materialized, a replay whose KV read comes back stale-null
  // (eventual consistency) must NOT resurrect the issue-time snapshot over the
  // revoked live row — the exact TOCTOU that used to turn
  // {revoked, [device]} back into {active, []}.
  kv.staleNullReads.set(issued.key, 10);
  const staleReplay = await issueLicense(env, {
    gateway: 'robokassa', payment_id: 'invoice-live-state',
    email: 'buyer@example.com', amount_rub: 1990
  });
  kv.staleNullReads.delete(issued.key);
  assert.equal(staleReplay.key, issued.key);
  assert.deepEqual(JSON.parse(kv.store.get(issued.key)), live,
    'a stale-null KV read during webhook replay must never overwrite the mutated live row');
}

// The genuine crash seam the D1 snapshot exists for: the claim committed but
// the invocation died before the KV license row was EVER written. The
// materialization flag is still unset, so a retry must complete the write.
{
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new FakeD1() };
  kv.failNextPut = true;
  await assert.rejects(issueLicense(env, {
    gateway: 'robokassa', payment_id: 'invoice-crash-seam',
    email: 'buyer@example.com', amount_rub: 1990
  }), /injected KV write failure/);

  const recovered = await issueLicense(env, {
    gateway: 'robokassa', payment_id: 'invoice-crash-seam',
    email: 'buyer@example.com', amount_rub: 1990
  });
  assert.ok(recovered.key, 'the retry must recover the claimed license');
  assert.deepEqual(JSON.parse(await kv.get(recovered.key)), recovered,
    'a crash before the first KV write must still be recovered from the D1 snapshot');
  assert.equal(await kv.get('payment:robokassa:invoice-crash-seam'), recovered.key);
}

// A materializer can spend longer than its lease in an eventually
// consistent KV read. If another invocation takes the D1 lock in that gap, the
// stale holder must fence itself before replaying the issue-time snapshot;
// otherwise it can erase a revocation/device/expiry mutation that already
// landed in the live row.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db };
  const snapshot = {
    key: 'SMESH-LEASE-FENCE', type: 'subscription', status: 'active',
    email: 'buyer@example.com', telegram_user_id: null,
    issued_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-08-01T00:00:00.000Z',
    payment_id: 'invoice-lease-fence', gateway: 'robokassa', amount_rub: 1990,
    is_preorder: false, device_ids: [], note: null
  };
  const live = {
    ...snapshot,
    status: 'revoked',
    expires_at: '2026-09-01T00:00:00.000Z',
    device_ids: ['device-after-issue']
  };
  db.payments.set('robokassa|invoice-lease-fence', { license_json: JSON.stringify(snapshot) });
  db.paymentKeys.add(snapshot.key);
  kv.store.set(snapshot.key, JSON.stringify(live));

  const originalGet = kv.get.bind(kv);
  let licenseReads = 0;
  kv.get = async (key) => {
    if (key === snapshot.key && ++licenseReads === 2) {
      // Model a stale-null read that finishes only after another materializer
      // has taken over the expired lease.
      const name = `license:${snapshot.key}`;
      db.kvLocks.set(name, (db.kvLocks.get(name) || Date.now()) + 60_000);
      return null;
    }
    return originalGet(key);
  };

  await assert.rejects(issueLicense(env, {
    gateway: 'robokassa', payment_id: snapshot.payment_id,
    email: snapshot.email, amount_rub: snapshot.amount_rub
  }), /materialization lease lost/);
  assert.deepEqual(JSON.parse(kv.store.get(snapshot.key)), live,
    'a lapped materializer must not overwrite the newer live license snapshot');
}

// Two distinct purchases for one code must serialize their KV updates: both
// counters and the target expiry retain the sum rather than last-writer-wins.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = {
    code: 'REF-ABCD-EFGH',
    owner_device_id: 'device-referrer',
    owner_license_key: null,
    purchases: 0,
    days_earned: 0,
    reward_key: null
  };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  const startedAt = Date.now();
  const outcomes = await Promise.all([
    creditReferrerForPurchase(env, ref, 'SMESH-PAID-ONE-KEY'),
    creditReferrerForPurchase(env, ref, 'SMESH-PAID-TWO-KEY')
  ]);
  assert.equal(outcomes.filter((result) => result.credited).length, 2);
  assert.equal(db.referralClaims.size, 2);
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 2);
  assert.equal(stored.days_earned, 14);
  const reward = JSON.parse(await kv.get(stored.reward_key));
  assert.ok(Date.parse(reward.expires_at) >= startedAt + 14 * 24 * 60 * 60 * 1000,
    'the reward expiry must include both serialized seven-day credits');
}

// Once D1 marks a credit applied, a failed KV materialization remains an
// applied-but-unmaterialized work item. Redelivery completes that same state
// exactly once; it does not create a second reward.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = {
    code: 'REF-RETRY-TEST', owner_device_id: 'device-referrer',
    owner_license_key: null, purchases: 0, days_earned: 0, reward_key: null
  };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  kv.failNextPut = true;
  await assert.rejects(creditReferrerForPurchase(env, ref, 'SMESH-PAID-RETRY-KEY'),
    /injected KV write failure/);
  assert.equal(db.referralStates.get('SMESH-PAID-RETRY-KEY').status, 'applied');
  assert.equal(await hasDurableCredit(env, 'SMESH-PAID-RETRY-KEY'), true,
    'a post-batch failure is safe to ack because its claim is durable');

  const retried = await creditReferrerForPurchase(env, ref, 'SMESH-PAID-RETRY-KEY');
  assert.equal(retried.credited, true);
  assert.equal(db.referralStates.get('SMESH-PAID-RETRY-KEY').status, 'applied');
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 1);
  assert.equal(stored.days_earned, 7);
  assert.equal((await creditReferrerForPurchase(env, ref, 'SMESH-PAID-RETRY-KEY')).reason, 'already');
}

// The initial state+claim creation is one D1 transaction. A batch-level
// failure leaves neither half behind, so redelivery can create and apply both.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = {
    code: 'REF-BATCH-FAIL', owner_device_id: 'device-referrer',
    owner_license_key: null, purchases: 0, days_earned: 0, reward_key: null
  };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  db.failNextBatch = true;
  await assert.rejects(creditReferrerForPurchase(env, ref, 'SMESH-PAID-BATCH-KEY'),
    /injected D1 batch failure/);
  assert.equal(db.referralClaims.has('SMESH-PAID-BATCH-KEY'), false,
    'a failed atomic batch must not leave a claim without state');
  assert.equal(db.referralStates.has('SMESH-PAID-BATCH-KEY'), false,
    'a failed atomic batch must not leave state without a claim');
  assert.equal(await hasDurableCredit(env, 'SMESH-PAID-BATCH-KEY'), false,
    'a failed journal batch must force gateway redelivery');

  const retried = await creditReferrerForPurchase(env, ref, 'SMESH-PAID-BATCH-KEY');
  assert.equal(retried.credited, true);
  assert.equal(db.referralClaims.has('SMESH-PAID-BATCH-KEY'), true);
  assert.equal(db.referralStates.get('SMESH-PAID-BATCH-KEY').status, 'applied');
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 1);
  assert.equal(stored.days_earned, 7);
  assert.equal((await creditReferrerForPurchase(env, ref, 'SMESH-PAID-BATCH-KEY')).reason, 'already');
}

// A pre-journal claim intentionally gains no pending row: replaying it could
// double-pay a reward that the legacy implementation already wrote to KV.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const licenseKey = 'SMESH-LEGACY-CLAIM-KEY';
  db.referralClaims.add(licenseKey);
  const ref = { code: 'REF-OLD1-PAID', purchases: 1, days_earned: 7 };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  const result = await creditReferrerForPurchase({ LICENSES: kv, DB: db }, ref, licenseKey);
  assert.deepEqual(result, { credited: false, reason: 'already' });
  assert.equal(db.referralStates.has(licenseKey), false);
}

// Device-linked licenses supply identity even when the invite record itself
// was created before the referrer owned any license.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const ownerDevice = 'device-unlicensed-referrer';
  const linkedKey = 'SMESH-DEVICE-LINK-KEY';
  const ref = {
    code: 'REF-LINK-TEST', owner_device_id: ownerDevice,
    owner_license_key: null, reward_key: null, purchases: 0, days_earned: 0
  };
  db.licenseDevices.set(ownerDevice, [linkedKey]);
  await kv.put(linkedKey, JSON.stringify({
    key: linkedKey, status: 'active', type: 'lifetime',
    email: 'linked@example.com', telegram_user_id: null
  }));
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  assert.deepEqual(await resolveReferral({ LICENSES: kv, DB: db }, {
    code: ref.code, buyerEmail: ' LINKED@example.com '
  }), { valid: false, reason: 'self_referral' });
  assert.equal((await resolveReferral({ LICENSES: kv, DB: db }, {
    code: ref.code, buyerEmail: 'different@example.com'
  })).valid, true);
}

// A failed source/target CAS happens before the owner entitlement write. A
// retry applies exactly one seven-day credit, never zero or two.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const ownerKey = 'SMESH-OWNER-REPLAY-KEY';
  const originalExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const ref = {
    code: 'REF-OWNER-SAFE', owner_license_key: ownerKey,
    purchases: 0, days_earned: 0, reward_key: null
  };
  await kv.put(ownerKey, JSON.stringify({
    key: ownerKey, status: 'active', type: 'subscription', expires_at: originalExpiry
  }));
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  db.failNextAppliedUpdate = true;
  await assert.rejects(creditReferrerForPurchase(
    { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' }, ref, 'SMESH-OWNER-CREDIT-KEY'
  ), /injected applied-state failure/);
  assert.equal(JSON.parse(await kv.get(ownerKey)).expires_at, originalExpiry,
    'a failed D1 authorization must not mutate the owner entitlement');

  const retried = await creditReferrerForPurchase(
    { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' }, ref, 'SMESH-OWNER-CREDIT-KEY'
  );
  assert.equal(retried.credited, true);
  assert.equal(
    JSON.parse(await kv.get(ownerKey)).expires_at,
    db.referralStates.get('SMESH-OWNER-CREDIT-KEY').target_expiry,
    'retry after failed authorization must materialize its one frozen expiry'
  );
  assert.equal(db.referralStates.get('SMESH-OWNER-CREDIT-KEY').status, 'applied');
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 1);
  assert.equal(stored.days_earned, 7);
  assert.equal(stored.legacy_purchases, 0);
  assert.equal(stored.legacy_days_earned, 0);
}

// Reward reservation uses payment_issuance, but does not expose a bearer
// license before the source/target CAS succeeds. Retry materializes exactly
// the reserved key and expiry.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = { code: 'REF-MINT-SAFE', purchases: 0, days_earned: 0, reward_key: null };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  db.failNextAppliedUpdate = true;
  await assert.rejects(creditReferrerForPurchase(env, ref, 'SMESH-MINT-CREDIT-KEY'),
    /injected applied-state failure/);
  const state = db.referralStates.get('SMESH-MINT-CREDIT-KEY');
  const mintedKey = state.target_key;
  const mintedExpiry = state.target_expiry;
  assert.equal(await kv.get(mintedKey), null,
    'a failed source authorization must leave the reserved bearer key unmaterialized');

  await creditReferrerForPurchase(env, ref, 'SMESH-MINT-CREDIT-KEY');
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.reward_key, mintedKey);
  assert.equal(JSON.parse(await kv.get(mintedKey)).expires_at, mintedExpiry);
  const rewardLicenses = [...kv.store.values()].flatMap((raw) => {
    try { const value = JSON.parse(raw); return value?.gateway === 'referral' ? [value] : []; }
    catch { return []; }
  });
  assert.equal(rewardLicenses.length, 1, 'mint retry must materialize exactly one reward license');
}

// A later purchase sweeps an earlier stranded row under the same code before
// applying itself, preserving both credits and their ordered expiry sum.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = { code: 'REF-SWEEP-ALL', purchases: 0, days_earned: 0, reward_key: null };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  const startedAt = Date.now();
  db.failNextAppliedUpdate = true;
  await assert.rejects(creditReferrerForPurchase(env, ref, 'SMESH-SWEEP-FIRST'),
    /injected applied-state failure/);
  const second = await creditReferrerForPurchase(env, ref, 'SMESH-SWEEP-SECOND');
  assert.equal(second.credited, true);
  assert.equal(db.referralStates.get('SMESH-SWEEP-FIRST').status, 'applied');
  assert.equal(db.referralStates.get('SMESH-SWEEP-SECOND').status, 'applied');
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 2);
  assert.equal(stored.days_earned, 14);
  const reward = JSON.parse(await kv.get(stored.reward_key));
  assert.ok(Date.parse(reward.expires_at) >= startedAt + 14 * 24 * 60 * 60 * 1000);
}

// Operator recovery applies a durable row even if no later buyer uses the code.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = { code: 'REF-ADMIN-FIX', purchases: 0, days_earned: 0, reward_key: null };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  db.failNextAppliedUpdate = true;
  await assert.rejects(creditReferrerForPurchase(env, ref, 'SMESH-ADMIN-PENDING'),
    /injected applied-state failure/);
  const recovered = await retryPendingReferralCredits(env);
  assert.deepEqual(recovered, { codes: 1, applied: 1, still_pending: 0, stalled: 0 },
    'a clean recovery reports no rows left stuck on a dead target');
  assert.equal(db.referralStates.get('SMESH-ADMIN-PENDING').status, 'applied');
}

// Applied entitlement is not enough: if the final ref:* write fails, NULL
// materialized_at keeps the code discoverable until recovery rebuilds the
// reward pointer and counters from D1.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = { code: 'REF-MATERIAL-X', purchases: 0, days_earned: 0, reward_key: null };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  kv.failNextRefPut = true;
  await assert.rejects(creditReferrerForPurchase(env, ref, 'SMESH-MATERIAL-KEY'),
    /injected referral record write failure/);
  const state = db.referralStates.get('SMESH-MATERIAL-KEY');
  assert.equal(state.status, 'applied');
  assert.equal(state.materialized_at, null);
  assert.equal(await hasDurableCredit(env, 'SMESH-MATERIAL-KEY'), true);

  const recovered = await retryPendingReferralCredits(env);
  assert.deepEqual(recovered, { codes: 1, applied: 0, still_pending: 0, stalled: 0 });
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.reward_key, state.target_key);
  assert.equal(stored.purchases, 1);
  assert.equal(stored.days_earned, 7);
  assert.ok(db.referralStates.get('SMESH-MATERIAL-KEY').materialized_at);
  assert.deepEqual(await retryPendingReferralCredits(env),
    { codes: 0, applied: 0, still_pending: 0, stalled: 0 },
    'a materialized credit must disappear from recovery scans');
}

// The first journal materialization captures old KV counters as a permanent
// baseline. Re-materialization derives baseline + D1 again instead of either
// swallowing the new row or counting it twice.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = { code: 'REF-LEGACY-SUM', purchases: 5, days_earned: 35, reward_key: null };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  const credited = await creditReferrerForPurchase(env, ref, 'SMESH-LEGACY-NEW');
  assert.equal(credited.credited, true);
  let stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 6);
  assert.equal(stored.days_earned, 42);
  assert.equal(stored.legacy_purchases, 5);
  assert.equal(stored.legacy_days_earned, 35);

  db.referralStates.get('SMESH-LEGACY-NEW').materialized_at = null;
  assert.deepEqual(await retryPendingReferralCredits(env),
    { codes: 1, applied: 0, still_pending: 0, stalled: 0 });
  stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(stored.purchases, 6, 'replay must not add the journal row twice');
  assert.equal(stored.days_earned, 42);
  assert.equal(stored.legacy_purchases, 5);
  assert.equal(stored.legacy_days_earned, 35);
}

// Audit B-03: a colo whose KV read lags must not re-base a new credit below
// days an earlier credit already promised. The intent base is the max of the
// KV row and every expiry the D1 journal ever recorded for the target, so
// journaled days always equal days actually landed on the reward.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ref = { code: 'REF-STALE-BASE', purchases: 0, days_earned: 0, reward_key: null };
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  const startedAt = Date.now();
  assert.equal((await creditReferrerForPurchase(env, ref, 'SMESH-STALE-ONE')).credited, true);
  assert.equal((await creditReferrerForPurchase(env, ref, 'SMESH-STALE-TWO')).credited, true);
  const stored = JSON.parse(await kv.get(`ref:${ref.code}`));
  const reward = JSON.parse(await kv.get(stored.reward_key));
  // Simulate another colo's stale KV view: rewind the reward row to its
  // post-first-credit expiry, as if the second credit's write never replicated
  // to the colo that processes the third purchase.
  const staleExpiry = new Date(startedAt + 7 * 24 * 60 * 60 * 1000).toISOString();
  await kv.put(stored.reward_key, JSON.stringify({ ...reward, expires_at: staleExpiry }));

  assert.equal((await creditReferrerForPurchase(env, ref, 'SMESH-STALE-THREE')).credited, true);
  const after = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(after.days_earned, 21);
  const finalReward = JSON.parse(await kv.get(after.reward_key));
  assert.ok(Date.parse(finalReward.expires_at) >= startedAt + 21 * 24 * 60 * 60 * 1000,
    `all 21 journaled days must land on the reward expiry (got ${finalReward.expires_at})`);
}

// Two different referral codes can legitimately point at the same owner
// subscription. Per-code leases do not serialize that shared entitlement:
// simultaneous purchases must reserve consecutive absolute expiries under a
// target-scoped D1 lease, or both journal seven days against the same +7 date.
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const ownerKey = 'SMESH-SHARED-OWNER-KEY';
  const originalExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await kv.put(ownerKey, JSON.stringify({
    key: ownerKey, status: 'active', type: 'subscription', expires_at: originalExpiry
  }));
  const refA = {
    code: 'REF-TARGET-LOCK-A', owner_license_key: ownerKey,
    purchases: 0, days_earned: 0, reward_key: null
  };
  const refB = {
    code: 'REF-TARGET-LOCK-B', owner_license_key: ownerKey,
    purchases: 0, days_earned: 0, reward_key: null
  };
  await kv.put(`ref:${refA.code}`, JSON.stringify(refA));
  await kv.put(`ref:${refB.code}`, JSON.stringify(refB));

  const [creditA, creditB] = await Promise.all([
    creditReferrerForPurchase(env, refA, 'SMESH-CROSS-CODE-PAID-A'),
    creditReferrerForPurchase(env, refB, 'SMESH-CROSS-CODE-PAID-B')
  ]);
  assert.equal(creditA.credited, true);
  assert.equal(creditB.credited, true);
  const finalOwner = JSON.parse(await kv.get(ownerKey));
  assert.ok(Date.parse(finalOwner.expires_at) >= Date.parse(originalExpiry) + 14 * 24 * 60 * 60 * 1000,
    `two journaled credits must land fourteen days (got ${finalOwner.expires_at})`);
  const targets = [
    db.referralStates.get('SMESH-CROSS-CODE-PAID-A'),
    db.referralStates.get('SMESH-CROSS-CODE-PAID-B')
  ];
  assert.equal(new Set(targets.map((state) => state.target_expiry)).size, 2,
    'shared-target intents must reserve distinct consecutive absolute expiries');
}

// Static checkout omits device_id, so delivery identity must reject a buyer
// using the owner/reward license's email. A different buyer remains eligible.
{
  const kv = new FakeKV();
  const env = { LICENSES: kv };
  const ownerKey = 'SMESH-OWNER-EMAIL-KEY';
  const ref = {
    code: 'REF-SELF-TEST', owner_device_id: 'device-referrer',
    owner_license_key: ownerKey, purchases: 0, days_earned: 0, reward_key: null
  };
  await kv.put(ownerKey, JSON.stringify({
    key: ownerKey, status: 'active', type: 'subscription',
    email: ' Owner@Example.com ', telegram_user_id: 12345
  }));
  await kv.put(`ref:${ref.code}`, JSON.stringify(ref));
  const self = await resolveReferral(env, { code: ref.code, buyerEmail: 'owner@example.com' });
  assert.deepEqual(self, { valid: false, reason: 'self_referral' });
  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(self.valid ? withBuyerBonus(env, expiry) : expiry, expiry,
    'a self-referrer must not receive the buyer bonus');

  const friend = await resolveReferral(env, {
    code: ref.code, buyerEmail: 'friend@example.com', buyerTelegramId: 67890
  });
  assert.equal(friend.valid, true, 'a genuinely different buyer remains eligible for both rewards');
  assert.notEqual(withBuyerBonus(env, expiry), expiry);
  const friendCredit = await creditReferrerForPurchase(env, friend.ref, 'SMESH-FRIEND-PAID-KEY');
  assert.equal(friendCredit.credited, true);
  const afterFriend = JSON.parse(await kv.get(`ref:${ref.code}`));
  assert.equal(afterFriend.purchases, 1, 'the genuinely different buyer must credit the referrer too');
  assert.equal(afterFriend.days_earned, 7);
}

// Recovering a referral claim whose KV read comes back stale-null must never
// reset a record that a concurrent purchase already credited: the write-once
// flag (set at creation and by every sweep) blocks the zeroed initial record.
{
  const { getOrCreateCode } = await import('../backend/src/referrals.js');
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const auth = Buffer.alloc(32, 0x66).toString('base64url');
  const device = 'device-materialize-owner';

  const created = await getOrCreateCode(env, device, null, auth, null);
  assert.equal(created.ok, true);
  const ref = JSON.parse(await kv.get(`ref:${created.code}`));
  const credit = await creditReferrerForPurchase(env, ref, 'SMESH-MATERIALIZE-PAID');
  assert.equal(credit.credited, true);
  const credited = JSON.parse(await kv.get(`ref:${created.code}`));
  assert.equal(credited.purchases, 1);

  // Simulate a delayed claim recovery: pointers lost, and every KV read of the
  // record observes an eventually-consistent null while the credit above is live.
  kv.store.delete(`refauth:${[...db.referralAuthClaims.keys()][0]}`);
  kv.staleNullReads.set(`ref:${created.code}`, 10);
  const recovered = await getOrCreateCode(env, device, null, auth, null);
  kv.staleNullReads.delete(`ref:${created.code}`);
  assert.equal(recovered.code, created.code, 'recovery must return the D1-claimed code');
  const after = JSON.parse(kv.store.get(`ref:${created.code}`));
  assert.equal(after.purchases, credited.purchases,
    'claim recovery with a stale-null read must not reset credited purchases');
  assert.equal(after.days_earned, credited.days_earned);
  assert.equal(after.reward_key, credited.reward_key,
    'claim recovery must not detach the minted reward license');
}

// The crash seam the recovery path exists for: the D1 claim committed but the
// invocation died before the initial ref record was ever written (flag unset).
{
  const { getOrCreateCode } = await import('../backend/src/referrals.js');
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new FakeD1() };
  const auth = Buffer.alloc(32, 0x77).toString('base64url');
  const device = 'device-crash-owner';

  kv.failNextRefPut = true;
  await assert.rejects(getOrCreateCode(env, device, null, auth, null),
    /injected referral record write failure/);
  const retried = await getOrCreateCode(env, device, null, auth, null);
  assert.equal(retried.ok, true);
  const record = JSON.parse(await kv.get(`ref:${retried.code}`));
  assert.equal(record.purchases, 0,
    'a crash before the first record write must still materialize the claimed code');
}

// Audit B-04: a referral-code refresh (the Settings page re-sending its
// license pointer) must never rewrite a stale pre-payout view of the record.
// No-op refreshes write nothing at all; a real pointer change goes through
// the leased path and rebuilds counters + reward pointer from the D1 journal.
{
  const { getOrCreateCode } = await import('../backend/src/referrals.js');
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, REFERRAL_PAID_DAYS: '7' };
  const auth = Buffer.alloc(32, 0x44).toString('base64url');
  const created = await getOrCreateCode(env, 'device-refresh-owner', null, auth, null);
  assert.equal(created.ok, true);
  const initial = JSON.parse(await kv.get(`ref:${created.code}`));
  const credit = await creditReferrerForPurchase(env, initial, 'SMESH-REFRESH-PAID');
  assert.equal(credit.credited, true);
  const credited = JSON.parse(await kv.get(`ref:${created.code}`));
  assert.equal(credited.purchases, 1);
  assert.ok(credited.reward_key);

  // A refresh with nothing to change must not write the record at all — any
  // write here trips the injected failure and fails the test loudly.
  kv.failNextRefPut = true;
  const idle = await getOrCreateCode(env, 'device-refresh-owner', null, auth, null);
  assert.equal(idle.ok, true, 'a no-op refresh must not rewrite the referral record');
  kv.failNextRefPut = false;

  // A real pointer change riding a STALE KV read (a colo that never saw the
  // payout) must restore the journal state instead of persisting the
  // pre-payout view that erased the reward pointer and counters.
  await kv.put(`ref:${created.code}`, JSON.stringify(initial));
  const refreshed = await getOrCreateCode(
    env, 'device-refresh-owner', 'SMESH-REFRESH-OWN1', auth, null
  );
  assert.equal(refreshed.ok, true);
  const after = JSON.parse(await kv.get(`ref:${created.code}`));
  assert.equal(after.owner_license_key, 'SMESH-REFRESH-OWN1');
  assert.equal(after.purchases, 1,
    'a stale refresh write must not reset credited purchases');
  assert.equal(after.days_earned, 7);
  assert.equal(after.reward_key, credited.reward_key,
    'a stale refresh write must not detach the materialized reward license');
}

// A slow KV read can outlive the 15-second D1 lease. Both initial
// materialization and authenticated mutation must renew/fence BEFORE their KV
// write; if another holder took over, the expired invocation aborts without
// resetting or creating the row.
{
  const { getOrCreateCode } = await import('../backend/src/referrals.js');

  const createKv = new FakeKV();
  const createDb = new FakeD1();
  createKv.refReadHook = async (key, count) => {
    if (count === 2) createDb.referralLocks.set(key.slice(4), Date.now() + 30_000);
  };
  await assert.rejects(
    getOrCreateCode(
      { LICENSES: createKv, DB: createDb },
      'device-expired-create-lease', null, Buffer.alloc(32, 0x41).toString('base64url'), null
    ),
    /referral lease lost/,
    'materialization must stop when its lease is taken during a slow KV read'
  );
  assert.equal([...createKv.store.keys()].some((key) => key.startsWith('ref:')), false,
    'an expired materializer must not write its initial zeroed snapshot');

  const mutateKv = new FakeKV();
  const mutateDb = new FakeD1();
  const mutateEnv = { LICENSES: mutateKv, DB: mutateDb };
  const mutateAuth = Buffer.alloc(32, 0x42).toString('base64url');
  const created = await getOrCreateCode(
    mutateEnv, 'device-expired-mutate-lease', null, mutateAuth, null
  );
  mutateKv.refReadCount = 0;
  mutateKv.refReadHook = async (key, count) => {
    if (count === 2) mutateDb.referralLocks.set(key.slice(4), Date.now() + 30_000);
  };
  await assert.rejects(
    getOrCreateCode(
      mutateEnv, 'device-expired-mutate-lease', 'SMESH-EXPIRED-LEASE', mutateAuth, created.code
    ),
    /referral lease lost/,
    'mutation must stop when its lease is taken during a slow KV read'
  );
  const unchanged = JSON.parse(await mutateKv.get(`ref:${created.code}`));
  assert.equal(unchanged.owner_license_key, null,
    'an expired mutator must not overwrite the takeover generation');
}

// An authenticated refresh can observe different KV generations across its
// initial authorization read and its leased mutation read. A stale legacy
// generation with no auth_hash must not strip the capability binding when the
// owner-license pointer is updated.
{
  const { getOrCreateCode } = await import('../backend/src/referrals.js');
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db };
  const auth = Buffer.alloc(32, 0x31).toString('base64url');
  const device = 'device-auth-generation-race';
  const created = await getOrCreateCode(env, device, null, auth, null);
  const current = JSON.parse(await kv.get(`ref:${created.code}`));
  const legacy = { ...current };
  delete legacy.auth_hash;
  kv.scriptedReads.set(`ref:${created.code}`, [
    JSON.stringify(current),
    JSON.stringify(legacy)
  ]);

  const refreshed = await getOrCreateCode(
    env, device, 'SMESH-AUTH-RACE-OWNER', auth, created.code
  );
  assert.equal(refreshed.ok, true);
  const after = JSON.parse(await kv.get(`ref:${created.code}`));
  assert.equal(after.auth_hash, current.auth_hash,
    'a leased write must preserve the authenticated capability digest');
  assert.equal(after.owner_license_key, 'SMESH-AUTH-RACE-OWNER');
}

await assert.rejects(
  issueLicense({ LICENSES: new FakeKV() }, { gateway: 'robokassa', payment_id: 'unsafe' }),
  /registry unavailable/,
  'paid issuance must fail closed without atomic storage'
);

const [schema, workerSource] = await Promise.all([
  readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'),
  readFile(new URL('../backend/src/worker.js', import.meta.url), 'utf8')
]);
assert.match(schema, /CREATE TABLE IF NOT EXISTS referral_credit_state/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS referral_apply_locks/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS referral_auth_claims/);
assert.match(schema, /target_kind TEXT/);
assert.match(schema, /target_key\s+TEXT/);
assert.match(schema, /target_expiry TEXT/);
assert.match(schema, /materialized_at INTEGER/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS kv_materializations/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS kv_apply_locks/);
assert.match(schema, /CREATE TABLE IF NOT EXISTS delivery_outbox/);
assert.match(workerSource, /buyerEmail:\s*order\.email/,
  'the payment webhook must pass its reliable delivery email to self-referral detection');
assert.match(workerSource, /buyerTelegramId:\s*order\.telegram_user_id/);
assert.match(workerSource, /\/admin\/referral\/retry-pending/);
assert.match(workerSource, /hasDurableCredit\(env, license\.key\)/,
  'the webhook catch must distinguish durable recovery from a lost journal batch');
const nonDurableBranch = [...workerSource.matchAll(/if \(!durable\) \{([\s\S]*?)\n\s*\}/g)]
  .map((match) => match[1])
  .find((branch) => branch.includes('deliverAndSettle(env, license, frozenPreorder)')) || '';
assert.ok(nonDurableBranch.indexOf('ctx.waitUntil(deliverAndSettle(env, license, frozenPreorder))') >= 0,
  'a lost referral journal batch must still schedule the buyer\'s paid key delivery');
assert.ok(nonDurableBranch.indexOf('ctx.waitUntil(deliverAndSettle(env, license, frozenPreorder))') <
  nonDurableBranch.indexOf("return error(500, 'referral_credit_retry')"),
  'buyer delivery must be scheduled before the webhook asks Robokassa to retry');
assert.ok(workerSource.indexOf('await enqueueDelivery(env, license, frozenPreorder)') <
  workerSource.indexOf('referrals.creditReferrerForPurchase(env, frozenReferral, license.key)'),
  'durable delivery state must be persisted before any path can ask the gateway to stop retrying');
assert.match(workerSource, /`delivered:\$\{license\.key\}`/,
  'gateway redelivery must not resend the same key');
assert.match(workerSource, /deliverKey\(env, license, !!body\.is_preorder, \{ force: true \}\)/,
  'manual admin delivery must bypass gateway dedup intentionally');

console.log('payment and referral idempotency regressions passed');
