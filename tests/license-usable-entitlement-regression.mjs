import assert from 'node:assert/strict';
import fs from 'node:fs';

const NOW = Date.parse('2026-08-27T12:00:00Z');
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const store = new Map();

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
const {
  ensureLicensed, isUsableLicenseStatus, verifyKey
} = await import('../src/lib/license.js');

try {
  // This is the broken state reported by users: /verify says the purchase is
  // active, but gives the extension no bearer capability for /ai/start.
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    type: 'lifetime',
    expires_at: null
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  const verdict = await verifyKey(key);
  assert.equal(verdict.ok, false,
    'an entitlement without an activation capability must not be presented as active');
  assert.equal(verdict.reason, 'bad_activation');
  await assert.rejects(ensureLicensed(), /Не удалось подтвердить активацию/,
    'the solve gate must not pass a license that the proxy cannot authenticate');

  // Current server behavior intentionally omits the bearer on routine
  // re-verification. A valid prior capability must survive that response.
  store.set('licenseStatus', {
    key,
    ok: true,
    type: 'lifetime',
    expires_at: null,
    activation_token: 'a'.repeat(43),
    lastVerifiedAt: NOW - 1000
  });
  const refreshed = await verifyKey(key);
  assert.equal(isUsableLicenseStatus(refreshed), true,
    'routine re-verification must retain the valid installation capability');
  assert.equal(refreshed.activation_token, 'a'.repeat(43));

  globalThis.fetch = async () => {
    throw new Error('proxy fetch must not run for an unusable local entitlement');
  };
  store.set('licenseStatus', { key, ok: true, expires_at: null });
  const { askViaProxy } = await import('../src/lib/smesh-proxy.js');
  await assert.rejects(
    askViaProxy('deepseek', [{ role: 'user', content: 'test' }]),
    /Не удалось подтвердить активацию/,
    'a direct proxy caller must reject before sending an unauthenticated request'
  );

  const popupSource = fs.readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
  const settingsSource = fs.readFileSync(new URL('../src/settings/settings.js', import.meta.url), 'utf8');
  const proxySource = fs.readFileSync(new URL('../src/lib/smesh-proxy.js', import.meta.url), 'utf8');
  for (const [name, source] of [
    ['popup', popupSource],
    ['settings', settingsSource],
    ['proxy', proxySource]
  ]) {
    assert.match(source, /isUsableLicenseStatus/,
      `${name} must use the shared usable-entitlement contract`);
  }
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}

console.log('license usable-entitlement regression passed');
