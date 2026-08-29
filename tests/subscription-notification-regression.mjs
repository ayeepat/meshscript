// Regression: the subscription lifecycle messages.
//
// A Bot API send has no idempotency key and the cron sweep can overlap itself,
// so "once" has to come from the database: rows are claimed by compare-and-set
// and UNIQUE(license_key, stage) is the send-once guarantee.
//
// The other half is honesty. Expiry is not fixed at purchase — a referral
// credit moves it — and a renewal mints a NEW key, so a reminder is re-checked
// against live state at send time. Nobody who already paid again should be told
// their access ended, and nobody should be asked why they left while they are
// still a customer.
import assert from 'node:assert/strict';
import {
  callback, captureTelegram, createEnv, seedLicense
} from './helpers/subscription-harness.mjs';

const telegram = captureTelegram();
const {
  processSubscriptionUpdate, sweepSubscriptionNotifications, pruneSubscriptionLifecycle
} = await import('../backend/src/delivery/subscription.js');
const { revokeLicenseDurable } = await import('../backend/src/licenses.js');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const KEY = 'SMESH-AAAA-BBBB-CCCC';
const USER = 777;

async function scenario(expiresAt, extra = {}) {
  const env = createEnv();
  await seedLicense(env, {
    key: KEY,
    telegram_user_id: String(USER),
    expires_at: new Date(expiresAt).toISOString(),
    ...extra
  });
  telegram.reset();
  return env;
}
const rows = (env) => env.sqlite.prepare(
  'SELECT id, stage, due_at, sent_at, cancelled_at, attempts FROM subscription_notifications ORDER BY stage'
).all();
const stage = (env, name) => rows(env).find((row) => row.stage === name);

/* ------------------------- three days before ---------------------------- */
{
  const env = await scenario(Date.now() + 3 * DAY - MINUTE);
  const first = await sweepSubscriptionNotifications(env);
  assert.equal(first.enqueued, 4, 'all four stages are scheduled from one expiry');
  assert.equal(first.sent, 1, 'only the stage that is actually due goes out');
  const text = telegram.texts().at(-1);
  assert.ok(text.includes('через 3 дня'), text);
  assert.ok(stage(env, 'expiry_3d').sent_at, 'the sent stage is recorded');
  assert.equal(stage(env, 'expiry_1d').sent_at, null);

  telegram.reset();
  const second = await sweepSubscriptionNotifications(env);
  assert.equal(second.sent, 0, 'a second sweep must not repeat a delivered reminder');
  assert.equal(telegram.sent().length, 0);
}

/* -------------- a referral credit moves expiry: reschedule --------------- */
{
  const env = await scenario(Date.now() + 3 * DAY - MINUTE);
  await sweepSubscriptionNotifications(env);
  telegram.reset();

  // The buyer's referral extends the subscription by another three weeks.
  await seedLicense(env, {
    key: KEY,
    telegram_user_id: String(USER),
    expires_at: new Date(Date.now() + 24 * DAY).toISOString()
  });
  // Fast-forward to the moment the reminder WAS scheduled for, which is what a
  // real sweep meets two days from now.
  env.sqlite.prepare(
    "UPDATE subscription_notifications SET next_attempt_at = ? WHERE stage = 'expiry_1d'"
  ).run(Date.now() - 1);
  const after = await sweepSubscriptionNotifications(env);
  assert.equal(after.sent, 0, 'a subscription with three weeks left is not "ending tomorrow"');
  assert.equal(telegram.sent().length, 0);
  const oneDay = stage(env, 'expiry_1d');
  assert.ok(oneDay.due_at > Date.now() + 22 * DAY,
    'the pending reminder moves with the new expiry instead of firing on the old one');
  assert.equal(oneDay.attempts, 0,
    'rescheduling must not spend one of the finite delivery attempts');
}

/* ------------------------ ten minutes after expiry ---------------------- */
{
  const env = await scenario(Date.now() - 11 * MINUTE);
  const swept = await sweepSubscriptionNotifications(env);
  assert.equal(swept.sent, 1);
  const text = telegram.texts().at(-1);
  assert.ok(text.includes('закончилась'), text);
  assert.ok(stage(env, 'expired').sent_at);
  assert.ok(stage(env, 'expiry_3d').cancelled_at,
    'reminders whose moment has passed are closed, not left to fire late');
}

/* --------------------------- the win-back survey ------------------------ */
{
  const env = await scenario(Date.now() - 3 * DAY - MINUTE);
  const swept = await sweepSubscriptionNotifications(env);
  assert.equal(swept.sent, 1);
  const body = telegram.sent().at(-1).body;
  assert.ok(body.text.includes('почему'), body.text);
  const buttons = body.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 6, 'one tap per reason, plus a way to write freely');
  const winbackId = stage(env, 'winback').id;
  assert.equal(buttons[0].callback_data, `wb:${winbackId}:price`);
  for (const button of buttons) {
    assert.ok(!String(button.callback_data).includes('SMESH-'),
      'the survey must not carry a bearer key in its callback data');
  }
  assert.ok(buttons.some((button) => button.callback_data.endsWith(':other')));

  // Answering records the choice exactly once, and only for the addressee.
  const answer = (from) => processSubscriptionUpdate(
    env, callback(`wb:${winbackId}:price`, { from }), {}
  );
  env.sqlite.exec("DELETE FROM telemetry_budget WHERE scope = 'support_rate'");
  await answer(USER);
  assert.equal(stage(env, 'winback').cancelled_at, null);
  const answered = env.sqlite.prepare(
    'SELECT answer_code, answered_at FROM subscription_notifications WHERE id = ?'
  ).get(winbackId);
  assert.equal(answered.answer_code, 'price');
  assert.ok(answered.answered_at);

  env.sqlite.exec("DELETE FROM telemetry_budget WHERE scope = 'support_rate'");
  telegram.reset();
  await processSubscriptionUpdate(env, callback(`wb:${winbackId}:bugs`, { from: 999 }), {});
  assert.equal(
    env.sqlite.prepare('SELECT answer_code FROM subscription_notifications WHERE id = ?')
      .get(winbackId).answer_code,
    'price',
    'callback data can be replayed by a modified client: only the addressee counts'
  );
}

/* ------------------ somebody who already came back ---------------------- */
{
  const env = await scenario(Date.now() - 3 * DAY - MINUTE);
  // The renewal is a different key on the same Telegram account.
  await seedLicense(env, {
    key: 'SMESH-NEW1-NEW2-NEW3',
    telegram_user_id: String(USER),
    expires_at: new Date(Date.now() + 27 * DAY).toISOString()
  });
  const swept = await sweepSubscriptionNotifications(env);
  assert.equal(swept.sent, 0, 'a paying customer is never asked why they left');
  assert.ok(stage(env, 'winback').cancelled_at);
  assert.equal(telegram.sent().length, 0);
}

/* ------------------------- refunded / revoked --------------------------- */
{
  const env = await scenario(Date.now() + 3 * DAY - MINUTE);
  await sweepSubscriptionNotifications(env);
  // The refund lands after the queue already exists — the send-time check is
  // the one that has to notice, since the row was scheduled while it was valid.
  await revokeLicenseDurable(env, KEY, 'robokassa_refund');
  telegram.reset();
  env.sqlite.prepare(
    "UPDATE subscription_notifications SET next_attempt_at = ? WHERE stage = 'expiry_1d'"
  ).run(Date.now() - 1);
  const swept = await sweepSubscriptionNotifications(env);
  assert.equal(swept.sent, 0, 'a refunded key must not generate renewal nags');
  assert.ok(stage(env, 'expiry_1d').cancelled_at);
}

/* ---------------------- the user blocked the bot ------------------------ */
{
  const blocked = captureTelegram({ status: () => 403 });
  const env = await scenario(Date.now() + 3 * DAY - MINUTE);
  const swept = await sweepSubscriptionNotifications(env);
  assert.equal(swept.sent, 0);
  assert.equal(swept.cancelled, 1,
    'a blocked chat is permanent — retrying it twelve times is noise, not delivery');
  assert.ok(stage(env, 'expiry_3d').cancelled_at);
  assert.equal(blocked.sent().length, 1, 'and it is attempted exactly once');
}

/* --------------------- a transient failure is retried ------------------- */
{
  let failing = true;
  const flaky = captureTelegram({ status: () => (failing ? 500 : 200) });
  const env = await scenario(Date.now() + 3 * DAY - MINUTE);
  await sweepSubscriptionNotifications(env);
  const attempted = stage(env, 'expiry_3d');
  assert.equal(attempted.sent_at, null);
  assert.equal(attempted.cancelled_at, null);
  assert.equal(attempted.attempts, 1, 'a provider outage costs an attempt, not the message');
  assert.ok(attempted.due_at < attempted.due_at + 1);

  failing = false;
  flaky.reset();
  // Backoff put it in the future; the next due sweep delivers it.
  env.sqlite.prepare(
    'UPDATE subscription_notifications SET next_attempt_at = ? WHERE id = ?'
  ).run(Date.now() - 1, attempted.id);
  const retried = await sweepSubscriptionNotifications(env);
  assert.equal(retried.sent, 1, 'the reminder survives a temporary Telegram failure');
}

/* ------------------------------- pruning -------------------------------- */
{
  const env = createEnv();
  env.sqlite.prepare(
    `INSERT INTO license_release_fence (license_key, device_id, released_at, released_by)
     VALUES (?, ?, ?, ?)`
  ).run(KEY, 'device-old', Date.now() - 400 * DAY, '777');
  env.sqlite.prepare(
    `INSERT INTO subscription_notifications
       (license_key, stage, telegram_user_id, due_at, created_at, next_attempt_at, sent_at)
     VALUES (?, 'expired', '777', ?, ?, ?, ?)`
  ).run(KEY, Date.now() - 400 * DAY, Date.now() - 400 * DAY, Date.now() - 400 * DAY, Date.now() - 400 * DAY);
  const pruned = await pruneSubscriptionLifecycle(env);
  assert.deepEqual(pruned, { fences: 1, notifications: 1 });
}

console.log('subscription notification regression passed');
