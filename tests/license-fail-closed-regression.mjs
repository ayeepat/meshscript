import assert from 'node:assert/strict';
import { LICENSE_OFFLINE_GRACE_MS } from '../src/lib/config.js';

const NOW = Date.parse('2026-08-01T12:00:00Z');
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const store = new Map();
let fetchCalls = 0;

Date.now = () => NOW;
globalThis.chrome = { storage: { local: {
  async get(keys) {
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
    return { [keys]: store.get(keys) };
  },
  async set(entries) { for (const [key, value] of Object.entries(entries)) store.set(key, value); },
  async remove(key) { store.delete(key); }
} } };

const key = 'SMESH-TEST-1111-2222';
const { ensureLicensed, getLicenseStatus, verifyKey } = await import('../src/lib/license.js');

try {
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      ok: true, type: 'lifetime', expires_at: null, activation_token: 'a'.repeat(43),
      entitlement_token: 'et1.test.signature', entitlement_token_expires_at: NOW + 10 * 60 * 1000
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  const verified = await verifyKey(key);
  assert.equal(verified.lastVerifiedAt, NOW, 'a parsed 200 verdict must set lastVerifiedAt');
  await assert.doesNotReject(ensureLicensed(), 'a server-confirmed license must pass');

  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('offline'); };
  store.set('licenseStatus', {
    ...verified,
    expires_at: new Date(NOW - 60 * 60 * 1000).toISOString(),
    checkedAt: NOW,
    lastVerifiedAt: NOW
  });
  const beforeExpired = fetchCalls;
  await assert.rejects(ensureLicensed(), /Не удалось связаться с сервером/,
    'an expired cached verdict must re-verify and cannot ride the offline grace');
  assert.equal(fetchCalls, beforeExpired + 1,
    'expiry must trigger an authoritative server re-verification');

  store.set('licenseStatus', {
    ...verified, checkedAt: NOW - LICENSE_OFFLINE_GRACE_MS,
    lastVerifiedAt: NOW - LICENSE_OFFLINE_GRACE_MS + 1
  });
  await assert.doesNotReject(ensureLicensed(), 'an outage inside the absolute grace must pass softly');

  const expiredVerification = NOW - LICENSE_OFFLINE_GRACE_MS - 1;
  store.set('licenseStatus', {
    ...verified, checkedAt: expiredVerification, lastVerifiedAt: expiredVerification
  });
  await assert.rejects(ensureLicensed(), /Не удалось связаться с сервером/,
    'an outage after the absolute grace must fail closed');
  assert.equal(store.get('licenseStatus').lastVerifiedAt, expiredVerification,
    'failed rechecks must never renew entitlement freshness');
  await assert.rejects(ensureLicensed(), /Не удалось связаться с сервером/,
    'repeated failed rechecks must remain closed');
  assert.equal(store.get('licenseStatus').lastVerifiedAt, expiredVerification);

  const beforeLegacy = fetchCalls;
  store.set('licenseStatus', { key, ok: true, checkedAt: NOW });
  await assert.rejects(ensureLicensed(), /Не удалось связаться с сервером/);
  assert.equal(fetchCalls, beforeLegacy + 1,
    'a legacy/forged cache without lastVerifiedAt must re-verify, not pass from checkedAt');

  store.set('licenseGeneration', 'fresh-generation');
  store.set('licenseStatus', {
    key, ok: true, checkedAt: NOW, lastVerifiedAt: NOW, generation: 'stale-generation'
  });
  assert.equal(await getLicenseStatus(), null,
    'a status embedded under an obsolete generation must be dead on arrival');

  const legacy = { key, ok: true, checkedAt: NOW, lastVerifiedAt: NOW };
  store.set('licenseStatus', legacy);
  assert.deepEqual(await getLicenseStatus(), legacy,
    'legacy status rows without an embedded generation must remain readable');
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}

console.log('license fail-closed regression passed');
