import assert from 'node:assert/strict';

const store = new Map([
  ['deviceId', 'dddddddd-4444-4444-8444-444444444444']
]);
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.map((key) => [key, store.get(key)]));
      },
      async set(entries) {
        for (const [key, value] of Object.entries(entries)) store.set(key, value);
      },
      async remove(key) { store.delete(key); }
    }
  }
};

let payload = null;
globalThis.fetch = async () => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'content-type': 'application/json' }
});

const { verifyKey } = await import('../src/lib/license.js?telemetry-cache');
const goodToken = `tm1.${'A'.repeat(64)}.${'B'.repeat(43)}`;
const entitlementToken = 'et1.test.signature';
const expiry = Date.now() + 60_000;
payload = {
  ok: true,
  type: 'lifetime',
  expires_at: null,
  activation_token: 'a'.repeat(43),
  entitlement_token: entitlementToken,
  entitlement_token_expires_at: expiry,
  developer_mode: true,
  telemetry_token: goodToken,
  telemetry_token_expires_at: expiry
};
const valid = await verifyKey('SMESH-TOKEN-TEST-0001');
assert.equal(valid.telemetry_token, goodToken);
assert.equal(valid.telemetry_token_expires_at, expiry);
assert.equal(valid.developer_mode, true,
  'a strict server-issued owner marker must survive the client cache boundary');
assert.equal(store.get('licenseStatus').telemetry_token, goodToken);

payload = {
  ok: true,
  type: 'lifetime',
  activation_token: 'b'.repeat(43),
  entitlement_token: entitlementToken,
  entitlement_token_expires_at: Date.now() + 60_000,
  telemetry_token: 'not-a-token',
  telemetry_token_expires_at: Date.now() + 60_000
};
const malformed = await verifyKey('SMESH-TOKEN-TEST-0002');
assert.equal(Object.hasOwn(malformed, 'telemetry_token'), false,
  'a new verdict must drop the previous capability instead of carrying it forward');
assert.equal(Object.hasOwn(malformed, 'developer_mode'), false,
  'an owner marker must never cross a licence-key transition');

payload = {
  ok: true,
  type: 'lifetime',
  activation_token: 'c'.repeat(43),
  entitlement_token: entitlementToken,
  entitlement_token_expires_at: Date.now() + 60_000,
  developer_mode: 'true',
  telemetry_token: goodToken,
  telemetry_token_expires_at: Date.now() - 1
};
const expired = await verifyKey('SMESH-TOKEN-TEST-0003');
assert.equal(Object.hasOwn(expired, 'telemetry_token'), false);
assert.equal(Object.hasOwn(expired, 'developer_mode'), false,
  'truthy response data must not impersonate the strict owner marker');

console.log('license telemetry-token cache regressions passed');
