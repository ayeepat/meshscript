/**
 * СМЭШ AI license backend.
 *
 * Routes:
 *   POST/GET /webhook/robokassa  Robokassa ResultURL notification, auto-issues a license
 *   GET  /verify             Extension calls this; returns active|expired|...
 *   POST /ai/chat            License-gated Qwen/DeepSeek proxy (see ai-proxy.js)
 *   POST /referral/code      Get/create this device's referral code
 *   GET  /referral/check     Validate a code at checkout (before charging)
 *   GET  /referral/status    Referral stats + reward key for a device
 *   POST /admin/issue        Manual issuance (testing, comp licenses)
 *   POST /admin/revoke       Revoke a key (refunds, fraud)
 *   GET  /admin/license      Inspect one license by key
 *   GET  /admin/referral     Inspect a referral record by code or device
 *   POST /telegram/webhook   Support bot: user tickets → owner, replies → user
 *   GET  /health             Liveness ping
 *
 * Everything else 404s. CORS is wide-open for /verify only (the extension
 * runs on chrome-extension:// origins; we don't need credential cookies).
 */

import { issueLicense, verifyLicense, getLicense, putLicense, normalizeKey } from './licenses.js';
import { handleAiChat } from './ai-proxy.js';
import * as referrals from './referrals.js';
import * as analytics from './analytics.js';
import * as robokassa from './gateways/robokassa.js';
import { sendLicenseEmail } from './delivery/email.js';
import { sendLicenseTelegram } from './delivery/telegram.js';
import { processSupportUpdate } from './delivery/support.js';

const VERIFY_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Public extension endpoints accept JSON only. Admin routes are deliberately
  // CLI/server-to-server only and must not be callable by a static website —
  // with ONE exception: the owner analytics dashboard (see statsCors below).
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// The owner analytics dashboard is a static GitHub Pages site — the ONLY
// browser origin allowed to call the read-only stats endpoints. Everything
// else under /admin/* stays CLI/server-to-server (no Origin header at all).
const DEFAULT_DASHBOARD_ORIGIN = 'https://ayeepat.github.io';
const dashboardOrigin = (env) =>
  String(env.DASHBOARD_ORIGIN || DEFAULT_DASHBOARD_ORIGIN).replace(/\/+$/, '');

// CORS headers for a stats request, or null when the caller is not the
// dashboard origin (absent Origin ⇒ null too: CLI callers need no CORS).
function statsCors(request, env) {
  const origin = request.headers.get('origin') || '';
  if (!origin || origin !== dashboardOrigin(env)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// The exact route set the dashboard is allowed to reach from a browser.
const isStatsPath = (path) => path.startsWith('/admin/stats/') || path === '/admin/backfill-licenses';

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
});

const error = (status, reason, headers = {}) => json({ ok: false, reason }, { status, headers });

const SECRET_ENCODER = new TextEncoder();

async function constantTimeStringEqual(expected, supplied) {
  const expectedText = String(expected || '');
  if (!expectedText) return false;

  // Hash both values to the same fixed width before invoking the runtime's
  // native constant-time primitive. This avoids leaking the configured
  // secret's length and keeps comparison semantics out of optimizable JS.
  if (typeof crypto.subtle.timingSafeEqual !== 'function') return false;
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', SECRET_ENCODER.encode(expectedText)),
    crypto.subtle.digest('SHA-256', SECRET_ENCODER.encode(String(supplied || '')))
  ]);
  return crypto.subtle.timingSafeEqual(expectedHash, suppliedHash);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      // Stats preflights from the dashboard origin must whitelist the
      // X-Admin-Token header; every other preflight keeps the public set
      // (which deliberately does NOT allow the admin header).
      const cors = isStatsPath(path) ? statsCors(request, env) : null;
      return new Response(null, { headers: cors || VERIFY_CORS });
    }

    try {
      if (path === '/health') return json({ ok: true });

      if (path === '/verify' && method === 'GET') return await handleVerify(request, env);
      if (path === '/ai/chat' && method === 'POST') return await handleAiChat(request, env);
      if (path === '/webhook/robokassa' && (method === 'POST' || method === 'GET')) {
        return await handleRobokassa(request, env, ctx);
      }

      if (path === '/referral/code' && method === 'POST') return await handleReferralCode(request, env);
      if (path === '/referral/check' && method === 'GET') return await handleReferralCheck(request, env);
      if (path === '/referral/status' && method === 'GET') return await handleReferralStatus(request, env);

      if (path === '/t' && method === 'POST') return await handleTelemetry(request, env);
      if (path === '/t/ai' && method === 'POST') return await handleServerTelemetry(request, env);
      if (path === '/t/delete' && method === 'POST') return await handleTelemetryDelete(request, env);
      if (path.startsWith('/admin/stats/') && method === 'GET') return await handleAdminStats(request, env, path);
      if (path === '/admin/backfill-licenses' && method === 'POST') return await handleAdminBackfill(request, env);

      if (path === '/admin/issue' && method === 'POST') return await handleAdminIssue(request, env);
      if (path === '/admin/revoke' && method === 'POST') return await handleAdminRevoke(request, env);
      if (path === '/admin/license' && method === 'GET') return await handleAdminLicense(request, env);
      if (path === '/admin/referral' && method === 'GET') return await handleAdminReferral(request, env);

      if (path === '/telegram/webhook' && method === 'POST') return await handleTelegramWebhook(request, env, ctx);
      if (path === '/telegram/setup' && method === 'POST') return await handleTelegramSetup(request, env);
      if (path === '/telegram/info' && method === 'GET') return await handleTelegramInfo(request, env);
      if (path === '/telegram/test' && method === 'POST') return await handleTelegramTest(request, env);
      if (path === '/telegram/debug' && method === 'GET') return await handleTelegramDebug(request, env);

      return error(404, 'not_found');
    } catch (e) {
      // Don't leak internals back to the caller; logs land in `wrangler tail`.
      console.error('worker exception', e?.stack || String(e));
      return error(500, 'server_error');
    }
  }
};

/* ------------------------------ /verify ------------------------------ */

async function handleVerify(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || '';
  const deviceId = url.searchParams.get('device_id') || '';
  const result = await verifyLicense(env, key, deviceId);
  return json(result, { headers: VERIFY_CORS });
}

/* ----------------------------- /referral/* ---------------------------- */
// Called by the extension (settings page) and the checkout page, so they
// share /verify's open CORS. Only /referral/code writes (behind a per-IP
// daily budget). The real guarantee — one payout per paid license — is
// enforced in the Robokassa webhook via referrals.js, not here.

async function handleReferralCode(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await referrals.bumpIpBudget(env, ip))) return error(429, 'rate_limited', VERIFY_CORS);
  let body;
  try { body = await request.json(); } catch { return error(400, 'bad_json', VERIFY_CORS); }
  const result = await referrals.getOrCreateCode(env, body.device_id, body.license_key);
  return json(result, { status: result.ok ? 200 : 400, headers: VERIFY_CORS });
}

async function handleReferralCheck(request, env) {
  const url = new URL(request.url);
  const result = await referrals.checkCode(env, url.searchParams.get('code') || '');
  return json(result, { headers: VERIFY_CORS });
}

async function handleReferralStatus(request, env) {
  const url = new URL(request.url);
  const result = await referrals.referralStatus(env, url.searchParams.get('device_id') || '');
  return json(result, { status: result.ok ? 200 : 400, headers: VERIFY_CORS });
}

/* ------------------------- /telegram/webhook ------------------------- */

async function handleTelegramWebhook(request, env, ctx) {
  // Telegram authenticates itself with the secret token registered at
  // setWebhook time (sent back in this header). Reject anything else so a
  // leaked URL can't be used to puppet the bot.
  // Fail closed on a missing secret. Treating "secret not configured" as
  // "authentication disabled" lets anyone forge Telegram update objects,
  // including an owner reply that makes the bot DM an arbitrary chat.
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    console.error('telegram webhook disabled: TELEGRAM_WEBHOOK_SECRET is not set');
    return error(503, 'webhook_not_configured');
  }
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!(await constantTimeStringEqual(env.TELEGRAM_WEBHOOK_SECRET, got))) return error(401, 'unauthorized');

  let update;
  try { update = await request.json(); }
  catch { return json({ ok: true }); } // ack malformed bodies so Telegram stops retrying

  // Do the work and AWAIT it (a couple of fast API calls) so the sends actually
  // complete before we ack — fire-and-forget proved unreliable here. We always
  // return 200 regardless, so Telegram never retries.
  let result;
  try { result = await processSupportUpdate(env, update); }
  catch (e) { result = { kind: 'error', error: String(e?.stack || e) }; console.error('support', e); }

  // Stash the last event for /telegram/debug (best-effort; never blocks the ack).
  ctx.waitUntil(env.LICENSES.put('tgdebug:last', JSON.stringify({
    at: new Date().toISOString(),
    incoming: summarizeUpdate(update),
    result
  }), { expirationTtl: 3600 }).catch(() => {}));

  return json({ ok: true });
}

function summarizeUpdate(u = {}) {
  const m = u.message;
  const cq = u.callback_query;
  if (cq) return { type: 'callback_query', data: cq.data, from: cq.from?.id };
  if (m) return { type: 'message', from: m.from?.id, chat: m.chat?.id, text: m.text || m.caption || null, is_reply: !!m.reply_to_message };
  return { type: 'other', keys: Object.keys(u).filter((k) => k !== 'update_id') };
}

// One-time helper: registers this worker's own URL as the bot's webhook, using
// the tokens it already has stored. Operator helpers use the independent
// ADMIN_SECRET header; the webhook credential never appears in a URL.
//   POST /telegram/setup  (X-Admin-Token: <ADMIN_SECRET>)
async function handleTelegramSetup(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.TELEGRAM_WEBHOOK_SECRET) return error(400, 'no_webhook_secret');
  if (!env.TELEGRAM_BOT_TOKEN) return error(400, 'no_bot_token');

  const url = new URL(request.url);
  const webhookUrl = `${url.origin}/telegram/webhook`;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true
    })
  });
  const data = await res.json();

  // Also register the command menu (the blue «/» button) so the bot feels official.
  const cmdRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: 'Меню поддержки' },
        { command: 'help', description: 'Помощь и как пользоваться' }
      ]
    })
  });
  const commands = await cmdRes.json();

  return json({ ok: data.ok === true, webhook: webhookUrl, telegram: data, commands }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}

// Diagnostics: returns Telegram's view of the webhook (url, pending count, last
// error). Guarded by the independent administrator credential.
//   GET /telegram/info  (X-Admin-Token: <ADMIN_SECRET>)
async function handleTelegramInfo(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.TELEGRAM_BOT_TOKEN) return error(400, 'no_bot_token');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  return json(await res.json(), { headers: { 'Cache-Control': 'no-store' } });
}

// Diagnostics: sends a real "ping" message to a chat via the stored token and
// returns Telegram's raw reply — proves whether the bot can DM that user.
//   POST /telegram/test?chat=<id>  (X-Admin-Token: <ADMIN_SECRET>)
async function handleTelegramTest(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  const url = new URL(request.url);
  if (!env.TELEGRAM_BOT_TOKEN) return error(400, 'no_bot_token');
  const chat = url.searchParams.get('chat') || env.SUPPORT_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: '✅ Проверка связи: бот СМЭШ AI работает.' })
  });
  return json(await res.json(), { headers: { 'Cache-Control': 'no-store' } });
}

// Diagnostics: returns the last update the webhook processed and what the bot
// did with it. Guarded by the independent administrator credential.
//   GET /telegram/debug  (X-Admin-Token: <ADMIN_SECRET>)
async function handleTelegramDebug(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  const last = await env.LICENSES.get('tgdebug:last');
  return json({ ok: true, last: last ? JSON.parse(last) : null }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}

/* ------------------------- /webhook/robokassa ------------------------ */

async function handleRobokassa(request, env, ctx) {
  // Robokassa expects the ResultURL handler to return plain "OK{InvId}" after
  // a valid notification. Delivery I/O (email + Telegram) can be slow, so it
  // runs after the response goes out via ctx.waitUntil.
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (robokassa.shouldEnforceIpAllowlist(env) && !robokassa.isRobokassaIp(ip)) {
    console.warn('robokassa: rejected ip', ip);
    return error(403, 'forbidden');
  }

  let fields;
  try { fields = await robokassa.readResultFields(request); }
  catch {
    return error(400, 'bad_form');
  }

  const signed = await robokassa.verifyResultSignature(fields, env.ROBOKASSA_PASSWORD2, env.ROBOKASSA_HASH_ALGO);
  if (!signed.ok) {
    console.warn('robokassa: bad signature', signed.reason, robokassa.invoiceId(fields) || '(no invoice)');
    return error(403, 'bad_signature');
  }

  const n = robokassa.normalizeResult(fields);
  if (!n.ok) {
    console.warn('robokassa: invalid signed notification', n.reason);
    return error(400, n.reason);
  }

  const floor = minPaymentRub(env);
  if (floor > 0 && n.amount_rub < floor) {
    console.warn('robokassa: amount below floor, not issuing', n.payment_id, n.amount_rub);
    return robokassa.okResponse(n.invoice_id);
  }
  if (floor <= 0) console.warn('robokassa: NO payment floor configured — set MIN_PAYMENT_RUB or any paid amount can issue a license');

  // The order page should thread signed delivery data + any referral code
  // through Shp_* params, or pre-register order:<InvId> in KV. EMail from
  // Robokassa is a last fallback.
  const order = await resolveRobokassaOrder(env, fields, n.invoice_id);
  if (!order.email && !order.telegram_user_id) {
    console.error('robokassa: payment without delivery contact', n.payment_id);
    return robokassa.okResponse(n.invoice_id);
  }

  // An amount that clears the hard floor but no plan threshold is not a
  // purchase — ack without issuing so Robokassa does not retry forever.
  const plan = planFromAmount(env, n.amount_rub);
  if (!plan) return robokassa.okResponse(n.invoice_id);
  const isPreorder = isPreorderNow();

  // Referral: a valid code the buyer entered at checkout (never self-referral)
  // extends the buyer's OWN subscription by the buyer bonus, and — once the
  // license exists — credits the referrer. A bad/self/absent code is ignored
  // silently: a real payment must never fail over a referral.
  const referral = await referrals.resolveReferral(env, {
    code: order.ref_code,
    buyerDeviceId: order.device_id
  });
  const expiresAt = (referral.valid && plan.type === 'subscription')
    ? referrals.withBuyerBonus(env, plan.expires_at)
    : plan.expires_at;

  const license = await issueLicense(env, {
    gateway: 'robokassa',
    payment_id: n.payment_id,     // InvId must be unique per order
    email: order.email,
    telegram_user_id: order.telegram_user_id,
    type: plan.type,
    expires_at: expiresAt,
    amount_rub: n.amount_rub,
    is_preorder: isPreorder
  });

  // Credit the referrer (idempotent per purchased license). Awaited, not
  // waitUntil'd — it's a few fast KV writes, and finishing before we ack means
  // a Robokassa retry can't race a half-written credit. issueLicense is itself
  // idempotent, so on a retry `license` is the original (already-bonused) key
  // and the refpaid marker skips a second payout.
  if (referral.valid) {
    try { await referrals.creditReferrerForPurchase(env, referral.ref, license.key); }
    catch (e) { console.error('referral credit', e); }
  }

  ctx.waitUntil(deliverKey(env, license, isPreorder));
  return robokassa.okResponse(n.invoice_id);
}

/**
 * Resolve delivery contact + referral fields from Robokassa ResultURL fields.
 * Prefer signed Shp_* fields, then an order record in KV, then Robokassa's
 * EMail fallback for the contact. `device_id` is usually absent (a static
 * checkout doesn't know it) and only feeds best-effort self-referral checks.
 */
async function resolveRobokassaOrder(env, fields, invoiceId) {
  const email = cleanEmail(fields.Shp_email) || cleanEmail(fields.Shp_Email);
  const telegram_user_id = cleanTelegramUserId(fields.Shp_telegram_user_id || fields.Shp_tg_user_id);
  const ref_code = fields.Shp_ref_code || fields.Shp_ref || '';
  const device_id = fields.Shp_device_id || fields.Shp_device || '';
  const orderId = cleanOrderId(fields.Shp_order_id || fields.Shp_order || invoiceId);
  let stored = {};

  try {
    const raw = orderId ? await env.LICENSES.get(`order:${orderId}`) : null;
    if (raw) {
      const o = JSON.parse(raw);
      stored = {
        email: cleanEmail(o.email),
        telegram_user_id: cleanTelegramUserId(o.telegram_user_id),
        ref_code: o.ref_code || o.referral_code || '',
        device_id: o.device_id || ''
      };
    }
  } catch { /* not JSON / not found */ }

  return {
    email: email || stored.email || cleanEmail(fields.EMail) || cleanEmail(fields.Email),
    telegram_user_id: telegram_user_id || stored.telegram_user_id || null,
    ref_code: ref_code || stored.ref_code || '',
    device_id: device_id || stored.device_id || ''
  };
}

function cleanEmail(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw) ? raw : null;
}

function cleanTelegramUserId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function cleanOrderId(value) {
  const raw = value == null ? '' : String(value).trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(raw) ? raw : '';
}

/**
 * Map a confirmed payment amount to a product plan.
 *   { type: 'lifetime',     expires_at: null }
 *   { type: 'subscription', expires_at: <now + N days ISO> }
 *   null                    — amount clears no configured floor; do NOT issue
 *
 * Pricing is env-driven so it changes without a redeploy:
 *   SUBSCRIPTION_MIN_RUB  — at/above this but below LIFETIME_MIN → subscription
 *   SUBSCRIPTION_DAYS     — subscription length in days (default 30)
 *   LIFETIME_MIN_RUB      — at/above this → lifetime
 * With none set, everything is DEFAULT_LICENSE_TYPE (lifetime) — current behaviour.
 */
function planFromAmount(env, amountRub) {
  const amount = Number(amountRub) || 0;
  const subMin = Number(env.SUBSCRIPTION_MIN_RUB || 0);
  const lifeMin = Number(env.LIFETIME_MIN_RUB || 0);
  const subDays = Number(env.SUBSCRIPTION_DAYS || 30);

  // Lifetime threshold wins when the payment clears it.
  if (lifeMin > 0 && amount >= lifeMin) return { type: 'lifetime', expires_at: null };
  // Otherwise, a subscription if the amount reaches the subscription floor.
  if (subMin > 0 && amount >= subMin) {
    const expires = new Date(Date.now() + subDays * 24 * 60 * 60 * 1000).toISOString();
    return { type: 'subscription', expires_at: expires };
  }
  // At least one floor is configured but the amount clears none of them: that
  // is not a purchase of any plan. Never fall through to the default here —
  // a 1₽ payment must not mint a lifetime license.
  if (subMin > 0 || lifeMin > 0) return null;
  // No pricing configured at all: fall back to the default product type.
  // (The MIN_PAYMENT_RUB gate in the webhook handlers covers this case.)
  const type = env.DEFAULT_LICENSE_TYPE || 'lifetime';
  return { type, expires_at: null };
}

/**
 * Hard floor on what counts as a purchase at all, applied before any plan
 * mapping. Explicit MIN_PAYMENT_RUB wins; otherwise the lowest configured
 * plan floor. Returns 0 (no floor) only when nothing is configured — the
 * handlers log a loud warning in that state.
 */
function minPaymentRub(env) {
  const explicit = Number(env.MIN_PAYMENT_RUB || 0);
  if (explicit > 0) return explicit;
  const floors = [Number(env.SUBSCRIPTION_MIN_RUB || 0), Number(env.LIFETIME_MIN_RUB || 0)]
    .filter((n) => n > 0);
  return floors.length ? Math.min(...floors) : 0;
}

/* ---------------------------- delivery glue --------------------------- */

async function deliverKey(env, license, isPreorder) {
  const [tg, em] = await Promise.allSettled([
    sendLicenseTelegram(env, {
      user_id: license.telegram_user_id,
      key: license.key,
      isPreorder
    }),
    sendLicenseEmail(env, {
      to: license.email,
      key: license.key,
      isPreorder
    })
  ]);
  if (tg.status === 'rejected') console.error('tg deliver', tg.reason);
  if (em.status === 'rejected') console.error('email deliver', em.reason);
}

// Preorder window — flips false on launch day. The extension client treats
// is_preorder as advisory metadata; the gate doesn't care. Stored on the
// license so the receipt email/TG copy can adapt.
function isPreorderNow() {
  return Date.now() < Date.parse('2026-07-25T00:00:00Z');
}

/* ------------------------------ telemetry ---------------------------- */

// POST /t — extension usage events (content-free; see analytics.js). Open like
// /verify: the extension runs on chrome-extension:// origins, no credentials.
async function handleTelemetry(request, env) {
  if (!env.DB) return error(503, 'no_db', VERIFY_CORS);
  const result = await analytics.handleIngest(request, env);
  return json(result, { status: result.status || (result.ok ? 200 : 400), headers: VERIFY_CORS });
}

// POST /t/ai — SERVER-observed AI usage from the VPS proxy (ai.smeshapi.site).
// This is the ground truth for 302.AI spend: the VPS sees every real upstream
// call regardless of the client's opt-in telemetry toggle. Guarded by the
// INGEST_KEY shared secret; browser callers are rejected outright, so the
// open /t endpoint can never be used to forge server-truth rows.
async function handleServerTelemetry(request, env) {
  if (request.headers.get('origin')) return error(401, 'unauthorized');
  if (!env.INGEST_KEY) return error(401, 'unauthorized');
  if (!(await constantTimeStringEqual(env.INGEST_KEY, request.headers.get('x-ingest-key') || ''))) {
    return error(401, 'unauthorized');
  }
  if (!env.DB) return error(503, 'no_db');
  const result = await analytics.handleServerIngest(request, env);
  return json(result, { status: result.status || (result.ok ? 200 : 400) });
}

// POST /t/delete — user-initiated erasure of one device's analytics rows
// (settings «Удалить мои данные статистики»). Open like /t itself: the device
// id is an unguessable UUID only that installation knows, and the worst a
// forged call can do is delete the caller's OWN pseudonymous rows.
async function handleTelemetryDelete(request, env) {
  if (!env.DB) return error(503, 'no_db', VERIFY_CORS);
  const result = await analytics.handleDeleteDevice(request, env);
  return json(result, { status: result.status || (result.ok ? 200 : 400), headers: VERIFY_CORS });
}

/* --------------------------- /admin/stats/* --------------------------- */

const STATS_ROUTES = {
  overview:   (env, q) => analytics.statsOverview(env, Number(q.get('days')) || 0),
  timeseries: (env, q) => analytics.statsTimeseries(env, Number(q.get('days')) || 30),
  users:      (env, q) => analytics.statsUsers(env, Object.fromEntries(q)),
  user:       (env, q) => analytics.statsUserDetail(env, q.get('device_id') || ''),
  subjects:   (env, q) => analytics.statsSubjects(env, Number(q.get('days')) || 0),
  purchases:  (env, q) => analytics.statsPurchases(env, Number(q.get('days')) || 0),
  retention:  (env)    => analytics.statsRetention(env),
  referrals:  (env)    => analytics.statsReferrals(env),
  errors:     (env, q) => analytics.statsErrors(env, Number(q.get('days')) || 0),
  rate:       (env, q) => analytics.statsRate(env, q.get('force') === '1')
};

// GET /admin/stats/<name> — aggregation endpoints for the owner dashboard
// (browser, dashboard origin only) and CLI/server-to-server callers.
async function handleAdminStats(request, env, path) {
  const cors = statsCors(request, env);
  const gate = await adminGate(request, env, cors);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db', cors || {});
  const name = path.slice('/admin/stats/'.length);
  const route = STATS_ROUTES[name];
  if (!route) return error(404, 'not_found', cors || {});
  const result = await route(env, new URL(request.url).searchParams);
  return json(result, { status: result.status || (result.ok ? 200 : 400), headers: cors || {} });
}

// POST /admin/backfill-licenses — re-mirror every KV license into D1.
async function handleAdminBackfill(request, env) {
  const cors = statsCors(request, env);
  const gate = await adminGate(request, env, cors);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db', cors || {});
  const result = await analytics.backfillLicenses(env);
  return json({ ok: true, ...result }, { headers: cors || {} });
}

/* ------------------------------- /admin ------------------------------ */

async function adminGuard(request, env, dashboardCors = null) {
  // Browser fetches send Origin; reject them before checking the token —
  // UNLESS the route explicitly allowed the owner dashboard origin
  // (dashboardCors is non-null only when Origin matched it exactly).
  if (request.headers.get('origin') && !dashboardCors) return false;
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_SECRET) return false;
  return constantTimeStringEqual(env.ADMIN_SECRET, token);
}

// Brute-force bound on the admin token: failed attempts per IP per Moscow day,
// counted in the same atomic D1 budget table telemetry uses. Once over the
// limit the endpoint answers 429 BEFORE the token is even compared, so a
// guessing loop is capped regardless of outcome. No DB ⇒ no limiter (the
// token check itself still gates; never fail the owner open OR closed on a
// D1 hiccup).
const ADMIN_FAIL_DAILY_LIMIT = 50;

async function adminFailures(env, ip, bump) {
  if (!env.DB) return 0;
  try {
    if (bump) {
      const count = await env.DB.prepare(
        `INSERT INTO telemetry_budget (day, scope, budget_key, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, scope, budget_key) DO UPDATE SET count = count + 1
         RETURNING count`
      ).bind(analytics.mskDay(), 'admin_fail', ip).first('count');
      return Number(count) || 0;
    }
    const row = await env.DB.prepare(
      'SELECT count FROM telemetry_budget WHERE day = ? AND scope = ? AND budget_key = ?'
    ).bind(analytics.mskDay(), 'admin_fail', ip).first();
    return Number(row?.count) || 0;
  } catch (e) {
    console.error('admin fail counter unavailable', String(e));
    return 0;
  }
}

// Returns an error Response (401/429) or null when the caller may proceed.
async function adminGate(request, env, dashboardCors = null) {
  const headers = dashboardCors || {};
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if ((await adminFailures(env, ip, false)) >= ADMIN_FAIL_DAILY_LIMIT) {
    return error(429, 'too_many_attempts', headers);
  }
  if (!(await adminGuard(request, env, dashboardCors))) {
    await adminFailures(env, ip, true);
    return error(401, 'unauthorized', headers);
  }
  return null;
}

async function handleAdminIssue(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  let body;
  try { body = await request.json(); }
  catch { return error(400, 'bad_json'); }

  const license = await issueLicense(env, {
    gateway: body.gateway || 'manual',
    payment_id: body.payment_id || null,
    email: body.email || null,
    telegram_user_id: body.telegram_user_id || null,
    type: body.type || 'lifetime',
    expires_at: body.expires_at || null,
    amount_rub: body.amount_rub || null,
    is_preorder: !!body.is_preorder,
    note: body.note || null
  });

  if (body.deliver !== false) {
    await deliverKey(env, license, !!body.is_preorder);
  }
  return json({ ok: true, license });
}

async function handleAdminRevoke(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  let body;
  try { body = await request.json(); }
  catch { return error(400, 'bad_json'); }
  const license = await getLicense(env, body.key);
  if (!license) return error(404, 'not_found');
  license.status = 'revoked';
  license.revoked_at = new Date().toISOString();
  license.revoke_reason = body.reason || null;
  await putLicense(env, license);
  return json({ ok: true, license });
}

async function handleAdminLicense(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return error(400, 'missing_key');
  const license = await getLicense(env, key);
  if (!license) return error(404, 'not_found');
  return json({ ok: true, license });
}

// Inspect a referral: ?code=REF-XXXX-XXXX or ?device_id=<uuid> (the referrer's
// device resolves to its code).
async function handleAdminReferral(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  const url = new URL(request.url);
  const result = await referrals.adminReferralLookup(env, {
    code: url.searchParams.get('code') || '',
    device_id: url.searchParams.get('device_id') || ''
  });
  if (!result.ref) return error(404, 'not_found');
  return json({ ok: true, ...result });
}
