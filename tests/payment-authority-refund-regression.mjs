import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import * as payments from '../backend/src/payments.js';
import { statsOverview, statsPurchases, statsTimeseries } from '../backend/src/analytics.js';
import { revokeLicense } from '../backend/src/licenses.js';
import { resultSignatureBase } from '../backend/src/gateways/robokassa.js';

const PASSWORD1 = 'production-payment-password-1';
const PASSWORD2 = 'production-result-password-2';
const PASSWORD3 = 'production-refund-password-3';
const ADMIN = 'payment-admin-secret'.repeat(2);

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
    this.db.exec('SAVEPOINT payment_test_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT payment_test_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT payment_test_batch');
      this.db.exec('RELEASE SAVEPOINT payment_test_batch');
      throw error;
    }
  }
}

async function environment(overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  return {
    sqlite,
    env: {
      DB: new SqliteD1(sqlite),
      LICENSES: new MemoryKV(),
      PAYMENT_ENVIRONMENT: 'production',
      ROBOKASSA_MERCHANT_LOGIN: 'smesh-shop',
      ROBOKASSA_PASSWORD1_PRODUCTION: PASSWORD1,
      ROBOKASSA_PASSWORD2_PRODUCTION: PASSWORD2,
      ROBOKASSA_PASSWORD3_PRODUCTION: PASSWORD3,
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      ROBOKASSA_REFUND_HASH_ALGO: 'HS256',
      ROBOKASSA_FISCALIZATION_MODE: 'provider',
      ROBOKASSA_RECEIPT_TAX: 'none',
      ROBOKASSA_RECEIPT_PAYMENT_METHOD: 'full_payment',
      ROBOKASSA_RECEIPT_PAYMENT_OBJECT: 'service',
      ROBOKASSA_OUT_CURRENCY_LABEL: 'RUB',
      SUBSCRIPTION_PRICE_RUB: '199',
      LIFETIME_PRICE_RUB: '990',
      SUBSCRIPTION_DAYS: '30',
      LEGACY_PAYMENT_ORDER_ENABLED: 'true',
      RUNTIME_WRITE_EPOCH: '1',
      ADMIN_SECRET: ADMIN,
      ...overrides
    }
  };
}

function context() {
  const promises = [];
  return {
    ctx: { waitUntil(promise) { promises.push(Promise.resolve(promise).catch(() => {})); } },
    async settle() { await Promise.all(promises); }
  };
}

async function createOrder(env, body = { plan: 'subscription', email: 'buyer@example.com' }) {
  const { ctx } = context();
  const response = await worker.fetch(new Request('https://api.example/payments/robokassa/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '192.0.2.10' },
    body: JSON.stringify(body)
  }), env, ctx);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function callbackFields(order, overrides = {}) {
  return {
    OutSum: order.fields.OutSum,
    InvId: order.fields.InvId,
    Shp_environment: order.fields.Shp_environment,
    Shp_order_id: order.fields.Shp_order_id,
    ...overrides
  };
}

async function signedCallback(env, fields, password = PASSWORD2, signatureOverride = null) {
  const signature = signatureOverride ?? createHash('sha256')
    .update(resultSignatureBase(fields, password), 'utf8').digest('hex');
  const body = new URLSearchParams({ ...fields, SignatureValue: signature });
  const waiting = context();
  const response = await worker.fetch(new Request('https://api.example/webhook/robokassa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }), env, waiting.ctx);
  await waiting.settle();
  return response;
}

async function adminPost(env, path, body, ctx = context().ctx) {
  return worker.fetch(new Request(`https://api.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN },
    body: JSON.stringify(body)
  }), env, ctx);
}

// The browser supplies a plan, not an amount. D1 freezes the catalog price,
// currency, environment, contact and plan before a redirect is generated.
{
  const { sqlite, env } = await environment();
  const order = await createOrder(env, {
    plan: 'subscription', email: 'Buyer@Example.com', amount: '0.01'
  });
  assert.equal(order.amount_kopecks, 19_900);
  assert.equal(order.currency, 'RUB');
  assert.equal(order.environment, 'production');
  assert.equal(order.fields.IsTest, undefined);
  const frozen = sqlite.prepare(
    `SELECT amount_kopecks, fiscalization_mode, receipt_json
     FROM payment_orders WHERE order_id = ?`
  ).get(order.order_id);
  assert.equal(frozen.amount_kopecks, 19_900);
  assert.equal(frozen.fiscalization_mode, 'provider');
  assert.equal(order.fields.Receipt, encodeURIComponent(frozen.receipt_json));
  const signedBase = [
    'smesh-shop', '199.00', order.order_id, order.fields.Receipt, PASSWORD1,
    'Shp_environment=production', `Shp_order_id=${order.order_id}`
  ].join(':');
  assert.equal(order.fields.SignatureValue,
    createHash('sha256').update(signedBase, 'utf8').digest('hex'),
    'the provider-encoded receipt must be frozen and included in SignatureValue');
  sqlite.close();
}

// Mutation witness for the load-bearing money guard: wrong, truncated and
// wrong-secret signatures all produce 403 and zero durable side effects.
{
  const { sqlite, env } = await environment();
  const order = await createOrder(env);
  for (const signature of ['deadbeef', '0'.repeat(63)]) {
    const response = await signedCallback(env, callbackFields(order), PASSWORD2, signature);
    assert.equal(response.status, 403);
  }
  const wrongSecret = await signedCallback(env, callbackFields(order), 'wrong-result-secret');
  assert.equal(wrongSecret.status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_review').get().n, 0);
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders').get().status, 'pending');
  sqlite.close();
}

// A valid signature without a server order is evidence to investigate, never
// authority to mint. The review can now be durably closed by an admin.
{
  const { sqlite, env } = await environment();
  const fields = {
    OutSum: '990.00', InvId: '424242',
    Shp_environment: 'production', Shp_order_id: '424242'
  };
  const response = await signedCallback(env, fields);
  assert.equal(await response.text(), 'OK424242');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 0);
  assert.equal(sqlite.prepare('SELECT reason FROM payment_review').get().reason, 'unknown_order');
  const resolved = await adminPost(env, '/admin/payment-review/resolve', {
    gateway: 'robokassa', payment_id: '424242', resolution: 'invalid_test',
    note: 'No production order existed; reconciled against the cabinet.'
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.ok(sqlite.prepare('SELECT resolved_at FROM payment_review').get().resolved_at);
  sqlite.close();
}

// Exact amount and environment binding: even a correctly signed callback
// cannot reinterpret a frozen order.
{
  const { sqlite, env } = await environment();
  const order = await createOrder(env);
  const amountConflict = await signedCallback(env, callbackFields(order, { OutSum: '990.00' }));
  assert.equal(await amountConflict.text(), `OK${order.order_id}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 0);
  assert.equal(sqlite.prepare('SELECT reason FROM payment_review').get().reason, 'amount_mismatch');

  const second = await createOrder(env);
  const environmentConflict = await signedCallback(env, callbackFields(second, {
    Shp_environment: 'test'
  }));
  assert.equal(environmentConflict.status, 409);
  assert.equal(sqlite.prepare(
    'SELECT status FROM payment_orders WHERE order_id = ?'
  ).get(second.order_id).status, 'pending');
  sqlite.close();
}

// Happy path and replay: one payment claim, one bearer key, integer money and
// a fulfilled order regardless of gateway redelivery.
let refundFixture;
{
  const fixture = await environment();
  const { sqlite, env } = fixture;
  const order = await createOrder(env);
  const first = await signedCallback(env, callbackFields(order));
  assert.equal(await first.text(), `OK${order.order_id}`);
  const replay = await signedCallback(env, callbackFields(order));
  assert.equal(await replay.text(), `OK${order.order_id}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM payment_issuance').get().n, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM delivery_outbox').get().n, 1);
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders').get().status, 'fulfilled');
  const purchase = sqlite.prepare('SELECT amount_kopecks, amount_rub FROM purchases').get();
  assert.equal(purchase.amount_kopecks, 19_900);
  assert.equal(purchase.amount_rub, 199);
  refundFixture = { ...fixture, order };
}

// Test credentials are not interchangeable with production credentials.
{
  const { sqlite, env } = await environment({
    PAYMENT_ENVIRONMENT: 'test',
    ROBOKASSA_PASSWORD1_TEST: 'test-payment-password-1',
    ROBOKASSA_PASSWORD2_TEST: 'test-result-password-2'
  });
  const order = await createOrder(env);
  assert.equal(order.fields.IsTest, '1');
  assert.equal((await signedCallback(env, callbackFields(order), PASSWORD2)).status, 403);
  const accepted = await signedCallback(env, callbackFields(order), 'test-result-password-2');
  assert.equal(await accepted.text(), `OK${order.order_id}`);
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders').get().status, 'fulfilled');
  sqlite.close();
}

// All revenue paths sum integer kopecks. The compatibility REAL column may
// retain 199.02 for old consumers, but it cannot leak float error into totals.
{
  const { sqlite, env } = await environment();
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    sqlite.prepare(
      `INSERT INTO purchases
         (license_key, gateway, type, status, amount_rub, issued_at, amount_kopecks)
       VALUES (?, 'robokassa', 'subscription', 'active', 199.02, ?, 19902)`
    ).run(`SMESH-MONEY-${index}`, now + index);
  }
  const overview = await statsOverview(env, 0);
  assert.equal(overview.revenue.revenue_kopecks, 59_706);
  assert.equal(overview.revenue.revenue_rub, 597.06);
  const timeseries = await statsTimeseries(env, 1);
  assert.equal(timeseries.rows.at(-1).revenue_rub, 597.06);
  const purchases = await statsPurchases(env, { days: 0, limit: 10 });
  assert.equal(purchases.gateways[0].revenue_rub, 597.06);
  sqlite.close();
}

// Production-only reconciliation verifies provider state, merchant currency
// and exact kopecks before storing OpKey. A full refund is then submitted once,
// polled to finished, and only then revokes the license and finalizes the order.
{
  const { sqlite, env, order } = refundFixture;
  const originalFetch = globalThis.fetch;
  let refundJwt = '';
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    if (address.includes('/OpStateExt')) {
      const parsed = new URL(address);
      const expected = createHash('sha256')
        .update(`smesh-shop:${order.order_id}:${PASSWORD2}`, 'utf8').digest('hex');
      assert.equal(parsed.searchParams.get('Signature'), expected);
      return new Response(`<?xml version="1.0"?><OperationStateResponse>
        <Result><Code>0</Code></Result><State><Code>100</Code></State>
        <Info><OutCurrLabel>RUB</OutCurrLabel><OutSum>199.00</OutSum>
        <OpKey>0005F891-8CCD-434B-8455-816AFFFDBF37-token</OpKey></Info>
      </OperationStateResponse>`, { headers: { 'Content-Type': 'application/xml' } });
    }
    if (address.endsWith('/RefundService/Refund/Create')) {
      refundJwt = String(init.body || '');
      return Response.json({
        success: true, message: null,
        requestId: '68cd7fa6-1338-4745-ba5c-28d16cbcdb3d'
      });
    }
    throw new Error(`unexpected fetch ${address}`);
  };
  try {
    const waiting = context();
    const reconciled = await adminPost(
      env, '/admin/payment/reconcile', { order_id: order.order_id }, waiting.ctx
    );
    assert.equal(reconciled.status, 200, await reconciled.clone().text());
    await waiting.settle();
    assert.ok(sqlite.prepare('SELECT provider_op_key FROM payment_orders').get().provider_op_key);

    const refund = await adminPost(env, '/admin/payment/refund', {
      order_id: order.order_id,
      reason: 'Buyer cancellation within the approved refund workflow',
      confirm_full_refund: true
    });
    assert.equal(refund.status, 200, await refund.clone().text());
    const [, encodedPayload] = refundJwt.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    assert.equal(payload.RefundSum, undefined, 'full refunds must omit the partial-refund field');
    assert.equal(payload.InvoiceItems[0].Cost, 199);
    assert.equal(payload.InvoiceItems[0].Tax, 'none');
    assert.equal(payload.InvoiceItems[0].PaymentMethod, 'full_payment');
    assert.equal(payload.InvoiceItems[0].PaymentObject, 'service');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const finished = await payments.inspectPendingRefunds(env, 20, async (url) => {
    assert.match(String(url), /RefundService\/Refund\/GetState\?id=/);
    return Response.json({
      requestId: '68cd7fa6-1338-4745-ba5c-28d16cbcdb3d',
      amount: 199.000000, label: 'finished'
    });
  });
  assert.equal(finished.length, 1);
  await revokeLicense(env, finished[0].license_key, 'robokassa_refund');
  await payments.finalizeRobokassaRefund(env, finished[0]);
  assert.equal(sqlite.prepare('SELECT status FROM payment_orders').get().status, 'refunded');
  assert.equal(JSON.parse(await env.LICENSES.get(finished[0].license_key)).status, 'revoked');
  sqlite.close();
}

console.log('payment authority, signature, reconciliation and refund regressions passed');
