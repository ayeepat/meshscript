import assert from 'node:assert/strict';
import {
  recoverPaymentLicense,
  verifyLicense
} from '../backend/src/licenses.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class PaymentD1 {
  payments = new Map();
  materialized = new Set();
  locks = new Map();
  revocations = new Map();

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO payment_issuance')) {
              const id = `${args[0]}|${args[1]}`;
              if (db.payments.has(id)) return { meta: { changes: 0 } };
              db.payments.set(id, { license_json: args[3] });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO kv_materializations')) {
              db.materialized.add(args[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM kv_apply_locks')) {
              if (db.locks.get(args[0]) === args[1]) db.locks.delete(args[0]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } }; // analytics mirror
          },
          async first() {
            if (sql.includes('SELECT license_json FROM payment_issuance')) {
              return db.payments.get(`${args[0]}|${args[1]}`) || null;
            }
            if (sql.includes('SELECT 1 AS done FROM kv_materializations')) {
              return db.materialized.has(args[0]) ? { done: 1 } : null;
            }
            if (sql.includes('INSERT INTO kv_apply_locks')) {
              const [name, leaseUntil, now] = args;
              if ((db.locks.get(name) || 0) >= now) return null;
              db.locks.set(name, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('UPDATE kv_apply_locks SET lease_until')) {
              const [name, oldLease, newLease, now] = args;
              if (db.locks.get(name) !== oldLease || oldLease < now) return null;
              db.locks.set(name, newLease);
              return { lease_until: newLease };
            }
            if (sql.includes('FROM license_revocations')) {
              return db.revocations.get(args[0]) || null;
            }
            return null;
          }
        };
      }
    };
  }
}

// A committed payment claim is recoverable without re-deriving mutable plan
// configuration, and recovery never overwrites a newer live KV mutation.
{
  const kv = new FakeKV();
  const db = new PaymentD1();
  const env = { LICENSES: kv, DB: db };
  const snapshot = {
    key: 'SMESH-PAID-CLAIM',
    type: 'subscription',
    status: 'active',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-08-01T00:00:00.000Z',
    payment_id: '77',
    gateway: 'robokassa',
    amount_rub: 500,
    device_ids: []
  };
  db.payments.set('robokassa|77', { license_json: JSON.stringify(snapshot) });

  const recovered = await recoverPaymentLicense(env, 'robokassa', '77');
  assert.equal(recovered.key, snapshot.key);
  assert.deepEqual(JSON.parse(await kv.get(snapshot.key)), snapshot,
    'a claim committed before KV materialization must repair the missing row');
  assert.equal(await kv.get('payment:robokassa:77'), snapshot.key);

  const live = {
    ...snapshot,
    expires_at: '2026-09-01T00:00:00.000Z',
    device_ids: ['device-0001-uuid']
  };
  await kv.put(snapshot.key, JSON.stringify(live));
  const replay = await recoverPaymentLicense(env, 'robokassa', '77');
  assert.deepEqual(replay, live, 'the live row must win over the immutable recovery snapshot');
  assert.deepEqual(JSON.parse(await kv.get(snapshot.key)), live,
    'recovery must not roll back referral/device/revocation-era live mutations');
  assert.equal(await recoverPaymentLicense(env, 'robokassa', 'missing'), null);
}

// A refund recorded after the payment claim but before its KV materialization
// marker must never let recovery re-surface or re-deliver the active snapshot.
{
  const kv = new FakeKV();
  const db = new PaymentD1();
  const env = { LICENSES: kv, DB: db };
  const snapshot = {
    key: 'SMESH-PAID-REFUNDED',
    type: 'lifetime',
    status: 'active',
    issued_at: '2026-01-01T00:00:00.000Z',
    expires_at: null,
    payment_id: '78',
    gateway: 'robokassa',
    amount_rub: 500,
    device_ids: []
  };
  db.payments.set('robokassa|78', { license_json: JSON.stringify(snapshot) });
  db.revocations.set(snapshot.key, { revoked_at: Date.now() - 1_000, reason: 'refund' });

  const recovered = await recoverPaymentLicense(env, 'robokassa', '78');
  assert.equal(recovered.status, 'revoked',
    'payment recovery must overlay the authoritative revocation');
  assert.equal(JSON.parse(await kv.get(snapshot.key)).status, 'revoked',
    'a missing materialization marker must not rewrite an active snapshot after refund');
  assert.equal(db.materialized.has(`license:${snapshot.key}`), true);
}

const seed = (kv, key, patch = {}) => kv.store.set(key, JSON.stringify({
  key,
  type: 'lifetime',
  status: 'active',
  expires_at: null,
  device_ids: [],
  ...patch
}));

// Unknown license types cannot fall through as eternal authorization.
{
  const kv = new FakeKV();
  seed(kv, 'SMESH-CORRUPT-TYPE', { type: 'premium' });
  const result = await verifyLicense({ LICENSES: kv }, 'SMESH-CORRUPT-TYPE', '');
  assert.deepEqual(result, { ok: false, reason: 'service_unavailable' });
}

// Any value other than the reviewed one-device policy fails closed before the
// activation registry is touched.
for (const configured of ['0', '-1', '2', '3', '3.5', '65', 'not-a-number']) {
  const kv = new FakeKV();
  const known = 'device-0001-uuid';
  seed(kv, 'SMESH-BAD-CAP', { device_ids: [known] });
  let deviceRegistryCalls = 0;
  const DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('license_revocations')) return null;
              deviceRegistryCalls += 1;
              return null;
            },
            async run() { deviceRegistryCalls += 1; return { meta: { changes: 0 } }; }
          };
        }
      };
    }
  };
  const env = { LICENSES: kv, DB, DEVICE_LIMIT: configured };
  assert.equal((await verifyLicense(env, 'SMESH-BAD-CAP', known)).reason,
    'service_unavailable');
  assert.equal((await verifyLicense(env, 'SMESH-BAD-CAP', 'device-0002-uuid')).reason,
    'service_unavailable');
  assert.equal(deviceRegistryCalls, 0, `invalid cap ${configured} must not reach the slot registry`);
}

console.log('license/payment-claim hardening regressions passed');
