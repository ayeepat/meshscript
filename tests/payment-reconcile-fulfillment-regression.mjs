/**
 * POST /admin/payment/reconcile must report what actually happened.
 *
 * Both settle paths answer the GATEWAY contract, where an unissued payment is
 * still acknowledged with HTTP 200 `OK{InvId}` after a payment_review row is
 * journaled. The handler used to forward that Response through `if
 * (!response.ok)` and then answer `{ ok: true, paid: true, fulfilled: true }` —
 * telling an operator a license had been issued for a payment that had in fact
 * just landed on the review worklist and needs manual work.
 *
 * The order used here is paid but has NO delivery contact, which is exactly the
 * ackUnissuedPayment('no_contact') path.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import * as payments from '../backend/src/payments.js';

const ADMIN = 'payment-admin-secret'.repeat(2);
const PASSWORD2 = 'production-result-password-2';

class MemoryKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    this.db.exec('SAVEPOINT reconcile_test_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT reconcile_test_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT reconcile_test_batch');
      this.db.exec('RELEASE SAVEPOINT reconcile_test_batch');
      throw error;
    }
  }
}

function context() {
  const promises = [];
  return {
    ctx: { waitUntil(promise) { promises.push(Promise.resolve(promise).catch(() => {})); } },
    async settle() { await Promise.all(promises); }
  };
}

async function environment() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    env: {
      DB: new SqliteD1(sqlite),
      LICENSES: new MemoryKV(),
      PAYMENT_ENVIRONMENT: 'production',
      ROBOKASSA_MERCHANT_LOGIN: 'smesh-shop',
      ROBOKASSA_PASSWORD1_PRODUCTION: 'production-payment-password-1',
      ROBOKASSA_PASSWORD2_PRODUCTION: PASSWORD2,
      ROBOKASSA_PASSWORD3_PRODUCTION: 'production-refund-password-3',
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      ROBOKASSA_FISCALIZATION_MODE: 'external',
      ROBOKASSA_OUT_CURRENCY_LABEL: 'RUB',
      SUBSCRIPTION_PRICE_RUB: '199',
      LIFETIME_PRICE_RUB: '990',
      SUBSCRIPTION_DAYS: '30',
      RUNTIME_WRITE_EPOCH: '1',
      RESEND_API_KEY: 'test-delivery-key',
      ADMIN_SECRET: ADMIN
    }
  };
}

// Insert an order directly: /payments/robokassa/order refuses a contactless
// order, but a legacy/edited row reaching reconcile is exactly the case the
// no_contact review path exists for.
function seedOrder(sqlite, { email = null, telegram = null }) {
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO payment_orders
       (gateway, environment, status, amount_kopecks, currency, plan_type,
        subscription_days, email, telegram_user_id, is_preorder,
        fiscalization_mode, created_at, expires_at)
     VALUES ('robokassa', 'production', 'pending', 19900, 'RUB', 'subscription',
             30, ?, ?, 0, 'external', ?, ?)`
  ).run(email, telegram, now, now + 30 * 60 * 1000);
  return Number(sqlite.prepare('SELECT MAX(order_id) AS id FROM payment_orders').get().id);
}

function seedDueOrder(sqlite, { email = null, telegram = null }) {
  const now = Date.now();
  sqlite.prepare(
    `INSERT INTO payment_orders
       (gateway, environment, status, amount_kopecks, currency, plan_type,
        subscription_days, email, telegram_user_id, is_preorder,
        fiscalization_mode, created_at, expires_at)
     VALUES ('robokassa', 'production', 'pending', 19900, 'RUB', 'subscription',
             30, ?, ?, 0, 'external', ?, ?)`
  ).run(email, telegram, now - 60 * 60 * 1000, now - 30 * 60 * 1000);
  return Number(sqlite.prepare('SELECT MAX(order_id) AS id FROM payment_orders').get().id);
}

function providerState(orderId, sqlite) {
  const amount = sqlite.prepare('SELECT amount_kopecks FROM payment_orders WHERE order_id = ?')
    .get(orderId).amount_kopecks;
  return `<Response><Result><Code>0</Code></Result><State><Code>100</Code></State>` +
    `<Info><OutCurrLabel>RUB</OutCurrLabel><OutSum>${amount / 100}.00</OutSum>` +
    `<OpKey>op-key-${orderId}</OpKey></Info></Response>`;
}

function seedCheckoutEvent(sqlite, orderId, eventType) {
  const order = sqlite.prepare(
    'SELECT environment, amount_kopecks, created_at FROM payment_orders WHERE order_id = ?'
  ).get(orderId);
  sqlite.prepare(
    `INSERT INTO payment_events
       (gateway, payment_id, order_id, environment, event_type, amount_kopecks,
        currency, details_json, created_at)
     VALUES ('robokassa', ?, ?, ?, ?, ?, 'RUB', NULL, ?)`
  ).run(
    String(orderId), orderId, order.environment, eventType,
    order.amount_kopecks, order.created_at
  );
}

function providerResultCode(code) {
  return `<Response><Result><Code>${code}</Code></Result></Response>`;
}

function providerUnpaidState() {
  return '<Response><Result><Code>0</Code></Result><State><Code>5</Code></State>' +
    '<Info><OutCurrLabel>RUB</OutCurrLabel><OutSum>199.00</OutSum></Info></Response>';
}

async function reconcile(env, orderId, sqlite) {
  const waiting = context();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(providerState(orderId, sqlite), {
    status: 200, headers: { 'Content-Type': 'application/xml' }
  });
  try {
    const response = await worker.fetch(new Request('https://api.example/admin/payment/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN },
      body: JSON.stringify({ order_id: String(orderId) })
    }), env, waiting.ctx);
    await waiting.settle();
    return response;
  } finally {
    globalThis.fetch = realFetch;
  }
}

/* --- a paid order with no delivery contact is NOT a fulfilled payment --- */
{
  const { sqlite, env } = await environment();
  const orderId = seedOrder(sqlite, {});

  const response = await reconcile(env, orderId, sqlite);
  const body = await response.json();

  assert.equal(response.status, 409,
    'a payment that could not be issued must not answer 200');
  assert.equal(body.ok, false);
  assert.equal(body.paid, true, 'the money really did move — say so');
  assert.equal(body.fulfilled, false,
    'reporting fulfilled:true for a review row is the whole bug');
  assert.equal(body.reason, 'payment_review_required');
  assert.equal(body.order_status, 'review');

  // And the durable state agrees with the answer the operator was given.
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders WHERE order_id = ?')
    .get(orderId).status, 'review');
  assert.equal(sqlite.prepare('SELECT reason FROM payment_review').get().reason, 'no_contact');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 0,
    'no license may exist for a payment reported as unfulfilled');
  sqlite.close();
}

/* ------ positive control: a real fulfilment still reports fulfilled ------ */
{
  const { sqlite, env } = await environment();
  const orderId = seedOrder(sqlite, { email: 'buyer@example.com' });

  const response = await reconcile(env, orderId, sqlite);
  const body = await response.json();

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, {
    ok: true, paid: true, fulfilled: true, order_id: String(orderId)
  });
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders WHERE order_id = ?')
    .get(orderId).status, 'fulfilled');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 1,
    'a fulfilled report must be backed by exactly one issued license');
  sqlite.close();
}

/* ---- cron recovers a paid order whose ResultURL callback never arrived ---- */
{
  const { sqlite, env } = await environment();

  // A checkout draft has never shown a payment form to Robokassa, so querying
  // OpState for it cannot discover money. Put more than the cron batch size in
  // front of a real missed-callback order: the drafts must be expired locally
  // without consuming provider-call slots or starving the paid order behind.
  const draftIds = [];
  for (let index = 0; index < 12; index += 1) {
    const draftId = seedDueOrder(sqlite, {});
    seedCheckoutEvent(sqlite, draftId, 'checkout_created');
    draftIds.push(draftId);
  }
  const orderId = seedDueOrder(sqlite, { email: 'missed-callback@example.com' });
  seedCheckoutEvent(sqlite, orderId, 'checkout_created');
  seedCheckoutEvent(sqlite, orderId, 'checkout_payment_started');
  const waiting = context();
  const realFetch = globalThis.fetch;
  const operationStateInvoices = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('OpStateExt')) {
      const invoiceId = new URL(String(url)).searchParams.get('InvoiceID');
      operationStateInvoices.push(invoiceId);
      if (invoiceId !== String(orderId)) {
        return new Response(providerResultCode(10), {
          status: 200, headers: { 'Content-Type': 'application/xml' }
        });
      }
      return new Response(providerState(orderId, sqlite), {
        status: 200, headers: { 'Content-Type': 'application/xml' }
      });
    }
    // Delivery is asynchronous and independent of durable issuance. Let it
    // succeed so this fixture also drains its outbox cleanly.
    return new Response(JSON.stringify({ id: 'delivery-test' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    await worker.scheduled({}, env, waiting.ctx);
    await waiting.settle();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(operationStateInvoices, [String(orderId)],
    'contact-free drafts must never consume an OpState call');
  assert.equal(sqlite.prepare(
    `SELECT COUNT(*) AS n FROM payment_orders
     WHERE order_id IN (${draftIds.map(() => '?').join(', ')}) AND status = 'expired'`
  ).get(...draftIds).n, draftIds.length,
  'never-started checkout drafts must expire locally');
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders WHERE order_id = ?')
    .get(orderId).status, 'fulfilled');
  assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS n FROM payment_issuance WHERE payment_id = ?'
  ).get(String(orderId)).n, 1,
  'scheduled reconciliation must issue exactly one license for a missed callback');
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS n FROM payment_events WHERE order_id = ? AND event_type = 'reconciled_paid'"
  ).get(orderId).n, 1);
  sqlite.close();
}

/* ---- a hung OpState call times out and cannot stop the same cron sweep ---- */
{
  const { sqlite, env } = await environment();
  env.ROBOKASSA_PROVIDER_TIMEOUT_MS = '20';
  const hungId = seedDueOrder(sqlite, { email: 'hung@example.com' });
  const paidId = seedDueOrder(sqlite, { email: 'after-hung@example.com' });
  for (const orderId of [hungId, paidId]) {
    seedCheckoutEvent(sqlite, orderId, 'checkout_created');
    seedCheckoutEvent(sqlite, orderId, 'checkout_payment_started');
  }

  const waiting = context();
  const realFetch = globalThis.fetch;
  const operationStateInvoices = [];
  let hungSignal = null;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('OpStateExt')) {
      const invoiceId = new URL(String(url)).searchParams.get('InvoiceID');
      operationStateInvoices.push(invoiceId);
      if (invoiceId === String(hungId)) {
        hungSignal = init.signal;
        return new Promise(() => {});
      }
      return new Response(providerState(paidId, sqlite), {
        status: 200, headers: { 'Content-Type': 'application/xml' }
      });
    }
    return new Response(JSON.stringify({ id: 'delivery-after-timeout' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  let guard;
  try {
    await worker.scheduled({}, env, waiting.ctx);
    await Promise.race([
      waiting.settle(),
      new Promise((_, reject) => {
        guard = setTimeout(() => reject(new Error('reconciliation timeout guard')), 1_000);
      })
    ]);
  } finally {
    if (guard) clearTimeout(guard);
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(operationStateInvoices, [String(hungId), String(paidId)],
    'the same cron sweep must continue to the paid order after a hung provider call');
  assert.equal(hungSignal?.aborted, true,
    'the deadline must also abort a real provider fetch/body stream');
  assert.ok(sqlite.prepare(
    'SELECT reconciled_at FROM payment_orders WHERE order_id = ?'
  ).get(hungId).reconciled_at,
  'the timed-out order must persist its retry cursor');
  assert.equal(sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = ?'
  ).get(paidId).status, 'fulfilled');
  assert.equal(sqlite.prepare(
    'SELECT COUNT(*) AS n FROM payment_issuance WHERE payment_id = ?'
  ).get(String(paidId)).n, 1,
  'the order behind a hung OpState call must still be fulfilled exactly once');
  sqlite.close();
}

/* -- every provider response advances the queue, including error/unpaid -- */
{
  const { sqlite, env } = await environment();
  const transportErrorId = seedDueOrder(sqlite, { email: 'transport@example.com' });
  const providerErrorId = seedDueOrder(sqlite, { email: 'error@example.com' });
  const unpaidId = seedDueOrder(sqlite, { email: 'unpaid@example.com' });
  const paidId = seedDueOrder(sqlite, { email: 'paid@example.com' });
  const ancient = Date.now() - 2 * 24 * 60 * 60 * 1000;
  sqlite.prepare(
    'UPDATE payment_orders SET created_at = ?, expires_at = ? WHERE order_id = ?'
  ).run(ancient, ancient + 30 * 60 * 1000, providerErrorId);
  for (const orderId of [transportErrorId, providerErrorId, unpaidId, paidId]) {
    seedCheckoutEvent(sqlite, orderId, 'checkout_created');
    seedCheckoutEvent(sqlite, orderId, 'checkout_payment_started');
  }

  const operationStateInvoices = [];
  const fetcher = async (url) => {
    const invoiceId = new URL(String(url)).searchParams.get('InvoiceID');
    operationStateInvoices.push(invoiceId);
    if (invoiceId === String(transportErrorId)) throw new Error('provider unreachable');
    if (invoiceId === String(providerErrorId)) {
      return new Response(providerResultCode(10), {
        status: 200, headers: { 'Content-Type': 'application/xml' }
      });
    }
    if (invoiceId === String(unpaidId)) {
      return new Response(providerUnpaidState(), {
        status: 200, headers: { 'Content-Type': 'application/xml' }
      });
    }
    return new Response(providerState(paidId, sqlite), {
      status: 200, headers: { 'Content-Type': 'application/xml' }
    });
  };

  const now = Date.now();
  const first = await payments.reconcileDueRobokassaOrders(env, 1, now, fetcher);
  const second = await payments.reconcileDueRobokassaOrders(env, 1, now, fetcher);
  await payments.pruneExpiredPaymentOrders(env, 100, now);
  assert.equal(sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = ?'
  ).get(providerErrorId).status, 'pending',
  'a provider error is a retry cursor, not evidence that an old order is unpaid');
  const third = await payments.reconcileDueRobokassaOrders(env, 1, now, fetcher);
  const fourth = await payments.reconcileDueRobokassaOrders(env, 1, now, fetcher);

  assert.deepEqual(operationStateInvoices, [
    String(transportErrorId), String(providerErrorId), String(unpaidId), String(paidId)
  ], 'each provider-contacted row must back off so the next due order can advance');
  assert.equal(first.failed, 1);
  assert.equal(second.failed, 1);
  assert.equal(third.checked, 1);
  assert.equal(third.paid.length, 0);
  assert.equal(fourth.paid.length, 1,
    'a paid missed-callback order behind provider errors must still be reached');
  assert.ok(sqlite.prepare(
    'SELECT reconciled_at FROM payment_orders WHERE order_id = ?'
  ).get(transportErrorId).reconciled_at,
  'a provider transport failure must persist its backoff cursor');
  assert.ok(sqlite.prepare(
    'SELECT reconciled_at FROM payment_orders WHERE order_id = ?'
  ).get(providerErrorId).reconciled_at,
  'a nonzero provider result code must persist its backoff cursor');
  assert.ok(sqlite.prepare(
    'SELECT reconciled_at FROM payment_orders WHERE order_id = ?'
  ).get(unpaidId).reconciled_at,
  'a valid nonpayment state must persist its backoff cursor');
  sqlite.close();
}

/* -- missing operations age to unpaid; duplicate InvIds require review -- */
{
  const { sqlite, env } = await environment();
  const orderId = seedDueOrder(sqlite, { email: 'closed-before-provider@example.com' });
  seedCheckoutEvent(sqlite, orderId, 'checkout_created');
  seedCheckoutEvent(sqlite, orderId, 'checkout_payment_started');
  const missingOperation = async () => new Response(providerResultCode(3), {
    status: 200, headers: { 'Content-Type': 'application/xml' }
  });

  const first = await payments.reconcileRobokassaOrder(env, orderId, missingOperation);
  assert.equal(first.ok, false,
    'code 3 inside the lost-callback grace period must remain retryable');
  assert.equal(sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = ?'
  ).get(orderId).status, 'pending');
  assert.equal(sqlite.prepare(
    `SELECT event_type FROM payment_events WHERE order_id = ?
     ORDER BY id DESC LIMIT 1`
  ).get(orderId).event_type, 'reconciliation_provider_error');

  const ancient = Date.now() - 2 * 24 * 60 * 60 * 1000;
  sqlite.prepare(
    'UPDATE payment_orders SET created_at = ?, expires_at = ? WHERE order_id = ?'
  ).run(ancient, ancient + 30 * 60 * 1000, orderId);
  const finalMissing = await payments.reconcileRobokassaOrder(env, orderId, missingOperation);
  assert.equal(finalMissing.ok, true);
  assert.equal(finalMissing.paid, false,
    'a fresh code 3 after the grace period is terminal nonpayment evidence');
  assert.equal(sqlite.prepare(
    `SELECT event_type FROM payment_events WHERE order_id = ?
     ORDER BY id DESC LIMIT 1`
  ).get(orderId).event_type, 'reconciliation_observed');

  await payments.pruneExpiredPaymentOrders(env, 100, Date.now());
  const expired = sqlite.prepare(
    'SELECT status, email, telegram_user_id FROM payment_orders WHERE order_id = ?'
  ).get(orderId);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.email, null, 'closed missing-operation orders must erase contact data');

  const duplicateId = seedDueOrder(sqlite, { email: 'duplicate-invoice@example.com' });
  seedCheckoutEvent(sqlite, duplicateId, 'checkout_created');
  seedCheckoutEvent(sqlite, duplicateId, 'checkout_payment_started');
  const duplicate = await payments.reconcileRobokassaOrder(
    env,
    duplicateId,
    async () => new Response(providerResultCode(4), {
      status: 200, headers: { 'Content-Type': 'application/xml' }
    })
  );
  assert.equal(duplicate.reason, 'reconciliation_duplicate_invoice');
  assert.equal(sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = ?'
  ).get(duplicateId).status, 'review',
  'Robokassa code 4 must never become unpaid');
  assert.equal(sqlite.prepare(
    'SELECT reason FROM payment_review WHERE payment_id = ?'
  ).get(String(duplicateId)).reason, 'reconciliation_duplicate_invoice');
  assert.equal(sqlite.prepare(
    `SELECT COUNT(*) AS n FROM payment_events
     WHERE order_id = ? AND event_type = 'reconciliation_duplicate_invoice'`
  ).get(duplicateId).n, 1);
  sqlite.close();
}

/* -- a large batch of abandoned started checkouts cannot hide real money -- */
{
  const { sqlite, env } = await environment();
  const ancient = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const missingIds = [];
  for (let index = 0; index < 60; index += 1) {
    const orderId = seedDueOrder(sqlite, { email: `abandoned-${index}@example.com` });
    sqlite.prepare(
      'UPDATE payment_orders SET created_at = ?, expires_at = ? WHERE order_id = ?'
    ).run(ancient, ancient + 30 * 60 * 1000, orderId);
    seedCheckoutEvent(sqlite, orderId, 'checkout_created');
    seedCheckoutEvent(sqlite, orderId, 'checkout_payment_started');
    missingIds.push(orderId);
  }
  const paidId = seedDueOrder(sqlite, { email: 'real-money-behind-abandoned@example.com' });
  seedCheckoutEvent(sqlite, paidId, 'checkout_created');
  seedCheckoutEvent(sqlite, paidId, 'checkout_payment_started');

  const contacted = [];
  const fetcher = async (url) => {
    const invoiceId = new URL(String(url)).searchParams.get('InvoiceID');
    contacted.push(invoiceId);
    if (invoiceId === String(paidId)) {
      return new Response(providerState(paidId, sqlite), {
        status: 200, headers: { 'Content-Type': 'application/xml' }
      });
    }
    return new Response(providerResultCode(3), {
      status: 200, headers: { 'Content-Type': 'application/xml' }
    });
  };

  const now = Date.now();
  const first = await payments.reconcileDueRobokassaOrders(env, 50, now, fetcher);
  const second = await payments.reconcileDueRobokassaOrders(env, 50, now, fetcher);
  assert.equal(first.checked, 50);
  assert.equal(first.failed, 0,
    'aged code-3 rows are terminal nonpayment observations, not provider failures');
  assert.equal(second.paid.length, 1,
    'the next bounded sweep must reach a paid order behind abandoned checkouts');
  assert.equal(String(second.paid[0].order.order_id), String(paidId));
  assert.equal(contacted.length, 61);
  assert.equal(sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = ?'
  ).get(paidId).status, 'paid');

  await payments.pruneExpiredPaymentOrders(env, 100, now);
  assert.equal(sqlite.prepare(
    `SELECT COUNT(*) AS n FROM payment_orders
     WHERE order_id IN (${missingIds.map(() => '?').join(', ')}) AND status = 'expired'`
  ).get(...missingIds).n, missingIds.length);
  sqlite.close();
}

console.log('payment reconcile fulfillment regression passed');
