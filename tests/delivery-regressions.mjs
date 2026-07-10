/**
 * Delivery-path regressions:
 *  1. The Telegram license DM must carry the key VERBATIM inside its code
 *     span. MarkdownV2 code entities may only escape ` and \ — escaping the
 *     key's hyphens made buyers copy «SMESH\-XXXX…», which /verify rejects.
 *  2. The support bot routes an owner reply by the #id tag it APPENDS to a
 *     forwarded ticket. A user writing «#id<victim>» in their ticket body must
 *     not hijack the routing — the LAST tag (ours) wins.
 */
import assert from 'node:assert/strict';

const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init?.body || 'null') });
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' };
};

const { sendLicenseTelegram } = await import('../backend/src/delivery/telegram.js');
const { processSupportUpdate } = await import('../backend/src/delivery/support.js');

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

console.log('delivery regressions passed');
