import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  getOrCreateCode,
  referralStatus
} from '../backend/src/referrals.js';

class StaleOnceKV {
  store = new Map();
  staleKey = null;
  async get(key) {
    if (key === this.staleKey) {
      this.staleKey = null;
      return null;
    }
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value) { this.store.set(key, value); }
}

class UniqueReferralD1 {
  claims = new Map();       // auth_hash -> code
  codeOwners = new Map();   // code -> auth_hash (UNIQUE(code))
  materialized = new Set();
  locks = new Map();
  insertAttempts = 0;

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO referral_auth_claims')) {
              db.insertAttempts += 1;
              const [authHash, code] = args;
              if (db.claims.has(authHash) || db.codeOwners.has(code)) {
                return { meta: { changes: 0 } };
              }
              db.claims.set(authHash, code);
              db.codeOwners.set(code, authHash);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('INSERT OR IGNORE INTO kv_materializations')) {
              db.materialized.add(args[0]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM referral_apply_locks')) {
              if (db.locks.get(args[0]) === args[1]) db.locks.delete(args[0]);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async first() {
            if (sql.includes('SELECT code FROM referral_auth_claims')) {
              const code = db.claims.get(args[0]);
              return code ? { code } : null;
            }
            if (sql.includes('SELECT 1 AS done FROM kv_materializations')) {
              return db.materialized.has(args[0]) ? { done: 1 } : null;
            }
            if (sql.includes('INSERT INTO referral_apply_locks')) {
              const [name, leaseUntil, now] = args;
              if ((db.locks.get(name) || 0) >= now) return null;
              db.locks.set(name, leaseUntil);
              return { lease_until: leaseUntil };
            }
            if (sql.includes('UPDATE referral_apply_locks SET lease_until')) {
              const [name, oldLease, newLease, now] = args;
              if (db.locks.get(name) !== oldLease || oldLease < now) return null;
              db.locks.set(name, newLease);
              return { lease_until: newLease };
            }
            return null;
          }
        };
      }
    };
  }
}

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
let randomCalls = 0;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    subtle: webcrypto.subtle,
    getRandomValues(buffer) {
      // First capability: REF-2222-2222. The second capability first proposes
      // the same code, then receives REF-3333-3333 on its retry.
      buffer.fill(randomCalls < 4 ? 0 : 1);
      randomCalls += 1;
      return buffer;
    }
  }
});

try {
  const kv = new StaleOnceKV();
  const db = new UniqueReferralD1();
  const env = { LICENSES: kv, DB: db };
  const authA = 'A'.repeat(43);
  const authB = 'B'.repeat(43);

  const first = await getOrCreateCode(env, 'device-collision-a', null, authA);
  assert.deepEqual(first, { ok: true, code: 'REF-2222-2222' });

  // Simulate a different colo's stale-null read of the already-materialized
  // code. D1's UNIQUE(code), not the KV pre-check, must prevent reassignment.
  kv.staleKey = 'ref:REF-2222-2222';
  const second = await getOrCreateCode(env, 'device-collision-b', null, authB);
  assert.deepEqual(second, { ok: true, code: 'REF-3333-3333' });
  assert.equal(db.insertAttempts, 3,
    'the ignored different-auth code conflict must generate and claim a fresh candidate');
  assert.equal(db.codeOwners.size, 2);

  assert.equal((await referralStatus(env, 'device-collision-a', authA)).code, first.code);
  assert.equal((await referralStatus(env, 'device-collision-b', authB)).code, second.code);
  assert.equal((await referralStatus(env, 'device-collision-a', authB)).code, second.code,
    'device id remains non-authoritative; each capability resolves only its own claim');
} finally {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete globalThis.crypto;
}

console.log('referral code uniqueness regressions passed');
