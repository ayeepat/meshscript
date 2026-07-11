import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

/* Dashboard launch: short-lived, session-only, and exactly one consumer wins. */
const sessionStore = {};
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
globalThis.chrome = {
  storage: {
    session: {
      async get(key) { await pause(); return { [key]: sessionStore[key] }; },
      async set(values) { await pause(); Object.assign(sessionStore, values); },
      async remove(key) { await pause(); delete sessionStore[key]; }
    },
    local: {
      async get(key) { await pause(); return { [key]: localStore[key] }; },
      async set(values) { Object.assign(localStore, values); },
      async remove(key) { delete localStore[key]; }
    }
  }
};

const localStore = {};
const {
  storeDashboardLaunch,
  consumeDashboardLaunch,
  cleanupDashboardLaunches
} = await import('../src/lib/dashboard-launch.js');

const launchId = await storeDashboardLaunch({ subject: 'Алгебра', task: '№ 7' });
assert.equal(localStore.dashLaunches, undefined, 'plaintext launch payload must never enter storage.local');
assert.equal(JSON.stringify(sessionStore).includes('№ 7'), false,
  'content-script-readable storage.session must contain ciphertext, not task text');
const consumed = await Promise.all([
  consumeDashboardLaunch(launchId),
  consumeDashboardLaunch(launchId)
]);
assert.equal(consumed.filter(Boolean).length, 1, 'a launch token must have exactly one winner');
assert.equal(consumed.find(Boolean).task, '№ 7');

sessionStore.dashLaunches = {
  stale: { ciphertext: 'AA', iv: 'AA', expiresAt: Date.now() - 1 }
};
localStore.dashLaunchKeys = { stale: { key: 'AA', expiresAt: Date.now() - 1 } };
await cleanupDashboardLaunches();
assert.equal(sessionStore.dashLaunches, undefined, 'scheduled cleanup must delete expired launches');
assert.equal(localStore.dashLaunchKeys, undefined, 'scheduled cleanup must delete expired launch keys');

const workerSource = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8');
assert.match(workerSource, /CONSUME_DASH_LAUNCH: \(msg\) => payloadRecord/,
  'consume message must be admitted only through the validated message schema');
assert.match(workerSource, /sender\?\.url\?\.split\('\?'\)\[0\] !== dashboardUrl/,
  'only the dashboard extension page may consume launch capabilities');
assert.doesNotMatch(dashboardSource, /storage\.local\.get\('dashLaunches'\)/,
  'dashboard must consume through the serialized worker boundary');

/* Remote config: exact selector policy plus cryptographic tamper detection. */
globalThis.fetch = async () => { throw new Error('offline'); };
const {
  APPROVED_HOMEWORK_SELECTORS,
  sanitizeRuntimeConfig,
  verifySignedConfigEnvelope,
  getRuntimeConfig
} = await import('../src/lib/remote-config.js');

assert.equal(sanitizeRuntimeConfig({ homeworkAnchorSelector: 'body' }).homeworkAnchorSelector, null);
assert.equal(
  sanitizeRuntimeConfig({ homeworkAnchorSelector: 'a[href^="https://evil.example/"]' }).homeworkAnchorSelector,
  null,
  'grammar-valid but unapproved selectors must be rejected'
);
assert.equal(
  sanitizeRuntimeConfig({ homeworkAnchorSelector: APPROVED_HOMEWORK_SELECTORS[0] }).homeworkAnchorSelector,
  APPROVED_HOMEWORK_SELECTORS[0]
);

const keys = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
);
const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
const payloadBytes = new TextEncoder().encode(JSON.stringify({
  configVersion: 9,
  homeworkAnchorSelector: APPROVED_HOMEWORK_SELECTORS[0]
}));
const signature = new Uint8Array(await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, payloadBytes
));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const envelope = { payload: b64url(payloadBytes), signature: b64url(signature) };
assert.equal((await verifySignedConfigEnvelope(envelope, { publicJwk })).configVersion, 9);
const tampered = { ...envelope, payload: b64url(new TextEncoder().encode('{"configVersion":10}')) };
assert.equal(await verifySignedConfigEnvelope(tampered, { publicJwk }), null);

localStore.runtimeConfig = {
  // This was the legacy permissive cache shape. It must not be served.
  configVersion: 999,
  homeworkAnchorSelector: 'a[href^="https://evil.example/"]',
  fetchedAt: Date.now()
};
const fromLegacyCache = await getRuntimeConfig();
assert.equal(fromLegacyCache.configVersion, 0);
assert.equal(localStore.runtimeConfig, undefined, 'unsigned legacy cache must be evicted');

console.log('security hardening regressions passed');
