// Regression (audit B-01): a paused /verify device claim resumed after a
// revocation must not rewrite the license back to "active". KV is
// last-write-wins with no CAS and its reads can be stale, so the fix is
// two-layered: the device mirror re-reads the row before writing, and the
// revocation itself lives authoritatively in D1 license_revocations, which
// verifyLicense consults even when the KV mirror claims the key is active.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyLicense, revokeLicense, putLicense } from '../backend/src/licenses.js';

class FakeKV {
  store = new Map();
  pauseNextPut = null;
  onPausedPut = null;
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) {
    if (this.pauseNextPut) {
      const gate = this.pauseNextPut;
      this.pauseNextPut = null;
      this.onPausedPut?.();
      this.onPausedPut = null;
      await gate;
    }
    this.store.set(key, value);
  }
}

class FakeD1 {
  devices = new Set();          // "LICENSE|device"
  activations = new Map();      // license -> one active installation
  revocations = new Map();      // key -> { revoked_at, reason }
  promisedExpiries = new Map(); // key -> maximum D1 referral target_expiry
  pauseNextClaim = null;        // promise the next conditional device insert awaits
  failRevocationInsert = false;
  failRevocationRead = false;
  count(key) { let n = 0; for (const row of this.devices) if (row.startsWith(key + '|')) n++; return n; }
  prepare(sql) {
    const db = this;
    return {
      bind: (...args) => ({
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO license_revocations')) {
            if (db.failRevocationInsert) {
              db.failRevocationInsert = false;
              throw new Error('injected revocation registry failure');
            }
            const [key, revokedAt, reason] = args;
            if (!db.revocations.has(key)) db.revocations.set(key, { revoked_at: revokedAt, reason: reason ?? null });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT OR IGNORE INTO license_activations')) {
            // The first activation insert — the exact pause window of the race:
            // the verify invocation is suspended here while a revoke lands.
            if (db.pauseNextClaim) {
              const gate = db.pauseNextClaim;
              db.pauseNextClaim = null;
              await gate;
            }
            const [key, device, tokenHash] = args;
            if (db.activations.has(key)) return { meta: { changes: 0 } };
            db.activations.set(key, {
              status: 'active', device_id: device, token_hash: tokenHash, generation: 1
            });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE license_activations SET last_seen_at')) {
            return { meta: { changes: 1 } };
          }
          if (sql.includes('license_devices')) {
            db.devices.add(`${args[0]}|${args[1]}`);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };   // purchases mirror etc.
        },
        async first() {
          if (sql.includes('FROM license_revocations')) {
            if (db.failRevocationRead) {
              db.failRevocationRead = false;
              throw new Error('injected revocation registry read failure');
            }
            return db.revocations.get(args[0]) || null;
          }
          if (sql.includes('MAX(target_expiry)')) {
            return { expiry: db.promisedExpiries.get(args[0]) || null };
          }
          if (sql.includes('FROM license_activations')) {
            return db.activations.get(args[0]) || null;
          }
          if (sql.includes('SELECT 1 FROM license_devices')) {
            return db.devices.has(`${args[0]}|${args[1]}`) ? { 1: 1 } : null;
          }
          return null;
        },
        async all() { return { results: [] }; }
      })
    };
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

const seed = (kv, key) => kv.store.set(key, JSON.stringify({
  key, type: 'lifetime', status: 'active', expires_at: null, device_ids: []
}));

/* ---- 1. the paused-claim race: a revoke landing mid-claim must survive ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, DEVICE_LIMIT: '1' };
  seed(kv, 'SMESH-RACE-REVOKE');

  let releaseClaim;
  db.pauseNextClaim = new Promise((resolve) => { releaseClaim = resolve; });
  const verifying = verifyLicense(env, 'SMESH-RACE-REVOKE', 'device-race-uuid-0001');
  await new Promise((resolve) => setTimeout(resolve, 10)); // reach the paused claim

  const revoked = await revokeLicense(env, 'SMESH-RACE-REVOKE', 'refund');
  assert.equal(revoked.status, 'revoked');
  releaseClaim();

  const verdict = await verifying;
  assert.deepEqual(verdict, { ok: false, reason: 'revoked' },
    'a device claim resumed after revocation must not report the key active');
  const row = JSON.parse(await kv.get('SMESH-RACE-REVOKE'));
  assert.equal(row.status, 'revoked',
    'the resumed mirror write must never resurrect the revoked KV row');
  assert.deepEqual(row.device_ids, ['device-race-uuid-0001'],
    'the historical mirror may record the attempt, but cannot authorize it after revocation');
  assert.equal((await verifyLicense(env, 'SMESH-RACE-REVOKE', 'device-race-uuid-0001')).reason,
    'revoked', 'the key stays revoked on every later verify');
}

/* ---- 2. a revoke landing during the KV mirror write wins permanently ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, DEVICE_LIMIT: '1' };
  seed(kv, 'SMESH-MIRROR-REVOKE');

  let releasePut;
  kv.pauseNextPut = new Promise((resolve) => { releasePut = resolve; });
  const pausedPut = new Promise((resolve) => { kv.onPausedPut = resolve; });
  const verifying = verifyLicense(env, 'SMESH-MIRROR-REVOKE', 'device-mirror-uuid-0001');
  await pausedPut;

  const revoked = await revokeLicense(env, 'SMESH-MIRROR-REVOKE', 'refund');
  assert.equal(revoked.status, 'revoked');
  releasePut();

  assert.deepEqual(await verifying, { ok: false, reason: 'revoked' },
    'verify must re-check D1 after its last awaited mirror write');
  assert.equal(JSON.parse(await kv.get('SMESH-MIRROR-REVOKE')).status, 'revoked',
    'a delayed active mirror write must be healed before verify completes');
}

/* ---- 3. stale/resurrected KV mirror: the D1 registry still rejects and heals ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, DEVICE_LIMIT: '1' };
  seed(kv, 'SMESH-STALE-ACTIVE');
  db.revocations.set('SMESH-STALE-ACTIVE', { revoked_at: Date.now() - 60_000, reason: 'fraud' });

  const verdict = await verifyLicense(env, 'SMESH-STALE-ACTIVE', 'device-stale-uuid-01');
  assert.deepEqual(verdict, { ok: false, reason: 'revoked' },
    'the D1 revocation registry must override a stale-active KV mirror');
  const healed = JSON.parse(await kv.get('SMESH-STALE-ACTIVE'));
  assert.equal(healed.status, 'revoked', 'verify must heal the resurrected mirror back to revoked');
  assert.ok(healed.revoked_at, 'the healed mirror carries the registry revocation time');
}

/* ---- 4. a later whole-row writer cannot resurrect the KV mirror ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, DEVICE_LIMIT: '1' };
  seed(kv, 'SMESH-RESURRECT');
  await revokeLicense(env, 'SMESH-RESURRECT', 'refund');
  // Simulate any stale read-modify-write (referral expiry extension, delayed
  // mirror) clobbering the KV row back to active after the revoke.
  await putLicense(env, {
    key: 'SMESH-RESURRECT', type: 'lifetime', status: 'active', expires_at: null, device_ids: []
  });
  assert.equal(JSON.parse(await kv.get('SMESH-RESURRECT')).status, 'revoked',
    'putLicense must overlay the durable revocation at the write boundary');
  assert.equal((await verifyLicense(env, 'SMESH-RESURRECT', 'device-resurrect-uuid')).reason,
    'revoked', 'no KV write may ever un-revoke a key recorded in D1');
}

/* ---- 5. a referral intent committed during a stale whole-row put is healed ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db };
  const key = 'SMESH-EXPIRY-FENCE';
  const oldExpiry = '2026-08-01T00:00:00.000Z';
  const promisedExpiry = '2026-08-08T00:00:00.000Z';
  kv.store.set(key, JSON.stringify({
    key, type: 'subscription', status: 'active',
    expires_at: oldExpiry, device_ids: []
  }));

  let releasePut;
  kv.pauseNextPut = new Promise((resolve) => { releasePut = resolve; });
  const pausedPut = new Promise((resolve) => { kv.onPausedPut = resolve; });
  const staleWrite = putLicense(env, {
    key, type: 'subscription', status: 'active',
    expires_at: oldExpiry, device_ids: ['device-expiry-fence']
  });
  await pausedPut;
  db.promisedExpiries.set(key, promisedExpiry);
  releasePut();
  const stored = await staleWrite;

  assert.equal(stored.expires_at, promisedExpiry);
  assert.equal(JSON.parse(await kv.get(key)).expires_at, promisedExpiry,
    'a whole-row writer crossing a durable referral intent must not shorten its promised expiry');
}

/* ---- 6. revocation durability fails closed: no half-applied KV-only revoke ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db };
  seed(kv, 'SMESH-DURABLE');
  db.failRevocationInsert = true;
  await assert.rejects(revokeLicense(env, 'SMESH-DURABLE', 'refund'),
    /injected revocation registry failure/,
    'a revoke whose durable record cannot land must surface the failure for retry');
  assert.equal(JSON.parse(await kv.get('SMESH-DURABLE')).status, 'active',
    'the KV write must not run ahead of the durable record');

  const done = await revokeLicense(env, 'SMESH-DURABLE', 'refund');
  assert.equal(done.status, 'revoked');
  assert.equal((await verifyLicense(env, 'SMESH-DURABLE', '')).reason, 'revoked');
}

/* ---- 7. an unavailable authoritative registry never grants access ---- */
{
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = { LICENSES: kv, DB: db, DEVICE_LIMIT: '1' };
  seed(kv, 'SMESH-REVOCATION-OUTAGE');
  db.failRevocationRead = true;

  assert.deepEqual(
    await verifyLicense(env, 'SMESH-REVOCATION-OUTAGE', 'device-outage-uuid-001'),
    { ok: false, reason: 'service_unavailable' },
    'a D1 read failure must not turn a stale-active KV row into authorization'
  );
  assert.equal(db.devices.size, 0, 'authorization must stop before claiming a device slot');
}

/* ---- 8. admin revoke cannot acknowledge a non-durable KV-only write ---- */
{
  const kv = new FakeKV();
  seed(kv, 'SMESH-NO-REVOCATION-DB');
  await assert.rejects(
    revokeLicense({ LICENSES: kv }, 'SMESH-NO-REVOCATION-DB', 'refund'),
    /revocation registry unavailable/,
    'revoke requires D1 because KV-only state can be resurrected'
  );
  assert.equal(JSON.parse(await kv.get('SMESH-NO-REVOCATION-DB')).status, 'active');
}

const schema = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
assert.match(schema, /CREATE TABLE IF NOT EXISTS license_revocations/,
  'the authoritative revocation registry must ship with the schema');

console.log('license revocation race regressions passed');
