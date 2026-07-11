import assert from 'node:assert/strict';
import { timingSafeEqualCalls } from './helpers/worker-runtime-shim.mjs';

const { default: worker } = await import('../backend/src/worker.js');

const telegramCalls = [];
globalThis.fetch = async (url, init = {}) => {
  telegramCalls.push({ url: String(url), body: JSON.parse(init.body || '{}') });
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

const kv = new Map();
const baseEnv = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  SUPPORT_CHAT_ID: '777',
  LICENSES: {
    async get(key) { return kv.get(key) || null; },
    async put(key, value) { kv.set(key, value); }
  }
};
const ctx = { waitUntil() {} };

const forgedOwnerReply = {
  message: {
    message_id: 9,
    chat: { id: 777 },
    from: { id: 777, first_name: 'Owner' },
    text: 'forged support reply',
    reply_to_message: { text: 'ticket route #id123456' }
  }
};

function webhookRequest(secret = null) {
  const headers = { 'content-type': 'application/json' };
  if (secret != null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  return new Request('https://smeshapi.site/telegram/webhook', {
    method: 'POST', headers, body: JSON.stringify(forgedOwnerReply)
  });
}

telegramCalls.length = 0;
const missingConfig = await worker.fetch(webhookRequest(), baseEnv, ctx);
assert.equal(missingConfig.status, 503, 'missing webhook secret must disable the route, not disable authentication');
assert.equal(telegramCalls.length, 0, 'misconfigured webhook must cause no Telegram side effect');

const configuredEnv = { ...baseEnv, TELEGRAM_WEBHOOK_SECRET: 'required-secret' };
telegramCalls.length = 0;
const wrongSecret = await worker.fetch(webhookRequest('wrong-secret'), configuredEnv, ctx);
assert.equal(wrongSecret.status, 401);
assert.equal(telegramCalls.length, 0, 'wrong secret must cause no Telegram side effect');

const timingSafePrimitive = crypto.subtle.timingSafeEqual;
delete crypto.subtle.timingSafeEqual;
const missingPrimitive = await worker.fetch(webhookRequest('required-secret'), configuredEnv, ctx);
assert.equal(missingPrimitive.status, 401, 'missing timing-safe primitive must fail authentication closed');
assert.equal(telegramCalls.length, 0);
Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
  configurable: true,
  value: timingSafePrimitive
});

telegramCalls.length = 0;
const valid = await worker.fetch(webhookRequest('required-secret'), configuredEnv, ctx);
assert.equal(valid.status, 200);
assert.ok(telegramCalls.some((call) => call.body.chat_id === '123456'),
  'a correctly authenticated Telegram update must still reach the intended handler');

assert.ok(timingSafeEqualCalls.count >= 2,
  'webhook authentication must execute the runtime timing-safe primitive');

// Operator helpers must never accept the webhook credential in a URL. They use
// a separate administrator header, and side-effecting helpers are POST-only.
const operatorEnv = {
  ...configuredEnv,
  ADMIN_SECRET: 'admin-secret'
};

telegramCalls.length = 0;
const legacySetup = await worker.fetch(new Request(
  'https://smeshapi.site/telegram/setup?secret=required-secret'
), operatorEnv, ctx);
assert.equal(legacySetup.status, 404, 'legacy GET setup route must no longer exist');
assert.equal(telegramCalls.length, 0);

const querySecretInfo = await worker.fetch(new Request(
  'https://smeshapi.site/telegram/info?secret=required-secret'
), operatorEnv, ctx);
assert.equal(querySecretInfo.status, 401, 'webhook secret in a query must not authorize operator helpers');
assert.equal(telegramCalls.length, 0);

const wrongAdmin = await worker.fetch(new Request('https://smeshapi.site/telegram/setup', {
  method: 'POST', headers: { 'X-Admin-Token': 'wrong-admin-secret' }
}), operatorEnv, ctx);
assert.equal(wrongAdmin.status, 401);
assert.equal(telegramCalls.length, 0);

const validAdmin = await worker.fetch(new Request('https://smeshapi.site/telegram/setup', {
  method: 'POST', headers: { 'X-Admin-Token': operatorEnv.ADMIN_SECRET }
}), operatorEnv, ctx);
assert.equal(validAdmin.status, 200);
assert.equal(telegramCalls.length, 2, 'authorized setup must call setWebhook and setMyCommands');
assert.equal(telegramCalls[0].body.secret_token, operatorEnv.TELEGRAM_WEBHOOK_SECRET);

telegramCalls.length = 0;
const legacyTest = await worker.fetch(new Request(
  'https://smeshapi.site/telegram/test?secret=required-secret&chat=123456'
), operatorEnv, ctx);
assert.equal(legacyTest.status, 404, 'legacy GET test route must no longer produce side effects');
assert.equal(telegramCalls.length, 0);

console.log('telegram webhook authentication regression passed');
