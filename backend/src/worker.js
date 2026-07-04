/**
 * СМЭШ AI license backend.
 *
 * Routes:
 *   POST /webhook/yookassa   YooKassa notification, auto-issues a license
 *   POST /webhook/yoomoney   YooMoney wallet notification, auto-issues a license
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
import { isYookassaIp, checkBasicAuth, parseNotification, verifyPayment } from './gateways/yookassa.js';
import * as yoomoney from './gateways/yoomoney.js';
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
      if (path === '/webhook/yookassa' && method === 'POST') return await handleYookassa(request, env, ctx);
      if (path === '/webhook/yoomoney' && method === 'POST') return await handleYoomoney(request, env, ctx);

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

/* -------------------------- /webhook/yookassa ------------------------ */

async function handleYookassa(request, env, ctx) {
  // YooKassa expects a 200 within ~10 seconds, otherwise it retries. The
  // delivery I/O (email + Telegram) can be slow, so it's run after the
  // response goes out via ctx.waitUntil.
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!isYookassaIp(ip)) {
    console.warn('yookassa: rejected ip', ip);
    return error(403, 'forbidden');
  }
  if (!checkBasicAuth(request, env)) {
    console.warn('yookassa: bad basic auth');
    return error(401, 'unauthorized');
  }

  let payload;
  try { payload = await request.json(); }
  catch { return error(400, 'bad_json'); }

  const parsed = parseNotification(payload);
  // Non-actionable events (canceled, refunded) — ack 200 so YooKassa stops
  // retrying. Refund handling will live in a future revision.
  if (!parsed) return json({ ok: true, ignored: true });

  // Sanity guard: never auto-issue if the order page didn't carry an email
  // OR a telegram_user_id through metadata. Without either we have no
  // delivery channel.
  if (!parsed.email && !parsed.telegram_user_id) {
    console.error('yookassa: payment without delivery contact', parsed.payment_id);
    return json({ ok: true, ignored: true, note: 'no_contact' });
  }

  // Don't trust the amount/status in the webhook body — confirm the payment
  // server-side against YooKassa's API before issuing (see verifyPayment).
  // Falls back to the notification amount only when shop creds aren't set.
  const confirmed = await verifyPayment(env, parsed.payment_id);
  if (!confirmed.ok) {
    console.error('yookassa: payment verification failed', parsed.payment_id, confirmed.reason);
    return error(400, 'payment_unverified');
  }
  if (confirmed.skipped) console.warn('yookassa: issuing WITHOUT server-side verification (set YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY)');
  const amountRub = confirmed.skipped ? parsed.amount_rub : confirmed.amount_rub;

  const floor = minPaymentRub(env);
  if (floor > 0 && amountRub < floor) {
    console.warn('yookassa: amount below floor, not issuing', parsed.payment_id, amountRub);
    return json({ ok: true, ignored: true, note: 'amount_below_min' });
  }

  // Decide product (lifetime vs a fixed-length subscription) from the confirmed
  // amount. Defaults keep everything lifetime unless SUBSCRIPTION_* is set.
  const plan = planFromAmount(env, amountRub);
  if (!plan) return json({ ok: true, ignored: true, note: 'amount_below_plan' });
  const isPreorder = isPreorderNow();

  const license = await issueLicense(env, {
    gateway: 'yookassa',
    payment_id: parsed.payment_id,
    email: parsed.email,
    telegram_user_id: parsed.telegram_user_id,
    type: plan.type,
    expires_at: plan.expires_at,
    amount_rub: amountRub,
    is_preorder: isPreorder
  });

  ctx.waitUntil(deliverKey(env, license, isPreorder));
  return json({ ok: true, key_issued: true });
}

/* -------------------------- /webhook/yoomoney ------------------------ */

async function handleYoomoney(request, env, ctx) {
  // YooMoney posts application/x-www-form-urlencoded. There is no stable IP
  // range to allowlist, so the SHA-1 signature is the ONLY authenticity gate —
  // verify it first and fail closed on any mismatch or unset secret.
  let form;
  try { form = await request.formData(); }
  catch { return error(400, 'bad_form'); }

  const fields = yoomoney.parseForm(form);
  const signed = await yoomoney.verifyNotification(fields, env.YOOMONEY_NOTIFICATION_SECRET);
  if (!signed) {
    console.warn('yoomoney: bad signature', fields.operation_id || '(no id)');
    return error(403, 'bad_signature');
  }

  const n = yoomoney.normalize(fields);
  // Signed but not fulfillable (test ping, protected/unaccepted payment, wrong
  // currency): ack 200 so YooMoney stops retrying, but don't issue.
  if (!n.ok) return json({ ok: true, ignored: true, note: n.reason });

  // YooMoney's `amount` is credited NET of its commission (up to ~3% on card
  // payments), so a buyer who pays exactly the 199₽/990₽ sticker price arrives
  // BELOW it (~193₽/~960₽) — failing the floor (paid but no key) or demoting a
  // lifetime purchase to a subscription. Gross the net amount back up by the
  // worst-case fee before the floor and plan checks; the license record keeps
  // the real net amount. (`withdraw_amount` carries the gross figure but is NOT
  // covered by the SHA-1 signature, so it can't be trusted for this decision.)
  const feePct = Math.min(Math.max(Number(env.YOOMONEY_FEE_PCT ?? 5), 0), 30);
  const grossRub = n.amount_rub / (1 - feePct / 100);

  // The Quickpay form's receiver/sum/label are plain client-side fields: anyone
  // can resubmit the form with sum=1 and their own email in label, and YooMoney
  // signs that notification like any real payment. The floor is what makes a
  // signed payment a purchase — below it we ack without issuing.
  const floor = minPaymentRub(env);
  if (floor > 0 && grossRub < floor) {
    console.warn('yoomoney: amount below floor, not issuing', n.payment_id, n.amount_rub);
    return json({ ok: true, ignored: true, note: 'amount_below_min' });
  }
  if (floor <= 0) console.warn('yoomoney: NO payment floor configured — set MIN_PAYMENT_RUB or any signed amount (1₽) issues a license');

  // The order page threads the buyer's contact through `label`. Resolve it to
  // an email and/or a telegram_user_id (order-id lookup supported too).
  const contact = await resolveYoomoneyContact(env, n.label);
  if (!contact.email && !contact.telegram_user_id) {
    console.error('yoomoney: payment without delivery contact', n.payment_id);
    return json({ ok: true, ignored: true, note: 'no_contact' });
  }

  // Same null guard as the YooKassa handler: an amount that clears the hard
  // floor but no plan threshold is not a purchase — ack without issuing (a
  // thrown `plan.type` here would 500 and put YooMoney into a retry loop).
  const plan = planFromAmount(env, grossRub);
  if (!plan) return json({ ok: true, ignored: true, note: 'amount_below_plan' });
  const isPreorder = isPreorderNow();

  const license = await issueLicense(env, {
    gateway: 'yoomoney',
    payment_id: n.payment_id,     // operation_id → idempotent, replay-safe
    email: contact.email,
    telegram_user_id: contact.telegram_user_id,
    type: plan.type,
    expires_at: plan.expires_at,
    amount_rub: n.amount_rub,
    is_preorder: isPreorder
  });

  ctx.waitUntil(deliverKey(env, license, isPreorder));
  return json({ ok: true, key_issued: true });
}

/**
 * Resolve the delivery contact from a YooMoney `label`. Two supported shapes:
 *  - a bare email  ("student@example.com")  → deliver there directly;
 *  - an order id you registered on the pay page → look up `order:<id>` in KV,
 *    which the order page wrote as { email, telegram_user_id } (short TTL).
 * A label that is neither yields no contact and the caller acks-without-issuing.
 */
async function resolveYoomoneyContact(env, label) {
  const raw = (label || '').trim();
  if (!raw) return {};
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return { email: raw, telegram_user_id: null };
  try {
    const stored = await env.LICENSES.get(`order:${raw}`);
    if (stored) {
      const o = JSON.parse(stored);
      return {
        email: typeof o.email === 'string' ? o.email : null,
        telegram_user_id: o.telegram_user_id ? Number(o.telegram_user_id) : null
      };
    }
  } catch { /* not JSON / not found */ }
  return {};
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
