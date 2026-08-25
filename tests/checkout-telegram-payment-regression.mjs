/**
 * Checkout capability -> trusted Telegram binding -> Robokassa ResultURL.
 *
 * This is deliberately a public-interface regression. The browser may choose
 * a catalog entry and provide an email/terms acknowledgement, but it never
 * supplies price authority, Telegram identity, or proof that money moved.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';

const PASSWORD1 = 'checkout-payment-password-1';
const PASSWORD2 = 'checkout-result-password-2';
const TELEGRAM_SECRET = 'checkout-telegram-webhook-secret';
const RESULT_URL = 'https://api.example/webhook/robokassa';
const SUCCESS_URL2 = 'https://site.example/checkout/success/';
const FAIL_URL2 = 'https://site.example/checkout/?payment=cancelled';
const TRUSTED_TELEGRAM_ID = '7001001';
const OTHER_TELEGRAM_ID = '7002002';
const CLIENT_SUPPLIED_TELEGRAM_ID = '7999999';
const DAY_MS = 24 * 60 * 60 * 1000;
const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');

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
    this.db.exec('SAVEPOINT checkout_test_batch');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('RELEASE SAVEPOINT checkout_test_batch');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT checkout_test_batch');
      this.db.exec('RELEASE SAVEPOINT checkout_test_batch');
      throw error;
    }
  }
}

function environment(overrides = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(schemaSql);
  return {
    sqlite,
    env: {
      DB: new SqliteD1(sqlite),
      LICENSES: new MemoryKV(),
      RUNTIME_WRITE_EPOCH: '1',
      PAYMENT_ENVIRONMENT: 'production',
      ROBOKASSA_MERCHANT_LOGIN: 'smesh-checkout',
      ROBOKASSA_PASSWORD1_PRODUCTION: PASSWORD1,
      ROBOKASSA_PASSWORD2_PRODUCTION: PASSWORD2,
      ROBOKASSA_PASSWORD3_PRODUCTION: 'checkout-refund-password-3',
      ROBOKASSA_HASH_ALGO: 'SHA-256',
      ROBOKASSA_REFUND_HASH_ALGO: 'HS256',
      ROBOKASSA_FISCALIZATION_MODE: 'provider',
      ROBOKASSA_RECEIPT_TAX: 'none',
      ROBOKASSA_RECEIPT_PAYMENT_METHOD: 'full_payment',
      ROBOKASSA_RECEIPT_PAYMENT_OBJECT: 'service',
      ROBOKASSA_OUT_CURRENCY_LABEL: 'RUB',
      ROBOKASSA_SUCCESS_URL2: SUCCESS_URL2,
      ROBOKASSA_FAIL_URL2: FAIL_URL2,
      SUBSCRIPTION_PRICE_RUB: '149',
      SUBSCRIPTION_DAYS: '30',
      LIFETIME_PRICE_RUB: '999',
      MONTHLY_PRICE_RUB: '149',
      MONTHLY_DAYS: '30',
      SCHOOL_YEAR_PRICE_RUB: '999',
      SCHOOL_YEAR_DAYS: '273',
      CHECKOUT_PROMO_CODE: 'TEST654',
      CHECKOUT_PROMO_MONTH_PRICE_RUB: '10',
      CHECKOUT_TELEGRAM_BOT_USERNAME: 'smesh_checkout_bot',
      CHECKOUT_CAPABILITY_SECRET: 'checkout-capability-secret-that-is-at-least-32-bytes',
      TELEGRAM_BOT_TOKEN: 'checkout-bot-token',
      TELEGRAM_WEBHOOK_SECRET: TELEGRAM_SECRET,
      INGEST_KEY: 'checkout-capability-signing-key-32-bytes-minimum',
      SUPPORT_CHAT_ID: '4242',
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

let requestSequence = 10;

async function postJson(env, path, body, headers = {}) {
  const waiting = context();
  const response = await worker.fetch(new Request(`https://api.example${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cf-connecting-ip': `192.0.2.${requestSequence++}`,
      ...headers
    },
    body: JSON.stringify(body)
  }), env, waiting.ctx);
  await waiting.settle();
  const text = await response.clone().text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ResultURL is deliberately plain text. */ }
  return { response, data, text };
}

async function createSession(env, body) {
  const result = await postJson(env, '/checkout/session', body);
  assert.equal(result.response.status, 200, result.text);
  assert.equal(result.data?.ok, true);
  assert.match(result.data?.token || '', /^[A-Za-z0-9_-]{50}$/,
    'the capability must fit Telegram start-parameter limits without exposing structure');
  assert.ok(Number.isFinite(Date.parse(result.data?.expires_at)));
  const deepLink = new URL(result.data.telegram_url);
  assert.equal(deepLink.protocol, 'https:');
  assert.equal(deepLink.hostname, 't.me');
  const start = deepLink.searchParams.get('start') || '';
  assert.match(start, /^pay_[A-Za-z0-9_-]{50}$/);
  assert.notEqual(start, `pay_${result.data.token}`,
    'Telegram and browser capabilities must be purpose-separated');
  return result.data;
}

function telegramToken(session) {
  const start = new URL(session.telegram_url).searchParams.get('start') || '';
  assert.match(start, /^pay_[A-Za-z0-9_-]{50}$/);
  return start.slice(4);
}

function assertClientRejected(result, message) {
  assert.ok(
    result.response.status >= 400 && result.response.status < 500,
    `${message}: expected a 4xx, got ${result.response.status} ${result.text}`
  );
  assert.equal(result.data?.ok, false, message);
}

function telegramStart(token, fromId, updateId, chat = null) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      from: { id: Number(fromId), is_bot: false, first_name: 'Buyer' },
      chat: chat || { id: Number(fromId), type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text: `/start pay_${token}`
    }
  };
}

async function telegramWebhook(env, update, secret = TELEGRAM_SECRET) {
  return postJson(env, '/telegram/webhook', update,
    secret == null ? {} : { 'X-Telegram-Bot-Api-Secret-Token': secret });
}

function tamperToken(token) {
  const index = Math.floor(token.length / 2);
  const replacement = token[index] === 'A' ? 'B' : 'A';
  return `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;
}

function sortedShpPairs(fields) {
  return Object.keys(fields)
    .filter((key) => /^Shp_/i.test(key))
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${fields[key]}`);
}

function expectedPaymentSignature(fields) {
  const parts = [fields.MerchantLogin, fields.OutSum, fields.InvId];
  for (const value of [
    fields.Receipt,
    fields.StepByStep,
    fields.SuccessUrl2 == null ? '' : encodeURIComponent(String(fields.SuccessUrl2)),
    fields.SuccessUrl2Method,
    fields.FailUrl2 == null ? '' : encodeURIComponent(String(fields.FailUrl2)),
    fields.FailUrl2Method,
    fields.Token
  ]) {
    if (value !== '' && value != null) parts.push(String(value));
  }
  parts.push(PASSWORD1, ...sortedShpPairs(fields));
  return createHash('sha256').update(parts.join(':'), 'utf8').digest('hex');
}

function resultSignature(fields) {
  const base = [fields.OutSum, fields.InvId, PASSWORD2, ...sortedShpPairs(fields)].join(':');
  return createHash('sha256').update(base, 'utf8').digest('hex');
}

async function signedResultCallback(env, paymentFields) {
  const fields = {
    OutSum: paymentFields.OutSum,
    InvId: paymentFields.InvId,
    EMail: 'Buyer@Example.com',
    UserIP: '203.0.113.55',
    ...Object.fromEntries(Object.entries(paymentFields).filter(([key]) => /^Shp_/i.test(key)))
  };
  fields.SignatureValue = resultSignature(fields);
  const waiting = context();
  const response = await worker.fetch(new Request(RESULT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  }), env, waiting.ctx);
  await waiting.settle();
  return response;
}

function assertStatusContainsNoSecrets(status, forbiddenValues = []) {
  const forbiddenKeys = new Set([
    'email', 'telegram_user_id', 'telegram_id', 'user_id', 'chat_id',
    'license_key', 'key', 'payment_fields', 'fields', 'signaturevalue',
    'merchantlogin', 'password', 'secret'
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key.toLowerCase()), false,
        `checkout status exposed sensitive field ${key}`);
      visit(child);
    }
  };
  visit(status);
  const serialized = JSON.stringify(status);
  for (const forbidden of forbiddenValues.filter(Boolean)) {
    assert.equal(serialized.includes(String(forbidden)), false,
      `checkout status exposed sensitive value ${forbidden}`);
  }
  assert.doesNotMatch(serialized, /SMESH-[A-Z0-9-]{8,}/,
    'checkout status must never return the bearer license key');
}

function count(sqlite, table) {
  return sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

let telegramCalls = [];
const realFetch = globalThis.fetch;
const realDateNow = Date.now;
let clock = Date.parse('2026-08-25T09:00:00.000Z');

globalThis.fetch = async (input, init = {}) => {
  const target = String(input?.url || input);
  if (!target.includes('api.telegram.org')) {
    throw new Error(`unexpected external request in checkout regression: ${target}`);
  }
  let body = null;
  if (init.body) {
    try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
  }
  telegramCalls.push({ target, method: target.split('/').pop(), body });
  return new Response(JSON.stringify({ ok: true, result: { message_id: telegramCalls.length } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
Date.now = () => clock;

try {
  // Catalog and promo price are server authority. Browser-supplied amounts are
  // accepted only as inert noise and can neither lower nor reshape a plan.
  {
    const { sqlite, env } = environment();
    for (const body of [
      {},
      { plan: 'lifetime' },
      { plan: 'month', promo_code: 'NOT-TEST654' },
      { plan: 'school', promo_code: 'TEST654' }
    ]) {
      assertClientRejected(await postJson(env, '/checkout/session', body),
        `invalid checkout ${JSON.stringify(body)}`);
    }

    const month = await createSession(env, {
      plan: 'month', amount: '0.01', amount_kopecks: 1, price_kopecks: 1, OutSum: '0.01'
    });
    assert.deepEqual(month.plan, {
      code: 'month', name: '30 дней', price_kopecks: 14_900,
      duration_days: 30, promo_applied: false
    });

    assertClientRejected(await postJson({
      ...env,
      // Knowledge of the separately shared VPS ingest key is deliberately
      // unchanged; only the Worker-only checkout key differs.
      CHECKOUT_CAPABILITY_SECRET: 'different-checkout-capability-secret-32-bytes'
    }, '/checkout/status', { token: month.token }),
    'INGEST_KEY alone must not validate a checkout capability');
    const missingCapabilityConfig = await postJson({
      ...env, CHECKOUT_CAPABILITY_SECRET: undefined
    }, '/checkout/session', { plan: 'month' });
    assert.equal(missingCapabilityConfig.response.status, 503);
    assert.equal(missingCapabilityConfig.data.reason, 'checkout_config');
    const sharedCapabilityConfig = await postJson({
      ...env, CHECKOUT_CAPABILITY_SECRET: env.INGEST_KEY
    }, '/checkout/session', { plan: 'month' });
    assert.equal(sharedCapabilityConfig.response.status, 503,
      'configuration must reject reuse of the VPS-shared ingest key');

    const school = await createSession(env, {
      plan: 'school', amount: '0.01', price_kopecks: 1
    });
    assert.deepEqual(school.plan, {
      code: 'school', name: 'Учебный период', price_kopecks: 99_900,
      duration_days: 273, promo_applied: false
    });

    const promo = await createSession(env, {
      plan: 'month', promo_code: 'TEST654', amount: '999999.99', price_kopecks: 1
    });
    assert.deepEqual(promo.plan, {
      code: 'month', name: '30 дней', price_kopecks: 1_000,
      duration_days: 30, promo_applied: true
    });

    const sharedIp = '198.51.100.77';
    const day = new Date(clock + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    sqlite.prepare(
      `INSERT INTO telemetry_budget(day, scope, budget_key, count)
       VALUES (?, 'payment_order_bad', ?, 200)`
    ).run(day, sharedIp);
    const exhaustedBad = await postJson(env, '/checkout/session', { plan: 'invalid' }, {
      'cf-connecting-ip': sharedIp
    });
    assert.equal(exhaustedBad.response.status, 429,
      'malformed traffic stays bounded after its own budget is exhausted');
    const validAfterBadBudget = await postJson(env, '/checkout/session', { plan: 'month' }, {
      'cf-connecting-ip': sharedIp
    });
    assert.equal(validAfterBadBudget.response.status, 200,
      'an exhausted malformed budget cannot deny a valid buyer behind the same NAT');

    const schoolIp = '198.51.100.78';
    sqlite.prepare(
      `INSERT INTO telemetry_budget(day, scope, budget_key, count)
       VALUES (?, 'payment_order', ?, 20)`
    ).run(day, schoolIp);
    const validAfterOldCeiling = await postJson(env, '/checkout/session', { plan: 'month' }, {
      'cf-connecting-ip': schoolIp
    });
    assert.equal(validAfterOldCeiling.response.status, 200,
      'twenty drafts must not lock a school or office NAT for the day');

    const retiredLegacy = await postJson(env, '/payments/robokassa/order', {
      plan: 'subscription', email: 'legacy@example.com'
    });
    assert.equal(retiredLegacy.response.status, 410,
      'the unsafe legacy route must stay disabled when its flag is unset');

    const tampered = tamperToken(month.token);
    assertClientRejected(await postJson(env, '/checkout/status', { token: tampered }),
      'a tampered status capability');
    assertClientRejected(await postJson(env, '/checkout/payment', {
      token: tampered, email: 'buyer@example.com', accepted_terms: true
    }), 'a tampered payment capability');
    assert.equal(count(sqlite, 'payment_issuance'), 0);
    sqlite.close();
  }

  // The only Telegram identity authority is an authenticated, private bot
  // update. Request JSON, missing webhook auth, groups, and later accounts all
  // fail to choose or replace the delivery recipient.
  {
    const { sqlite, env } = environment();
    telegramCalls = [];
    const session = await createSession(env, {
      plan: 'month',
      promo_code: 'TEST654',
      telegram_user_id: CLIENT_SUPPLIED_TELEGRAM_ID,
      amount_kopecks: 1,
      OutSum: '0.01'
    });
    assert.equal(sqlite.prepare(
      'SELECT telegram_user_id FROM payment_orders WHERE order_id = ?'
    ).get(session.order_id).telegram_user_id, null,
    'the browser must not bind a Telegram id while creating the session');

    assertClientRejected(await postJson(env, '/checkout/status', {
      token: telegramToken(session)
    }), 'the Telegram capability must not authorize browser status');
    const wrongPurposeStart = await telegramWebhook(
      env, telegramStart(session.token, CLIENT_SUPPLIED_TELEGRAM_ID, 1000)
    );
    assert.equal(wrongPurposeStart.response.status, 200, wrongPurposeStart.text);
    assert.equal(sqlite.prepare(
      'SELECT telegram_user_id FROM payment_orders WHERE order_id = ?'
    ).get(session.order_id).telegram_user_id, null,
    'the browser capability must not authorize Telegram binding');

    assertClientRejected(await postJson(env, '/checkout/payment', {
      token: session.token,
      email: 'buyer@example.com',
      accepted_terms: true,
      telegram_user_id: CLIENT_SUPPLIED_TELEGRAM_ID
    }), 'payment before Telegram binding');

    const unauthenticated = await telegramWebhook(
      env, telegramStart(telegramToken(session), CLIENT_SUPPLIED_TELEGRAM_ID, 1001), null
    );
    assert.equal(unauthenticated.response.status, 401);

    const group = await telegramWebhook(env, telegramStart(
      telegramToken(session),
      CLIENT_SUPPLIED_TELEGRAM_ID,
      1002,
      { id: -100123456, type: 'group', title: 'Untrusted group' }
    ));
    assert.equal(group.response.status, 200, group.text);
    assertClientRejected(await postJson(env, '/checkout/payment', {
      token: session.token, email: 'buyer@example.com', accepted_terms: true
    }), 'a group /start must not bind checkout ownership');

    const connected = await telegramWebhook(
      env, telegramStart(telegramToken(session), TRUSTED_TELEGRAM_ID, 1003)
    );
    assert.equal(connected.response.status, 200, connected.text);
    const debugSnapshot = await env.LICENSES.get('tgdebug:last');
    assert.ok(debugSnapshot, 'authenticated updates keep a short-lived redacted diagnostic');
    assert.equal(debugSnapshot.includes(telegramToken(session)), false,
      'Telegram debug persistence must not retain the checkout bearer capability');
    assert.match(debugSnapshot, /pay_\[REDACTED\]/);
    assert.equal(sqlite.prepare(
      'SELECT telegram_user_id FROM payment_orders WHERE order_id = ?'
    ).get(session.order_id).telegram_user_id, TRUSTED_TELEGRAM_ID,
    'the authenticated private update must bind its trusted from.id');

    const rebound = await telegramWebhook(
      env, telegramStart(telegramToken(session), OTHER_TELEGRAM_ID, 1004)
    );
    assert.equal(rebound.response.status, 200, rebound.text);
    assert.equal(sqlite.prepare(
      'SELECT telegram_user_id FROM payment_orders WHERE order_id = ?'
    ).get(session.order_id).telegram_user_id, TRUSTED_TELEGRAM_ID,
    'a second Telegram account must not steal an already-bound capability');

    const boundStatus = await postJson(env, '/checkout/status', { token: session.token });
    assert.equal(boundStatus.response.status, 200, boundStatus.text);
    assert.equal(boundStatus.data.state, 'telegram_bound');
    assert.deepEqual(boundStatus.data.plan, session.plan);
    assertStatusContainsNoSecrets(boundStatus.data, [
      'buyer@example.com', TRUSTED_TELEGRAM_ID, OTHER_TELEGRAM_ID,
      CLIENT_SUPPLIED_TELEGRAM_ID, PASSWORD1, PASSWORD2, TELEGRAM_SECRET
    ]);

    for (const body of [
      { token: session.token, email: '', accepted_terms: true },
      { token: session.token, email: 'not-an-email', accepted_terms: true },
      { token: session.token, email: 'buyer@example.com' },
      { token: session.token, email: 'buyer@example.com', accepted_terms: false },
      { token: session.token, email: 'buyer@example.com', accepted_terms: 'true' }
    ]) {
      assertClientRejected(await postJson(env, '/checkout/payment', body),
        `payment prerequisites ${JSON.stringify(body)}`);
    }

    const paymentResult = await postJson(env, '/checkout/payment', {
      token: session.token,
      email: 'Buyer@Example.com',
      accepted_terms: true,
      telegram_user_id: CLIENT_SUPPLIED_TELEGRAM_ID,
      plan: 'school',
      promo_code: 'NOPE',
      amount: '0.01',
      amount_kopecks: 1,
      price_kopecks: 1,
      OutSum: '0.01'
    });
    assert.equal(paymentResult.response.status, 200, paymentResult.text);
    assert.equal(paymentResult.data.ok, true);
    assert.equal(paymentResult.data.payment_url,
      'https://auth.robokassa.ru/Merchant/Index.aspx');
    const fields = paymentResult.data.fields;
    assert.equal(fields.MerchantLogin, 'smesh-checkout');
    assert.equal(fields.OutSum, '10.00', 'the promo price, not a browser amount, is signed');
    assert.match(fields.InvId, /^[1-9]\d*$/);
    assert.equal(fields.InvId, String(session.order_id));
    assert.equal(fields.Email, 'buyer@example.com');
    assert.equal(fields.ResultUrl2, undefined,
      'the classic checkout must use the cabinet ResultURL, not the JWS ResultUrl2 flow');
    assert.equal(fields.SuccessUrl2, SUCCESS_URL2);
    assert.equal(fields.SuccessUrl2Method, 'GET');
    assert.equal(fields.FailUrl2, FAIL_URL2);
    assert.equal(fields.FailUrl2Method, 'GET');
    assert.match(fields.Receipt || '', /^%7B/);
    const serializedForm = new URLSearchParams(fields).toString();
    assert.ok(serializedForm.includes(
      `SuccessUrl2=${encodeURIComponent(SUCCESS_URL2)}`
    ), 'ordinary form serialization must encode the raw SuccessUrl2 exactly once');
    assert.ok(serializedForm.includes(
      `FailUrl2=${encodeURIComponent(FAIL_URL2)}`
    ), 'ordinary form serialization must encode the raw FailUrl2 exactly once');
    assert.ok(serializedForm.includes(
      `Receipt=${encodeURIComponent(fields.Receipt)}`
    ), 'the already provider-encoded Receipt receives the separate form-transport encoding');
    assert.equal(serializedForm.includes('ResultUrl2='), false);
    assert.equal(fields.Shp_environment, 'production');
    assert.equal(fields.Shp_order_id, fields.InvId);
    assert.equal(fields.SignatureValue, expectedPaymentSignature(fields),
      'the encoded browser return URLs and frozen receipt/order fields must be covered by Password #1');
    assert.match(fields.SignatureValue, /^[0-9a-f]{64}$/);
    for (const name of ['SuccessUrl2', 'FailUrl2']) {
      assert.notEqual(
        expectedPaymentSignature({ ...fields, [name]: `${fields[name]}tampered` }),
        fields.SignatureValue,
        `${name} must be integrity-bound by SignatureValue`
      );
    }
    assert.equal(JSON.stringify(fields).includes(CLIENT_SUPPLIED_TELEGRAM_ID), false,
      'a browser Telegram id must not leak into provider parameters');

    let frozen = sqlite.prepare(
      `SELECT status, amount_kopecks, subscription_days, email, telegram_user_id
       FROM payment_orders WHERE order_id = ?`
    ).get(fields.InvId);
    assert.deepEqual({ ...frozen }, {
      status: 'pending',
      amount_kopecks: 1_000,
      subscription_days: 30,
      email: 'buyer@example.com',
      telegram_user_id: TRUSTED_TELEGRAM_ID
    });

    // Once provider fields have been handed to the browser they are immutable.
    // A retry may return the exact same form or reject, but it cannot silently
    // change email, Telegram recipient, plan, amount, URLs, or signature.
    const mutation = await postJson(env, '/checkout/payment', {
      token: session.token,
      email: 'attacker@example.com',
      accepted_terms: true,
      telegram_user_id: OTHER_TELEGRAM_ID,
      plan: 'school',
      amount_kopecks: 99_900
    });
    if (mutation.response.ok) {
      assert.deepEqual(mutation.data.fields, fields,
        'an idempotent payment retry must return the original frozen form');
    } else {
      assertClientRejected(mutation, 'mutating a started payment');
    }
    frozen = sqlite.prepare(
      `SELECT amount_kopecks, subscription_days, email, telegram_user_id
       FROM payment_orders WHERE order_id = ?`
    ).get(fields.InvId);
    assert.deepEqual({ ...frozen }, {
      amount_kopecks: 1_000,
      subscription_days: 30,
      email: 'buyer@example.com',
      telegram_user_id: TRUSTED_TELEGRAM_ID
    }, 'provider-facing payment authority must stay frozen after first creation');
    assert.equal(sqlite.prepare(
      `SELECT COUNT(*) AS n FROM payment_events
       WHERE payment_id = ? AND event_type = 'checkout_payment_started'`
    ).get(fields.InvId).n, 1);

    const readyStatus = await postJson(env, '/checkout/status', {
      token: session.token,
      paid: true,
      email: 'attacker@example.com',
      telegram_user_id: OTHER_TELEGRAM_ID,
      license_key: 'SMESH-FAKE-CLIENT-PROOF',
      InvId: fields.InvId,
      OutSum: fields.OutSum,
      SignatureValue: fields.SignatureValue
    });
    assert.equal(readyStatus.response.status, 200, readyStatus.text);
    assert.equal(readyStatus.data.state, 'payment_ready');
    assertStatusContainsNoSecrets(readyStatus.data, [
      'buyer@example.com', 'attacker@example.com', TRUSTED_TELEGRAM_ID,
      OTHER_TELEGRAM_ID, CLIENT_SUPPLIED_TELEGRAM_ID, fields.SignatureValue,
      PASSWORD1, PASSWORD2, TELEGRAM_SECRET
    ]);

    // Simulate the browser reaching SuccessUrl2. A redirect and arbitrary
    // status-poll JSON are browser claims, never settlement authority.
    const redirect = new URL(fields.SuccessUrl2);
    redirect.searchParams.set('InvId', fields.InvId);
    redirect.searchParams.set('OutSum', fields.OutSum);
    redirect.searchParams.set('SignatureValue', fields.SignatureValue);
    const redirectWaiting = context();
    await worker.fetch(new Request(redirect, { method: 'GET' }), env, redirectWaiting.ctx);
    await redirectWaiting.settle();
    assert.equal(count(sqlite, 'payment_issuance'), 0,
      'SuccessUrl2 cannot mint a license');
    assert.equal(count(sqlite, 'purchases'), 0,
      'status/redirect alone cannot grant entitlement');
    assert.equal(count(sqlite, 'delivery_outbox'), 0,
      'status/redirect alone cannot enqueue delivery');
    assert.equal(telegramCalls.some((call) => /SMESH-[A-Z0-9-]+/.test(call.body?.text || '')), false,
      'no license may be delivered before a valid ResultURL notification');

    const callback = await signedResultCallback(env, fields);
    assert.equal(callback.status, 200, await callback.clone().text());
    assert.equal(await callback.text(), `OK${fields.InvId}`);

    const replay = await signedResultCallback(env, fields);
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(await replay.text(), `OK${fields.InvId}`);
    assert.equal(count(sqlite, 'payment_issuance'), 1,
      'ResultURL replay must not mint a second entitlement');
    assert.equal(count(sqlite, 'purchases'), 1);
    assert.equal(count(sqlite, 'delivery_outbox'), 1);

    const eventDetails = sqlite.prepare(
      'SELECT details_json FROM payment_events WHERE payment_id = ?'
    ).all(fields.InvId).map((row) => row.details_json || '').join('\n');
    assert.equal(eventDetails.toLowerCase().includes('buyer@example.com'), false,
      'provider ResultURL email must not be copied into append-only payment events');
    const guessableEmailDigest = createHash('sha256')
      .update('smesh-checkout-email:buyer@example.com', 'utf8').digest('hex');
    assert.equal(eventDetails.includes(guessableEmailDigest), false,
      'append-only consent evidence must not retain an offline-guessable email digest');
    assert.equal(eventDetails.includes('203.0.113.55'), false,
      'provider network identifiers must not be copied into append-only payment events');

    const purchase = sqlite.prepare(
      `SELECT license_key, status, type, amount_kopecks, email,
              telegram_user_id, issued_at, expires_at
       FROM purchases WHERE payment_id = ?`
    ).get(fields.InvId);
    assert.match(purchase.license_key, /^SMESH-[A-Z0-9-]+$/);
    assert.equal(purchase.status, 'active');
    assert.equal(purchase.type, 'subscription');
    assert.equal(purchase.amount_kopecks, 1_000);
    assert.equal(purchase.email, 'buyer@example.com');
    assert.equal(purchase.telegram_user_id, TRUSTED_TELEGRAM_ID);
    assert.equal(purchase.expires_at, clock + 30 * DAY_MS,
      'the fulfilled monthly plan must grant exactly 30 server-clock days');

    const licenseDeliveries = telegramCalls.filter((call) =>
      String(call.body?.text || '').includes(purchase.license_key));
    assert.equal(licenseDeliveries.length, 1,
      'a valid callback and its replay must deliver the key exactly once');
    assert.equal(String(licenseDeliveries[0].body.text).includes('buyer@example.com'), false,
      'Telegram delivery must not disclose the separate receipt email address');
    assert.equal(String(licenseDeliveries[0].body.chat_id), TRUSTED_TELEGRAM_ID,
      'delivery must use the first authenticated private from.id exactly');
    assert.notEqual(String(licenseDeliveries[0].body.chat_id), OTHER_TELEGRAM_ID);
    assert.ok(sqlite.prepare(
      'SELECT delivered_at FROM delivery_outbox WHERE license_key = ?'
    ).get(purchase.license_key).delivered_at);

    const deliveredStatus = await postJson(env, '/checkout/status', { token: session.token });
    assert.equal(deliveredStatus.response.status, 200, deliveredStatus.text);
    assert.equal(deliveredStatus.data.state, 'delivered');
    assert.deepEqual(deliveredStatus.data.plan, session.plan);
    assertStatusContainsNoSecrets(deliveredStatus.data, [
      purchase.license_key, purchase.email, purchase.telegram_user_id,
      PASSWORD1, PASSWORD2, TELEGRAM_SECRET, fields.SignatureValue
    ]);
    sqlite.close();
  }

  // Expiration remains effective even after Telegram ownership was bound.
  // The status capability may say "expired", but it can no longer create a
  // provider form or grant anything.
  {
    const { sqlite, env } = environment();
    telegramCalls = [];
    const session = await createSession(env, { plan: 'school' });
    const connected = await telegramWebhook(
      env, telegramStart(telegramToken(session), TRUSTED_TELEGRAM_ID, 2001)
    );
    assert.equal(connected.response.status, 200, connected.text);
    clock = Date.parse(session.expires_at) + 1_000;

    const expiredStatus = await postJson(env, '/checkout/status', { token: session.token });
    if (expiredStatus.response.ok) {
      assert.equal(expiredStatus.data.state, 'expired');
      assertStatusContainsNoSecrets(expiredStatus.data, [TRUSTED_TELEGRAM_ID]);
    } else {
      assert.ok([403, 410].includes(expiredStatus.response.status), expiredStatus.text);
    }
    assertClientRejected(await postJson(env, '/checkout/payment', {
      token: session.token, email: 'buyer@example.com', accepted_terms: true
    }), 'an expired checkout capability');
    assert.equal(count(sqlite, 'payment_issuance'), 0);
    assert.equal(count(sqlite, 'purchases'), 0);
    assert.equal(count(sqlite, 'delivery_outbox'), 0);
    sqlite.close();
  }
} finally {
  Date.now = realDateNow;
  globalThis.fetch = realFetch;
}

console.log('checkout Telegram payment regression passed');
