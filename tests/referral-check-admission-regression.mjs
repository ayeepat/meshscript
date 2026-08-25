import assert from 'node:assert/strict';
await import('./helpers/worker-runtime-shim.mjs');
import worker from '../backend/src/worker.js';

/* /referral/check admission: a well-formed code performs a KV read plus up to
 * three D1 statements (the ref:* journal rebuild), so every anonymous lookup
 * needs a per-IP budget. Referral codes are public, therefore both hits and
 * misses are charged. Malformed codes never touch storage, and over-limit
 * traffic must not reach KV. */

class FakeKV {
  store = new Map();
  reads = 0;
  async get(key) { this.reads += 1; return this.store.get(key) || null; }
  async put(key, value) { this.store.set(key, value); }
}

class FakeD1 {
  budgets = new Map();
  statements = 0;
  prepare(sql) {
    this.statements += 1;
    return {
      bind: (...args) => ({
        first: async (column) => {
          const [day, scope, key, amount] = args;
          const id = `${day}|${scope}|${key}`;
          let count = this.budgets.get(id) || 0;
          if (sql.includes('INSERT INTO telemetry_budget')) {
            const limit = Number(args[4]);
            if (count + Number(amount) > limit) return null;
            count += Number(amount);
            this.budgets.set(id, count);
          } else if (sql.includes('UPDATE telemetry_budget')) {
            if (!this.budgets.has(id)) return null;
            count = Math.max(0, count - Number(amount));
            this.budgets.set(id, count);
          } else {
            return null;
          }
          return column === 'count' ? count : { count };
        },
        run: async () => ({ meta: { changes: 1 } })
      })
    };
  }
  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const db = new FakeD1();
const kv = new FakeKV();
const env = { DB: db, LICENSES: kv };
const ctx = { waitUntil() {} };
const ip = '198.51.100.10';
const check = (code, requestIp = ip, requestEnv = env) => worker.fetch(
  new Request(`https://api.example/referral/check?code=${encodeURIComponent(code)}`, {
    headers: { 'CF-Connecting-IP': requestIp }
  }),
  requestEnv,
  ctx
);
const budgetFor = (requestIp) => [...db.budgets.entries()]
  .filter(([id]) => id.endsWith(`|ref_check|${requestIp}`))
  .reduce((sum, [, count]) => sum + count, 0);

// Malformed codes are answered without a reservation and without any storage
// access — mirroring /verify's normalizeKey fast path.
const beforeMalformed = { reads: kv.reads, statements: db.statements };
const malformed = await check('ABCDEFGH');
assert.equal(malformed.status, 200);
assert.deepEqual(await malformed.json(), { ok: true, valid: false, reason: 'bad_code', buyer_bonus_pct: 10 });
assert.equal(malformed.headers.get('access-control-allow-origin'), '*');
assert.equal(kv.reads, beforeMalformed.reads, 'malformed codes must not touch KV');
assert.equal(db.statements, beforeMalformed.statements, 'malformed codes must not touch D1');

// A valid public code still consumes anonymous storage and therefore must
// consume the budget. Otherwise anyone who knows one code can bypass admission.
await kv.put('ref:REF-CDEA-0001', JSON.stringify({
  code: 'REF-CDEA-0001', owner_device_id: null, owner_license_key: null,
  purchases: 0, days_earned: 0, reward_key: null
}));
const valid = await check('REF-CDEA-0001');
assert.equal(valid.status, 200);
assert.deepEqual(await valid.json(), { ok: true, valid: true, code: 'REF-CDEA-0001', buyer_bonus_pct: 10 });
assert.equal(budgetFor(ip), 1, 'a valid public code must consume one lookup');

// The first valid lookup plus 199 misses exhaust the 200-request allowance;
// the next request is rejected before storage.
const readsBeforeMisses = kv.reads;
for (let i = 0; i < 199; i++) {
  const miss = await check(`REF-MISS-${String(i).padStart(4, '0')}`);
  assert.equal(miss.status, 200);
  assert.equal((await miss.json()).valid, false);
}
assert.equal(kv.reads - readsBeforeMisses, 199,
  'the allowance must correspond to exactly 200 total expensive KV lookups');
const readsAtLimit = kv.reads;
const limited = await check('REF-OVRL-0001');
assert.equal(limited.status, 429);
assert.deepEqual(await limited.json(), { ok: false, reason: 'rate_limited' });
assert.equal(kv.reads, readsAtLimit, 'an over-limit request must be rejected before the KV lookup');

// The blocked IP must not regain a validity oracle, even for a real code.
const blockedValid = await check('REF-CDEA-0001');
assert.equal(blockedValid.status, 429);
assert.equal(kv.reads, readsAtLimit, 'cached over-limit traffic must not consume more KV reads');

// The budget is per source IP: another buyer keeps ordinary access.
const otherIp = await check('REF-CDEA-0001', '198.51.100.11');
assert.equal(otherIp.status, 200);
assert.equal((await otherIp.json()).valid, true);

// If D1 cannot make an authoritative reservation, fail closed before KV
// instead of silently reopening unlimited anonymous reads.
const unavailableEnv = { ...env, DB: { prepare() { throw new Error('simulated reservation outage'); } } };
const beforeUnavailable = kv.reads;
const unavailable = await check('REF-OUTG-0001', '198.51.100.12', unavailableEnv);
assert.equal(unavailable.status, 503);
assert.deepEqual(await unavailable.json(), { ok: false, reason: 'service_unavailable' });
assert.equal(kv.reads, beforeUnavailable,
  'a broken limiter must not fall through to the protected KV resource');

console.log('referral check admission regression passed');
