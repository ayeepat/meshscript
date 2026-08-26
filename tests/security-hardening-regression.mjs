import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isImageFile } from '../src/lib/file-kinds.js';
import { createSseSink, readResponseTextBounded } from '../src/lib/http.js';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

/* Only inert raster formats may enter a shared vision-provider parser. */
assert.equal(isImageFile({ mimeType: 'image/png', name: 'page.png' }), true);
assert.equal(isImageFile({ mimeType: 'image/svg+xml', name: 'payload.svg' }), false);
assert.equal(isImageFile({ mimeType: 'image/heic', name: 'camera.heic' }), false);
assert.equal(isImageFile({ mimeType: 'image/svg+xml', name: 'spoofed.png' }), false,
  'an explicitly unsafe MIME must not be overridden by a misleading extension');
assert.equal(isImageFile({ mimeType: 'application/octet-stream', name: 'mesh-photo.webp' }), true,
  'generic Mesh attachment MIME may fall back to a known-safe extension');
assert.equal(isImageFile({ mimeType: 'image/bmp', name: 'legacy.bmp' }), false);

const oversizedStream = createSseSink({ label: 'test' });
assert.throws(() => oversizedStream.push('x'.repeat(2 * 1024 * 1024 + 1)),
  /безопасный лимит/, 'newline-free upstream streams must have a hard memory bound');
const boundedUpstreamText = await readResponseTextBounded(new Response('x'.repeat(70 * 1024)));
assert.equal(boundedUpstreamText.length, 64 * 1024,
  'provider error/JSON bodies must stop at the shared response cap');

const aiProxySource = readFileSync(new URL('../backend/src/ai-proxy.js', import.meta.url), 'utf8');
const vpsProxySource = readFileSync(new URL('../backend-vps/server.js', import.meta.url), 'utf8');
for (const [label, source, sanitizerCall] of [
  ['Worker', aiProxySource, /isSafeImageDataUri\(part\.image_url\.url\)/],
  ['VPS', vpsProxySource, /isCanonicalBase64DataUri\(part\.image_url\.url, SAFE_IMAGE_DATA_URI\)/]
]) {
  assert.match(source, sanitizerCall,
    `${label} proxy must route image data URIs through its strict sanitizer`);
  assert.match(source, /payload\.length\s*%\s*4/,
    `${label} sanitizer must require complete base64 quanta`);
  assert.match(source, /&\s*0x0f/,
    `${label} sanitizer must reject non-zero unused bits before == padding`);
  assert.match(source, /&\s*0x03/,
    `${label} sanitizer must reject non-zero unused bits before = padding`);
  assert.doesNotMatch(source, /part\.image_url\.url\.startsWith\('data:image\/'\)/,
    'generic image data URIs must not reach shared providers');
}

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
const signedNow = Date.now();
const payloadBytes = new TextEncoder().encode(JSON.stringify({
  configVersion: 9,
  issuedAt: signedNow - 1_000,
  expiresAt: signedNow + 24 * 60 * 60 * 1000,
  homeworkAnchorSelector: APPROVED_HOMEWORK_SELECTORS[0],
  notice: { text: 'Обновление', url: 'https://evil.example/phishing' }
}));
const signature = new Uint8Array(await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, payloadBytes
));
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const envelope = { payload: b64url(payloadBytes), signature: b64url(signature) };
const verifiedEnvelope = await verifySignedConfigEnvelope(envelope, { publicJwk, now: signedNow });
assert.equal(verifiedEnvelope.configVersion, 9);
assert.deepEqual(verifiedEnvelope.notice, { text: 'Обновление' },
  'a signed notice still cannot direct users to an arbitrary phishing origin');
const tampered = { ...envelope, payload: b64url(new TextEncoder().encode('{"configVersion":10}')) };
assert.equal(await verifySignedConfigEnvelope(tampered, { publicJwk }), null);

const timelessBytes = new TextEncoder().encode(JSON.stringify({ configVersion: 10 }));
const timelessSignature = new Uint8Array(await crypto.subtle.sign(
  { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, timelessBytes
));
assert.equal(await verifySignedConfigEnvelope({
  payload: b64url(timelessBytes), signature: b64url(timelessSignature)
}, { publicJwk, now: signedNow }), null,
'an authentic payload without a signed lifetime must not be replayable forever');

localStore.runtimeConfig = {
  // This was the legacy permissive cache shape. It must not be served.
  configVersion: 999,
  homeworkAnchorSelector: 'a[href^="https://evil.example/"]',
  fetchedAt: Date.now()
};
const fromLegacyCache = await getRuntimeConfig();
assert.equal(fromLegacyCache.configVersion, 0);
assert.equal(localStore.runtimeConfig, undefined, 'unsigned legacy cache must be evicted');

/* The privileged message surface is the extension's trust boundary. Every type
 * the worker accepts must have a real caller: a routable handler nobody sends
 * is unreviewed attack surface that still spends quota, money and network. */
{
  const workerSource = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
  const senderTypes = workerSource.slice(
    workerSource.indexOf('const CONTENT_ACTIONS = new Set(['),
    workerSource.indexOf('const actionTokens = new Map();')
  );
  const declared = [...senderTypes.matchAll(/'([A-Z][A-Z_]+)'/g)].map((match) => match[1]);
  assert.ok(declared.length > 10, 'the accepted message types must be extractable');

  // Exhaustiveness works both ways: a schema/handler omitted from the sender
  // sets is dead code. The caller receives "action unavailable" before its
  // validated switch case can run, which is exactly how GDZ_COVER originally
  // shipped as a permanent placeholder.
  const schemaSource = workerSource.slice(
    workerSource.indexOf('const MESSAGE_SCHEMAS = {'),
    workerSource.indexOf('function isMeshContentUrl(')
  );
  const schemaTypes = [...schemaSource.matchAll(/^  ([A-Z][A-Z_]+):/gm)]
    .map((match) => match[1]);
  assert.ok(schemaTypes.length > 10, 'the message schemas must be extractable');
  assert.deepEqual(
    [...new Set(declared)].sort(),
    [...new Set(schemaTypes)].sort(),
    'sender allowlists and message schemas must name the same exhaustive surface'
  );

  const callerSources = [
    '../src/popup/popup.js', '../src/dashboard/dashboard.js', '../src/settings/settings.js',
    '../src/content/scraper.js', '../src/content/test-pill.js', '../src/content/answer-panel.js',
    '../src/lib/history.js', '../src/lib/license.js', '../src/lib/referral.js',
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

  // Content-script capabilities are named by GET_ACTION_TOKEN rather than sent
  // literally, so the token request counts as the caller.
  for (const type of declared) {
    assert.ok(
      callerSources.includes(`'${type}'`),
      `${type} is accepted by the worker but nothing in the extension sends it — ` +
      'delete the handler rather than leaving unreviewed privileged surface'
    );
  }

  for (const removed of ['CLASSIFY_TASKS', 'GDZ_CATALOG', 'GDZ_RESOLVE', 'GDZ_SELFTEST']) {
    assert.ok(!declared.includes(removed),
      `${removed} had no caller and must stay removed from the privileged surface`);
  }
}

/* Runtime-config signing is release authority. The CLI must reject a merely
 * well-formed P-256 key that does not match the public key shipped to clients,
 * and it must publish to the lexical OUTPUT path rather than following an
 * unrelated output symlink to its target. */
{
  const signer = readFileSync(
    new URL('../scripts/sign-runtime-config.mjs', import.meta.url), 'utf8'
  );
  assert.match(signer, /RUNTIME_CONFIG_PUBLIC_KEY_JWK/,
    'the signer must load the public key pinned by the extension');
  assert.match(signer, /actual\.x !== expected\.x \|\| actual\.y !== expected\.y/,
    'the derived key must be compared before any output is published');
  assert.match(signer, /rename\(temporaryPath, destinationPath\)/,
    'publishing must replace the requested output entry, not a resolved symlink target');
  assert.doesNotMatch(signer, /rename\(temporaryPath, resolved\.output\)/,
    'a harmless output symlink must never make the signer overwrite its target');
}

console.log('security hardening regressions passed');
