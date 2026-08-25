/**
 * Refund settlement must be durable, isolated and retryable.
 *
 * Findings covered:
 *  H-2  a cash refund could finish with NO durable revocation, because
 *       revokeLicense() bailed out with null whenever the KV projection was
 *       missing or malformed — before inserting the authoritative D1 row — and
 *       the cron ignored that return value.
 *  H-3  one failing provider poll aborted the entire sweep, and deterministic
 *       `ORDER BY order_id` selection re-picked that same row every run, so a
 *       permanently failing low order id starved every later refund forever.
 *  M-6  an unsupported ROBOKASSA_REFUND_HASH_ALGO passed readiness and then
 *       dead-ended the order in submission_unknown without any network call.
 *  M-7  a finished-refund mismatch left no payment_review row, so it vanished
 *       from every operator worklist.
 *  M-8  state transitions and their audit events were written separately.
 *  M-9  a provider-canceled refund kept its request id, so every later attempt
 *       was rejected with refund_already_started.
 *  M-10 abandoned checkouts kept contact PII forever.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import * as payments from '../backend/src/payments.js';
import { revokeLicenseDurable, getRevocation } from '../backend/src/licenses.js';

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
    this.db.exec('SAVEPOINT refund_test_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT refund_test_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT refund_test_batch');
      this.db.exec('RELEASE SAVEPOINT refund_test_batch');
      throw error;
    }
  }
}

const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');

async function environment(overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  return {
    sqlite,
    env: {
      DB: new SqliteD1(sqlite),
      LICENSES: new MemoryKV(),
      PAYMENT_ENVIRONMENT: 'production',
      ROBOKASSA_MERCHANT_LOGIN: 'smesh-shop',
      ROBOKASSA_PASSWORD1_PRODUCTION: 'p1',
      ROBOKASSA_PASSWORD2_PRODUCTION: 'p2',
      ROBOKASSA_PASSWORD3_PRODUCTION: 'p3',
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      ROBOKASSA_REFUND_HASH_ALGO: 'HS256',
      ROBOKASSA_FISCALIZATION_MODE: 'provider',
      ROBOKASSA_RECEIPT_TAX: 'none',
      ROBOKASSA_RECEIPT_PAYMENT_METHOD: 'full_payment',
      ROBOKASSA_RECEIPT_PAYMENT_OBJECT: 'service',
      LIFETIME_PRICE_RUB: '990',
      ...overrides
    }
  };
}

const GUID = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;

// A provider-fiscalized order needs a receipt whose single item matches the
// order amount exactly, or refundInvoiceItems() refuses the refund.
const RECEIPT = JSON.stringify({
  items: [{
    name: 'СМЭШ AI — бессрочная лицензия',
    quantity: 1,
    sum: 990,
    payment_method: 'full_payment',
    payment_object: 'service',
    tax: 'none'
  }]
});

function seedRefundPending(sqlite, { orderId, licenseKey, requestId, kopecks = 99000 }) {
  sqlite.prepare(
    `INSERT INTO payment_orders
       (order_id, gateway, environment, status, amount_kopecks, currency, plan_type,
        is_preorder, fiscalization_mode, receipt_json, created_at, expires_at,
        paid_at, fulfilled_at, provider_op_key, refund_request_id, refund_status,
        refund_kopecks)
     VALUES (?, 'robokassa', 'production', 'refund_pending', ?, 'RUB', 'lifetime',
             0, 'provider', ?, 1, 2, 3, 4, 'op-key', ?, 'processing', ?)`
  ).run(orderId, kopecks, RECEIPT, requestId, kopecks);
  if (licenseKey) {
    sqlite.prepare(
      `INSERT INTO payment_issuance (gateway, payment_id, license_key, license_json, created_at)
       VALUES ('robokassa', ?, ?, ?, 1)`
    ).run(String(orderId), licenseKey, JSON.stringify({ key: licenseKey }));
  }
}

const orderRow = (sqlite, orderId) => sqlite.prepare(
  'SELECT status, refund_status, refund_request_id, email, telegram_user_id, device_id FROM payment_orders WHERE order_id = ?'
).get(orderId);

const eventTypes = (sqlite, orderId) => sqlite.prepare(
  'SELECT event_type FROM payment_events WHERE order_id = ? ORDER BY id'
).all(orderId).map((r) => r.event_type);

/* ---- H-2: a refund cannot finish without a durable D1 revocation ---- */
{
  const { sqlite, env } = await environment();
  const LICENSE = 'SMESH-REFUND-NO-KV';
  seedRefundPending(sqlite, { orderId: 1, licenseKey: LICENSE, requestId: GUID(1) });
  // The KV projection is MISSING entirely — the exact case that used to make
  // revokeLicense return null before writing anything durable.
  assert.equal(await env.LICENSES.get(LICENSE), null);

  const result = await revokeLicenseDurable(env, LICENSE, 'robokassa_refund');
  assert.equal(result.ok, true, 'an absent projection must not block revocation');
  assert.equal(result.license, null, 'there was no projection to heal');
  const proof = await getRevocation(env, LICENSE);
  assert.ok(proof.revocation, 'the authoritative D1 revocation row must exist');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM license_revocations WHERE license_key = ?')
      .get(LICENSE).n,
    1
  );
}

/* ---- H-2: a MALFORMED projection is equally not a reason to skip ---- */
{
  const { sqlite, env } = await environment();
  const LICENSE = 'SMESH-REFUND-BAD-KV';
  seedRefundPending(sqlite, { orderId: 1, licenseKey: LICENSE, requestId: GUID(1) });
  await env.LICENSES.put(LICENSE, '{not json at all');

  const result = await revokeLicenseDurable(env, LICENSE, 'robokassa_refund');
  assert.equal(result.ok, true);
  assert.ok((await getRevocation(env, LICENSE)).revocation,
    'unparseable KV must still produce a permanent revocation');
}

/* ---- H-2: revocation lands BEFORE the order is marked refunded ---- */
{
  const { sqlite, env } = await environment();
  const LICENSE = 'SMESH-REFUND-ORDER';
  seedRefundPending(sqlite, { orderId: 7, licenseKey: LICENSE, requestId: GUID(7) });
  await revokeLicenseDurable(env, LICENSE, 'robokassa_refund');
  await payments.finalizeRobokassaRefund(env, {
    order_id: 7, environment: 'production', amount_kopecks: 99000, license_key: LICENSE
  });
  assert.equal(orderRow(sqlite, 7).status, 'refunded');
  assert.ok(eventTypes(sqlite, 7).includes('refund_finished'),
    'M-8: the terminal transition and its event commit together');
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM license_revocations').get().n, 1
  );
}

/* ---- H-2: the finalizer itself refuses an unrevoked entitlement ---- */
{
  const { sqlite, env } = await environment();
  const LICENSE = 'SMESH-REFUND-NO-REVOCATION';
  seedRefundPending(sqlite, { orderId: 11, licenseKey: LICENSE, requestId: GUID(11) });

  await assert.rejects(
    payments.finalizeRobokassaRefund(env, {
      order_id: 11, environment: 'production', amount_kopecks: 99000, license_key: LICENSE
    }),
    /refund finalization state changed/,
    'a caller mistake must not be able to mark cash returned while access is still live'
  );
  assert.equal(orderRow(sqlite, 11).status, 'refund_pending');
  assert.equal(eventTypes(sqlite, 11).includes('refund_finished'), false,
    'the rejected transition must not forge a terminal audit event');
}

/* ---- H-3: one failing row must not starve the rows behind it ---- */
{
  const { sqlite, env } = await environment();
  seedRefundPending(sqlite, { orderId: 1, licenseKey: 'SMESH-A', requestId: GUID(1) });
  seedRefundPending(sqlite, { orderId: 2, licenseKey: 'SMESH-B', requestId: GUID(2) });

  const polled = [];
  const fetcher = async (url) => {
    const id = new URL(url).searchParams.get('id');
    polled.push(id);
    // The LOWEST order id is permanently broken — the shape that used to end
    // the whole sweep on its very first call, every single run.
    if (id === GUID(1)) throw new Error('provider unreachable');
    return new Response(
      JSON.stringify({ requestId: id, label: 'finished', amount: '990.00' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const finished = await payments.inspectPendingRefunds(env, 20, fetcher);
  assert.equal(polled.length, 2, 'the second refund must still be polled');
  assert.equal(finished.length, 1, 'the healthy refund must still settle');
  assert.equal(String(finished[0].order_id), '2');

  const backoff = sqlite.prepare(
    'SELECT attempts, next_poll_at, last_error FROM payment_refund_poll WHERE order_id = 1'
  ).get();
  assert.equal(backoff.attempts, 1, 'the failing row records its attempt');
  assert.ok(backoff.next_poll_at > Date.now(), 'and backs off out of the eligible set');
  assert.match(backoff.last_error, /provider unreachable/);

  // Settle the healthy refund the way the cron does, then sweep again: while
  // order 1 sits in backoff it is not selected AT ALL, so it can never again
  // block whatever else is due.
  await revokeLicenseDurable(env, finished[0].license_key, 'robokassa_refund');
  await payments.finalizeRobokassaRefund(env, finished[0]);
  const second = await payments.inspectPendingRefunds(env, 20, async () => {
    throw new Error('a backed-off row must not be polled');
  });
  assert.deepEqual(second, [], 'nothing is due while order 1 backs off');
  assert.equal(orderRow(sqlite, 2).status, 'refunded');
}

/* ---- M-7: a finished mismatch creates a durable operator work item ---- */
{
  const { sqlite, env } = await environment();
  seedRefundPending(sqlite, { orderId: 3, licenseKey: 'SMESH-C', requestId: GUID(3) });
  const fetcher = async (url) => new Response(
    JSON.stringify({
      requestId: new URL(url).searchParams.get('id'), label: 'finished', amount: '1.00'
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  const finished = await payments.inspectPendingRefunds(env, 20, fetcher);
  assert.deepEqual(finished, [], 'a mismatched amount must not be finalized');

  const row = orderRow(sqlite, 3);
  assert.equal(row.status, 'review');
  assert.equal(row.refund_status, 'finished_mismatch');
  const open = sqlite.prepare(
    "SELECT COUNT(*) AS n FROM payment_review WHERE resolved_at IS NULL AND payment_id = '3'"
  ).get().n;
  assert.equal(open, 1, 'the mismatch must appear on the open-review worklist');
  assert.ok(eventTypes(sqlite, 3).includes('refund_finished_mismatch'));
}

/* ---- a mismatch REOPENS an already-resolved review for that payment ---- */
{
  const { sqlite, env } = await environment();
  seedRefundPending(sqlite, { orderId: 9, licenseKey: 'SMESH-E', requestId: GUID(9) });
  // An earlier, unrelated review for this same payment that an operator already
  // closed. INSERT OR IGNORE used to leave it alone, so the new mismatch — cash
  // already returned by the provider — showed up on no worklist at all, and the
  // audit event was skipped too because it was chained off that ignored insert.
  sqlite.prepare(
    `INSERT INTO payment_review
       (gateway, payment_id, invoice_id, amount_rub, reason, fields_json,
        created_at, environment, amount_kopecks, resolved_at, resolution, resolution_note)
     VALUES ('robokassa', '9', '9', 990.0, 'reconciliation_mismatch', '{}', 1,
             'production', 99000, 123, 'duplicate', 'closed earlier')`
  ).run();

  const fetcher = async (url) => new Response(
    JSON.stringify({
      requestId: new URL(url).searchParams.get('id'), label: 'finished', amount: '1.00'
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  assert.deepEqual(await payments.inspectPendingRefunds(env, 20, fetcher), []);

  const review = sqlite.prepare(
    "SELECT reason, resolved_at, resolution, resolution_note FROM payment_review WHERE payment_id = '9'"
  ).get();
  assert.equal(review.reason, 'refund_finished_mismatch', 'the review must describe the NEW problem');
  assert.equal(review.resolved_at, null, 'and must be reopened');
  assert.equal(review.resolution, null);
  assert.equal(review.resolution_note, null);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM payment_review WHERE resolved_at IS NULL").get().n,
    1, 'the reopened review must appear on the open-review worklist'
  );
  assert.ok(eventTypes(sqlite, 9).includes('refund_finished_mismatch'),
    'the audit event must be gated on the order transition, not on the review write');
}

/* ---- M-9: a provider-canceled refund can be attempted again ---- */
{
  const { sqlite, env } = await environment();
  seedRefundPending(sqlite, { orderId: 4, licenseKey: 'SMESH-D', requestId: GUID(4) });
  const fetcher = async (url) => new Response(
    JSON.stringify({
      requestId: new URL(url).searchParams.get('id'), label: 'canceled', amount: '990.00'
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  await payments.inspectPendingRefunds(env, 20, fetcher);

  const row = orderRow(sqlite, 4);
  assert.equal(row.status, 'fulfilled');
  assert.equal(row.refund_status, 'canceled');
  assert.equal(row.refund_request_id, null,
    'the spent request id must be retired so a new attempt is permitted');
  assert.ok(eventTypes(sqlite, 4).includes('refund_canceled'),
    'the reset must be audited, not silent');

  // The initiation guard now admits a fresh attempt instead of answering
  // refund_already_started for a refund that never happened.
  const retry = await payments.initiateRobokassaRefund(env, {
    order_id: '4', reason: 'second attempt', confirm_full_refund: true
  }, async () => new Response(
    JSON.stringify({ success: true, requestId: GUID(5) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  ));
  assert.equal(retry.ok, true, `a canceled refund must be retryable, got ${retry.reason}`);
  assert.equal(orderRow(sqlite, 4).refund_status, 'processing');
}

/* ---- M-6: an unsupported refund algorithm is caught before reservation ---- */
{
  const { sqlite, env } = await environment({ ROBOKASSA_REFUND_HASH_ALGO: 'RS256' });
  sqlite.prepare(
    `INSERT INTO payment_orders
       (order_id, gateway, environment, status, amount_kopecks, currency, plan_type,
        is_preorder, fiscalization_mode, receipt_json, created_at, expires_at,
        paid_at, fulfilled_at, provider_op_key)
     VALUES (5, 'robokassa', 'production', 'fulfilled', 99000, 'RUB', 'lifetime',
             0, 'provider', ?, 1, 2, 3, 4, 'op-key')`
  ).run(RECEIPT);

  assert.equal(payments.refundHashAlgorithm(env), '',
    'RS256 is not a refund JWT algorithm');
  assert.equal(payments.paymentRefundConfigValid(env), false,
    'readiness must reject the misconfiguration instead of reporting healthy');

  let fetchCount = 0;
  const result = await payments.initiateRobokassaRefund(env, {
    order_id: '5', reason: 'test', confirm_full_refund: true
  }, async () => { fetchCount += 1; throw new Error('unreachable'); });
  assert.equal(result.reason, 'refund_hash_config');
  assert.equal(fetchCount, 0, 'no provider call is attempted');
  const row = orderRow(sqlite, 5);
  assert.equal(row.status, 'fulfilled', 'the order must stay refundable');
  assert.equal(row.refund_status, null, 'and must not be stranded in a refund state');
}

/* ---- M-10: abandoned checkouts expire and shed their contact details ---- */
{
  const { sqlite, env } = await environment();
  const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
  sqlite.prepare(
    `INSERT INTO payment_orders
       (order_id, gateway, environment, status, amount_kopecks, currency, plan_type,
        email, telegram_user_id, device_id, is_preorder, fiscalization_mode,
        receipt_json, created_at, expires_at, reconciled_at)
     VALUES (6, 'robokassa', 'production', 'pending', 99000, 'RUB', 'lifetime',
             'buyer@example.com', '12345', 'device-abcdefgh', 0, 'provider',
             ?, ?, ?, ?)`
  ).run(RECEIPT, old, old + 30 * 60 * 1000, Date.now());

  const summary = await payments.pruneExpiredPaymentOrders(env);
  assert.equal(summary.expired, 1);
  const row = orderRow(sqlite, 6);
  assert.equal(row.status, 'expired');
  assert.equal(row.email, null);
  assert.equal(row.telegram_user_id, null);
  assert.equal(row.device_id, null);
  assert.ok(eventTypes(sqlite, 6).includes('order_expired'));
  // Reconciliation evidence survives the erasure.
  assert.equal(
    sqlite.prepare('SELECT amount_kopecks, plan_type FROM payment_orders WHERE order_id = 6')
      .get().amount_kopecks,
    99000
  );

  // A still-live pending order is untouched.
  sqlite.prepare(
    `INSERT INTO payment_orders
       (order_id, gateway, environment, status, amount_kopecks, currency, plan_type,
        email, is_preorder, fiscalization_mode, receipt_json, created_at, expires_at)
     VALUES (8, 'robokassa', 'production', 'pending', 99000, 'RUB', 'lifetime',
             'fresh@example.com', 0, 'provider', ?, ?, ?)`
  ).run(RECEIPT, Date.now(), Date.now() + 30 * 60 * 1000);
  await payments.pruneExpiredPaymentOrders(env);
  assert.equal(orderRow(sqlite, 8).email, 'fresh@example.com',
    'an in-flight checkout must keep its contact');
}

/* ---- checkout expiry is enforced by the GATEWAY, not just locally ---- */
{
  const { sqlite, env } = await environment();
  const created = await payments.createRobokassaOrder(env, {
    plan: 'lifetime', email: 'buyer@example.com'
  }, '203.0.113.9');
  assert.equal(created.ok, true, created.reason);

  // Without ExpirationDate the 30-minute TTL was ours alone: a customer could
  // hold the provider checkout open and pay afterwards, and the signed callback
  // then dead-ended in manual review instead of issuing the paid licence.
  const expiration = created.fields.ExpirationDate;
  assert.ok(expiration, 'the payment form must carry the gateway-side deadline');
  assert.match(expiration, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    'the payment interface documents ExpirationDate as exactly YYYY-MM-DDThh:mm');
  // The zone-less payment-interface value is Moscow wall time. Keep the local
  // order alive through that entire provider minute, so even an end-of-minute
  // interpretation cannot accept a payment after our own fulfillment window.
  const gatewayDeadline = Date.parse(`${expiration}:00+03:00`);
  const orderDeadline = Date.parse(created.expires_at);
  assert.ok(gatewayDeadline <= orderDeadline,
    'the gateway must never accept payment after the order expires');
  assert.equal(orderDeadline - gatewayDeadline, 60_000,
    'the order must cover the complete provider deadline minute');
  // It must not be smuggled into the signature base.
  assert.ok(!created.fields.SignatureValue.includes(expiration));
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM payment_orders WHERE status = ?').get('pending').n,
    1
  );
}

console.log('refund settlement isolation regressions passed');
