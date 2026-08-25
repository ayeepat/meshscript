import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

import {
  getOrCreateCode,
  referralStatus
} from '../backend/src/referrals.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class ReferralClaimD1 {
  claims = new Map();
  locks = new Map();
  materializations = new Set();
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO referral_auth_claims') && !db.claims.has(args[0])) {
              db.claims.set(args[0], { code: args[1], created_at: args[2] });
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO kv_materializations')) {
              db.materializations.add(args[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM referral_apply_locks')) {
              if (db.locks.get(args[0]) === args[1]) db.locks.delete(args[0]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async first() {
            if (sql.includes('SELECT code FROM referral_auth_claims')) return db.claims.get(args[0]) || null;
            if (sql.includes('SELECT 1 AS done FROM kv_materializations')) {
              return db.materializations.has(args[0]) ? { done: 1 } : null;
            }
            if (sql.includes('INSERT INTO referral_apply_locks')) {
              const [refCode, leaseUntil, now] = args;
              if ((db.locks.get(refCode) || 0) >= now) return null;
              db.locks.set(refCode, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('UPDATE referral_apply_locks SET lease_until')) {
              const [refCode, oldLease, newLease, now] = args;
              if (db.locks.get(refCode) !== oldLease || oldLease < now) return null;
              db.locks.set(refCode, newLease);
              return { lease_until: newLease };
            }
            return null;
          }
        };
      }
    };
  }
}

// Both first reads deliberately observe the same pre-write KV snapshot. D1's
// unique auth_hash claim must still select one code and prevent an orphan ref:.
class RacingReferralKV extends FakeKV {
  constructor() {
    super();
    this.refauthReads = 0;
    this.releaseInitialReads = null;
    this.initialReads = new Promise((resolve) => { this.releaseInitialReads = resolve; });
  }
  async get(key) {
    if (key.startsWith('refauth:') && this.refauthReads < 2) {
      const snapshot = await super.get(key);
      this.refauthReads += 1;
      if (this.refauthReads === 2) this.releaseInitialReads();
      await this.initialReads;
      return snapshot;
    }
    return super.get(key);
  }
}

const authA = Buffer.alloc(32, 0x11).toString('base64url');
const authB = Buffer.alloc(32, 0x22).toString('base64url');
const authLegacy = Buffer.alloc(32, 0x33).toString('base64url');
const authEmptyLegacy = Buffer.alloc(32, 0x44).toString('base64url');
const authBoundLegacy = Buffer.alloc(32, 0x55).toString('base64url');
const device = 'device-referral-owner';

const kv = new FakeKV();
const env = { LICENSES: kv };
const created = await getOrCreateCode(env, device, null, authA, null);
assert.equal(created.ok, true);
assert.match(created.code, /^REF-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

const stored = JSON.parse(await kv.get(`ref:${created.code}`));
assert.equal(typeof stored.auth_hash, 'string');
assert.equal(stored.auth_hash.length, 64);
assert.equal(JSON.stringify(stored).includes(authA), false, 'the raw capability must never be stored server-side');
assert.equal(await kv.get(`refauth:${stored.auth_hash}`), created.code,
  'capability digest, not device id, must be the primary identity pointer');

const wrongStatus = await referralStatus(env, device, authB);
assert.equal(wrongStatus.reward_key, null,
  'a device id without its independent capability must reveal no stats or reward key');
assert.equal(wrongStatus.code, null);

const attackerUpdate = await getOrCreateCode(env, device, 'SMESH-ATTACKER-KEY', authB, created.code);
assert.equal(attackerUpdate.ok, true,
  'a different capability may create its own identity without squatting the victim');
assert.notEqual(attackerUpdate.code, created.code);
assert.equal(JSON.parse(await kv.get(`ref:${created.code}`)).owner_license_key, null,
  'a leaked device id must not redirect future referral rewards');

const ownerUpdate = await getOrCreateCode(env, device, 'SMESH-OWNER-KEY', authA, created.code);
assert.equal(ownerUpdate.ok, true);
assert.equal(JSON.parse(await kv.get(`ref:${created.code}`)).owner_license_key, 'SMESH-OWNER-KEY');

const reward = {
  key: 'SMESH-REWARD-KEY', type: 'subscription', status: 'active',
  expires_at: new Date(Date.now() + 86400000).toISOString(), device_ids: []
};
await kv.put(reward.key, JSON.stringify(reward));
const withReward = JSON.parse(await kv.get(`ref:${created.code}`));
withReward.reward_key = reward.key;
withReward.purchases = 1;
withReward.days_earned = 7;
await kv.put(`ref:${created.code}`, JSON.stringify(withReward));

assert.equal((await referralStatus(env, device, authA)).reward_key, reward.key,
  'the legitimate installation can still retrieve its earned reward');
assert.equal((await referralStatus(env, device, authB)).reward_key, null);

const legacyDevice = 'device-legacy-owner';
const legacyCode = 'REF-ABCD-EFGH';
await kv.put(`refowner:${legacyDevice}`, legacyCode);
await kv.put(`ref:${legacyCode}`, JSON.stringify({
  code: legacyCode, owner_device_id: legacyDevice, owner_license_key: null,
  purchases: 1, days_earned: 7, reward_key: reward.key
}));
assert.equal(
  (await getOrCreateCode(env, legacyDevice, null, authLegacy, legacyCode)).reason,
  'legacy_auth_required',
  'a valuable legacy record must not use insecure first-caller-wins migration'
);

const emptyLegacyDevice = 'device-empty-legacy';
const emptyLegacyCode = 'REF-WXYZ-2345';
await kv.put(`refowner:${emptyLegacyDevice}`, emptyLegacyCode);
await kv.put(`ref:${emptyLegacyCode}`, JSON.stringify({
  code: emptyLegacyCode, owner_device_id: emptyLegacyDevice, owner_license_key: null,
  purchases: 0, days_earned: 0, reward_key: null
}));
assert.equal(
  (await getOrCreateCode(env, emptyLegacyDevice, null, authEmptyLegacy, emptyLegacyCode)).reason,
  'legacy_auth_required',
  'an empty legacy code may earn value later and must not use a device id as ownership proof'
);

const boundLegacyDevice = 'device-bound-legacy';
const boundLegacyCode = 'REF-QWER-5678';
const boundLicenseKey = 'SMESH-ABCD-EFGH-JKLM';
await kv.put(boundLicenseKey, JSON.stringify({
  key: boundLicenseKey, type: 'subscription', status: 'active',
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  device_ids: [boundLegacyDevice]
}));
await kv.put(`refowner:${boundLegacyDevice}`, boundLegacyCode);
await kv.put(`ref:${boundLegacyCode}`, JSON.stringify({
  code: boundLegacyCode, owner_device_id: boundLegacyDevice,
  owner_license_key: boundLicenseKey, purchases: 0, days_earned: 0,
  reward_key: null
}));
assert.equal(
  (await getOrCreateCode(
    env, boundLegacyDevice, boundLicenseKey, authBoundLegacy, boundLegacyCode
  )).ok,
  true,
  'an active license already bound to the device is sufficient legacy ownership proof'
);

const raceKv = new RacingReferralKV();
const raceDb = new ReferralClaimD1();
const raced = await Promise.all([
  getOrCreateCode({ LICENSES: raceKv, DB: raceDb }, device, null, authA, null),
  getOrCreateCode({ LICENSES: raceKv, DB: raceDb }, device, null, authA, null)
]);
assert.equal(raced[0].code, raced[1].code,
  'simultaneous first requests for one capability must return the D1 winner');
const raceAuthPointers = [...raceKv.store.entries()].filter(([key]) => key.startsWith('refauth:'));
const raceRecords = [...raceKv.store.keys()].filter((key) => key.startsWith('ref:'));
assert.equal(raceAuthPointers.length, 1);
assert.equal(raceAuthPointers[0][1], raced[0].code);
assert.deepEqual(raceRecords, [`ref:${raced[0].code}`],
  'the losing candidate must never leave an orphan referral record');
assert.equal(raceDb.claims.size, 1);

console.log('referral authorization regressions passed');
