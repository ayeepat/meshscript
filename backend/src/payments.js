import * as robokassa from './gateways/robokassa.js';

const ORDER_TTL_MS = 30 * 60 * 1000;
const ORDER_CREATE_DAILY_LIMIT = 20;
const RECEIPT_TAXES = new Set([
  'none', 'vat0', 'vat5', 'vat7', 'vat10', 'vat20', 'vat22',
  'vat105', 'vat107', 'vat110', 'vat120', 'vat122'
]);
const RECEIPT_METHODS = new Set([
  'full_prepayment', 'prepayment', 'advance', 'full_payment',
  'partial_payment', 'credit', 'credit_payment'
]);
const RECEIPT_OBJECTS = new Set([
  'commodity', 'excise', 'job', 'service', 'gambling_bet',
  'gambling_prize', 'lottery', 'lottery_prize', 'intellectual_activity',
  'payment', 'agent_commission', 'composite', 'resort_fee', 'another',
  'property_right', 'non-operating_gain', 'insurance_premium',
  'sales_tax', 'tovar_mark'
]);
const RECEIPT_SNO = new Set([
  'osn', 'usn_income', 'usn_income_outcome', 'esn', 'patent'
]);

export function paymentEnvironment(env) {
  const value = String(env.PAYMENT_ENVIRONMENT || '').trim().toLowerCase();
  return value === 'production' || value === 'test' ? value : '';
}

export function robokassaCredential(env, slot) {
  const environment = paymentEnvironment(env);
  if (!environment || ![1, 2, 3].includes(slot)) return '';
  const suffix = environment === 'production' ? 'PRODUCTION' : 'TEST';
  return String(env[`ROBOKASSA_PASSWORD${slot}_${suffix}`] || '');
}

export function rublesToKopecks(raw) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(raw ?? ''));
  if (!match) return null;
  const kopecks = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(kopecks) && kopecks > 0 ? kopecks : null;
}

function fiscalizationMode(env) {
  const mode = String(env.ROBOKASSA_FISCALIZATION_MODE || '').trim().toLowerCase();
  return mode === 'provider' || mode === 'external' ? mode : '';
}

function receiptSettings(env) {
  if (fiscalizationMode(env) !== 'provider') return null;
  const tax = String(env.ROBOKASSA_RECEIPT_TAX || '').trim().toLowerCase();
  const paymentMethod = String(env.ROBOKASSA_RECEIPT_PAYMENT_METHOD || '').trim().toLowerCase();
  const paymentObject = String(env.ROBOKASSA_RECEIPT_PAYMENT_OBJECT || '').trim().toLowerCase();
  const sno = String(env.ROBOKASSA_RECEIPT_SNO || '').trim().toLowerCase();
  if (!RECEIPT_TAXES.has(tax) || !RECEIPT_METHODS.has(paymentMethod) ||
      !RECEIPT_OBJECTS.has(paymentObject) || (sno && !RECEIPT_SNO.has(sno))) {
    return null;
  }
  return { tax, payment_method: paymentMethod, payment_object: paymentObject, sno };
}

function buildReceiptJson(env, plan, amountKopecks) {
  const settings = receiptSettings(env);
  if (!settings) return null;
  const receipt = {
    ...(settings.sno ? { sno: settings.sno } : {}),
    items: [{
      name: plan === 'subscription' ? 'СМЭШ AI — подписка' : 'СМЭШ AI — бессрочная лицензия',
      quantity: 1,
      sum: Number(robokassa.formatKopecks(amountKopecks)),
      payment_method: settings.payment_method,
      payment_object: settings.payment_object,
      tax: settings.tax
    }]
  };
  return JSON.stringify(receipt);
}

// The refund JWT is signed with the HMAC family only. Readiness has to check
// the same allowlist createRefund enforces: an unsupported value used to pass
// readiness, then throw locally AFTER the order had been reserved into
// 'refund_pending/creating', leaving it stuck as submission_unknown with every
// retry rejected — all without a single byte reaching the provider.
export function refundHashAlgorithm(env) {
  const raw = String(env.ROBOKASSA_REFUND_HASH_ALGO || 'HS256').trim().toUpperCase();
  return robokassa.isSupportedRefundHashAlgorithm(raw) ? raw : '';
}

export function paymentRefundConfigValid(env) {
  if (paymentEnvironment(env) !== 'production') return true;
  if (!robokassaCredential(env, 3)) return false;
  if (!refundHashAlgorithm(env)) return false;
  return fiscalizationMode(env) === 'provider' || (
    fiscalizationMode(env) === 'external' &&
    String(env.ROBOKASSA_REFUND_ALLOW_MONEY_ONLY || '').toLowerCase() === 'true'
  );
}

function planPriceKopecks(env, plan) {
  const current = plan === 'subscription'
    ? env.SUBSCRIPTION_PRICE_RUB
    : env.LIFETIME_PRICE_RUB;
  // Transitional fallback: the former minimum was the only server-owned
  // catalog price. New deployments should use the explicit *_PRICE_RUB names.
  const legacy = plan === 'subscription'
    ? env.SUBSCRIPTION_MIN_RUB
    : env.LIFETIME_MIN_RUB;
  return rublesToKopecks(current == null || current === '' ? legacy : current);
}

function subscriptionDays(env) {
  const raw = String(env.SUBSCRIPTION_DAYS ?? '30');
  if (!/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days >= 1 && days <= 3650 ? days : null;
}

export function paymentConfigValid(env) {
  const environment = paymentEnvironment(env);
  if (!environment || !env.DB || !String(env.ROBOKASSA_MERCHANT_LOGIN || '').trim()) return false;
  if (!robokassaCredential(env, 1) || !robokassaCredential(env, 2)) return false;
  if (!robokassa.isSupportedHashAlgorithm(env.ROBOKASSA_HASH_ALGO)) return false;
  const subscription = planPriceKopecks(env, 'subscription');
  const lifetime = planPriceKopecks(env, 'lifetime');
  if (subscription && !subscriptionDays(env)) return false;
  const fiscalMode = fiscalizationMode(env);
  if (!fiscalMode || (fiscalMode === 'provider' && !receiptSettings(env))) return false;
  return !!(lifetime || subscription);
}

function cleanEmail(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw.length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : null;
}

function cleanTelegramUserId(value) {
  const text = value == null ? '' : String(value).trim();
  return /^\d{1,20}$/.test(text) && BigInt(text) > 0n ? text : null;
}

function cleanReferralCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^REF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : null;
}

function cleanDeviceId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

function moscowDay(now = Date.now()) {
  return new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function reserveOrderCreation(env, ip) {
  const key = String(ip || 'unknown').slice(0, 128);
  const row = await env.DB.prepare(
    `INSERT INTO telemetry_budget(day, scope, budget_key, count)
     VALUES (?1, 'payment_order', ?2, 1)
     ON CONFLICT(day, scope, budget_key) DO UPDATE SET count = count + 1
     WHERE count < ?3
     RETURNING count`
  ).bind(moscowDay(), key, ORDER_CREATE_DAILY_LIMIT).first();
  return !!row;
}

// Malformed requests still need a bound — they are the cheap-to-generate half
// of the abuse surface — but on their OWN, much larger budget, so exhausting
// it cannot deny checkout to a legitimate buyer sharing the address.
const ORDER_MALFORMED_DAILY_LIMIT = 200;

async function chargeMalformedOrderAttempt(env, ip) {
  const key = String(ip || 'unknown').slice(0, 128);
  try {
    await env.DB.prepare(
      `INSERT INTO telemetry_budget(day, scope, budget_key, count)
       VALUES (?1, 'payment_order_bad', ?2, 1)
       ON CONFLICT(day, scope, budget_key) DO UPDATE SET count = count + 1
       WHERE count < ?3`
    ).bind(moscowDay(), key, ORDER_MALFORMED_DAILY_LIMIT).run();
  } catch (e) {
    // Never turn a rejected malformed request into a 500.
    console.error('malformed order budget write failed', String(e));
  }
}

export async function recordMalformedOrderAttempt(env, ip) {
  return chargeMalformedOrderAttempt(env, ip);
}

export async function malformedOrderBudgetExhausted(env, ip) {
  const key = String(ip || 'unknown').slice(0, 128);
  try {
    const row = await env.DB.prepare(
      `SELECT count FROM telemetry_budget
       WHERE day = ?1 AND scope = 'payment_order_bad' AND budget_key = ?2`
    ).bind(moscowDay(), key).first();
    return (Number(row?.count) || 0) >= ORDER_MALFORMED_DAILY_LIMIT;
  } catch {
    return false;
  }
}

export async function createRobokassaOrder(env, body, ip = '') {
  if (!paymentConfigValid(env)) return { ok: false, status: 503, reason: 'payment_config' };

  // Cheap validation BEFORE reserving order capacity. Reserving first meant 20
  // malformed 400s burned the whole day's budget for that address, and the
  // next CORRECT request got a 429 — a trivial way to deny checkout to a user
  // or to everyone behind a shared NAT for the entire Moscow day.
  const plan = String(body?.plan || '').trim().toLowerCase();
  if (plan !== 'subscription' && plan !== 'lifetime') {
    await chargeMalformedOrderAttempt(env, ip);
    return { ok: false, status: 400, reason: 'bad_plan' };
  }
  const amountKopecks = planPriceKopecks(env, plan);
  if (!amountKopecks) return { ok: false, status: 503, reason: 'plan_unavailable' };
  const days = plan === 'subscription' ? subscriptionDays(env) : null;
  if (plan === 'subscription' && !days) {
    return { ok: false, status: 503, reason: 'plan_unavailable' };
  }
  const email = cleanEmail(body?.email);
  const telegramUserId = cleanTelegramUserId(body?.telegram_user_id);
  if (!email && !telegramUserId) {
    await chargeMalformedOrderAttempt(env, ip);
    return { ok: false, status: 400, reason: 'missing_contact' };
  }

  const environment = paymentEnvironment(env);
  const fiscalMode = fiscalizationMode(env);
  const receiptJson = fiscalMode === 'provider'
    ? buildReceiptJson(env, plan, amountKopecks)
    : null;
  if (fiscalMode === 'provider' && !receiptJson) {
    return { ok: false, status: 503, reason: 'receipt_config' };
  }

  // The request is well-formed and about to create a real order — only now
  // does it consume valid-order capacity.
  if (!(await reserveOrderCreation(env, ip))) {
    return { ok: false, status: 429, reason: 'rate_limited' };
  }
  const now = Date.now();
  // ExpirationDate has minute precision. Give Robokassa a whole provider
  // minute, then keep our authoritative order valid until that minute ends.
  // This prevents both late-paid dead letters and local expiry preceding the
  // gateway's interpretation of the same minute.
  const gatewayExpiresAt = Math.floor((now + ORDER_TTL_MS) / 60_000) * 60_000;
  const expiresAt = gatewayExpiresAt + 60_000;
  const row = await env.DB.prepare(
    `INSERT INTO payment_orders
       (gateway, environment, status, amount_kopecks, currency, plan_type,
        subscription_days, email, telegram_user_id, referral_code, device_id,
        is_preorder, fiscalization_mode, receipt_json, created_at, expires_at)
     VALUES ('robokassa', ?1, 'pending', ?2, 'RUB', ?3, ?4, ?5, ?6, ?7, ?8,
             ?9, ?10, ?11, ?12, ?13)
     RETURNING order_id`
  ).bind(
    environment, amountKopecks, plan, days, email, telegramUserId,
    cleanReferralCode(body?.referral_code), cleanDeviceId(body?.device_id),
    body?.is_preorder ? 1 : 0, fiscalMode, receiptJson, now, expiresAt
  ).first();
  const orderId = Number(row?.order_id);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('payment order creation failed');

  const fields = await robokassa.createPaymentFields({
    merchantLogin: String(env.ROBOKASSA_MERCHANT_LOGIN),
    password1: robokassaCredential(env, 1),
    algorithm: env.ROBOKASSA_HASH_ALGO,
    amountKopecks,
    invId: String(orderId),
    description: plan === 'lifetime' ? 'СМЭШ AI — бессрочная лицензия' : 'СМЭШ AI — подписка',
    email,
    isTest: environment === 'test',
    receipt: receiptJson || '',
    expiresAt: gatewayExpiresAt,
    shp: { Shp_environment: environment, Shp_order_id: String(orderId) }
  });
  await env.DB.prepare(
    `INSERT INTO payment_events
       (gateway, payment_id, order_id, environment, event_type, amount_kopecks,
        currency, details_json, created_at)
     VALUES ('robokassa', ?1, ?1, ?2, 'order_created', ?3, 'RUB', NULL, ?4)`
  ).bind(String(orderId), environment, amountKopecks, now).run();
  return {
    ok: true,
    order_id: String(orderId),
    environment,
    amount_kopecks: amountKopecks,
    currency: 'RUB',
    expires_at: new Date(expiresAt).toISOString(),
    payment_url: 'https://auth.robokassa.ru/Merchant/Index.aspx',
    fields
  };
}

export async function loadRobokassaOrder(env, paymentId) {
  if (!env.DB || !/^\d+$/.test(String(paymentId || ''))) return null;
  return env.DB.prepare(
    `SELECT order_id, gateway, environment, status, amount_kopecks, currency,
            plan_type, subscription_days, email, telegram_user_id,
            referral_code, device_id, is_preorder, fiscalization_mode,
            receipt_json, created_at, expires_at,
            paid_at, fulfilled_at, provider_op_key, reconciled_at,
            refund_request_id, refund_status, refund_kopecks, refunded_at
     FROM payment_orders WHERE gateway = 'robokassa' AND order_id = ?1`
  ).bind(String(paymentId)).first();
}

export function validateRobokassaCallbackOrder(env, order, normalized, fields) {
  if (!order) return { ok: false, reason: 'unknown_order' };
  const environment = paymentEnvironment(env);
  if (!environment || order.environment !== environment || fields.Shp_environment !== environment) {
    return { ok: false, reason: 'environment_mismatch', retry: true };
  }
  if (String(fields.Shp_order_id || '') !== String(order.order_id) ||
      String(order.order_id) !== String(normalized.payment_id)) {
    return { ok: false, reason: 'order_binding_mismatch', retry: true };
  }
  if (order.currency !== 'RUB' || Number(order.amount_kopecks) !== normalized.amount_kopecks) {
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (Number(order.expires_at) <= Date.now() && order.status === 'pending') {
    return { ok: false, reason: 'paid_after_expiry' };
  }
  if (order.status === 'refunded' || order.status === 'refund_pending') {
    return { ok: false, reason: 'order_refunded' };
  }
  if (!['pending', 'paid', 'fulfilled'].includes(order.status)) {
    return { ok: false, reason: 'invalid_order_state' };
  }
  return { ok: true };
}

export async function markOrderPaid(env, order, normalized, fields) {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE payment_orders
     SET status = CASE WHEN status IN ('pending', 'expired') THEN 'paid' ELSE status END,
         paid_at = COALESCE(paid_at, ?2)
     WHERE order_id = ?1 AND gateway = 'robokassa'
       AND environment = ?3 AND amount_kopecks = ?4 AND currency = 'RUB'
       AND status IN ('pending', 'expired', 'paid', 'fulfilled')`
  ).bind(String(order.order_id), now, order.environment, normalized.amount_kopecks).run();
  if ((result?.meta?.changes || 0) < 1) throw new Error('payment order state changed');
  await appendPaymentEvent(env, order, 'payment_confirmed', normalized.amount_kopecks, fields, now);
}

export async function markOrderFulfilled(env, order, licenseKey) {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE payment_orders SET status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, ?2)
     WHERE order_id = ?1 AND gateway = 'robokassa' AND status IN ('paid', 'fulfilled')`
  ).bind(String(order.order_id), now).run();
  if ((result?.meta?.changes || 0) < 1) throw new Error('payment fulfillment state changed');
  await appendPaymentEvent(env, order, 'license_fulfilled', Number(order.amount_kopecks), {
    license_ref: await shortHash(licenseKey)
  }, now);
}

export async function reconcileRobokassaOrder(env, orderId, fetcher = fetch) {
  const order = await loadRobokassaOrder(env, orderId);
  if (!order) return { ok: false, status: 404, reason: 'order_not_found' };
  if (order.environment !== 'production') {
    return { ok: false, status: 409, reason: 'test_reconciliation_unavailable' };
  }
  const merchantLogin = String(env.ROBOKASSA_MERCHANT_LOGIN || '').trim();
  const password2 = robokassaCredential(env, 2);
  if (!merchantLogin || !password2) {
    return { ok: false, status: 503, reason: 'payment_config' };
  }
  const state = await robokassa.queryOperationState({
    merchantLogin, invoiceId: String(order.order_id), password2,
    algorithm: env.ROBOKASSA_HASH_ALGO, fetcher
  });
  const now = Date.now();
  if (state.result_code !== 0) {
    await appendPaymentEvent(env, order, 'reconciliation_provider_error', null, {
      result_code: state.result_code
    }, now);
    return { ok: false, status: 409, reason: 'provider_result', provider: state };
  }
  if (state.state_code !== 100) {
    await env.DB.prepare(
      'UPDATE payment_orders SET reconciled_at = ?2 WHERE order_id = ?1'
    ).bind(String(order.order_id), now).run();
    await appendPaymentEvent(env, order, 'reconciliation_observed', null, {
      state_code: state.state_code
    }, now);
    return { ok: true, paid: false, order, provider: state };
  }
  const providerKopecks = rublesToKopecks(state.out_sum);
  const expectedCurrency = String(env.ROBOKASSA_OUT_CURRENCY_LABEL || 'RUB').trim().toUpperCase();
  if (providerKopecks !== Number(order.amount_kopecks) ||
      String(state.out_currency || '').trim().toUpperCase() !== expectedCurrency || !state.op_key) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE payment_orders SET status = 'review', reconciled_at = ?2
         WHERE order_id = ?1 AND status NOT IN ('refunded', 'refund_pending')`
      ).bind(String(order.order_id), now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO payment_review
           (gateway, payment_id, invoice_id, amount_rub, reason, fields_json,
            created_at, environment, amount_kopecks)
         VALUES ('robokassa', ?1, ?1, ?2, 'reconciliation_mismatch', ?3, ?4,
                 ?5, ?6)`
      ).bind(
        String(order.order_id), providerKopecks == null ? null : providerKopecks / 100,
        JSON.stringify({
          result_code: state.result_code, state_code: state.state_code,
          out_currency: state.out_currency, out_sum: state.out_sum,
          op_key_present: !!state.op_key
        }), now, order.environment, providerKopecks
      )
    ]);
    await appendPaymentEvent(env, order, 'reconciliation_mismatch', providerKopecks, {
      state_code: state.state_code, out_currency: state.out_currency
    }, now);
    return { ok: false, status: 409, reason: 'reconciliation_mismatch', provider: state };
  }
  const update = await env.DB.prepare(
    `UPDATE payment_orders
     SET status = CASE WHEN status IN ('pending', 'expired') THEN 'paid' ELSE status END,
         paid_at = COALESCE(paid_at, ?2), provider_op_key = ?3, reconciled_at = ?2
     WHERE order_id = ?1 AND environment = 'production'
       AND amount_kopecks = ?4 AND currency = 'RUB'
       AND status IN ('pending', 'expired', 'paid', 'fulfilled')`
  ).bind(String(order.order_id), now, state.op_key, providerKopecks).run();
  if ((update?.meta?.changes || 0) < 1) {
    return { ok: false, status: 409, reason: 'invalid_order_state' };
  }
  await appendPaymentEvent(env, order, 'reconciled_paid', providerKopecks, {
    state_code: state.state_code, out_currency: state.out_currency,
    op_key_ref: await shortHash(state.op_key)
  }, now);
  return {
    ok: true,
    paid: true,
    order: { ...order, status: ['pending', 'expired'].includes(order.status) ? 'paid' : order.status,
      paid_at: order.paid_at || now, provider_op_key: state.op_key, reconciled_at: now },
    provider: state
  };
}

export async function initiateRobokassaRefund(env, body, fetcher = fetch) {
  const orderId = String(body?.order_id || '').trim();
  const reason = String(body?.reason || '').trim().slice(0, 500);
  if (!/^\d+$/.test(orderId) || !reason || body?.confirm_full_refund !== true) {
    return { ok: false, status: 400, reason: 'bad_refund_request' };
  }
  const order = await loadRobokassaOrder(env, orderId);
  if (!order) return { ok: false, status: 404, reason: 'order_not_found' };
  if (order.environment !== 'production') {
    return { ok: false, status: 409, reason: 'test_refund_unavailable' };
  }
  if (order.refund_request_id || order.status === 'refunded' || order.status === 'refund_pending') {
    return { ok: false, status: 409, reason: 'refund_already_started' };
  }
  if (order.status !== 'fulfilled') {
    return { ok: false, status: 409, reason: 'order_not_fulfilled' };
  }
  const password3 = robokassaCredential(env, 3);
  if (!password3) return { ok: false, status: 503, reason: 'refund_config' };
  // Validate the signing algorithm BEFORE reserving anything. createRefund
  // rejects an unsupported value locally, without contacting the provider, so
  // discovering it after the reservation would strand a perfectly refundable
  // order in submission_unknown for no reason at all.
  const algorithm = refundHashAlgorithm(env);
  if (!algorithm) return { ok: false, status: 503, reason: 'refund_hash_config' };
  const invoiceItems = refundInvoiceItems(order);
  if (!invoiceItems && String(env.ROBOKASSA_REFUND_ALLOW_MONEY_ONLY || '').toLowerCase() !== 'true') {
    return { ok: false, status: 503, reason: 'refund_receipt_config' };
  }
  let opKey = order.provider_op_key;
  if (!opKey) {
    const reconciliation = await reconcileRobokassaOrder(env, orderId, fetcher);
    if (!reconciliation.ok || !reconciliation.paid) return reconciliation;
    opKey = reconciliation.provider.op_key;
  }
  const now = Date.now();
  const reserved = await transitionWithEvent(
    env,
    env.DB.prepare(
      `UPDATE payment_orders
       SET status = 'refund_pending', refund_status = 'creating',
           refund_kopecks = amount_kopecks
       WHERE order_id = ?1 AND status = 'fulfilled' AND refund_request_id IS NULL`
    ).bind(orderId),
    order, 'refund_requested', Number(order.amount_kopecks),
    { reason, fiscal_receipt: !!invoiceItems }, now
  );
  if (reserved < 1) {
    return { ok: false, status: 409, reason: 'refund_already_started' };
  }
  let created;
  try {
    created = await robokassa.createRefund({ opKey, password3, invoiceItems, algorithm, fetcher });
  } catch (error) {
    // The provider may have accepted the request before the connection failed.
    // Keep the row in an explicit unknown state; retrying automatically could
    // issue a second refund. The health worklist forces operator reconciliation.
    await transitionWithEvent(
      env,
      env.DB.prepare(
        `UPDATE payment_orders SET refund_status = 'submission_unknown'
         WHERE order_id = ?1 AND refund_status = 'creating'`
      ).bind(orderId),
      order, 'refund_submission_unknown', Number(order.amount_kopecks),
      { error: String(error?.message || error).slice(0, 200) }, Date.now()
    );
    throw error;
  }
  if (!created.ok) {
    await transitionWithEvent(
      env,
      env.DB.prepare(
        `UPDATE payment_orders
         SET status = 'fulfilled', refund_status = ?2, refund_kopecks = NULL
         WHERE order_id = ?1 AND refund_status = 'creating'`
      ).bind(orderId, `rejected:${created.reason}`.slice(0, 120)),
      order, 'refund_rejected', Number(order.amount_kopecks),
      { reason: created.reason }, Date.now()
    );
    return { ok: false, status: 409, reason: 'refund_rejected' };
  }
  const recorded = await transitionWithEvent(
    env,
    env.DB.prepare(
      `UPDATE payment_orders SET refund_request_id = ?2, refund_status = 'processing'
       WHERE order_id = ?1 AND status = 'refund_pending' AND refund_status = 'creating'`
    ).bind(orderId, created.request_id),
    order, 'refund_accepted', Number(order.amount_kopecks),
    { request_ref: await shortHash(created.request_id) }, Date.now()
  );
  if (recorded < 1) throw new Error('refund request journal changed');
  return { ok: true, order_id: orderId, status: 'processing' };
}

// Only 'processing' is pollable: refund_request_id is written by the same
// UPDATE that leaves 'creating', so a row can never hold both. 'creating' and
// 'submission_unknown' rows are operator work, surfaced by the
// refund_submission_unknown worklist in /admin/health rather than swept here.
//
// Every row is polled and settled in ISOLATION. Previously one shared
// try/catch wrapped the whole loop, so the first provider query that threw
// ended the sweep — and because selection was `ORDER BY order_id` the same row
// was picked first on every subsequent cron run. A permanently failing low
// order id therefore starved every later refund forever, which can leave a
// paid licence active long after the money went back. A failing row now backs
// off (payment_refund_poll) and selection prefers whatever is due soonest.
export async function inspectPendingRefunds(env, limit = 20, fetcher = fetch) {
  const bounded = Math.max(1, Math.min(50, Number(limit) || 20));
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT o.order_id, o.environment, o.amount_kopecks, o.currency,
            o.refund_request_id, o.refund_status, i.license_key
     FROM payment_orders o
     LEFT JOIN payment_issuance i
       ON i.gateway = 'robokassa' AND i.payment_id = CAST(o.order_id AS TEXT)
     LEFT JOIN payment_refund_poll p ON p.order_id = o.order_id
     WHERE o.status = 'refund_pending' AND o.refund_request_id IS NOT NULL
       AND o.refund_status = 'processing'
       AND COALESCE(p.next_poll_at, 0) <= ?2
     ORDER BY COALESCE(p.next_poll_at, 0), o.order_id LIMIT ?1`
  ).bind(bounded, now).all();
  const finished = [];
  for (const order of rows?.results || []) {
    try {
      const settled = await settleRefundPoll(env, order, fetcher);
      if (settled) finished.push(settled);
    } catch (e) {
      // One unreachable provider call, one malformed response, one row. The
      // rest of the queue still drains this run, and this row comes back after
      // its backoff instead of blocking the head of the queue forever.
      console.error('refund poll failed', order.order_id, String(e));
      await recordRefundPollFailure(env, order.order_id, e);
    }
  }
  return finished;
}

// Poll one order and apply whatever terminal transition the provider reports.
// Returns the row to finalize when the refund is genuinely complete, else null.
async function settleRefundPoll(env, order, fetcher) {
  const state = await robokassa.queryRefundState({
    requestId: order.refund_request_id, fetcher
  });
  const amountKopecks = rublesToKopecks(state.amount);
  const orderId = String(order.order_id);

  if (state.label === 'finished') {
    if (amountKopecks !== Number(order.amount_kopecks) || !order.license_key) {
      // A mismatch leaves the pollable set, so cron will never look at it
      // again. Without a durable work item it would vanish from every operator
      // worklist at the same moment — money moved, nobody assigned. The review
      // row is created in the SAME batch as the state change so the handoff
      // cannot be lost between them.
      const mismatchAt = Date.now();
      const mismatchDetails = JSON.stringify({
        expected_kopecks: Number(order.amount_kopecks),
        provider_kopecks: amountKopecks,
        license_present: !!order.license_key
      });
      // Statement order matters: each changes() guard refers to the statement
      // immediately before it, so both the event and the review are gated,
      // transitively, on the ORDER TRANSITION rather than on each other's
      // success. Chaining the event off the review write was the bug — a review
      // that was a no-op silently swallowed the audit record too.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE payment_orders SET status = 'review', refund_status = 'finished_mismatch'
           WHERE order_id = ?1 AND status = 'refund_pending'`
        ).bind(orderId),
        env.DB.prepare(
          `INSERT INTO payment_events
             (gateway, payment_id, order_id, environment, event_type, amount_kopecks,
              currency, details_json, created_at)
           SELECT 'robokassa', ?1, ?1, ?2, 'refund_finished_mismatch', ?3, 'RUB', ?4, ?5
           WHERE changes() = 1`
        ).bind(orderId, order.environment, amountKopecks, mismatchDetails, mismatchAt),
        // REOPEN, don't ignore. This payment may already carry a review an
        // operator resolved earlier (a reconciliation mismatch, say). INSERT OR
        // IGNORE left that resolved row untouched, so this brand-new mismatch —
        // money already returned by the provider — appeared on NO worklist.
        // Clearing resolved_at/resolution puts it back in front of someone.
        env.DB.prepare(
          `INSERT INTO payment_review
             (gateway, payment_id, invoice_id, amount_rub, reason, fields_json,
              created_at, environment, amount_kopecks)
           SELECT 'robokassa', ?1, ?1, ?2, 'refund_finished_mismatch', ?3, ?4, ?5, ?6
           WHERE changes() = 1
           ON CONFLICT(gateway, payment_id) DO UPDATE SET
             reason = 'refund_finished_mismatch',
             fields_json = ?3,
             created_at = ?4,
             amount_rub = ?2,
             amount_kopecks = ?6,
             resolved_at = NULL,
             resolution = NULL,
             resolution_note = NULL`
        ).bind(
          orderId, amountKopecks == null ? null : amountKopecks / 100,
          mismatchDetails, mismatchAt, order.environment, amountKopecks
        )
      ]);
      await clearRefundPollState(env, orderId);
      return null;
    }
    await clearRefundPollState(env, orderId);
    return { ...order, provider_amount_kopecks: amountKopecks };
  }

  if (state.label === 'canceled') {
    // Cancellation is terminal for THIS attempt, so the spent request id is
    // retired into the audit event rather than left on the row. Keeping it
    // made the initiation guard reject every later attempt with
    // refund_already_started even though no refund had happened.
    await transitionWithEvent(
      env,
      env.DB.prepare(
        `UPDATE payment_orders
         SET status = 'fulfilled', refund_status = 'canceled',
             refund_request_id = NULL, refund_kopecks = NULL
         WHERE order_id = ?1 AND status = 'refund_pending'`
      ).bind(orderId),
      order, 'refund_canceled', null,
      { previous_request_ref: await shortHash(order.refund_request_id), retryable: true },
      Date.now()
    );
    await clearRefundPollState(env, orderId);
    return null;
  }

  // Still 'processing'. Clear any stale failure bookkeeping: the provider is
  // answering, so this row should stay at the front of the queue.
  await clearRefundPollState(env, orderId);
  return null;
}

export async function finalizeRobokassaRefund(env, order) {
  const now = Date.now();
  const changed = await transitionWithEvent(
    env,
    env.DB.prepare(
      `UPDATE payment_orders SET status = 'refunded', refund_status = 'finished', refunded_at = ?2
       WHERE order_id = ?1 AND status = 'refund_pending' AND refund_status = 'processing'
         AND EXISTS (
           SELECT 1
           FROM payment_issuance issuance
           JOIN license_revocations revocation
             ON revocation.license_key = issuance.license_key
           WHERE issuance.gateway = 'robokassa'
             AND issuance.payment_id = CAST(payment_orders.order_id AS TEXT)
         )`
    ).bind(String(order.order_id), now),
    order, 'refund_finished', Number(order.amount_kopecks),
    { license_ref: await shortHash(order.license_key) }, now
  );
  if (changed < 1) throw new Error('refund finalization state changed');
  await clearRefundPollState(env, order.order_id);
}

/* ----------------- order expiry and contact retention ------------------ */
// Orders carry a 30-minute logical TTL, but nothing ever acted on it: an
// abandoned checkout kept the buyer's email/Telegram id/device id in
// payment_orders forever, and the analytics prune never touches payment
// tables. A never-paid order has no money to reconcile, so once it is
// definitively dead its contact details are dropped and the row is closed.
// Everything reconciliation actually needs — amount, plan, environment,
// timestamps, and the append-only payment_events log — is preserved.
const ORDER_EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;
// Settled orders keep contact details for one Russian accounting cycle plus a
// margin, then keep only the money evidence.
const ORDER_CONTACT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
const SETTLED_ORDER_STATUSES = ['refunded', 'expired', 'fulfilled'];

/**
 * Recover ResultURL callbacks lost in transit. A pending order is checked once
 * when its checkout TTL expires, and once more immediately before the 24-hour
 * contact-erasure boundary. Provider/network failures never stamp
 * reconciled_at, so prune remains fail-closed and retries later.
 */
export async function reconcileDueRobokassaOrders(env, limit = 10, now = Date.now(), fetcher = fetch) {
  if (!env.DB || paymentEnvironment(env) !== 'production') {
    return { checked: 0, paid: [], failed: 0 };
  }
  const bounded = Math.max(1, Math.min(50, Number(limit) || 10));
  const finalCheckCutoff = now - 10 * 60 * 1000;
  const due = await env.DB.prepare(
    `SELECT order_id FROM payment_orders
     WHERE environment = 'production' AND status = 'pending' AND expires_at <= ?1
       AND (
         reconciled_at IS NULL OR
         (expires_at <= ?2 AND reconciled_at < ?3)
       )
     ORDER BY CASE WHEN reconciled_at IS NULL THEN 0 ELSE 1 END, order_id
     LIMIT ?4`
  ).bind(now, now - ORDER_EXPIRY_GRACE_MS, finalCheckCutoff, bounded).all();
  const paid = [];
  let checked = 0;
  let failed = 0;
  for (const row of due?.results || []) {
    try {
      const result = await reconcileRobokassaOrder(env, String(row.order_id), fetcher);
      checked += 1;
      if (result.ok && result.paid) paid.push(result);
      else if (!result.ok) failed += 1;
    } catch (error) {
      failed += 1;
      console.error('automatic payment reconciliation failed', row.order_id, String(error));
    }
  }
  return { checked, paid, failed };
}

export async function pruneExpiredPaymentOrders(env, limit = 100, now = Date.now()) {
  if (!env.DB) return { expired: 0, anonymized: 0 };
  const bounded = Math.max(1, Math.min(500, Number(limit) || 100));

  // 1. Close abandoned checkouts. Per row so one bad row cannot abort the
  //    sweep, and state+event commit together like every other transition.
  const due = await env.DB.prepare(
    `SELECT order_id, environment, amount_kopecks
     FROM payment_orders
     WHERE status = 'pending' AND expires_at <= ?1
       AND reconciled_at IS NOT NULL AND reconciled_at >= ?3
     ORDER BY order_id LIMIT ?2`
  ).bind(now - ORDER_EXPIRY_GRACE_MS, bounded, now - 10 * 60 * 1000).all();
  let expired = 0;
  for (const order of due?.results || []) {
    try {
      expired += await transitionWithEvent(
        env,
        env.DB.prepare(
          `UPDATE payment_orders
           SET status = 'expired', email = NULL, telegram_user_id = NULL, device_id = NULL
           WHERE order_id = ?1 AND status = 'pending'`
        ).bind(String(order.order_id)),
        order, 'order_expired', Number(order.amount_kopecks),
        { contact_erased: true }, now
      );
    } catch (e) {
      console.error('order expiry failed', order.order_id, String(e));
    }
  }

  // 2. Age out contact details on long-settled orders. Open operator work
  //    ('review', 'refund_pending') is deliberately excluded — those rows are
  //    still someone's job and may need the contact to finish.
  let anonymized = 0;
  try {
    const result = await env.DB.prepare(
      `UPDATE payment_orders
       SET email = NULL, telegram_user_id = NULL, device_id = NULL
       WHERE order_id IN (
         SELECT order_id FROM payment_orders
         WHERE status IN (${SETTLED_ORDER_STATUSES.map((_, i) => `?${i + 3}`).join(', ')})
           AND created_at <= ?1
           AND (email IS NOT NULL OR telegram_user_id IS NOT NULL OR device_id IS NOT NULL)
         ORDER BY order_id LIMIT ?2
       )`
    ).bind(now - ORDER_CONTACT_RETENTION_MS, bounded, ...SETTLED_ORDER_STATUSES).run();
    anonymized = Number(result?.meta?.changes || 0);
  } catch (e) {
    console.error('order contact retention sweep failed', String(e));
  }
  return { expired, anonymized };
}

async function appendPaymentEvent(env, order, type, amountKopecks, details, now = Date.now()) {
  const safeDetails = { ...details };
  delete safeDetails.SignatureValue;
  await env.DB.prepare(
    `INSERT INTO payment_events
       (gateway, payment_id, order_id, environment, event_type, amount_kopecks,
        currency, details_json, created_at)
     VALUES ('robokassa', ?1, ?1, ?2, ?3, ?4, 'RUB', ?5, ?6)`
  ).bind(
    String(order.order_id), order.environment, type, amountKopecks,
    JSON.stringify(safeDetails), now
  ).run();
}

function paymentEventStatement(env, order, type, amountKopecks, details, now) {
  const safeDetails = { ...details };
  delete safeDetails.SignatureValue;
  // Gated on the preceding statement in the same batch: SQLite's changes()
  // reports the rows the last DML touched, so the event is written only when
  // the guarded transition actually matched.
  return env.DB.prepare(
    `INSERT INTO payment_events
       (gateway, payment_id, order_id, environment, event_type, amount_kopecks,
        currency, details_json, created_at)
     SELECT 'robokassa', ?1, ?1, ?2, ?3, ?4, 'RUB', ?5, ?6
     WHERE changes() = 1`
  ).bind(
    String(order.order_id), order.environment, type, amountKopecks,
    JSON.stringify(safeDetails), now
  );
}

/**
 * Apply a guarded refund state transition and its audit event as ONE D1 batch
 * (a SQLite transaction).
 *
 * These used to be two awaited statements. Fault injection between them left a
 * terminal `refunded` order with no `refund_finished` event, and an order
 * parked in `refund_pending/creating` — before any provider call — whose every
 * retry was then rejected. Money state and its evidence must commit together
 * or not at all.
 *
 * Returns the number of rows the transition changed (0 = the guard did not
 * match, and nothing at all was written).
 */
async function transitionWithEvent(env, statement, order, type, amountKopecks, details, now) {
  if (typeof env.DB.batch !== 'function') {
    throw new Error('D1 batch API missing — refusing non-atomic refund accounting');
  }
  const results = await env.DB.batch([
    statement,
    paymentEventStatement(env, order, type, amountKopecks, details, now)
  ]);
  return Number(results?.[0]?.meta?.changes || 0);
}

// A refund whose provider poll keeps failing must not be able to hold the
// queue. Backing it off moves it out of the eligible set so every later refund
// still advances; the ceiling keeps a long provider outage from parking a row
// past any plausible operator response time.
const REFUND_POLL_BASE_BACKOFF_MS = 5 * 60 * 1000;
const REFUND_POLL_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

function refundPollBackoffMs(attempts) {
  const exponent = Math.min(Math.max(0, Number(attempts) - 1), 12);
  return Math.min(REFUND_POLL_MAX_BACKOFF_MS, REFUND_POLL_BASE_BACKOFF_MS * 2 ** exponent);
}

/**
 * Record one failed provider poll for an order and schedule its next attempt.
 * Best effort by construction: if THIS write fails the row simply stays due,
 * which reproduces the old behaviour for that single row rather than for the
 * whole queue.
 */
export async function recordRefundPollFailure(env, orderId, error, now = Date.now()) {
  const message = String(error?.message || error || 'unknown').slice(0, 300);
  try {
    const row = await env.DB.prepare(
      `INSERT INTO payment_refund_poll (order_id, attempts, next_poll_at, last_error, last_error_at)
       VALUES (?1, 1, ?2, ?3, ?4)
       ON CONFLICT(order_id) DO UPDATE SET
         attempts = payment_refund_poll.attempts + 1,
         last_error = ?3,
         last_error_at = ?4
       RETURNING attempts`
    ).bind(String(orderId), now + refundPollBackoffMs(1), message, now).first();
    const attempts = Number(row?.attempts) || 1;
    await env.DB.prepare(
      'UPDATE payment_refund_poll SET next_poll_at = ?2 WHERE order_id = ?1'
    ).bind(String(orderId), now + refundPollBackoffMs(attempts)).run();
    return attempts;
  } catch (e) {
    console.error('refund poll backoff write failed', String(e));
    return 0;
  }
}

// The row left 'processing', so its retry bookkeeping is spent.
export async function clearRefundPollState(env, orderId) {
  try {
    await env.DB.prepare('DELETE FROM payment_refund_poll WHERE order_id = ?1')
      .bind(String(orderId)).run();
  } catch (e) {
    console.error('refund poll state cleanup failed', String(e));
  }
}

async function shortHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function refundInvoiceItems(order) {
  if (order.fiscalization_mode !== 'provider' || !order.receipt_json) return null;
  let receipt;
  try {
    receipt = JSON.parse(order.receipt_json);
  } catch {
    return null;
  }
  const item = receipt?.items?.length === 1 ? receipt.items[0] : null;
  const itemKopecks = rublesToKopecks(item?.sum);
  if (!item || itemKopecks !== Number(order.amount_kopecks) ||
      !RECEIPT_TAXES.has(item.tax) || !RECEIPT_METHODS.has(item.payment_method) ||
      !RECEIPT_OBJECTS.has(item.payment_object)) return null;
  return [{
    Name: String(item.name || '').slice(0, 128),
    Quantity: 1,
    Cost: Number(robokassa.formatKopecks(Number(order.amount_kopecks))),
    Tax: item.tax,
    PaymentMethod: item.payment_method,
    PaymentObject: item.payment_object
  }];
}

export async function resolvePaymentReview(env, body) {
  const gateway = String(body?.gateway || 'robokassa').trim().toLowerCase();
  const paymentId = String(body?.payment_id || '').trim();
  const resolution = String(body?.resolution || '').trim().toLowerCase();
  const note = String(body?.note || '').trim().slice(0, 1000);
  const allowed = new Set(['refunded', 'fulfilled_manually', 'duplicate', 'invalid_test', 'other']);
  if (gateway !== 'robokassa' || !/^\d+$/.test(paymentId)) {
    return { ok: false, status: 400, reason: 'bad_payment' };
  }
  if (!allowed.has(resolution) || !note) {
    return { ok: false, status: 400, reason: 'bad_resolution' };
  }
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE payment_review
     SET resolved_at = ?3, resolution = ?4, resolution_note = ?5
     WHERE gateway = ?1 AND payment_id = ?2 AND resolved_at IS NULL`
  ).bind(gateway, paymentId, now, resolution, note).run();
  if ((result?.meta?.changes || 0) < 1) {
    const existing = await env.DB.prepare(
      'SELECT resolved_at FROM payment_review WHERE gateway = ?1 AND payment_id = ?2'
    ).bind(gateway, paymentId).first();
    return existing
      ? { ok: false, status: 409, reason: 'already_resolved' }
      : { ok: false, status: 404, reason: 'not_found' };
  }
  await env.DB.prepare(
    `INSERT INTO payment_events
       (gateway, payment_id, order_id, environment, event_type, amount_kopecks,
        currency, details_json, created_at)
     SELECT gateway, payment_id,
            CASE WHEN payment_id GLOB '[0-9]*' THEN CAST(payment_id AS INTEGER) END,
            environment, 'review_resolved', amount_kopecks, 'RUB', ?3, ?4
     FROM payment_review WHERE gateway = ?1 AND payment_id = ?2`
  ).bind(gateway, paymentId, JSON.stringify({ resolution, note }), now).run();
  return { ok: true, gateway, payment_id: paymentId, resolution, resolved_at: now };
}
