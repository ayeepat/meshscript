import assert from 'node:assert/strict';

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
let now = originalNow();
Date.now = () => now;
let store;
const local = {
  async get(keys) {
    if (typeof keys === 'string') return structuredClone({ [keys]: store[keys] });
    if (Array.isArray(keys)) return structuredClone(Object.fromEntries(keys.map((k) => [k, store[k]])));
    return structuredClone(store);
  },
  async set(values) { Object.assign(store, values); },
  async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]; },
};
globalThis.chrome = { storage: { local, session: local, onChanged: { addListener() {} } } };
const { askViaProxy } = await import('../src/lib/smesh-proxy.js');
const jobId = '00000000-0000-4000-8000-000000000001';
const jobToken = '00000000-0000-4000-8000-000000000002';
const messages = (large) => [{ role: 'user', content: large ? 'a'.repeat(40000) : '2+2' }];
let calls;
let starts;
let upload;
let failStart;
let failPoll;
let denyVerification;
function reset(remaining = 600000) {
  now = originalNow();
  store = {
    licenseStatus: { key: 'SMESH-TEST-TEST-TEST', ok: true, type: 'lifetime',
      activation_token: 'a'.repeat(43), entitlement_token: 'et1.old.signature',
      entitlement_token_expires_at: now + remaining, lastVerifiedAt: now, checkedAt: now },
    deviceId: '00000000-0000-4000-8000-000000000003',
    aiConsent: { version: 4, terms: true, ai_processing: true, eligibility: true, telemetry: false },
  };
  calls = []; starts = []; upload = () => {}; failStart = false; failPoll = false;
  denyVerification = false;
}
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  calls.push(path);
  if (path === '/verify') return Response.json(denyVerification
    ? { ok: false, reason: 'revoked' }
    : { ok: true, type: 'lifetime', expires_at: null,
      entitlement_token: 'et1.fresh.signature', entitlement_token_expires_at: now + 600000 });
  if (path === '/ai/upload-ticket') return Response.json({ ok: true, blob_id: jobId, upload_token: 'a'.repeat(43) });
  if (path === '/ai/blob') { upload(); return Response.json({ ok: true }); }
  if (path === '/ai/start') {
    starts.push(options.body);
    if (failStart) { failStart = false; throw new TypeError('synthetic lost start reply'); }
    return Response.json({ ok: true, job_id: jobId, job_token: jobToken });
  }
  if (path === '/ai/poll') {
    assert.equal(options.headers['X-Job-Token'], jobToken);
    if (failPoll) return Response.json({ ok: true, done: true, error: 'synthetic upstream failure' });
    return Response.json({ ok: true, done: true, cursor: 100, chunk:
      'data: {"choices":[{"delta":{"content":"4"}}]}\n\ndata: [DONE]\n\n' });
  }
  if (path === '/ai/cancel') {
    assert.equal(options.headers['X-Job-Token'], jobToken);
    return Response.json({ ok: true });
  }
  throw new Error(`unexpected request: ${path}`);
};

try {
  for (const provider of ['qwen', 'deepseek']) {
    for (const large of [false, true]) {
      reset();
      assert.equal(await askViaProxy(provider, messages(large)), '4');
      assert.equal(calls.filter((p) => p === '/ai/start').length, 1);
      assert.equal(calls.filter((p) => p === '/ai/poll').length, 1);
      assert.equal(calls.includes('/ai/blob'), large);
      assert.equal(calls.includes('/ai/cancel'), false);
    }
  }

  // The capability was fresh on entry, but expired during the upload.
  // A lost start response must replay the renewed payload byte-for-byte.
  reset(40000);
  upload = () => { now += 45000; };
  failStart = true;
  assert.equal(await askViaProxy('deepseek', messages(true)), '4');
  assert.equal(calls.filter((p) => p === '/verify').length, 1);
  assert.ok(calls.indexOf('/verify') > calls.indexOf('/ai/blob'));
  assert.equal(JSON.parse(starts[0]).entitlement_token, 'et1.fresh.signature');
  assert.equal(starts.length, 2);
  assert.equal(starts[0], starts[1], 'transport retry must preserve the entitlement and idempotency bytes');

  reset(40000);
  upload = () => { now += 45000; };
  denyVerification = true;
  await assert.rejects(askViaProxy('deepseek', messages(true)));
  assert.equal(calls.filter((p) => p === '/verify').length, 1);
  assert.equal(starts.length, 0, 'revocation discovered after upload must stop AI admission');

  for (const field of ['key', 'activation_token']) {
    reset();
    upload = () => { store.licenseStatus[field] = field === 'key' ? 'SMESH-OTHER-TEST-TEST' : 'b'.repeat(43); };
    await assert.rejects(askViaProxy('qwen', messages(true)), /Активация изменилась/);
    assert.equal(starts.length, 0, 'a different activation must never redeem the old upload');
  }

  reset();
  failPoll = true;
  await assert.rejects(askViaProxy('deepseek', messages(false)), /synthetic upstream failure/);
  assert.equal(calls.filter((p) => p === '/ai/cancel').length, 1,
    'a failed poll must cancel the paid job without a logger masking the failure');

  reset();
  const controller = new AbortController();
  upload = () => controller.abort();
  await assert.rejects(askViaProxy('qwen', messages(true), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(starts.length, 0);
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
}
console.log('proxy client lifecycle regression passed');
