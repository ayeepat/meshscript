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

  // Routine re-verification may omit the unchanged activation bearer, but it
  // must issue a fresh short-lived AI entitlement. The prior installation
  // capability survives while the new AI capability replaces the old one.
  store.set('licenseStatus', {
    key,
    ok: true,
    type: 'lifetime',
    expires_at: null,
    activation_token: 'a'.repeat(43),
    lastVerifiedAt: NOW - 1000
  });
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    type: 'lifetime',
    expires_at: null,
    entitlement_token: 'et1.test.signature',
    entitlement_token_expires_at: NOW + 10 * 60 * 1000
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
  const refreshed = await verifyKey(key);
  assert.equal(isUsableLicenseStatus(refreshed), true,
    'routine re-verification must retain the valid installation capability');
  assert.equal(refreshed.activation_token, 'a'.repeat(43));

  let attemptedUrl = '';
  globalThis.fetch = async (url) => {
    attemptedUrl = String(url);
    throw new Error('offline');
  };
  store.set('licenseStatus', { key, ok: true, expires_at: null });
  const { askViaProxy } = await import('../src/lib/smesh-proxy.js');
  await assert.rejects(
    askViaProxy('deepseek', [{ role: 'user', content: 'test' }]),
    /Не удалось связаться с сервером/,
    'a direct proxy caller must reject when it cannot renew its capability'
  );
  assert.match(attemptedUrl, /\/verify$/,
    'the only permitted network attempt is an authoritative license refresh, never AI inference');

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
