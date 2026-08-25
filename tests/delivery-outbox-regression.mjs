/**
 * Durable delivery regressions. The Robokassa webhook used to make its
 * in-process attempts and then ack the gateway, so an outage longer than the
 * ten-second retry stranded the buyer until manual admin action. Now:
 *  1. enqueueDelivery persists a delivery_outbox row BEFORE the webhook acks
 *     (worker.js returns non-OK when it cannot).
 *  2. The cron sweep (retryPendingDeliveries) re-drives due rows with backoff,
 *     marks delivered_at only on the promised channel (Telegram whenever a
 *     Telegram recipient is bound), and stops at the attempt cap.
 *  3. The delivered:<key> marker still guarantees a recovered outage cannot
 *     resend the same bearer key twice.
 */
import assert from 'node:assert/strict';

const calls = [];
let providersUp = false;
let telegramUp = null;
let emailUp = null;
let providerGate = null;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init?.body || 'null') });
  if (providerGate) await providerGate.promise;
  const channelUp = String(url).includes('api.telegram.org')
    ? (telegramUp == null ? providersUp : telegramUp)
    : (emailUp == null ? providersUp : emailUp);
  return channelUp
    ? { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }
    : { ok: false, status: 503, body: { cancel: async () => {} } };
};

const {
  deliverAndSettle, deliverKey, enqueueDelivery, retryPendingDeliveries
} = await import('../backend/src/worker.js');

class MarkerKV {
  store = new Map();
  async get(key) { return this.store.get(key) || null; }
  async put(key, value) { this.store.set(key, value); }
}

class OutboxD1 {
  rows = new Map();
  issuance = new Map();
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (sql.includes('INSERT OR IGNORE INTO delivery_outbox')) {
              const [key, email, tg, pre, created, next] = args;
              if (!db.rows.has(key)) {
                db.rows.set(key, {
                  license_key: key, email, telegram_user_id: tg, is_preorder: pre,
                  created_at: created, attempts: 0, next_attempt_at: next,
                  claim_token: null, lease_until: null, delivered_at: null
                });
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET delivered_at')) {
              const [key, at, token] = args;
              const row = db.rows.get(key);
              if (!row || row.delivered_at != null || row.claim_token !== token) {
                return { meta: { changes: 0 } };
              }
              row.delivered_at = at;
              row.claim_token = null;
              row.lease_until = null;
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET attempts')) {
              if (sql.includes('claim_token = ?4')) {
                // The cron claim: a compare-and-set on the scanned attempts
                // value. Model it faithfully so overlapping sweeps race here.
                const [key, attempts, next, token, leaseUntil, expected, now] = args;
                const row = db.rows.get(key);
                if (!row || row.delivered_at != null || row.attempts !== expected ||
                    (row.lease_until != null && row.lease_until > now)) {
                  return { meta: { changes: 0 } };
                }
                row.attempts = attempts;
                row.next_attempt_at = next;
                row.claim_token = token;
                row.lease_until = leaseUntil;
                return { meta: { changes: 1 } };
              }
              const [key, attempts, next] = args;
              const row = db.rows.get(key);
              if (row && row.delivered_at == null) {
                row.attempts = attempts;
                row.next_attempt_at = next;
              }
              return { meta: { changes: 1 } };
            }
            if (sql.includes('SET claim_token = NULL')) {
              const [key, token] = args;
              const row = db.rows.get(key);
              if (!row || row.delivered_at != null || row.claim_token !== token) {
                return { meta: { changes: 0 } };
              }
              row.claim_token = null;
              row.lease_until = null;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('SELECT attempts FROM delivery_outbox')) {
              const row = db.rows.get(args[0]);
              return row && row.delivered_at == null ? { attempts: row.attempts } : null;
            }
            return null;
          },
          async all() {
            if (sql.includes('FROM delivery_outbox')) {
              const [maxAttempts, now, limit] = args;
              const due = [...db.rows.values()]
                .filter((r) => r.delivered_at == null && r.attempts < maxAttempts && r.next_attempt_at <= now)
                .filter((r) => r.lease_until == null || r.lease_until <= now)
                .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
                .slice(0, limit)
                .map((r) => ({ ...r, license_json: db.issuance.get(r.license_key) || null }));
              return { results: due };
            }
            return { results: [] };
          }
        };
      }
    };
  }
}

const kv = new MarkerKV();
const db = new OutboxD1();
const env = { LICENSES: kv, DB: db, TELEGRAM_BOT_TOKEN: 'tg-token', RESEND_API_KEY: 'resend-key' };
const license = { key: 'SMESH-OUTB-TEST-KEY1', email: 'buyer@example.com', telegram_user_id: 7777 };

// 1. The webhook persists retry state before acking; a full provider outage
//    leaves an undelivered row behind instead of nothing.
await enqueueDelivery(env, license, false);
const row = db.rows.get(license.key);
assert.ok(row, 'the outbox row must exist before the gateway is acked');
assert.equal(row.delivered_at, null);
assert.ok(row.next_attempt_at > Date.now(), 'the first cron retry is deferred past the webhook attempt');

// Without D1 the webhook must know delivery is NOT durable (it then keeps the
// gateway retrying instead of acking).
await assert.rejects(enqueueDelivery({ LICENSES: kv }, license, false), /outbox unavailable/);

// 2. Cron sweep while providers are still down: one single attempt per channel
//    (the cron IS the retry loop), attempts bumped, backoff scheduled.
row.next_attempt_at = Date.now() - 1;
calls.length = 0;
let sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 1, delivered: 0 });
assert.equal(calls.length, 2, 'a cron pass makes exactly one attempt per failed channel');
assert.equal(row.attempts, 1);
assert.ok(row.next_attempt_at > Date.now(), 'a failed retry must back off, not hot-loop');
assert.equal(row.delivered_at, null);

// Not due yet → the sweep must leave it alone.
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 0, delivered: 0 });
assert.equal(calls.length, 0);

// 3. Providers recover: the due row is delivered exactly once and closed.
providersUp = true;
row.next_attempt_at = Date.now() - 1;
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 1, delivered: 1 });
assert.equal(calls.length, 2, 'recovery must send the key once per channel');
assert.ok(row.delivered_at, 'a confirmed channel must settle the outbox row');
const marker = JSON.parse(await kv.get(`delivered:${license.key}`));
assert.equal(marker.tg, 'ok');

// A delivered row never fires again.
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 0, delivered: 0 });
assert.equal(calls.length, 0);

// Telegram-bound checkout is not delivered merely because the fallback email
// worked. The outbox must keep retrying the bot, and a delayed retry must
// rebuild the full payment/subscription message from payment_issuance.
const mandatoryTgLicense = {
  key: 'SMESH-OUTB-TG-MANDATORY',
  email: 'telegram-required@example.com',
  telegram_user_id: 787878,
  amount_kopecks: 1000,
  expires_at: '2026-09-24T09:00:00.000Z',
  payment_id: '424242'
};
await enqueueDelivery(env, mandatoryTgLicense, false);
db.issuance.set(mandatoryTgLicense.key, JSON.stringify(mandatoryTgLicense));
const mandatoryTgRow = db.rows.get(mandatoryTgLicense.key);
mandatoryTgRow.next_attempt_at = Date.now() - 1;
providersUp = false;
telegramUp = false;
emailUp = true;
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 1, delivered: 0 });
assert.equal(mandatoryTgRow.delivered_at, null,
  'email success cannot settle a Telegram-bound checkout');
assert.equal(calls.length, 2, 'the first pass still attempts both configured channels');

mandatoryTgRow.next_attempt_at = Date.now() - 1;
telegramUp = true;
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 1, delivered: 1 });
assert.ok(mandatoryTgRow.delivered_at, 'Telegram recovery settles the outbox');
assert.equal(calls.length, 1, 'successful email is deduped while Telegram alone retries');
const recoveredTelegram = calls[0].body.text;
assert.match(recoveredTelegram, /Оплата подтверждена: 10 ₽/,
  'delayed Telegram delivery retains the frozen amount');
assert.match(recoveredTelegram, /Подписка действует до/,
  'delayed Telegram delivery retains subscription expiry');
assert.match(recoveredTelegram, /Заказ №424242/,
  'delayed Telegram delivery retains the order number');
assert.ok(recoveredTelegram.includes(mandatoryTgLicense.key),
  'delayed Telegram delivery still contains the exact key');
telegramUp = null;
emailUp = null;
providersUp = true;

// 4. A row whose key was already delivered elsewhere (marker says ok) settles
//    WITHOUT resending the bearer key.
const dupLicense = { key: 'SMESH-OUTB-DUP1-KEY2', email: 'dup@example.com', telegram_user_id: 8888 };
await enqueueDelivery(env, dupLicense, false);
await kv.put(`delivered:${dupLicense.key}`, JSON.stringify({ tg: 'ok', email: 'failed', at: new Date().toISOString() }));
const dupRow = db.rows.get(dupLicense.key);
dupRow.next_attempt_at = Date.now() - 1;
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 1, delivered: 1 });
assert.equal(calls.length, 0, 'an already-delivered key must never be resent by the cron');
assert.ok(dupRow.delivered_at);

// 5. Exhausted rows stop retrying and stay behind as the operator worklist.
providersUp = false;
const deadLicense = { key: 'SMESH-OUTB-DEAD-KEY3', email: 'dead@example.com', telegram_user_id: null };
await enqueueDelivery(env, deadLicense, true);
const deadRow = db.rows.get(deadLicense.key);
deadRow.attempts = 30;
deadRow.next_attempt_at = Date.now() - 1;
calls.length = 0;
sweep = await retryPendingDeliveries(env);
assert.deepEqual(sweep, { retried: 0, delivered: 0 });
assert.equal(calls.length, 0, 'the attempt cap must bound the sweep');
assert.equal(deadRow.delivered_at, null, 'the exhausted row remains visible for the operator');

// 6. (Audit B-05) Overlapping sweeps race on one due row: the claim is an
//    exclusive compare-and-set, so exactly one invocation sends the bearer
//    key and the loser touches neither the wire nor the row's retry state.
providersUp = true;
const raceLicense = { key: 'SMESH-OUTB-RACE-KEY4', email: 'race@example.com', telegram_user_id: 9999 };
await enqueueDelivery(env, raceLicense, false);
const raceRow = db.rows.get(raceLicense.key);
raceRow.next_attempt_at = Date.now() - 1;
calls.length = 0;
const [sweepA, sweepB] = await Promise.all([
  retryPendingDeliveries(env),
  retryPendingDeliveries(env)
]);
assert.equal(sweepA.retried + sweepB.retried, 1,
  'exactly one overlapping sweep may claim a due row');
assert.equal(sweepA.delivered + sweepB.delivered, 1);
assert.equal(calls.length, 2,
  'the bearer key must be sent once per channel, never once per overlapping sweep');
assert.equal(raceRow.attempts, 1,
  'the losing sweep must not regress or double-bump the attempt counter');
assert.ok(raceRow.delivered_at, 'the winning sweep settles the row');

// 7. A provider call that is still in flight cannot be lapped merely because
// next_attempt_at becomes due. The separate lease remains exclusive for much
// longer than the bounded provider timeout.
const slowLicense = {
  key: 'SMESH-OUTB-SLOW-KEY5', email: 'slow@example.com', telegram_user_id: 5555
};
await enqueueDelivery(env, slowLicense, false);
const slowRow = db.rows.get(slowLicense.key);
slowRow.next_attempt_at = Date.now() - 1;
let releaseProviders;
providerGate = {};
providerGate.promise = new Promise((resolve) => { releaseProviders = resolve; });
calls.length = 0;
const slowSweep = retryPendingDeliveries(env);
while (calls.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
assert.ok(slowRow.lease_until > Date.now(), 'the external send is protected by a live lease');
slowRow.next_attempt_at = Date.now() - 1;
assert.deepEqual(await retryPendingDeliveries(env), { retried: 0, delivered: 0 },
  'a later sweep must not reclaim an in-flight provider operation');
releaseProviders();
providerGate = null;
assert.deepEqual(await slowSweep, { retried: 1, delivered: 1 });
assert.ok(slowRow.delivered_at);

// 8. Concurrent signed ResultURL callbacks used to bypass the cron claim and
// both run the immediate delivery. The initial attempt now claims attempts=0
// in the same D1 outbox before touching either provider, so only one callback
// can send. Its claim also pre-schedules cron recovery if the isolate dies.
const webhookLicense = {
  key: 'SMESH-OUTB-WEBHOOK-5', email: 'webhook@example.com', telegram_user_id: 1111
};
await enqueueDelivery(env, webhookLicense, false);
const webhookRow = db.rows.get(webhookLicense.key);
calls.length = 0;
const [deliveryA, deliveryB] = await Promise.all([
  deliverAndSettle(env, webhookLicense, false),
  deliverAndSettle(env, webhookLicense, false)
]);
assert.equal(Number(deliveryA.claimed) + Number(deliveryB.claimed), 1,
  'exactly one concurrent webhook may claim the initial attempt');
assert.equal(calls.length, 2,
  'one email and one Telegram send occur, never one pair per callback');
assert.equal(webhookRow.attempts, 1, 'the initial attempt is counted exactly once');
assert.ok(webhookRow.delivered_at, 'the winning immediate attempt settles the outbox');

calls.length = 0;
const noOutbox = await deliverAndSettle(
  { ...env, DB: null },
  { key: 'SMESH-NO-OUTBOX-SEND', email: 'unsafe@example.com', telegram_user_id: 2222 },
  false
);
assert.equal(noOutbox.claimed, false);
assert.equal(calls.length, 0,
  'a failed outbox enqueue must keep Robokassa retrying without an unclaimed direct send');

// 9. Only the exact historical ISO marker format proves delivery. A corrupt
// or partial KV value must remain retryable instead of silently closing its
// outbox and stranding the buyer.
const corruptLicense = {
  key: 'SMESH-OUTB-CORRUPT-6', email: 'corrupt@example.com', telegram_user_id: 3333
};
await kv.put(`delivered:${corruptLicense.key}`, '{"tg":"maybe"}');
calls.length = 0;
const corruptState = await deliverKey(env, corruptLicense, false, { retry: false });
assert.equal(corruptState.tg, 'ok');
assert.equal(calls.length, 2, 'a malformed marker must not suppress delivery');

const legacyLicense = {
  key: 'SMESH-OUTB-LEGACY-7', email: 'legacy@example.com', telegram_user_id: 4444
};
await kv.put(`delivered:${legacyLicense.key}`, '2026-07-18T12:34:56.789Z');
calls.length = 0;
assert.deepEqual(await deliverKey(env, legacyLicense, false, { retry: false }),
  { tg: 'ok', email: 'ok' });
assert.equal(calls.length, 0, 'a canonical legacy timestamp remains a valid dedup marker');

// 10. The marker is only a best-effort dedup projection. A wedged KV get must
// not consume the outbox's exclusive lease forever and permit a later sweep to
// lap the still-running provider operation.
{
  const hangingMarkerKv = {
    get: async () => new Promise(() => {}),
    put: async () => {}
  };
  const boundedEnv = {
    ...env,
    LICENSES: hangingMarkerKv,
    DELIVERY_MARKER_TIMEOUT_MS: '100'
  };
  providersUp = true;
  calls.length = 0;
  const started = Date.now();
  const state = await deliverKey(boundedEnv, {
    key: 'SMESH-OUTB-HANG-KV8',
    email: 'bounded@example.com',
    telegram_user_id: 4545
  }, false, { retry: false });
  assert.equal(state.tg, 'ok');
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 1000,
    'a non-resolving marker read must be abandoned well inside the D1 lease');
}

// 11. A corrupt immutable issuance snapshot is an operational error, but the
// diagnostic must never copy the bearer key or routing contacts into logs.
{
  const privateLicense = {
    key: 'SMESH-OUTB-PRIVATE-LOG9',
    email: 'private-log@example.com',
    telegram_user_id: 919191
  };
  await enqueueDelivery(env, privateLicense, false);
  db.issuance.set(privateLicense.key, '{not-json');
  const privateRow = db.rows.get(privateLicense.key);
  privateRow.next_attempt_at = Date.now() - 1;
  providersUp = true;
  const captured = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { captured.push(args.map(String).join(' ')); };
  try {
    assert.deepEqual(await retryPendingDeliveries(env), { retried: 1, delivered: 1 });
  } finally {
    console.error = originalConsoleError;
  }
  const diagnostic = captured.join('\n');
  assert.match(diagnostic, /delivery outbox snapshot invalid/);
  for (const secret of [
    privateLicense.key,
    privateLicense.email,
    String(privateLicense.telegram_user_id)
  ]) {
    assert.equal(diagnostic.includes(secret), false,
      'snapshot diagnostics must contain no bearer key or delivery contact');
  }
}

console.log('delivery outbox regression passed');
