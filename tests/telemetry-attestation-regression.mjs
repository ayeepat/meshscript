import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import {
  issueTelemetryToken,
  verifyTelemetryToken,
  TELEMETRY_TOKEN_TTL_MS
} from '../backend/src/telemetry-token.js';

class FakeD1 {
  budgets = new Map();
  batches = 0;

  prepare(sql) {
    const db = this;
    return {
      bind: (...args) => ({
        async first() {
          if (sql.includes('UPDATE telemetry_budget')) {
            const [day, scope, key, amount] = args;
            const id = `${day}|${scope}|${key}`;
            if (!db.budgets.has(id)) return null;
            const count = Math.max(0, db.budgets.get(id) - amount);
            db.budgets.set(id, count);
            return count;
          }
          if (!sql.includes('INSERT INTO telemetry_budget')) return null;
          const isDevice = sql.includes("SELECT ?1, 'device'");
          const day = args[0];
          const scope = isDevice ? 'device' : args[1];
          const key = isDevice ? args[1] : args[2];
          const amount = isDevice ? args[2] : args[3];
          const cap = args[4];
          const limit = args[5];
          const id = `${day}|${scope}|${key}`;
          const current = db.budgets.get(id) || 0;
          if (current > limit) return null;
          const count = Math.min(current + amount, cap);
          db.budgets.set(id, count);
          return count;
        },
        async run() { return { meta: { changes: 1 } }; }
      })
    };
  }

  async batch(statements) {
    this.batches += 1;
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

const SECRET = 'telemetry-attestation-test-secret-32-bytes-plus';
const OWNER_KEY = 'SMESH-OWNER-TEST-KEY';
const DEVICE = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_DEVICE = 'bbbbbbbb-2222-4222-8222-222222222222';
const ctx = { waitUntil() {} };
const db = new FakeD1();
const env = {
  DB: db,
  INGEST_KEY: SECRET,
  OWNER_LICENSE_KEY: OWNER_KEY
};

assert.equal(await issueTelemetryToken(env, '79991234567'), null,
  'phone-like caller text must never become an authenticated analytics device id');

const verifyResponse = await worker.fetch(new Request('https://api.example/verify', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: OWNER_KEY, device_id: DEVICE })
}), env, ctx);
assert.equal(verifyResponse.status, 200);
assert.match(
  verifyResponse.headers.get('access-control-allow-headers') || '',
  /X-Telemetry-Token/i,
  'extension preflights must be allowed to send the narrow telemetry capability'
);
const verdict = await verifyResponse.json();
assert.equal(verdict.ok, true);
assert.match(verdict.telemetry_token, /^tm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
assert.ok(verdict.telemetry_token_expires_at > Date.now());

const eventRequest = (deviceId, token) => new Request('https://api.example/t', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'cf-connecting-ip': '203.0.113.90',
    ...(token ? { 'x-telemetry-token': token } : {})
  },
  body: JSON.stringify({
    device_id: deviceId,
    browser: 'chrome',
    version: '0.5.0',
    license_type: 'lifetime',
    events: [{
      type: 'solve',
      subject: 'Алгебра',
      tokens_in: 9_999_999,
      tokens_out: 9_999_999,
      cost_usd: 50
    }]
  })
});

const anonymous = await worker.fetch(eventRequest(DEVICE, ''), env, ctx);
assert.equal(anonymous.status, 401, 'anonymous callers cannot manufacture users or events');
assert.equal(db.batches, 0);

const parts = verdict.telemetry_token.split('.');
const replacement = parts[1].endsWith('A') ? 'B' : 'A';
const tamperedPayload = `${parts[0]}.${parts[1].slice(0, -1)}${replacement}.${parts[2]}`;
const tampered = await worker.fetch(eventRequest(DEVICE, tamperedPayload), env, ctx);
assert.equal(tampered.status, 401, 'payload tampering must invalidate the HMAC');
assert.equal(db.batches, 0);

const mismatch = await worker.fetch(
  eventRequest(OTHER_DEVICE, verdict.telemetry_token),
  env,
  ctx
);
assert.equal(mismatch.status, 403,
  'a capability cannot be replayed to manufacture a second device');
assert.equal(db.batches, 0);

const admitted = await worker.fetch(
  eventRequest(DEVICE, verdict.telemetry_token),
  env,
  ctx
);
assert.equal(admitted.status, 200);
assert.equal((await admitted.json()).accepted, 1);
assert.equal(db.batches, 1);

const issuedAt = 2_000_000_000_000;
const shortLived = await issueTelemetryToken(env, DEVICE, issuedAt);
assert.equal(
  (await verifyTelemetryToken(env, shortLived.token, issuedAt + TELEMETRY_TOKEN_TTL_MS - 1)).ok,
  true
);
assert.deepEqual(
  await verifyTelemetryToken(env, shortLived.token, issuedAt + TELEMETRY_TOKEN_TTL_MS),
  { ok: false, reason: 'expired_token' },
  'expiry is enforced at the exact boundary'
);
assert.equal(
  (await verifyTelemetryToken(
    { INGEST_KEY: `${SECRET}-different` },
    shortLived.token,
    issuedAt
  )).ok,
  false,
  'tokens are scoped to the configured secret'
);

console.log('telemetry attestation regressions passed');
