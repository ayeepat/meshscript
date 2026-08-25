/**
 * Robokassa InvId allocation is a money/idempotency boundary.
 *
 * New orders use disjoint production/test namespaces plus 48 bits of CSPRNG
 * entropy. The database claims the candidate atomically, retries collisions,
 * and never lets JavaScript or a provider round-trip rewrite its decimal form.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import * as payments from '../backend/src/payments.js';
import { resultSignatureBase } from '../backend/src/gateways/robokassa.js';

const PRODUCTION_BASE = 7_000_000_000_000_000n;
const TEST_BASE = 8_000_000_000_000_000n;
const RANDOM_SPACE = 1n << 48n;
const RANDOM_MAX = RANDOM_SPACE - 1n;
const PASSWORD1 = 'allocator-payment-password-1';
const PASSWORD2 = 'allocator-result-password-2';
const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const paymentsSource = await readFile(new URL('../backend/src/payments.js', import.meta.url), 'utf8');

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
    this.db.exec('SAVEPOINT allocator_test_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT allocator_test_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT allocator_test_batch');
      this.db.exec('RELEASE SAVEPOINT allocator_test_batch');
      throw error;
    }
  }
}

function environment(paymentEnvironment = 'production', overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  return {
    sqlite,
    env: {
      DB: new SqliteD1(sqlite),
      LICENSES: new MemoryKV(),
      RUNTIME_WRITE_EPOCH: '1',
      PAYMENT_ENVIRONMENT: paymentEnvironment,
      ROBOKASSA_MERCHANT_LOGIN: 'smesh-invoice-allocator',
      ROBOKASSA_PASSWORD1_PRODUCTION: PASSWORD1,
      ROBOKASSA_PASSWORD2_PRODUCTION: PASSWORD2,
      ROBOKASSA_PASSWORD1_TEST: PASSWORD1,
      ROBOKASSA_PASSWORD2_TEST: PASSWORD2,
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      ROBOKASSA_FISCALIZATION_MODE: 'external',
      ROBOKASSA_OUT_CURRENCY_LABEL: 'RUB',
      SUBSCRIPTION_PRICE_RUB: '149',
      SUBSCRIPTION_DAYS: '30',
      LIFETIME_PRICE_RUB: '999',
      MONTHLY_PRICE_RUB: '149',
      MONTHLY_DAYS: '30',
      SCHOOL_YEAR_PRICE_RUB: '999',
      SCHOOL_YEAR_DAYS: '273',
      ROBOKASSA_SUCCESS_URL2: 'https://site.example/checkout/success/',
      ROBOKASSA_FAIL_URL2: 'https://site.example/checkout/',
      CHECKOUT_TELEGRAM_BOT_USERNAME: 'smesh_allocator_bot',
      CHECKOUT_CAPABILITY_SECRET: 'allocator-checkout-capability-secret-0123456789',
      TELEGRAM_BOT_TOKEN: 'allocator-telegram-token',
      TELEGRAM_WEBHOOK_SECRET: 'allocator-telegram-webhook-secret-0123456789',
      INGEST_KEY: 'allocator-distinct-ingest-secret-0123456789',
      RESEND_API_KEY: 'allocator-resend-key',
      EMAIL_FROM: 'Smesh <license@example.com>',
      ...overrides
    }
  };
}

function context() {
  const promises = [];
  return {
    ctx: { waitUntil(promise) { promises.push(Promise.resolve(promise)); } },
    async settle() { await Promise.all(promises); }
  };
}

async function createLegacyOrder(env, suffix, ip) {
  const order = await payments.createRobokassaOrder(env, {
    plan: 'subscription', email: `buyer-${suffix}@example.com`
  }, ip);
  assert.equal(order.ok, true);
  assert.equal(order.fields.InvId, order.order_id);
  assert.equal(order.fields.Shp_order_id, order.order_id);
  return order;
}

function assertRange(id, base, label) {
  const decimal = String(id);
  const parsed = BigInt(decimal);
  assert.ok(parsed >= base && parsed < base + RANDOM_SPACE, `${label} must be in its namespace`);
  assert.equal(Number.isSafeInteger(Number(decimal)), true, `${label} must be a safe JS integer`);
  assert.equal(String(Number(decimal)), decimal, `${label} decimal form must round-trip exactly`);
}

function insertHistoricalOrder(sqlite, orderId, now = Date.now()) {
  sqlite.prepare(
    `INSERT INTO payment_orders
       (order_id, gateway, environment, status, amount_kopecks, currency,
        plan_type, subscription_days, email, telegram_user_id, referral_code,
        device_id, is_preorder, fiscalization_mode, receipt_json, created_at,
        expires_at)
     VALUES (?, 'robokassa', 'production', 'pending', 14900, 'RUB',
             'subscription', 30, 'historical@example.com', NULL, NULL, NULL,
             0, 'external', NULL, ?, ?)`
  ).run(orderId, now, now + 60 * 60 * 1000);
}

async function signedCallback(env, order) {
  const fields = {
    OutSum: order.fields?.OutSum || '149.00',
    InvId: String(order.order_id),
    Shp_environment: 'production',
    Shp_order_id: String(order.order_id)
  };
  fields.SignatureValue = createHash('sha256')
    .update(resultSignatureBase(fields, PASSWORD2), 'utf8').digest('hex');
  const waiting = context();
  const response = await worker.fetch(new Request('https://api.example/webhook/robokassa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  }), env, waiting.ctx);
  await waiting.settle();
  return response;
}

// Keep the SQL contract visible: both creators share one explicit atomic
// claim. INSERT OR IGNORE would hide unrelated constraint errors and is not an
// acceptable substitute for handling only an order_id collision.
assert.equal((paymentsSource.match(/INSERT INTO payment_orders/g) || []).length, 1);
assert.match(paymentsSource,
  /INSERT INTO payment_orders[\s\S]*ON CONFLICT\(order_id\) DO NOTHING[\s\S]*RETURNING order_id/);
assert.doesNotMatch(paymentsSource, /INSERT OR IGNORE INTO payment_orders/);

const realGetRandomValues = crypto.getRandomValues.bind(crypto);
const realFetch = globalThis.fetch;
let forcedOffsets = null;
let forcedCalls = 0;

function forceOffsets(offsets) {
  forcedOffsets = offsets.map((offset) => BigInt(offset));
  forcedCalls = 0;
}

function assertForcedCalls(expected) {
  assert.equal(forcedCalls, expected);
  assert.equal(forcedOffsets?.length, 0, 'every forced 48-bit sample should be consumed');
  forcedOffsets = null;
}

crypto.getRandomValues = (target) => {
  if (target.byteLength !== 6 || forcedOffsets == null) return realGetRandomValues(target);
  assert.ok(forcedOffsets.length > 0, 'allocator requested an unexpected extra 48-bit sample');
  let value = forcedOffsets.shift();
  assert.ok(value >= 0n && value < RANDOM_SPACE, 'forced offset must fit 48 bits');
  for (let index = 5; index >= 0; index -= 1) {
    target[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  forcedCalls += 1;
  return target;
};

globalThis.fetch = async (input) => {
  const target = String(input?.url || input);
  if (target === 'https://api.resend.com/emails') {
    return new Response('', { status: 200 });
  }
  throw new Error(`unexpected external request in invoice allocator regression: ${target}`);
};

try {
  // Both public order creators use the approved namespace for both gateway
  // environments. Boundary offsets also prove the complete 48-bit value is
  // assembled with no signed-int or floating-point truncation.
  const production = environment('production');
  forceOffsets([0n]);
  const productionCheckout = await payments.createCheckoutSession(
    production.env, { plan: 'month' }, '192.0.2.10'
  );
  assert.equal(productionCheckout.ok, true);
  assertForcedCalls(1);
  forceOffsets([RANDOM_MAX]);
  const productionLegacy = await createLegacyOrder(production.env, 'prod', '192.0.2.11');
  assertForcedCalls(1);
  assertRange(productionCheckout.order_id, PRODUCTION_BASE, 'production checkout InvId');
  assertRange(productionLegacy.order_id, PRODUCTION_BASE, 'production legacy InvId');
  assert.equal(BigInt(productionCheckout.order_id), PRODUCTION_BASE);
  assert.equal(BigInt(productionLegacy.order_id), PRODUCTION_BASE + RANDOM_MAX);

  const test = environment('test');
  forceOffsets([0n]);
  const testCheckout = await payments.createCheckoutSession(
    test.env, { plan: 'month' }, '192.0.2.20'
  );
  assert.equal(testCheckout.ok, true);
  assertForcedCalls(1);
  forceOffsets([RANDOM_MAX]);
  const testLegacy = await createLegacyOrder(test.env, 'test', '192.0.2.21');
  assertForcedCalls(1);
  assertRange(testCheckout.order_id, TEST_BASE, 'test checkout InvId');
  assertRange(testLegacy.order_id, TEST_BASE, 'test legacy InvId');
  assert.equal(BigInt(testCheckout.order_id), TEST_BASE);
  assert.equal(BigInt(testLegacy.order_id), TEST_BASE + RANDOM_MAX);
  assert.equal(testLegacy.fields.IsTest, '1');

  const productionSamples = new Set([productionCheckout.order_id, productionLegacy.order_id]);
  for (const sample of [testCheckout.order_id, testLegacy.order_id]) {
    assert.equal(productionSamples.has(sample), false, 'production/test namespaces must be disjoint');
  }
  production.sqlite.close();
  test.sqlite.close();

  // The database, not probability, decides uniqueness. One collision retries
  // to a fresh candidate; eight collisions fail without overwriting the winner
  // or appending a phantom order-created event.
  const collision = environment('production');
  forceOffsets([900n]);
  const winner = await createLegacyOrder(collision.env, 'winner', '192.0.2.30');
  assertForcedCalls(1);
  forceOffsets([900n, 901n]);
  const retried = await createLegacyOrder(collision.env, 'retry', '192.0.2.31');
  assertForcedCalls(2);
  assert.equal(BigInt(winner.order_id), PRODUCTION_BASE + 900n);
  assert.equal(BigInt(retried.order_id), PRODUCTION_BASE + 901n);

  const beforeOrders = collision.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_orders').get().n;
  const beforeEvents = collision.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n;
  forceOffsets(Array(8).fill(900n));
  await assert.rejects(
    () => createLegacyOrder(collision.env, 'exhausted', '192.0.2.32'),
    /invoice id allocation exhausted/
  );
  assertForcedCalls(8);
  assert.equal(collision.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_orders').get().n,
    beforeOrders);
  assert.equal(collision.sqlite.prepare('SELECT COUNT(*) AS n FROM payment_events').get().n,
    beforeEvents);
  assert.equal(collision.sqlite.prepare(
    'SELECT email FROM payment_orders WHERE order_id = ?'
  ).get(winner.order_id).email, 'buyer-winner@example.com');
  collision.sqlite.close();

  // Historical small autoincrement IDs remain valid callback identities even
  // though no newly allocated order may enter that old namespace.
  const historical = environment('production');
  insertHistoricalOrder(historical.sqlite, 42);
  const loadedHistorical = await payments.loadRobokassaOrder(historical.env, '42');
  assert.equal(String(loadedHistorical.order_id), '42');
  assert.ok(42n < PRODUCTION_BASE && 42n < TEST_BASE);
  const historicalResponse = await signedCallback(historical.env, {
    order_id: '42', fields: { OutSum: '149.00' }
  });
  assert.equal(await historicalResponse.text(), 'OK42');
  assert.equal(historical.sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = 42'
  ).get().status, 'fulfilled');
  historical.sqlite.close();

  // The exact large decimal string crosses the payment form, ResultURL
  // signature/ack, idempotency registry, and OpState query unchanged.
  const roundTrip = environment('production');
  forceOffsets([RANDOM_MAX - 17n]);
  const large = await createLegacyOrder(roundTrip.env, 'roundtrip', '192.0.2.40');
  assertForcedCalls(1);
  const callbackResponse = await signedCallback(roundTrip.env, large);
  assert.equal(await callbackResponse.text(), `OK${large.order_id}`);
  assert.equal(roundTrip.sqlite.prepare(
    'SELECT payment_id FROM payment_issuance WHERE gateway = ?'
  ).get('robokassa').payment_id, large.order_id);

  let opStateInvoice = '';
  let opStateSignature = '';
  const reconciliation = await payments.reconcileRobokassaOrder(
    roundTrip.env, large.order_id, async (url) => {
      const request = new URL(url);
      opStateInvoice = request.searchParams.get('InvoiceID') || '';
      opStateSignature = request.searchParams.get('Signature') || '';
      return new Response(
        '<?xml version="1.0"?><OperationStateResponse>' +
        '<Result><Code>0</Code></Result><State><Code>5</Code></State>' +
        '<Info><OutCurrLabel>RUB</OutCurrLabel><OutSum>149.00</OutSum><OpKey></OpKey></Info>' +
        '</OperationStateResponse>',
        { status: 200, headers: { 'Content-Type': 'application/xml' } }
      );
    }
  );
  assert.equal(reconciliation.ok, true);
  assert.equal(reconciliation.paid, false);
  assert.equal(opStateInvoice, large.order_id);
  assert.equal(opStateSignature, createHash('sha256')
    .update(`smesh-invoice-allocator:${large.order_id}:${PASSWORD2}`, 'utf8').digest('hex'));
  roundTrip.sqlite.close();
} finally {
  crypto.getRandomValues = realGetRandomValues;
  globalThis.fetch = realFetch;
}

console.log('Robokassa invoice ID allocation regression passed');
