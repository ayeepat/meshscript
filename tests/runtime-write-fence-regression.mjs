import assert from 'node:assert/strict';

import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import {
  createWriteFenceAuthorizer,
  enforceRuntimeWriteFence,
  RuntimeWriteFenceError,
  sqlMayMutate
} from '../backend/src/write-fence.js';

class FenceD1 {
  fence = { write_epoch: 1, writes_enabled: 1 };
  mutations = 0;
  execCalls = 0;
  fenceReads = 0;
  failFenceReads = false;

  withSession(mode) {
    assert.equal(mode, 'first-primary', 'write authorization must read the latest primary');
    return this;
  }

  prepare(sql) {
    const db = this;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        if (sql.includes('FROM runtime_write_fence')) {
          db.fenceReads += 1;
          if (db.failFenceReads) throw new Error('fence primary unavailable');
          const row = db.fence ? { ...db.fence } : null;
          return column ? row?.[column] ?? null : row;
        }
        if (sql.includes('SELECT count FROM telemetry_budget')) return { count: 0 };
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) {
          db.mutations += 1;
          return column ? 1 : { count: 1 };
        }
        return null;
      },
      async all() { return { results: [] }; },
      async run() {
        db.mutations += 1;
        return { meta: { changes: 1 }, args };
      }
    });
    return statement();
  }

  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  async exec(sql) {
    this.execCalls += 1;
    if (/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql)) {
      this.mutations += 1;
    }
    return { count: 1 };
  }
}

class FenceKV {
  constructor(values = new Map()) { this.values = values; }
  writes = 0;
  async get(key) { return this.values.get(key) || null; }
  async put(key, value) { this.writes += 1; this.values.set(key, value); }
  async delete(key) { this.writes += 1; this.values.delete(key); }
}

const db = new FenceD1();
const kv = new FenceKV();
const epochOne = enforceRuntimeWriteFence({
  DB: db, LICENSES: kv, RUNTIME_WRITE_EPOCH: '1'
});

await epochOne.DB.prepare('UPDATE counters SET value = value + 1').run();
await epochOne.DB.prepare(
  'INSERT INTO telemetry_budget(day, scope, budget_key, count) VALUES (?1, ?2, ?3, 1) RETURNING count'
).bind('2026-08-07', 'probe', 'one').first('count');
await epochOne.LICENSES.put('probe', 'one');
assert.equal(db.mutations, 2);
assert.equal(kv.writes, 1);
assert.equal(db.fenceReads, 3,
  'each authoritative storage call must receive a fresh primary authorization');

// Closing AND rotating the row revokes the old environment immediately.
db.fence = { write_epoch: 2, writes_enabled: 0 };
await assert.rejects(
  epochOne.DB.prepare('DELETE FROM counters WHERE name = ?').bind('x').run(),
  RuntimeWriteFenceError
);
await assert.rejects(epochOne.LICENSES.delete('probe'), RuntimeWriteFenceError);
await assert.rejects(
  epochOne.DB.prepare('PRAGMA user_version = 7').run(),
  RuntimeWriteFenceError,
  'a mutating PRAGMA must not bypass the durable fence'
);
await assert.rejects(
  epochOne.DB.prepare('PRAGMA future_unknown_control').all(),
  RuntimeWriteFenceError,
  'unknown PRAGMAs must fail closed until deliberately classified'
);
await epochOne.DB.prepare('PRAGMA table_info("counters")').all();
await epochOne.DB.prepare('PRAGMA table_xinfo("counters")').all();
assert.equal(sqlMayMutate('PRAGMA table_info("counters")'), false);
assert.equal(sqlMayMutate('PRAGMA table_xinfo("counters")'), false);
assert.equal(sqlMayMutate('PRAGMA index_list("counters")'), false);
assert.equal(sqlMayMutate('PRAGMA index_info("sqlite_autoindex_counters_1")'), false);
assert.equal(sqlMayMutate('PRAGMA index_xinfo("sqlite_autoindex_counters_1")'), false);
assert.equal(sqlMayMutate('PRAGMA optimize'), true);
assert.equal(sqlMayMutate('PRAGMA writable_schema = ON'), true);
assert.equal(sqlMayMutate("SELECT ';' AS literal; /* ignored ; */ SELECT 2"), false,
  'semicolons inside literals/comments and stacked reads remain read-only');
assert.equal(sqlMayMutate('SELECT 1; DELETE FROM counters'), true,
  'a later statement in D1.exec must not inherit the first SELECT classification');
await assert.rejects(
  epochOne.DB.exec('SELECT 1; DELETE FROM counters'),
  RuntimeWriteFenceError,
  'stacked D1.exec writes must re-authorize even when the first statement is read-only'
);
await assert.rejects(
  epochOne.DB.exec('SELECT 1\nDELETE FROM counters'),
  RuntimeWriteFenceError,
  'D1 newline-separated exec queries must never bypass the fence classifier'
);
assert.equal(db.execCalls, 0,
  'closed-fence exec calls must be rejected before reaching the raw D1 binding');
assert.equal(db.mutations, 2);
assert.equal(kv.writes, 1);

const epochTwo = enforceRuntimeWriteFence({
  DB: db, LICENSES: kv, RUNTIME_WRITE_EPOCH: '2'
});
await assert.rejects(epochTwo.LICENSES.put('probe', 'two'), RuntimeWriteFenceError,
  'matching epoch is not enough while the durable fence is closed');

// Reopening the new epoch restores only the replacement deployment. An old
// isolate can never regain authority merely because writes_enabled became 1.
db.fence = { write_epoch: 2, writes_enabled: 1 };
await epochTwo.LICENSES.put('probe', 'two');
await assert.rejects(epochOne.LICENSES.put('probe', 'stale'), RuntimeWriteFenceError);
assert.equal(kv.values.get('probe'), 'two');

db.failFenceReads = true;
await assert.rejects(epochTwo.DB.prepare('UPDATE counters SET value = 0').run(),
  (error) => error instanceof RuntimeWriteFenceError &&
    error.code === 'write_fence_unavailable',
  'a marker-read outage must fail writes closed');
db.failFenceReads = false;

await assert.rejects(
  createWriteFenceAuthorizer({ DB: db }, db)(),
  (error) => error.code === 'write_fence_unavailable',
  'missing epoch configuration must never silently disable the production fence'
);
const legacyFixtureMarker = globalThis.__SMESH_TEST_ALLOW_LEGACY_FENCE_ENV__;
delete globalThis.__SMESH_TEST_ALLOW_LEGACY_FENCE_ENV__;
const missingConfigEnv = enforceRuntimeWriteFence({ DB: db, LICENSES: kv });
await assert.rejects(missingConfigEnv.LICENSES.put('must-not-write', 'x'),
  (error) => error.code === 'write_fence_unavailable');
globalThis.__SMESH_TEST_ALLOW_LEGACY_FENCE_ENV__ = legacyFixtureMarker;

// Adversarial held-body reproduction: the request starts under epoch 10 and
// reaches admin authentication, then stalls indefinitely in its body stream.
// Maintenance rotates the durable row before the final body byte arrives.
// The actual revocation write must re-check and fail; an entry-only gate would
// incorrectly mutate D1 here.
const heldDb = new FenceD1();
heldDb.fence = { write_epoch: 10, writes_enabled: 1 };
const heldKey = 'SMESH-HELD-BODY-REVOKE';
const heldKv = new FenceKV(new Map([[heldKey, JSON.stringify({
  key: heldKey,
  status: 'active',
  type: 'lifetime',
  expires_at: null,
  device_ids: []
})]]));
let releaseTail;
let confirmTailRequested;
const tailGate = new Promise((resolve) => { releaseTail = resolve; });
const tailRequested = new Promise((resolve) => { confirmTailRequested = resolve; });
let bodyPhase = 0;
const heldBody = new ReadableStream({
  pull(controller) {
    if (bodyPhase === 0) {
      bodyPhase = 1;
      controller.enqueue(new TextEncoder().encode(`{"key":"${heldKey}"`));
      return;
    }
    if (bodyPhase === 1) {
      bodyPhase = 2;
      confirmTailRequested();
      return tailGate.then(() => {
        controller.enqueue(new TextEncoder().encode('}'));
        controller.close();
      });
    }
  }
});
const heldRequest = new Request('https://api.example/admin/revoke', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Admin-Token': 'held-body-admin-secret'.repeat(2)
  },
  body: heldBody,
  duplex: 'half'
});
const heldResponsePromise = worker.fetch(heldRequest, {
  DB: heldDb,
  LICENSES: heldKv,
  ADMIN_SECRET: 'held-body-admin-secret'.repeat(2),
  RUNTIME_WRITE_EPOCH: '10',
  BACKUP_MAINTENANCE: 'false'
}, { waitUntil() {} });
await tailRequested;
assert.equal(heldDb.mutations, 0);
heldDb.fence = { write_epoch: 11, writes_enabled: 0 };
releaseTail();
const heldResponse = await heldResponsePromise;
assert.equal(heldResponse.status, 503);
assert.deepEqual(await heldResponse.json(), { ok: false, reason: 'service_unavailable' });
assert.equal(heldDb.mutations, 0,
  'a pre-maintenance request released after rotation must not mutate D1');
assert.equal(heldKv.writes, 0,
  'the fenced request must not fall through to a KV mirror write');

console.log('runtime write-fence regressions passed');
