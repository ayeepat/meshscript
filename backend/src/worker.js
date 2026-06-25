/**
 * СМЭШ AI license backend.
 *
 * Routes:
 *   POST /webhook/yookassa   YooKassa notification, auto-issues a license
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
import { isYookassaIp, checkBasicAuth, parseNotification } from './gateways/yookassa.js';
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

  // Decide product type from the amount. For now everything is lifetime;
  // when subscriptions launch we'll branch on amount or on a metadata field.
  const type = env.DEFAULT_LICENSE_TYPE || 'lifetime';
  const isPreorder = isPreorderNow();

  const license = await issueLicense(env, {
    gateway: 'yookassa',
    payment_id: parsed.payment_id,
    email: parsed.email,
    telegram_user_id: parsed.telegram_user_id,
    type,
    amount_rub: parsed.amount_rub,
    is_preorder: isPreorder
  });

  ctx.waitUntil(deliverKey(env, license, isPreorder));
  return json({ ok: true, key_issued: true });
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
