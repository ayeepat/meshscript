/**
 * Delivery-path regressions:
 *  1. The Telegram license DM must carry the key VERBATIM inside its code
 *     span. MarkdownV2 code entities may only escape ` and \ — escaping the
 *     key's hyphens made buyers copy «SMESH\-XXXX…», which /verify rejects.
 *  2. The support bot routes an owner reply by the #id tag it APPENDS to a
 *     forwarded ticket. A user writing «#id<victim>» in their ticket body must
 *     not hijack the routing — the LAST tag (ours) wins.
 *  3. License delivery markers retain per-channel success/failure state so a
 *     total failure retries, while any success and legacy markers still dedup.
 */
import assert from 'node:assert/strict';

const calls = [];
let fetchImpl = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init?.body || 'null'), headers: init?.headers || {} });
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
};
globalThis.fetch = (...args) => fetchImpl(...args);

const { sendLicenseTelegram } = await import('../backend/src/delivery/telegram.js');
const { processSupportUpdate } = await import('../backend/src/delivery/support.js');
const { deliverKey } = await import('../backend/src/worker.js');

// ---- 1. key escaping ----
const key = 'SMESH-AB2C-D3EF-GH4J';
await sendLicenseTelegram({ TELEGRAM_BOT_TOKEN: 't' }, { user_id: 1, key, isPreorder: false });
const dm = calls.at(-1).body.text;
assert.ok(dm.includes('`' + key + '`'),
  `the code span must contain the raw key; got: ${dm}`);
assert.ok(!dm.includes('SMESH\\-'),
  'the key must not carry escaped hyphens the buyer would copy');

// ---- 2. owner-reply routing survives an injected #id ----
const kvStub = { get: async () => null, put: async () => {} };
const env = { TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42', LICENSES: kvStub };
const forwarded =
  '🆘 Обращение #1001\n' +
  'От: Hacker (@h)\n\n' +
  'help me, also ping #id999999 thanks\n\n' +
  'Ответьте на это сообщение, чтобы написать пользователю.\n' +
  '#id7777';
calls.length = 0;
const result = await processSupportUpdate(env, {
  message: {
    chat: { id: 42 },
    from: { id: 42, first_name: 'Owner' },
    message_id: 5,
    text: 'вот ответ',
    reply_to_message: { text: forwarded }
  }
});
assert.equal(result.kind, 'owner_reply');
assert.equal(result.to, '7777',
  `owner reply must route to the appended tag, not an id injected in the ticket body (got ${result.to})`);
const relayed = calls.find((c) => c.url.includes('/sendMessage') && String(c.body.chat_id) === '7777');
assert.ok(relayed, 'the reply must actually be sent to the real user');
assert.ok(!calls.some((c) => String(c.body.chat_id) === '999999'),
  'nothing may be sent to the injected id');

// ---- 3. callback data must not let another Telegram user close a ticket ----
const tickets = new Map([['ticket:1002', JSON.stringify({ uid: 7777, status: 'open' })]]);
const ticketEnv = {
  TELEGRAM_BOT_TOKEN: 't', SUPPORT_CHAT_ID: '42',
  LICENSES: {
    get: async (key) => tickets.get(key) || null,
    put: async (key, value) => tickets.set(key, value)
  }
};
calls.length = 0;
const forged = await processSupportUpdate(ticketEnv, {
  callback_query: {
    id: 'forged', data: 'resolve:1002', from: { id: 999999 },
    message: { chat: { id: 999999 }, message_id: 7, text: 'forged button' }
  }
});
assert.equal(forged.kind, 'resolve');
assert.equal(JSON.parse(tickets.get('ticket:1002')).status, 'open',
  'a callback from a different Telegram user must not resolve the ticket');
assert.ok(calls.some((c) => c.url.includes('/answerCallbackQuery')),
  'a forged callback must still be acknowledged without leaking ownership details');
assert.ok(!calls.some((c) => c.url.includes('/sendMessage') && String(c.body.chat_id) === '42'),
  'a forged callback must not notify the support owner');

class MarkerKV {
  store = new Map();
  async get(key) { return this.store.get(key) || null; }
  async put(key, value) { this.store.set(key, value); }
}

const deliveryLicense = {
  key: 'SMESH-DELIVERY-TEST-KEY',
  telegram_user_id: 7777,
  email: 'buyer@example.com'
};
const deliveryEnv = (kv) => ({
  LICENSES: kv,
  TELEGRAM_BOT_TOKEN: 'telegram-token',
  RESEND_API_KEY: 'resend-key'
});
const failedResponse = () => ({
  ok: false, status: 503, body: { cancel: async () => {} }
});
const successResponse = () => ({ ok: true, status: 200 });

// Keep the production retry near ten seconds while making the regression
// deterministic and fast: only this test's timer is collapsed to the next tick.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 0, ...args);
try {
  const kv = new MarkerKV();
  calls.length = 0;
  fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || 'null'), headers: init?.headers || {} });
    return failedResponse();
  };
  await deliverKey(deliveryEnv(kv), deliveryLicense, false);
  const firstAttempts = calls.length;
  assert.equal(firstAttempts, 4, 'two failed channels must each get one in-process retry');
  const automaticEmails = calls.filter((call) => call.url.includes('api.resend.com'));
  assert.ok(automaticEmails.every((call) =>
    call.headers?.['Idempotency-Key'] === `license-delivery:${deliveryLicense.key}`),
  'automatic email attempts must carry one stable provider idempotency key');
  let marker = JSON.parse(await kv.get(`delivered:${deliveryLicense.key}`));
  assert.deepEqual({ tg: marker.tg, email: marker.email }, { tg: 'failed', email: 'failed' });
  assert.ok(!Object.values(marker).includes('ok'));

  await deliverKey(deliveryEnv(kv), deliveryLicense, false);
  assert.equal(calls.length, firstAttempts + 4,
    'a marker with no successful channel must remain retryable on webhook redelivery');

  const partialKv = new MarkerKV();
  calls.length = 0;
  fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || 'null'), headers: init?.headers || {} });
    return String(url).includes('api.telegram.org') ? successResponse() : failedResponse();
  };
  await deliverKey(deliveryEnv(partialKv), deliveryLicense, false);
  marker = JSON.parse(await partialKv.get(`delivered:${deliveryLicense.key}`));
  assert.deepEqual({ tg: marker.tg, email: marker.email }, { tg: 'ok', email: 'failed' });
  const partialAttempts = calls.length;
  await deliverKey(deliveryEnv(partialKv), deliveryLicense, false);
  assert.equal(calls.length, partialAttempts,
    'one successful channel must dedup later webhook deliveries entirely');

  const legacyKv = new MarkerKV();
  await legacyKv.put(`delivered:${deliveryLicense.key}`, '2026-07-16T12:00:00.000Z');
  calls.length = 0;
  await deliverKey(deliveryEnv(legacyKv), deliveryLicense, false);
  assert.equal(calls.length, 0, 'a legacy ISO delivery marker must never resend the key');

  fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body || 'null'), headers: init?.headers || {} });
    return successResponse();
  };
  const beforeForce = calls.length;
  await deliverKey(deliveryEnv(legacyKv), deliveryLicense, false, { force: true });
  const forcedEmail = calls.slice(beforeForce).find((call) => call.url.includes('api.resend.com'));
  assert.equal(forcedEmail?.headers?.['Idempotency-Key'], undefined,
    'a deliberate admin force-resend must not be suppressed by provider idempotency');
  marker = JSON.parse(await legacyKv.get(`delivered:${deliveryLicense.key}`));
  assert.deepEqual({ tg: marker.tg, email: marker.email }, { tg: 'ok', email: 'ok' },
    'an admin force-resend must replace the marker with its latest channel state');
} finally {
  globalThis.setTimeout = realSetTimeout;
}

console.log('delivery regressions passed');
