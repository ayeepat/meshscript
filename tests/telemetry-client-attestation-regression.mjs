import assert from 'node:assert/strict';

const DEVICE = 'cccccccc-3333-4333-8333-333333333333';
const TOKEN = `tm1.${'A'.repeat(64)}.${'B'.repeat(43)}`;
const store = new Map([
  ['telemetryEnabled', true],
  ['aiProvider', 'qwen'],
  ['aiConsent', { accepted: true, version: 3, at: new Date().toISOString() }],
  ['deviceId', DEVICE]
]);

globalThis.chrome = {
  runtime: { getManifest: () => ({ version: '0.5.0' }) },
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
        }
        return { [keys]: store.get(keys) };
      },
      async set(entries) {
        for (const [key, value] of Object.entries(entries)) store.set(key, value);
      }
    }
  }
};
try {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 Chrome/140.0'
  });
} catch {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 Chrome/140.0' }
  });
}

const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'content-type': 'application/json' }
  });
};

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

// Opt-in alone is insufficient: without a fresh capability from /verify the
// queue is dropped locally and never reaches the network.
store.set('licenseStatus', { ok: true, type: 'lifetime' });
const withoutToken = await import('../src/lib/telemetry.js?client-no-token');
for (let i = 0; i < 20; i++) withoutToken.track('heartbeat');
await settle();
assert.equal(requests.length, 0);

store.set('licenseStatus', {
  ok: true,
  type: 'lifetime',
  telemetry_token: TOKEN,
  telemetry_token_expires_at: Date.now() + 60_000
});
const withToken = await import('../src/lib/telemetry.js?client-token');
const usage = withToken.usageFields('qwen', {
  model: 'qwen3.7-plus',
  prompt_tokens: 12345,
  completion_tokens: 6789,
  cost: 42
});
assert.deepEqual(usage, { provider: 'qwen', model: 'qwen3.7-plus' },
  'client usage helpers must not produce financial-looking self-reported fields');
for (let i = 0; i < 20; i++) withToken.track('solve', usage);
await settle();

assert.equal(requests.length, 1);
const sent = requests[0];
assert.equal(new Headers(sent.init.headers).get('x-telemetry-token'), TOKEN);
const body = JSON.parse(sent.init.body);
assert.equal(body.device_id, DEVICE);
assert.equal(body.events.length, 20);
for (const event of body.events) {
  assert.equal(Object.hasOwn(event, 'tokens_in'), false);
  assert.equal(Object.hasOwn(event, 'tokens_out'), false);
  assert.equal(Object.hasOwn(event, 'cost_usd'), false);
}

console.log('telemetry client attestation regressions passed');
