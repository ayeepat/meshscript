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
  const orderId = seedDueOrder(sqlite, { email: 'missed-callback@example.com' });
  const waiting = context();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('OpStateExt')) {
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

console.log('payment reconcile fulfillment regression passed');
