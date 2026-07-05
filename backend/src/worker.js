/**
 * СМЭШ AI license backend.
 *
 * Routes:
 *   POST /webhook/robokassa  Robokassa ResultURL notification, auto-issues a license
 *   GET  /verify             Extension calls this; returns active|expired|...
 *   POST /admin/issue        Manual issuance (testing, comp licenses)
 *   POST /admin/revoke       Revoke a key (refunds, fraud)
 *   GET  /admin/license      Inspect one license by key
 *   POST /telegram/webhook   Support bot: user tickets → owner, replies → user
 *   GET  /health             Liveness ping
 *
 * Everything else 404s. CORS is wide-open for /verify only (the extension
 * runs on chrome-extension:// origins; we don't need credential cookies).
 */

import { issueLicense, verifyLicense, getLicense, putLicense, normalizeKey } from './licenses.js';
import * as robokassa from './gateways/robokassa.js';
import { sendLicenseEmail } from './delivery/email.js';
import { sendLicenseTelegram } from './delivery/telegram.js';
import { processSupportUpdate } from './delivery/support.js';

const VERIFY_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
});

const error = (status, reason, headers = {}) => json({ ok: false, reason }, { status, headers });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') return new Response(null, { headers: VERIFY_CORS });

    try {
      if (path === '/health') return json({ ok: true });

      if (path === '/verify' && method === 'GET') return await handleVerify(request, env);
      if (path === '/webhook/robokassa' && (method === 'POST' || method === 'GET')) {
        return await handleRobokassa(request, env, ctx);
      }

      if (path === '/admin/issue' && method === 'POST') return await handleAdminIssue(request, env);
      if (path === '/admin/revoke' && method === 'POST') return await handleAdminRevoke(request, env);
      if (path === '/admin/license' && method === 'GET') return await handleAdminLicense(request, env);

      if (path === '/telegram/webhook' && method === 'POST') return await handleTelegramWebhook(request, env, ctx);
      if (path === '/telegram/setup' && method === 'GET') return await handleTelegramSetup(request, env);
      if (path === '/telegram/info' && method === 'GET') return await handleTelegramInfo(request, env);
      if (path === '/telegram/test' && method === 'GET') return await handleTelegramTest(request, env);
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

/* ------------------------- /telegram/webhook ------------------------- */

async function handleTelegramWebhook(request, env, ctx) {
  // Telegram authenticates itself with the secret token registered at
  // setWebhook time (sent back in this header). Reject anything else so a
  // leaked URL can't be used to puppet the bot.
  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
    if (got !== env.TELEGRAM_WEBHOOK_SECRET) return error(401, 'unauthorized');
  }

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
// the token it already has stored. Lets you (re)connect the bot without ever
// handling the token by hand. Guarded by the webhook secret.
//   GET /telegram/setup?secret=<TELEGRAM_WEBHOOK_SECRET>
async function handleTelegramSetup(request, env) {
  const url = new URL(request.url);
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get('secret') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return error(401, 'unauthorized');
  }
  if (!env.TELEGRAM_BOT_TOKEN) return error(400, 'no_bot_token');

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

  return json({ ok: data.ok === true, webhook: webhookUrl, telegram: data, commands });
}

// Diagnostics: returns Telegram's view of the webhook (url, pending count, last
// error). Guarded by the webhook secret.
//   GET /telegram/info?secret=<TELEGRAM_WEBHOOK_SECRET>
async function handleTelegramInfo(request, env) {
  const url = new URL(request.url);
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get('secret') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return error(401, 'unauthorized');
  }
  if (!env.TELEGRAM_BOT_TOKEN) return error(400, 'no_bot_token');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  return json(await res.json());
}

// Diagnostics: sends a real "ping" message to a chat via the stored token and
// returns Telegram's raw reply — proves whether the bot can DM that user.
//   GET /telegram/test?secret=<TELEGRAM_WEBHOOK_SECRET>&chat=<id>
async function handleTelegramTest(request, env) {
  const url = new URL(request.url);
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get('secret') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return error(401, 'unauthorized');
  }
  if (!env.TELEGRAM_BOT_TOKEN) return error(400, 'no_bot_token');
  const chat = url.searchParams.get('chat') || env.SUPPORT_CHAT_ID;
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: '✅ Проверка связи: бот СМЭШ AI работает.' })
  });
  return json(await res.json());
}

// Diagnostics: returns the last update the webhook processed and what the bot
// did with it. Guarded by the webhook secret.
//   GET /telegram/debug?secret=<TELEGRAM_WEBHOOK_SECRET>
async function handleTelegramDebug(request, env) {
  const url = new URL(request.url);
  if (!env.TELEGRAM_WEBHOOK_SECRET || url.searchParams.get('secret') !== env.TELEGRAM_WEBHOOK_SECRET) {
    return error(401, 'unauthorized');
  }
  const last = await env.LICENSES.get('tgdebug:last');
  return json({ ok: true, last: last ? JSON.parse(last) : null });
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

  // The order page should thread signed delivery data through Shp_* params, or
  // pre-register order:<InvId> in KV. EMail from Robokassa is a last fallback.
  const contact = await resolveRobokassaContact(env, fields, n.invoice_id);
  if (!contact.email && !contact.telegram_user_id) {
    console.error('robokassa: payment without delivery contact', n.payment_id);
    return robokassa.okResponse(n.invoice_id);
  }

  // An amount that clears the hard floor but no plan threshold is not a
  // purchase — ack without issuing so Robokassa does not retry forever.
  const plan = planFromAmount(env, n.amount_rub);
  if (!plan) return robokassa.okResponse(n.invoice_id);
  const isPreorder = isPreorderNow();

  const license = await issueLicense(env, {
    gateway: 'robokassa',
    payment_id: n.payment_id,     // InvId must be unique per order
    email: contact.email,
    telegram_user_id: contact.telegram_user_id,
    type: plan.type,
    expires_at: plan.expires_at,
    amount_rub: n.amount_rub,
    is_preorder: isPreorder
  });

  ctx.waitUntil(deliverKey(env, license, isPreorder));
  return robokassa.okResponse(n.invoice_id);
}

/**
 * Resolve the delivery contact from Robokassa ResultURL fields. Prefer signed
 * Shp_* fields, then an order record in KV, then Robokassa's EMail fallback.
 */
async function resolveRobokassaContact(env, fields, invoiceId) {
  const email = cleanEmail(fields.Shp_email) || cleanEmail(fields.Shp_Email);
  const telegram_user_id = cleanTelegramUserId(fields.Shp_telegram_user_id || fields.Shp_tg_user_id);
  const orderId = cleanOrderId(fields.Shp_order_id || fields.Shp_order || invoiceId);
  let stored = {};

  try {
    const raw = orderId ? await env.LICENSES.get(`order:${orderId}`) : null;
    if (raw) {
      const o = JSON.parse(raw);
      stored = {
        email: cleanEmail(o.email),
        telegram_user_id: cleanTelegramUserId(o.telegram_user_id)
      };
    }
  } catch { /* not JSON / not found */ }

  return {
    email: email || stored.email || cleanEmail(fields.EMail) || cleanEmail(fields.Email),
    telegram_user_id: telegram_user_id || stored.telegram_user_id || null
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

/* ------------------------------- /admin ------------------------------ */

function adminGuard(request, env) {
  const token = request.headers.get('x-admin-token') || '';
  if (!env.ADMIN_SECRET) return false;
  // Constant-time compare to avoid timing leaks. Equal-length check first;
  // mismatched lengths can short-circuit safely (no secret leakage).
  if (token.length !== env.ADMIN_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ env.ADMIN_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

async function handleAdminIssue(request, env) {
  if (!adminGuard(request, env)) return error(401, 'unauthorized');
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
  if (!adminGuard(request, env)) return error(401, 'unauthorized');
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
  if (!adminGuard(request, env)) return error(401, 'unauthorized');
  const url = new URL(request.url);
  const key = normalizeKey(url.searchParams.get('key') || '');
  if (!key) return error(400, 'missing_key');
  const license = await getLicense(env, key);
  if (!license) return error(404, 'not_found');
  return json({ ok: true, license });
}
