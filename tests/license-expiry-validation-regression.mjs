// Regression (audit B-06): a subscription whose expires_at is missing or
// unparseable must never read as "never expires". verifyLicense fails closed
// on time-bound rows, issueLicense rejects the shapes at the single issuance
// chokepoint, and /admin/issue reports them as a readable 400 instead of
// minting an eternal key.
import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import { verifyLicense, issueLicense } from '../backend/src/licenses.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class ActivationD1 {
  rows = new Map();
  prepare(sql) {
    const db = this;
    return {
      bind: (...args) => ({
        async first() {
          if (sql.includes('FROM license_activations')) return db.rows.get(args[0]) || null;
          return null;
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO license_activations')) {
            if (db.rows.has(args[0])) return { meta: { changes: 0 } };
            db.rows.set(args[0], {
              status: 'active', device_id: args[1], token_hash: args[2], generation: 1
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      })
    };
  }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

const seed = (kv, key, patch) => kv.store.set(key, JSON.stringify({
  key, type: 'lifetime', status: 'active', expires_at: null, device_ids: [], ...patch
}));

/* ---- verifyLicense fails closed on corrupt/missing time bounds ---- */
{
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new ActivationD1(), DEVICE_LIMIT: '1' };

  seed(kv, 'SMESH-SUB-NULL', { type: 'subscription', expires_at: null });
  assert.equal((await verifyLicense(env, 'SMESH-SUB-NULL', '')).reason, 'expired',
    'a subscription without an expiry must not verify as eternal');

  seed(kv, 'SMESH-SUB-GARBAGE', { type: 'subscription', expires_at: 'not-a-date' });
  assert.equal((await verifyLicense(env, 'SMESH-SUB-GARBAGE', '')).reason, 'expired',
    'an unparseable subscription expiry must fail closed');

  seed(kv, 'SMESH-SUB-PAST', {
    type: 'subscription', expires_at: new Date(Date.now() - 1000).toISOString()
  });
  assert.equal((await verifyLicense(env, 'SMESH-SUB-PAST', '')).reason, 'expired');

  const exactExpiryMs = Date.parse('2030-01-02T03:04:05.000Z');
  seed(kv, 'SMESH-SUB-EXACT', {
    type: 'subscription', expires_at: new Date(exactExpiryMs).toISOString()
  });
  const realDateNow = Date.now;
  Date.now = () => exactExpiryMs;
  try {
    assert.equal((await verifyLicense(env, 'SMESH-SUB-EXACT', '')).reason, 'expired',
      'the entitlement ends at expires_at, not one millisecond afterward');
  } finally {
    Date.now = realDateNow;
  }

  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  seed(kv, 'SMESH-SUB-VALID', { type: 'subscription', expires_at: future });
  const valid = await verifyLicense(env, 'SMESH-SUB-VALID', 'expiry-test-device');
  assert.equal(valid.ok, true, 'a well-formed future subscription still verifies');
  assert.equal(valid.expires_at, future);

  seed(kv, 'SMESH-LIFE-OK', {});
  assert.equal((await verifyLicense(env, 'SMESH-LIFE-OK', 'lifetime-test-device')).ok, true,
    'a lifetime license with a null expiry is the one legitimate eternal shape');

  seed(kv, 'SMESH-LIFE-GARBAGE', { expires_at: '2026-13-45T99:99:99Z' });
  assert.equal((await verifyLicense(env, 'SMESH-LIFE-GARBAGE', '')).reason, 'expired',
    'a present-but-corrupt expiry fails closed even on a lifetime row');
}

/* ---- issueLicense rejects the shapes at the chokepoint ---- */
{
  const env = { LICENSES: new FakeKV() };
  await assert.rejects(issueLicense(env, { type: 'subscription' }),
    /subscription requires expires_at/);
  await assert.rejects(issueLicense(env, { type: 'subscription', expires_at: 'soon' }),
    /invalid expires_at/);
  for (const ambiguous of [
    '2026-02-30T00:00:00.000Z',
    '2026-07-24T12:00:00',
    '07/24/2026 12:00:00',
    '2026-07-24T12:00:00Z'
  ]) {
    await assert.rejects(
      issueLicense(env, { type: 'subscription', expires_at: ambiguous }),
      /invalid expires_at/,
      `non-canonical or impossible expiry must be rejected: ${ambiguous}`
    );
  }
  await assert.rejects(issueLicense(env, { type: 'premium' }),
    /unknown license type/);
  const issued = await issueLicense(env, {
    type: 'subscription',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  assert.equal(issued.type, 'subscription');
}

/* ---- /admin/issue reports bad shapes as 400, not a 500 or an eternal key ---- */
{
  const env = { LICENSES: new FakeKV(), ADMIN_SECRET: 'admin-secret-token'.repeat(3) };
  const ctx = { waitUntil() {} };
  const post = (body) => worker.fetch(new Request('https://api.example/admin/issue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': env.ADMIN_SECRET },
    body: JSON.stringify(body)
  }), env, ctx);

  const noExpiry = await post({ type: 'subscription', deliver: false });
  assert.equal(noExpiry.status, 400);
  assert.equal((await noExpiry.json()).reason, 'bad_expiry');

  const badExpiry = await post({ type: 'lifetime', expires_at: 'whenever', deliver: false });
  assert.equal(badExpiry.status, 400);
  assert.equal((await badExpiry.json()).reason, 'bad_expiry');

  const badType = await post({ type: 'trial', deliver: false });
  assert.equal(badType.status, 400);
  assert.equal((await badType.json()).reason, 'bad_type');

  const ok = await post({ type: 'lifetime', deliver: false });
  assert.equal(ok.status, 200, 'valid manual issuance still works');
  assert.equal((await ok.json()).license.type, 'lifetime');
}

console.log('license expiry validation regressions passed');
