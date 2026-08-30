import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

await import('./helpers/worker-runtime-shim.mjs');
import worker from '../backend/src/worker.js';
import { releaseDailyBudget, reserveDailyBudget } from '../backend/src/analytics.js';

class FakeKV {
  store = new Map();
  reads = 0;
  async get(key) { this.reads += 1; return this.store.get(key) || null; }
  async put(key, value) { this.store.set(key, value); }
}

class FakeD1 {
  budgets = new Map();
  statements = 0;
  deactivationUpdates = 0;
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
        run: async () => {
          if (sql.includes('UPDATE license_activations')) {
            this.deactivationUpdates += 1;
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 1 } };
        }
      })
    };
  }
  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class SqliteBudgetD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    return {
      bind: (...args) => ({
        async first(column) {
          const row = db.prepare(sql).get(...args) || null;
          return column ? row?.[column] ?? null : row;
        }
      })
    };
  }
}

const db = new FakeD1();
const kv = new FakeKV();
const env = {
  DB: db, LICENSES: kv,
  OWNER_LICENSE_KEY: 'SMESH-OWNER-VALID-KEY'
};
const ctx = { waitUntil() {} };
const ip = '203.0.113.200';
const verify = (
  key,
  deviceId = '11111111-1111-4111-8111-111111111111',
  requestIp = ip,
  requestEnv = env
) => worker.fetch(new Request('https://api.example/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': requestIp },
  body: JSON.stringify({ key, device_id: deviceId })
}), requestEnv, ctx);

// At the exact boundary, only one concurrent reservation is admitted. The
// rejected call receives an in-memory sentinel but must not persist +1; when
// the admitted operation refunds, the durable count returns to the original
// 199 rather than remaining falsely saturated at 200.
const boundarySqlite = new DatabaseSync(':memory:');
boundarySqlite.exec(`
  CREATE TABLE telemetry_budget (
    day TEXT NOT NULL,
    scope TEXT NOT NULL,
    budget_key TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, scope, budget_key)
  );
`);
const boundaryEnv = { DB: new SqliteBudgetD1(boundarySqlite) };
const boundaryDay = '2026-08-07';
const boundaryKey = '203.0.113.199';
boundarySqlite.prepare(
  'INSERT INTO telemetry_budget(day, scope, budget_key, count) VALUES (?, ?, ?, ?)'
).run(boundaryDay, 'verify_fail', boundaryKey, 199);
const boundary = await Promise.all([
  reserveDailyBudget(boundaryEnv, boundaryDay, 'verify_fail', boundaryKey, 1, 200),
  reserveDailyBudget(boundaryEnv, boundaryDay, 'verify_fail', boundaryKey, 1, 200)
]);
assert.deepEqual(boundary.slice().sort((a, b) => a - b), [200, 201]);
const boundaryCount = () => boundarySqlite.prepare(
  'SELECT count FROM telemetry_budget WHERE day = ? AND scope = ? AND budget_key = ?'
).get(boundaryDay, 'verify_fail', boundaryKey).count;
assert.equal(boundaryCount(), 200,
  'an over-limit sentinel must never be written to the shared counter');
await releaseDailyBudget(boundaryEnv, boundaryDay, 'verify_fail', boundaryKey, 1);
assert.equal(boundaryCount(), 199,
  'refunding the sole admitted reservation must restore the pre-race count');
boundarySqlite.close();

// Recognized verdicts reserve before lookup and refund afterwards, so they do
// not consume the anonymous-failure budget under ordinary traffic.
const validBeforeLimit = await verify('SMESH-OWNER-VALID-KEY');
assert.equal(validBeforeLimit.status, 200);
const validBeforeLimitBody = await validBeforeLimit.json();
assert.equal(validBeforeLimitBody.ok, true);
assert.equal(validBeforeLimitBody.developer_mode, true,
  'only a backend-confirmed owner key may receive the diagnostics marker');
assert.equal([...db.budgets.values()].reduce((sum, count) => sum + count, 0), 0);

await kv.put('SMESH-EXPIRED-TEST-KEY', JSON.stringify({
  key: 'SMESH-EXPIRED-TEST-KEY', status: 'active', type: 'subscription',
  expires_at: '2020-01-01T00:00:00.000Z', device_ids: []
}));
const expired = await verify('SMESH-EXPIRED-TEST-KEY');
assert.equal((await expired.json()).reason, 'expired');
assert.equal([...db.budgets.values()].reduce((sum, count) => sum + count, 0), 0,
  'expired verdicts must refund their pre-lookup reservation');

// The D1 activation is the authorization decision. A failure updating the
// historical KV device_ids mirror must not strand the successfully activated
// buyer or charge the request as an anonymous miss.
const throwingKv = new FakeKV();
throwingKv.store.set('SMESH-THROWN-VERIFY-KEY', JSON.stringify({
  key: 'SMESH-THROWN-VERIFY-KEY', status: 'active', type: 'lifetime',
  expires_at: null, device_ids: []
}));
throwingKv.put = async () => { throw new Error('simulated KV materialization failure'); };
const thrownIp = '203.0.113.198';
const thrown = await verify(
  'SMESH-THROWN-VERIFY-KEY',
  '22222222-2222-4222-8222-222222222222',
  thrownIp,
  { DB: db, LICENSES: throwingKv }
);
assert.equal(thrown.status, 200);
const thrownBody = await thrown.json();
assert.equal(thrownBody.ok, true);
assert.equal(Object.hasOwn(thrownBody, 'developer_mode'), false,
  'ordinary valid licences must not receive the owner diagnostics marker');
const thrownBudget = [...db.budgets.entries()].find(([id]) => id.endsWith(`|${thrownIp}`));
assert.equal(thrownBudget?.[1] ?? 0, 0,
  'a recognized activation with a failed audit mirror must refund its lookup reservation');

const readsBeforeFlood = kv.reads;
for (let i = 0; i < 200; i++) {
  const response = await verify(`SMESH-MISSING-${i}-KEY`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reason, 'not_found');
}
assert.equal(kv.reads - readsBeforeFlood, 200,
  'the configured allowance must correspond to exactly 200 expensive KV lookups');
const readsAtLimit = kv.reads;
const limited = await verify('SMESH-MISSING-OVER-LIMIT');
assert.equal(limited.status, 429);
assert.deepEqual(await limited.json(), { ok: false, reason: 'rate_limited' });
assert.equal(limited.headers.get('access-control-allow-origin'), '*');
assert.equal(kv.reads, readsAtLimit,
  'the first over-limit request must be rejected before the entitlement KV lookup');

// A correct guess after the anonymous budget is exhausted must not remain a
// valid-vs-invalid oracle, and repeated blocked traffic must not reach KV.
const valid = await verify('SMESH-OWNER-VALID-KEY');
assert.equal(valid.status, 429);
assert.deepEqual(await valid.json(), { ok: false, reason: 'rate_limited' });
for (let i = 0; i < 20; i++) {
  assert.equal((await verify(`SMESH-STILL-BLOCKED-${i}-KEY`)).status, 429);
}
assert.equal(kv.reads, readsAtLimit,
  'cached over-limit requests must not consume any additional KV reads');

// The budget is per source IP. A different egress retains ordinary access.
const otherIpValid = await verify(
  'SMESH-OWNER-VALID-KEY',
  '11111111-1111-4111-8111-111111111111',
  '203.0.113.201'
);
assert.equal(otherIpValid.status, 200);
assert.equal((await otherIpValid.json()).ok, true);

// /deactivate is a public credential boundary too. A syntactically valid but
// random capability reaches an UPDATE plus a SELECT, so anonymous failures must
// share the same fail-closed budget rather than exposing unlimited D1 work.
const deactivateIp = '203.0.113.203';
const deactivate = () => worker.fetch(new Request('https://api.example/deactivate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': deactivateIp },
  body: JSON.stringify({
    key: 'SMESH-MISSING-DEACTIVATE',
    device_id: '33333333-3333-4333-8333-333333333333',
    activation_token: 'z'.repeat(43)
  })
}), env, ctx);
for (let i = 0; i < 200; i++) {
  const response = await deactivate();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).reason, 'activation_mismatch');
}
assert.equal(db.deactivationUpdates, 200,
  'the configured allowance must correspond to exactly 200 deactivation writes');
const deactivateLimited = await deactivate();
assert.equal(deactivateLimited.status, 429);
assert.deepEqual(await deactivateLimited.json(), { ok: false, reason: 'rate_limited' });
assert.equal(db.deactivationUpdates, 200,
  'the first over-limit deactivation must be rejected before its D1 update');

// If D1 cannot make an authoritative reservation, fail closed before KV
// instead of silently reopening unlimited anonymous entitlement reads.
const unavailableEnv = {
  ...env,
  DB: { prepare() { throw new Error('simulated reservation outage'); } }
};
const beforeUnavailable = kv.reads;
const unavailable = await verify(
  'SMESH-UNKNOWN-DURING-OUTAGE',
  '11111111-1111-4111-8111-111111111111',
  '203.0.113.202',
  unavailableEnv
);
assert.equal(unavailable.status, 503);
assert.deepEqual(await unavailable.json(), { ok: false, reason: 'service_unavailable' });
assert.equal(kv.reads, beforeUnavailable,
  'a broken limiter must not fall through to the protected KV resource');

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.host_permissions.includes('<all_urls>'), false,
  'the extension must not regain blanket cross-origin access');

console.log('failed verify rate-limit regression passed');
