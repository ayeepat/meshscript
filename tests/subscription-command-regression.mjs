// Regression: the /sub surface — what it shows, what it never shows, and who
// is allowed to release a device.
//
// Two properties are load-bearing:
//   * the license key is a bearer credential, so it must not appear in full in
//     the card, and never in callback_data (which the webhook debug record
//     stores verbatim);
//   * a release is authorized by re-resolving the caller's OWN licenses, so an
//     account can never act on a key that does not belong to it — including by
//     replaying someone else's button through a modified client.
import assert from 'node:assert/strict';
import {
  callback, captureTelegram, createEnv, privateMessage, seedActivation, seedLicense
} from './helpers/subscription-harness.mjs';

const telegram = captureTelegram();
const { processSubscriptionUpdate } = await import('../backend/src/delivery/subscription.js');

const KEY = 'SMESH-AAAA-BBBB-CCCC';
const OTHER_KEY = 'SMESH-DDDD-EEEE-FFFF';
const DEVICE = 'device-aaaa-9f2c';
const OWNER = 777;
const STRANGER = 888;
const DAY = 24 * 60 * 60 * 1000;

const env = createEnv();
// Only the per-minute flood control — the per-day bind budget is under test.
const resetRate = () =>
  env.sqlite.exec("DELETE FROM telemetry_budget WHERE scope = 'support_rate'");
const claimUpdate = (update) => {
  const claimedAt = Date.now();
  env.sqlite.prepare(
    'INSERT INTO telegram_updates (update_id, claimed_at, lease_until) VALUES (?, ?, ?)'
  ).run(update.update_id, claimedAt, claimedAt + 60_000);
  return { updateId: update.update_id, claimVersion: claimedAt };
};
const run = (update) => processSubscriptionUpdate(env, update, claimUpdate(update));
const activation = () => env.sqlite.prepare(
  'SELECT status, device_id FROM license_activations WHERE license_key = ?'
).get(KEY);

await seedLicense(env, {
  key: KEY,
  telegram_user_id: String(OWNER),
  expires_at: new Date(Date.now() + 17 * DAY).toISOString(),
  subscription_started_at: new Date(Date.now() - 13 * DAY).toISOString()
});
seedActivation(env, KEY, DEVICE, { activatedAt: Date.now() - 13 * DAY });

/* ---------------------------- the card itself --------------------------- */

const card = await run(privateMessage('/sub', { from: OWNER }));
assert.equal(card.handled, true);
assert.equal(card.kind, 'sub_card');
const cardBody = telegram.sent().at(-1).body;
assert.ok(cardBody.text.includes('SMESH-····-····-CCCC'), 'the card identifies the key');
assert.ok(!cardBody.text.includes(KEY), 'the full bearer key must not be echoed back');
assert.ok(cardBody.text.includes('····9f2c'), 'the buyer needs to recognize the device');
assert.ok(!cardBody.text.includes(DEVICE), 'the raw installation id adds nothing here');
assert.ok(/осталось 1[67] дней/.test(cardBody.text), `days left must be pluralized: ${cardBody.text}`);
assert.ok(cardBody.text.includes('Активирован:'), 'the card reports the activation date');
const releaseButton = cardBody.reply_markup.inline_keyboard
  .flat().find((button) => String(button.callback_data || '').startsWith('sub:rel:'));
assert.ok(releaseButton, 'an active installation offers the release button');
assert.equal(releaseButton.callback_data, 'sub:rel:0:CCCC');
for (const button of cardBody.reply_markup.inline_keyboard.flat()) {
  assert.ok(!String(button.callback_data || '').includes('SMESH-'),
    'callback data is echoed into the debug record — it must never carry a key');
}

/* ------------------------------ the release ----------------------------- */

resetRate();
telegram.reset();
const confirm = await run(callback('sub:rel:0:CCCC', { from: OWNER }));
assert.equal(confirm.kind, 'sub_release_confirm');
assert.equal(activation().status, 'active', 'the first tap only asks');
const confirmBody = telegram.sent().at(-1).body;
assert.ok(confirmBody.text.includes('SMESH-····-····-CCCC'));
assert.equal(
  confirmBody.reply_markup.inline_keyboard[0][0].callback_data, 'sub:relx:0:CCCC'
);

resetRate();
telegram.reset();
const done = await run(callback('sub:relx:0:CCCC', { from: OWNER }));
assert.equal(done.kind, 'sub_release');
assert.equal(activation().status, 'inactive', 'confirming actually frees the seat');
const fence = env.sqlite.prepare(
  'SELECT device_id, released_by FROM license_release_fence WHERE license_key = ?'
).get(KEY);
assert.deepEqual({ ...fence }, { device_id: DEVICE, released_by: String(OWNER) },
  'the release is fenced so the old installation cannot silently re-claim it');
assert.ok(telegram.texts().some((text) => text.includes('свободен')));

/* --------------------------- other people's keys ------------------------ */

resetRate();
telegram.reset();
seedActivation(env, OTHER_KEY, 'device-strangers', {});
await seedLicense(env, { key: OTHER_KEY, telegram_user_id: String(OWNER) });
const strangerCard = await run(privateMessage('/sub', { from: STRANGER }));
assert.equal(strangerCard.kind, 'sub_card');
const strangerText = telegram.sent().at(-1).body.text;
assert.ok(!strangerText.includes('CCCC') && !strangerText.includes('FFFF'),
  'a stranger must not see another account`s keys');
assert.ok(strangerText.includes('ключей не числится'));

resetRate();
telegram.reset();
const strangerRelease = await run(callback('sub:rel:0:FFFF', { from: STRANGER }));
assert.equal(strangerRelease.kind, 'sub_release_confirm');
assert.equal(
  env.sqlite.prepare('SELECT status FROM license_activations WHERE license_key = ?')
    .get(OTHER_KEY).status,
  'active',
  'replaying a button for a key you do not own must resolve to nothing'
);
assert.ok(telegram.texts().some((text) => text.includes('Список ключей изменился')));

/* -------------------------------- binding ------------------------------- */

resetRate();
telegram.reset();
const prompt = await run(callback('sub:bind', { from: STRANGER }));
assert.equal(prompt.kind, 'sub_bind_prompt');
const promptBody = telegram.sent().at(-1).body;
assert.equal(promptBody.reply_markup.force_reply, true);

const bindReply = (text, from) =>
  run(privateMessage(text, { from, replyTo: promptBody.text }));

resetRate();
telegram.reset();
await bindReply('не помню', STRANGER);
assert.ok(telegram.texts().at(-1).includes('не похоже на ключ'),
  'a malformed key is rejected without touching storage');

resetRate();
telegram.reset();
await bindReply('SMESH-ZZZZ-ZZZZ-ZZZZ', STRANGER);
assert.ok(telegram.texts().at(-1).includes('Такого ключа нет'));

resetRate();
telegram.reset();
await bindReply(KEY, STRANGER);
assert.ok(telegram.texts().at(-1).includes('уже привязан к другому аккаунту'),
  'a key that already has a Telegram owner cannot be re-bound by a stranger');
assert.equal(
  env.sqlite.prepare('SELECT COUNT(*) AS n FROM license_telegram_links').get().n, 0
);

// A key delivered by email has no Telegram owner at all: that buyer proves
// ownership by sending it, which is the only way /sub can ever work for them.
const EMAIL_KEY = 'SMESH-GGGG-HHHH-JJJJ';
await seedLicense(env, {
  key: EMAIL_KEY,
  email: 'buyer@example.com',
  expires_at: new Date(Date.now() + 5 * DAY).toISOString()
});
resetRate();
telegram.reset();
await bindReply(EMAIL_KEY, STRANGER);
assert.deepEqual(
  env.sqlite.prepare(
    'SELECT license_key, telegram_user_id FROM license_telegram_links'
  ).all().map((row) => ({ ...row })),
  [{ license_key: EMAIL_KEY, telegram_user_id: String(STRANGER) }]
);
assert.ok(telegram.texts().some((text) => text.includes('привязан к этому чату')));
assert.ok(telegram.texts().at(-1).includes('SMESH-····-····-JJJJ'),
  'binding shows the card straight away');

// Guessing keys through the bot is an existence oracle; it is budgeted per day.
resetRate();
telegram.reset();
for (let attempt = 0; attempt < 12; attempt++) {
  resetRate();
  await bindReply('SMESH-2222-3333-4444', STRANGER);
}
assert.ok(telegram.texts().at(-1).includes('Слишком много попыток'),
  'the key-existence oracle must run out of budget for the day');

/* ---------------------- everything else stays support ------------------- */

resetRate();
const unrelated = await processSubscriptionUpdate(
  env, privateMessage('у меня не решается задача', { from: OWNER }), {}
);
assert.equal(unrelated.handled, false,
  'an ordinary message must still reach the support surface as a ticket');
const otherCallback = await processSubscriptionUpdate(
  env, callback('new_ticket', { from: OWNER }), {}
);
assert.equal(otherCallback.handled, false);

console.log('subscription command regression passed');
