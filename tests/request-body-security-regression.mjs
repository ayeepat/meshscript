import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

await import('./helpers/worker-runtime-shim.mjs');
import worker from '../backend/src/worker.js';
import { handleAiChat } from '../backend/src/ai-proxy.js';
import { readJsonBounded } from '../backend/src/request-body.js';
import { readResultFields } from '../backend/src/gateways/robokassa.js';

const REFERRAL_DEVICE = '11111111-1111-4111-8111-111111111111';
const IMAGE_DEVICE = '22222222-2222-4222-8222-222222222222';
const IMAGE_ACTIVATION_TOKEN = 'A'.repeat(43);
const IMAGE_ACTIVATION_HASH = [...new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(IMAGE_ACTIVATION_TOKEN)
))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function chunkedRequest(chunks, headers = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    }
  });
  return {
    headers: new Headers(headers),
    body: stream
  };
}

const bounded = await readJsonBounded(chunkedRequest([
  '{"value":"', 'x'.repeat(5000), '"}'
]), 4096);
assert.deepEqual(bounded, { ok: false, reason: 'too_large', status: 413 },
  'a chunked body with no Content-Length must stop at the streamed byte cap');

const declared = await readJsonBounded(chunkedRequest(['{}'], { 'Content-Length': '5000' }), 4096);
assert.deepEqual(declared, { ok: false, reason: 'too_large', status: 413 });

await assert.rejects(
  readResultFields(new Request('https://api.example/webhook/robokassa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `OutSum=199&InvId=1&padding=${'x'.repeat(17000)}`
  })),
  (error) => error?.status === 413,
  'the unauthenticated payment callback must be bounded before signature parsing'
);

const validResult = await readResultFields(new Request('https://api.example/webhook/robokassa', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'OutSum=199.00&InvId=42&SignatureValue=abc123&Shp_ref=HELLO'
}));
assert.equal(validResult.OutSum, '199.00');
assert.equal(validResult.InvId, '42');
assert.equal(validResult.Shp_ref, 'HELLO', 'bounded parsing must preserve legitimate gateway fields');

class FakeKV {
  store = new Map();
  async get(key) { return this.store.get(key) || null; }
  async put(key, value) { this.store.set(key, value); }
}
const env = { LICENSES: new FakeKV() };
const ctx = { waitUntil() {} };
const oversizedReferral = await worker.fetch(new Request('https://api.example/referral/code', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.8' },
  body: JSON.stringify({ device_id: REFERRAL_DEVICE, padding: 'x'.repeat(5000) })
}), env, ctx);
assert.equal(oversizedReferral.status, 413);
assert.equal((await oversizedReferral.json()).reason, 'body_too_large');
assert.equal([...env.LICENSES.store.keys()].some((key) => key.startsWith('refip:')), false,
  'rejected bodies must not consume the shared referral rate budget');

const legacyStatusGet = await worker.fetch(
  new Request(`https://api.example/referral/status?device_id=${REFERRAL_DEVICE}&referral_auth=secret`),
  env,
  ctx
);
assert.equal(legacyStatusGet.status, 404,
  'referral capabilities must never be accepted in a URL/query string');

const referralAuth = 'a'.repeat(43);
const validReferralStatus = await worker.fetch(new Request('https://api.example/referral/status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: REFERRAL_DEVICE, referral_auth: referralAuth })
}), env, ctx);
assert.equal(validReferralStatus.status, 200,
  'the public referral route must accept the UUIDv4 shape emitted by current clients');
assert.equal((await validReferralStatus.json()).ok, true);

const nonUuidReferralStatus = await worker.fetch(new Request('https://api.example/referral/status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: 'device-test', referral_auth: referralAuth })
}), env, ctx);
assert.equal(nonUuidReferralStatus.status, 400);
assert.equal((await nonUuidReferralStatus.json()).reason, 'bad_device',
  'public referral routes must reject content-bearing legacy identifiers');

const oversizedTelegram = await worker.fetch(new Request('https://api.example/telegram/webhook', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Telegram-Bot-Api-Secret-Token': 'webhook-secret'
  },
  body: JSON.stringify({ padding: 'x'.repeat(140 * 1024) })
}), { ...env, TELEGRAM_WEBHOOK_SECRET: 'webhook-secret' }, ctx);
assert.equal(oversizedTelegram.status, 200,
  'oversized authenticated Telegram updates must be bounded and acknowledged without processing');
assert.deepEqual(await oversizedTelegram.json(), { ok: true });

const oversizedAdmin = await worker.fetch(new Request('https://api.example/admin/issue', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'admin-secret'.repeat(3) },
  body: JSON.stringify({ note: 'x'.repeat(20 * 1024) })
}), { ...env, ADMIN_SECRET: 'admin-secret'.repeat(3) }, ctx);
assert.equal(oversizedAdmin.status, 413,
  'authenticated admin mutations must still enforce a streamed body cap');

const workerSource = readFileSync(new URL('../backend/src/worker.js', import.meta.url), 'utf8');
assert.doesNotMatch(workerSource, /request\.(?:json|text|formData|arrayBuffer)\(/,
  'Worker request bodies must go through explicit bounded readers');

const aiProxySource = readFileSync(new URL('../backend/src/ai-proxy.js', import.meta.url), 'utf8');
assert.match(aiProxySource, /readJsonBounded\(request, MAX_BODY_BYTES\)/,
  'the public Worker AI proxy must stream through the shared request cap');

// The per-image character cap is not a byte/format check: a string of Unicode
// code points can be several times larger in UTF-8 and is not base64 at all.
// Reject it before quota charging or the paid upstream parser sees it, while
// preserving the canonical FileReader data-URI shape real clients send.
class AiD1 {
  prepare(sql) {
    const statement = {
      bind() {
        return statement;
      },
      async first(column) {
        if (sql.includes('FROM license_activations')) {
          const row = {
            status: 'active', device_id: IMAGE_DEVICE,
            token_hash: IMAGE_ACTIVATION_HASH, generation: 1,
          };
          return column ? row[column] : row;
        }
        if (sql.includes('proxy_quota')) return column ? 1 : { count: 1 };
        return null;
      },
      async run() { return { meta: { changes: 1 } }; },
    };
    return statement;
  }

  async batch() {
    return [
      { success: true, results: [{ count: 1 }] },
      { success: true, results: [{ count: 1 }] }
    ];
  }
}
const aiKv = new FakeKV();
aiKv.store.set('SMESH-IMAGE-BASE64', JSON.stringify({
  key: 'SMESH-IMAGE-BASE64', type: 'lifetime', status: 'active', expires_at: null,
  device_ids: [IMAGE_DEVICE]
}));
const aiEnv = {
  LICENSES: aiKv,
  DB: new AiD1(),
  AI_PROXY_API_KEY: 'proxy-test-key'
};
let upstreamCalls = 0;
globalThis.fetch = async () => {
  upstreamCalls += 1;
  return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
const aiRequest = (url) => new Request('https://api.example/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'qwen', license_key: 'SMESH-IMAGE-BASE64', device_id: IMAGE_DEVICE,
    activation_token: IMAGE_ACTIVATION_TOKEN,
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }]
    }]
  })
});

const validImage = await handleAiChat(aiRequest('data:image/png;base64,iVBORw0KGgo='), aiEnv);
assert.equal(validImage.status, 200, 'canonical base64 data URIs remain accepted');
assert.equal(upstreamCalls, 1);

const nonUuidImage = await handleAiChat(new Request('https://api.example/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'qwen',
    license_key: 'SMESH-IMAGE-BASE64',
    device_id: 'device-image-base64-01',
    messages: [{ role: 'user', content: 'test' }]
  })
}), aiEnv);
assert.equal(nonUuidImage.status, 403,
  'the paid public AI route must reject legacy/content-bearing device identifiers');
assert.equal(upstreamCalls, 1, 'a malformed public device id must not reach the paid upstream');

for (const invalid of [
  `data:image/png;base64,${'😀'.repeat(1024)}`,
  'data:image/png;base64,iVBORw0KGgo',   // missing canonical padding/quantum
  'data:image/png;base64,Zh=='             // decodes, but has non-zero unused bits
]) {
  const response = await handleAiChat(aiRequest(invalid), aiEnv);
  assert.equal(response.status, 400, `invalid/non-canonical base64 must be rejected: ${invalid.slice(0, 40)}`);
}
assert.equal(upstreamCalls, 1, 'rejected image payloads must never reach the paid upstream');

console.log('bounded public-request regressions passed');
