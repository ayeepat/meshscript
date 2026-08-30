/**
 * СМЭШ AI license backend.
 *
 * Routes:
 *   POST/GET /webhook/robokassa  Robokassa ResultURL notification, auto-issues a license
 *   POST /verify             Extension calls this; returns active|expired|...
 *   POST /ai/chat            Disabled legacy proxy; production AI runs on the VPS
 *   POST /gdz/fetch          License-gated GDZ proxy (see gdz.js): the extension
 *                            has no GDZ host permissions and no DNR rule
 *   POST /referral/code      Get/create this device's referral code
 *   GET  /referral/check     Validate a code at checkout (before charging)
 *   POST /referral/status    Referral stats + reward key (device capability required)
 *                            (all three answer `coming_soon` while the referral
 *                            programme is switched off — see REFERRALS_ENABLED)
 *   GET  /admin/health       Readiness: bindings, schema, payment config
 *   POST /admin/issue        Manual issuance (testing, comp licenses)
 *   POST /admin/revoke       Revoke a key (refunds, fraud)
 *   GET  /admin/license      Inspect one license by key
 *   GET  /admin/referral     Inspect a referral record by code or device
 *   POST /admin/referral/retry-pending  Recover durable incomplete referral credits
 *   POST /telegram/webhook   Bot: /sub subscription card and device release,
 *                            user tickets → owner, replies → user
 *   POST /checkout/session   Create a short-lived server-priced checkout
 *   POST /checkout/status    Poll checkout/payment/delivery state by capability
 *   POST /checkout/payment   Create signed hosted-payment fields after Telegram binding
 *   GET  /health             Liveness ping
 *
 * Everything else 404s. CORS is wide-open only on the public extension APIs
 * (/verify, /ai/chat, /referral/* and opt-in telemetry); no route uses cookies.
 * Admin browser access is restricted to the configured dashboard origin.
 */

import {
  issueLicense, recoverPaymentLicense, verifyLicense, deactivateLicense,
  getLicense, revokeLicense, revokeLicenseDurable, normalizeKey, normalizeExpiry,
  deviceLimitConfigValid
} from './licenses.js';
import { handleAiChat } from './ai-proxy.js';
import { handleGdzFetch } from './gdz.js';
import * as referrals from './referrals.js';
import * as analytics from './analytics.js';
import * as robokassa from './gateways/robokassa.js';
import * as payments from './payments.js';
import { sendLicenseEmail } from './delivery/email.js';
import { sendLicenseTelegram } from './delivery/telegram.js';
import { processCheckoutStart } from './delivery/checkout.js';
import {
  processSupportUpdate, retryPendingSupportForwards,
  supportConfigValid, SUPPORT_FORWARD_MAX_ATTEMPTS
} from './delivery/support.js';
import {
  processSubscriptionUpdate, pruneSubscriptionLifecycle,
  sweepSubscriptionNotifications, SUBSCRIPTION_NOTIFY_MAX_ATTEMPTS
} from './delivery/subscription.js';
import { readJsonBounded } from './request-body.js';
import {
  issueTelemetryToken, verifyTelemetryToken, issueErasureToken, verifyErasureToken
} from './telemetry-token.js';
import {
  configuredWriteEpoch, enforceRuntimeWriteFence, isRuntimeWriteFenceError
} from './write-fence.js';

const VERIFY_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // Public extension endpoints accept JSON only. Admin routes are deliberately
  // CLI/server-to-server only and must not be callable by a static website —
  // with ONE exception: the owner analytics dashboard (see statsCors below).
  'Access-Control-Allow-Headers': 'Content-Type, X-Telemetry-Token, X-Erasure-Token',
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Stats-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// The exact route set the dashboard is allowed to reach from a browser.
const isStatsPath = (path) => path.startsWith('/admin/stats/');

const isPublicExtensionPath = (path) =>
  path === '/verify' || path === '/deactivate' || path === '/ai/chat' || path === '/gdz/fetch' ||
  path.startsWith('/referral/') ||
  path === '/payments/robokassa/order' || path.startsWith('/checkout/') ||
  path === '/t' || path === '/t/ai' || path === '/t/delete';

function backupMaintenanceEnabled(env) {
  return String(env.BACKUP_MAINTENANCE || '').trim().toLowerCase() === 'true';
}

function legacyAiProxyEnabled(env) {
  return String(env.AI_PROXY_LEGACY_ENABLED || '').trim().toLowerCase() === 'true';
}

function maintenanceHeaders(request, env, path) {
  const headers = { 'Retry-After': '120' };
  if (isPublicExtensionPath(path)) Object.assign(headers, VERIFY_CORS);
  else if (isStatsPath(path)) Object.assign(headers, statsCors(request, env) || {});
  return headers;
}

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  status: init.status || 200,
  // Every response here is a dynamic API verdict (license status, referral,
  // admin stats) — none should be cached. Default no-store so a license verdict
  // can't be served stale by a heuristic browser/intermediary cache; callers may
  // still override via init.headers.
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(init.headers || {}) }
});

const error = (status, reason, headers = {}) => json({ ok: false, reason }, { status, headers });

const SECRET_ENCODER = new TextEncoder();

function safeErrorText(errorValue, env = {}) {
  let text = String(errorValue?.stack || errorValue || 'error');
  // Telegram embeds the bot token in the request path. Fetch failures may
  // include that URL in their stack/cause, so redact both the path shape and
  // every configured credential that could plausibly appear in an error.
  text = text.replace(/\/bot[^/\s]+/gi, '/bot[REDACTED]');
  for (const name of [
    'ADMIN_SECRET', 'STATS_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
    'ROBOKASSA_PASSWORD1', 'ROBOKASSA_PASSWORD2',
    'ROBOKASSA_PASSWORD1_PRODUCTION', 'ROBOKASSA_PASSWORD2_PRODUCTION',
    'ROBOKASSA_PASSWORD1_TEST', 'ROBOKASSA_PASSWORD2_TEST',
    'ROBOKASSA_PASSWORD3_PRODUCTION', 'ROBOKASSA_PASSWORD3_TEST', 'RESEND_API_KEY',
    'AI_PROXY_API_KEY', 'INGEST_KEY', 'CHECKOUT_CAPABILITY_SECRET',
    'CHECKOUT_PROMO_CODE', 'CHECKOUT_PROMO2_CODE', 'OWNER_LICENSE_KEY'
  ]) {
    const secret = String(env[name] || '');
    if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text.slice(0, 2000);
}

async function readUpstreamJson(res, maxBytes = 64 * 1024) {
  const parsed = await readJsonBounded(res, maxBytes);
  return parsed.ok && parsed.value && typeof parsed.value === 'object'
    ? parsed.value
    : { ok: false, error_code: 'invalid_upstream_response', status: res.status };
}

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
  async fetch(request, rawEnv, ctx) {
    // The wrapper performs a fresh durable authorization immediately before
    // every D1/KV mutation. This is intentionally per-write rather than an
    // entry check: an invocation retains rawEnv from the deployment that
    // started it and may still be waiting on a request body during rollout.
    const env = enforceRuntimeWriteFence(rawEnv);
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === 'OPTIONS') {
      // Stats preflights from the dashboard origin must whitelist the
      // read-only X-Stats-Token header; every other preflight keeps the public set
      // (which deliberately does NOT allow the admin header).
      const cors = isStatsPath(path) ? statsCors(request, env) : null;
      return new Response(null, { headers: cors || VERIFY_CORS });
    }

    try {
      if (path === '/health') return json({ ok: true, maintenance: backupMaintenanceEnabled(env) });
      // Readiness remains reachable while writes are gated so an operator can
      // prove that the 100%-deployed maintenance version is active before a
      // cross-store backup. It deliberately reports 503/red in that state.
      if (path === '/admin/health' && method === 'GET') return await handleAdminHealth(request, env);
      if (backupMaintenanceEnabled(env)) {
        return error(503, 'maintenance', maintenanceHeaders(request, env, path));
      }

      if (path === '/verify' && method === 'POST') return await handleVerify(request, env);
      if (path === '/deactivate' && method === 'POST') return await handleDeactivate(request, env);
      if (path === '/ai/chat' && method === 'POST') {
        if (!legacyAiProxyEnabled(env)) return error(410, 'legacy_ai_proxy_disabled', VERIFY_CORS);
        return await handleAiChat(request, env);
      }
      if (path === '/gdz/fetch' && method === 'POST') return await handleGdzFetch(request, env, ctx);
      if (path === '/webhook/robokassa' && (method === 'POST' || method === 'GET')) {
        return await handleRobokassa(request, env, ctx);
      }
      if (path === '/payments/robokassa/order' && method === 'POST') {
        // The retired route trusted a browser-supplied Telegram id. Make the
        // exceptional compatibility path opt-in, never fail-open on an unset
        // or misspelled flag.
        if (String(env.LEGACY_PAYMENT_ORDER_ENABLED || '').trim().toLowerCase() !== 'true') {
          return error(410, 'legacy_checkout_disabled', VERIFY_CORS);
        }
        return await handleCreateRobokassaOrder(request, env);
      }
      if (path === '/checkout/session' && method === 'POST') {
        return await handleCreateCheckoutSession(request, env);
      }
      if (path === '/checkout/status' && method === 'POST') {
        return await handleCheckoutStatus(request, env);
      }
      if (path === '/checkout/payment' && method === 'POST') {
        return await handleCreateCheckoutPayment(request, env);
      }

      if (path === '/referral/code' && method === 'POST') return await handleReferralCode(request, env);
      if (path === '/referral/check' && method === 'GET') return await handleReferralCheck(request, env);
      if (path === '/referral/status' && method === 'POST') return await handleReferralStatus(request, env);

      if (path === '/t' && method === 'POST') return await handleTelemetry(request, env);
      if (path === '/t/ai' && method === 'POST') return await handleServerTelemetry(request, env);
      if (path === '/t/delete' && method === 'POST') return await handleTelemetryDelete(request, env);
      if (path.startsWith('/admin/stats/') && method === 'GET') return await handleAdminStats(request, env, path);
      if (path === '/admin/backfill-licenses' && method === 'POST') return await handleAdminBackfill(request, env);

      if (path === '/admin/issue' && method === 'POST') return await handleAdminIssue(request, env);
      if (path === '/admin/revoke' && method === 'POST') return await handleAdminRevoke(request, env);
      if (path === '/admin/payment-review/resolve' && method === 'POST') {
        return await handleAdminPaymentReviewResolve(request, env);
      }
      if (path === '/admin/payment/reconcile' && method === 'POST') {
        return await handleAdminPaymentReconcile(request, env, ctx);
      }
      if (path === '/admin/payment/refund' && method === 'POST') {
        return await handleAdminPaymentRefund(request, env);
      }
      if (path === '/admin/license' && method === 'GET') return await handleAdminLicense(request, env);
      if (path === '/admin/referral' && method === 'GET') return await handleAdminReferral(request, env);
      if (path === '/admin/referral/retry-pending' && method === 'POST') {
        return await handleAdminReferralRetryPending(request, env);
      }

      if (path === '/telegram/webhook' && method === 'POST') return await handleTelegramWebhook(request, env, ctx);
      if (path === '/telegram/setup' && method === 'POST') return await handleTelegramSetup(request, env);
      if (path === '/telegram/info' && method === 'GET') return await handleTelegramInfo(request, env);
      if (path === '/telegram/test' && method === 'POST') return await handleTelegramTest(request, env);
      if (path === '/telegram/debug' && method === 'GET') return await handleTelegramDebug(request, env);

      return error(404, 'not_found');
    } catch (e) {
      if (isRuntimeWriteFenceError(e)) {
        const reason = backupMaintenanceEnabled(env) ? 'maintenance' : 'service_unavailable';
        return error(503, reason, maintenanceHeaders(request, env, path));
      }
      // Don't leak internals back to the caller; logs land in `wrangler tail`.
      console.error('worker exception', safeErrorText(e, env));
      return error(500, 'server_error');
    }
  },

  // Cron trigger (wrangler.toml [triggers]): the durable retry channel for
  // work the request path could only attempt, never guarantee. Each sweep is
  // bounded and idempotent, so overlapping or skipped runs are harmless.
  async scheduled(event, rawEnv, ctx) {
    const env = enforceRuntimeWriteFence(rawEnv);
    // A backup spans KV and D1, which cannot share a transaction. Suppress
    // every new scheduled writer for the entire maintenance window; the
    // runbook also drains any invocation from the prior deployment before it
    // begins either export.
    if (backupMaintenanceEnabled(env)) return;
    ctx.waitUntil((async () => {
      try { await retryPendingDeliveries(env); }
      catch (e) { console.error('delivery retry sweep failed', safeErrorText(e, env)); }
      try { await retryPendingSupportForwards(env); }
      catch (e) { console.error('support retry sweep failed', safeErrorText(e, env)); }
      // Expiry reminders and the win-back survey. Every row is claimed before a
      // send, so a five-minute cadence is what makes "ten minutes after expiry"
      // land within a five-minute window rather than whenever traffic happens.
      try { await sweepSubscriptionNotifications(env); }
      catch (e) { console.error('subscription notification sweep failed', safeErrorText(e, env)); }
      try { await referrals.retryPendingReferralCredits(env, 50); }
      catch (e) { console.error('referral retry sweep failed', safeErrorText(e, env)); }
      try {
        const reconciliation = await payments.reconcileDueRobokassaOrders(env, 10);
        for (const paid of reconciliation.paid) {
          try {
            const response = await settleReconciledRobokassaPayment(env, ctx, paid);
            if (!response.ok) {
              console.error('automatic payment fulfillment needs review', paid.order?.order_id, response.status);
            }
          } catch (e) {
            console.error('automatic payment fulfillment failed', paid.order?.order_id, safeErrorText(e, env));
          }
        }
      } catch (e) { console.error('payment reconciliation sweep failed', safeErrorText(e, env)); }
      try {
        const refunds = await payments.inspectPendingRefunds(env, 20);
        for (const refund of refunds) {
          // Isolated per item: one order that cannot be revoked or finalized
          // must not stop the refunds behind it from settling.
          try {
            // The durable D1 revocation must exist BEFORE the money is
            // declared returned. revokeLicenseDurable derives the revocation
            // from the authoritative payment_issuance key and throws unless
            // the row is provably present, so a missing or malformed KV
            // projection can no longer produce a refunded order with a live
            // entitlement behind it.
            const revocation = await revokeLicenseDurable(
              env, refund.license_key, 'robokassa_refund'
            );
            if (!revocation.ok) {
              throw new Error(`refund revocation rejected: ${revocation.reason}`);
            }
            await referrals.reverseReferralCreditForPurchase(env, refund.license_key);
            await payments.finalizeRobokassaRefund(env, refund);
          } catch (e) {
            console.error('refund settlement failed', refund.order_id, safeErrorText(e, env));
            await payments.recordRefundPollFailure(env, refund.order_id, e);
          }
        }
      } catch (e) { console.error('refund state sweep failed', safeErrorText(e, env)); }
      try { await payments.pruneExpiredPaymentOrders(env); }
      catch (e) { console.error('payment order prune failed', safeErrorText(e, env)); }
      try { await pruneTelegramUpdates(env); }
      catch (e) { console.error('telegram update prune failed', safeErrorText(e, env)); }
      try { await pruneSubscriptionLifecycle(env); }
      catch (e) { console.error('subscription lifecycle prune failed', safeErrorText(e, env)); }
      // Identifier lifecycle: expire raw-IP/device budget rows, stale quota
      // days, and aged deletion tombstones (see pruneExpiredAnalytics).
      try { await analytics.pruneExpiredAnalytics(env); }
      catch (e) { console.error('analytics prune failed', safeErrorText(e, env)); }
    })());
  }
};

/* ------------------------------ /verify ------------------------------ */

async function handleVerify(request, env) {
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) {
    return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json', VERIFY_CORS);
  }
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_json', VERIFY_CORS);
  const key = typeof body.key === 'string' ? body.key : '';
  const suppliedDeviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
  const deviceId = referrals.cleanPublicDeviceId(body.device_id);
  // The UUID names an installation but is not its authenticator. The first
  // successful verify receives an activation capability; every later verify
  // must send it so a copied key cannot silently take over device №1.
  if (!suppliedDeviceId) return error(400, 'missing_device', VERIFY_CORS);
  if (!deviceId) return error(400, 'bad_device', VERIFY_CORS);
  // Malformed credentials are rejected by normalizeKey without touching KV,
  // so they do not need an expensive-lookup reservation.
  if (!normalizeKey(key)) {
    return json({ ok: false, reason: 'not_found' }, { headers: VERIFY_CORS });
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const admission = await reserveVerifyLookup(env, ip);
  if (admission.status === 'rate_limited') return error(429, 'rate_limited', VERIFY_CORS);
  if (admission.status !== 'allowed') return error(503, 'service_unavailable', VERIFY_CORS);

  let result;
  try {
    const activationToken = typeof body.activation_token === 'string'
      ? body.activation_token.trim()
      : '';
    // Strict `true` only: the flag says "the user just typed this key here",
    // which is the sole way past a remote-release fence. Anything looser would
    // let a stale background revalidation claim the intent by accident.
    result = await verifyLicense(env, key, deviceId, activationToken, {
      intent: body.activation_intent === true
    });
  } catch (e) {
    // A reservation is a charge only for a completed anonymous miss. Storage
    // exceptions can happen after D1 has claimed a device slot but before KV
    // materialization; refund those paths too and return the same fail-closed
    // public outage contract as an explicit service_unavailable verdict.
    await refundVerifyLookup(env, admission);
    console.error('license verification failed', safeErrorText(e, env));
    return error(503, 'service_unavailable', VERIFY_CORS);
  }
  // The reservation becomes a permanent failure charge only for an anonymous
  // miss. Every recognized entitlement verdict (including expired/revoked) and
  // every backend outage refunds it atomically. Reserving before KV is what
  // makes the limit actually cap both lookups and the valid-vs-invalid oracle.
  if (result.ok || result.reason !== 'not_found') {
    await refundVerifyLookup(env, admission);
  }
  let response = result;
  if (result.ok) {
    // Telemetry is optional and must never turn a valid entitlement into an
    // outage. Readiness still reports a missing/broken INGEST_KEY, while the
    // paid license path remains available and simply omits the capability.
    try {
      const [telemetry, erasure] = await Promise.all([
        issueTelemetryToken(env, deviceId),
        issueErasureToken(env, deviceId)
      ]);
      if (telemetry || erasure) {
        response = {
          ...result,
          ...(telemetry ? {
            telemetry_token: telemetry.token,
            telemetry_token_expires_at: telemetry.expires_at
          } : {}),
          ...(erasure ? {
            erasure_token: erasure.token,
            erasure_token_expires_at: erasure.expires_at
          } : {})
        };
      }
    } catch (e) {
      console.error('telemetry token issuance failed', safeErrorText(e, env));
    }
  }
  return json(response, {
    status: result.reason === 'service_unavailable' ? 503 : 200,
    headers: VERIFY_CORS
  });
}

/* ---------------------------- /deactivate ---------------------------- */

async function handleDeactivate(request, env) {
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) {
    return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json', VERIFY_CORS);
  }
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return error(400, 'bad_json', VERIFY_CORS);
  }
  const key = typeof body.key === 'string' ? body.key : '';
  const deviceId = referrals.cleanPublicDeviceId(body.device_id);
  const activationToken = typeof body.activation_token === 'string'
    ? body.activation_token.trim()
    : '';
  if (!normalizeKey(key)) return error(400, 'bad_key', VERIFY_CORS);
  if (!deviceId) return error(400, 'bad_device', VERIFY_CORS);
  if (!/^[A-Za-z0-9_-]{43}$/.test(activationToken)) {
    return error(403, 'bad_activation', VERIFY_CORS);
  }

  // A random but well-formed capability still makes deactivateLicense perform
  // an UPDATE plus a SELECT. Reserve from the same anonymous licence-credential
  // budget as /verify before touching D1, otherwise this public endpoint is an
  // unbounded write-amplification path. Successful and outage verdicts are not
  // abuse and give the reservation back.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const admission = await reserveVerifyLookup(env, ip);
  if (admission.status === 'rate_limited') return error(429, 'rate_limited', VERIFY_CORS);
  if (admission.status !== 'allowed') return error(503, 'service_unavailable', VERIFY_CORS);
  const result = await deactivateLicense(env, key, deviceId, activationToken);
  if (result.ok || result.reason === 'service_unavailable') {
    await refundVerifyLookup(env, admission);
  }
  const status = result.ok ? 200 : (
    result.reason === 'service_unavailable' ? 503 :
    result.reason === 'activation_mismatch' ? 403 : 400
  );
  return json(result, { status, headers: VERIFY_CORS });
}

const VERIFY_FAIL_DAILY_LIMIT = 200;
const VERIFY_BLOCK_CACHE_MS = 5 * 1000;
const verifyBlockedIps = new Map(); // raw IP -> { day, until }; bounded below

// Reserve before the KV lookup. A short negative cache protects D1 during a
// sustained blocked flood but expires quickly because concurrent valid verdicts
// may refund the shared count in another isolate.
async function reserveVerifyLookup(env, ip) {
  if (!env.DB) return { status: 'unavailable' };
  const day = analytics.mskDay();
  const cached = verifyBlockedIps.get(ip);
  if (cached?.day === day && cached.until > Date.now()) return { status: 'rate_limited' };
  if (cached) verifyBlockedIps.delete(ip);
  try {
    const count = await analytics.reserveDailyBudget(
      env, day, 'verify_fail', ip, 1, VERIFY_FAIL_DAILY_LIMIT
    );
    if (count > VERIFY_FAIL_DAILY_LIMIT) {
      if (verifyBlockedIps.size >= 10_000) verifyBlockedIps.clear();
      verifyBlockedIps.set(ip, { day, until: Date.now() + VERIFY_BLOCK_CACHE_MS });
      return { status: 'rate_limited' };
    }
    return { status: 'allowed', day, ip };
  } catch (e) {
    console.error('verify lookup reservation unavailable', safeErrorText(e, env));
    return { status: 'unavailable' };
  }
}

async function refundVerifyLookup(env, reservation) {
  try {
    await analytics.releaseDailyBudget(
      env, reservation.day, 'verify_fail', reservation.ip, 1
    );
    verifyBlockedIps.delete(reservation.ip);
  } catch (e) {
    // Never turn a valid entitlement into an error after verification. A lost
    // refund fails closed by over-counting this IP; monitoring still sees D1.
    console.error('verify lookup refund unavailable', safeErrorText(e, env));
  }
}

/* ----------------------------- /referral/* ---------------------------- */
// Called by the extension (settings page) and the checkout page, so they
// share /verify's open CORS. The device id only locates a record; code/status
// also require the install's independent 256-bit referral capability. Only
// /referral/code writes (behind a per-IP daily budget). The real guarantee —
// one payout per paid license — is enforced in the payment webhook.

// «Пригласи друга» is switched OFF for everyone while the programme is
// finished. This is the whole kill switch: the Worker is the only way in, so
// refusing the three public routes here plus the checkout bonus below stops
// every new referral effect. referrals.js, its storage layout and its payout
// ledger are untouched, so switching back on restores the feature with no code
// change at all — and the referral regression suite keeps covering those live
// paths by opting in through this same binding.
//
// Unset means OFF: the programme must never come back by accident, and a
// Worker deployed without the var is a Worker nobody meant to turn on.
// wrangler.toml pins it to "false" so the deployed state is visible in git.
//
// Deliberately still ON: /admin/referral*, the pending-credit sweep and the
// refund reversal. Days promised BEFORE the switch must still settle and still
// unwind on a refund; only NEW referral value is refused.
//
// Keep in sync with src/lib/config.js REFERRALS_ENABLED, which hides the
// extension's card. A live backend behind a hidden card promises days nobody
// can find; a live card in front of a switched-off backend shows «нет связи».
const referralsEnabled = (env) => /^(1|true|on|yes)$/i.test(String(env?.REFERRALS_ENABLED ?? '').trim());

// One reason string across all three routes so the checkout page and the
// extension can tell "not yet" apart from "your code is wrong".
const REFERRALS_COMING_SOON = 'coming_soon';

async function handleReferralCode(request, env) {
  if (!referralsEnabled(env)) return error(503, REFERRALS_COMING_SOON, VERIFY_CORS);
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json', VERIFY_CORS);
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_json', VERIFY_CORS);
  const deviceId = referrals.cleanPublicDeviceId(body.device_id);
  if (!deviceId) return error(400, 'bad_device', VERIFY_CORS);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await referrals.bumpIpBudget(env, ip))) return error(429, 'rate_limited', VERIFY_CORS);
  const result = await referrals.getOrCreateCode(
    env, deviceId, body.license_key, body.referral_auth, body.known_code
  );
  const status = result.ok ? 200 : (result.reason === 'unauthorized' ? 403 :
    (result.reason === 'legacy_auth_required' ? 409 : 400));
  return json(result, { status, headers: VERIFY_CORS });
}

// /referral/check is unauthenticated and, for a well-formed code, performs a
// KV read plus up to three D1 statements (getJson's auth/claim/journal
// rebuild) before answering. Referral codes are public, so a valid code is not
// evidence of an authenticated caller: every storage-backed lookup consumes
// the same per-IP budget. Malformed codes never reach storage and are answered
// without a charge.
const REFERRAL_CHECK_DAILY_LIMIT = 200;

async function admitReferralCheck(env, ip) {
  if (!env.DB) return { status: 'unavailable' };
  const day = analytics.mskDay();
  try {
    const count = await analytics.bumpDailyBudget(
      env, day, 'ref_check', ip, 1, REFERRAL_CHECK_DAILY_LIMIT
    );
    return { status: count > REFERRAL_CHECK_DAILY_LIMIT ? 'rate_limited' : 'allowed' };
  } catch (e) {
    console.error('referral check admission unavailable', safeErrorText(e, env));
    return { status: 'unavailable' };
  }
}

async function handleReferralCheck(request, env) {
  // The checkout page asks before charging. Answer without touching storage or
  // the per-IP budget — there is nothing to look up — and say so explicitly:
  // `enabled:false` lets the page show «скоро» instead of «неверный код», and
  // a zero bonus stops it advertising days the webhook will not grant.
  if (!referralsEnabled(env)) {
    return json(
      { ok: true, enabled: false, valid: false, reason: REFERRALS_COMING_SOON, buyer_bonus_pct: 0 },
      { headers: VERIFY_CORS }
    );
  }
  const url = new URL(request.url);
  const rawCode = url.searchParams.get('code') || '';
  // Mirrors /verify's normalizeKey fast path: a malformed code is rejected by
  // normalizeRefCode without touching storage, so it needs no reservation.
  if (!referrals.normalizeRefCode(rawCode)) {
    return json(
      { ok: true, valid: false, reason: 'bad_code', buyer_bonus_pct: referrals.buyerBonusPct(env) },
      { headers: VERIFY_CORS }
    );
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const admission = await admitReferralCheck(env, ip);
  if (admission.status === 'rate_limited') return error(429, 'rate_limited', VERIFY_CORS);
  if (admission.status !== 'allowed') return error(503, 'service_unavailable', VERIFY_CORS);
  const result = await referrals.checkCode(env, rawCode);
  return json(result, { headers: VERIFY_CORS });
}

async function handleReferralStatus(request, env) {
  if (!referralsEnabled(env)) return error(503, REFERRALS_COMING_SOON, VERIFY_CORS);
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json', VERIFY_CORS);
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_json', VERIFY_CORS);
  const deviceId = referrals.cleanPublicDeviceId(body.device_id);
  if (!deviceId) return error(400, 'bad_device', VERIFY_CORS);
  const result = await referrals.referralStatus(env, deviceId, body.referral_auth);
  const status = result.ok ? 200 : (result.reason === 'unauthorized' ? 403 :
    (result.reason === 'legacy_auth_required' ? 409 : 400));
  return json(result, { status, headers: VERIFY_CORS });
}

/* ------------------------- /telegram/webhook ------------------------- */

async function handleTelegramWebhook(request, env, ctx) {
  // Telegram authenticates itself with the secret token registered at
  // setWebhook time (sent back in this header). Reject anything else so a
  // leaked URL can't be used to puppet the bot.
  // Fail closed on a missing secret. Treating "secret not configured" as
  // "authentication disabled" lets anyone forge Telegram update objects,
  // including an owner reply that makes the bot DM an arbitrary chat.
  if (!payments.telegramWebhookSecretValid(env)) {
    console.error('telegram webhook disabled: TELEGRAM_WEBHOOK_SECRET is missing or weak');
    return error(503, 'webhook_not_configured');
  }
  const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!(await constantTimeStringEqual(env.TELEGRAM_WEBHOOK_SECRET, got))) return error(401, 'unauthorized');

  // Telegram updates are normally only a few KiB. Bound even authenticated
  // requests so a leaked webhook secret or malformed upstream delivery cannot
  // turn JSON parsing/debug persistence into a memory spike. Always ack bad
  // input so Telegram does not retry it forever.
  const parsed = await readJsonBounded(request, 128 * 1024);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return json({ ok: true });
  }
  const update = parsed.value;

  // Telegram defines update_id so a receiver can ignore repeats, and it RETRIES
  // any delivery it does not see acknowledged. Claim the id before doing any
  // work: without this, a redelivery minted a second ticket, forwarded it to
  // the owner again and sent the user a second confirmation.
  const claim = await claimTelegramUpdate(env, update.update_id);
  if (claim.state === 'duplicate') {
    // Already processed. Ack so Telegram stops retrying, and do nothing else.
    return json({ ok: true, duplicate: true });
  }
  if (claim.state === 'in_flight') {
    // Another delivery of this same update is still being processed. Do NOT
    // ack: Telegram retrying after the lease expires is exactly the recovery
    // path we want if that delivery dies.
    return error(409, 'update_in_flight');
  }
  if (claim.state === 'invalid') {
    // Authenticated but not shaped like a Telegram update. There is no stable
    // id to claim and processSupportUpdate would ignore it anyway.
    return json({ ok: true, ignored: true });
  }
  if (claim.state === 'unavailable') {
    // External effects without the authoritative replay registry are unsafe:
    // Telegram can redeliver the same update after any lost response.
    return error(503, 'update_registry_unavailable');
  }

  // Do the work and AWAIT it (a couple of fast API calls) so the sends actually
  // complete before we ack — fire-and-forget proved unreliable here.
  let result;
  let failed = false;
  try {
    // Three surfaces, most specific first: the checkout deep link, then the
    // subscription commands and buttons, then support — which deliberately
    // treats anything left over as a ticket rather than losing it.
    const checkout = await processCheckoutStart(env, update);
    if (checkout.handled) {
      result = checkout;
    } else {
      const subscription = await processSubscriptionUpdate(env, update, {
        updateId: claim.updateId,
        claimVersion: claim.claimVersion
      });
      result = subscription.handled
        ? subscription
        : await processSupportUpdate(env, update, {
            updateId: claim.updateId,
            claimVersion: claim.claimVersion
          });
    }
  }
  catch (e) {
    const safeError = safeErrorText(e, env);
    result = { kind: 'error', error: safeError };
    failed = true;
    console.error('support', safeError);
  }
  // processSupportUpdate converts most internal failures (an unavailable
  // ticket counter, an unavailable rate-limit store) into a
  // 'service_unavailable' outcome plus a "temporarily unavailable" reply rather
  // than a thrown error. Those are still failures: acknowledging them drops the
  // student's message for good. The cost of retrying is one repeated apology
  // message per redelivery, which is plainly better than losing the ticket.
  if (RETRYABLE_SUPPORT_OUTCOMES.has(result?.kind)) failed = true;

  // Stash the last event for /telegram/debug (best-effort; never blocks the ack).
  ctx.waitUntil(env.LICENSES.put('tgdebug:last', JSON.stringify({
    at: new Date().toISOString(),
    incoming: summarizeUpdate(update),
    result
  }), { expirationTtl: 3600 }).catch(() => {}));

  if (failed) {
    // Release the claim and refuse the delivery so Telegram redelivers it.
    // Answering 200 here is what made a failed update unrecoverable.
    await releaseTelegramUpdate(env, claim.updateId, claim.claimVersion);
    return error(500, 'update_processing_failed');
  }
  // The completion write is what makes the dedupe durable, so a failed write
  // must NOT be acknowledged. Swallowing it left completed_at NULL while
  // answering 200: after the lease expired the update was processed again.
  // Refusing lets Telegram redeliver, and the ticket binding above makes that
  // redelivery reuse the same ticket, outbox row and confirmation state.
  if (!(await completeTelegramUpdate(
    env, claim.updateId, claim.claimVersion, result?.kind
  ))) {
    await releaseTelegramUpdate(env, claim.updateId, claim.claimVersion);
    return error(500, 'update_completion_failed');
  }
  return json({ ok: true });
}

const RETRYABLE_SUPPORT_OUTCOMES = new Set(['error', 'service_unavailable']);

// One delivery may hold an unfinished update for this long before a Telegram
// retry is allowed to take it over. Comfortably longer than the handful of
// awaited Bot API calls processSupportUpdate makes.
const TELEGRAM_UPDATE_LEASE_MS = 2 * 60 * 1000;
// Replays only matter for as long as Telegram will retry.
const TELEGRAM_UPDATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Claim one update_id for processing.
 *   'claimed'    — we own it; process, then complete or release.
 *   'duplicate'  — already completed; ack and do nothing.
 *   'in_flight'  — another live delivery owns it; refuse so Telegram retries.
 *   'invalid'    — no valid Telegram update_id; ack without effects.
 *   'unavailable'— replay authority is missing/down; refuse without effects.
 */
async function claimTelegramUpdate(env, rawUpdateId) {
  const updateId = Number(rawUpdateId);
  if (!Number.isSafeInteger(updateId)) {
    // Not a Telegram-shaped update. processSupportUpdate ignores these anyway,
    // and there is nothing stable to deduplicate on.
    return { state: 'invalid', updateId: null };
  }
  if (!env.DB) {
    console.error('telegram webhook: no D1 binding — refusing unbounded effects');
    return { state: 'unavailable', updateId };
  }
  const now = Date.now();
  try {
    const claimed = await env.DB.prepare(
      `INSERT INTO telegram_updates (update_id, claimed_at, lease_until)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(update_id) DO UPDATE SET
         claimed_at = CASE
           WHEN telegram_updates.claimed_at >= ?2 THEN telegram_updates.claimed_at + 1
           ELSE ?2
         END,
         lease_until = ?3
       WHERE telegram_updates.completed_at IS NULL
         AND telegram_updates.lease_until <= ?2
       RETURNING update_id, claimed_at`
    ).bind(updateId, now, now + TELEGRAM_UPDATE_LEASE_MS).first();
    if (claimed) {
      return {
        state: 'claimed', updateId,
        // claimed_at doubles as a monotonically increasing fencing token. A
        // stale worker cannot mutate a lease after a later retry takes over.
        claimVersion: Number(claimed.claimed_at)
      };
    }

    // The conditional upsert wrote nothing: the row is either finished or
    // still leased. One read tells the ack apart from the retry.
    const existing = await env.DB.prepare(
      'SELECT completed_at FROM telegram_updates WHERE update_id = ?1'
    ).bind(updateId).first();
    return {
      state: existing?.completed_at != null ? 'duplicate' : 'in_flight',
      updateId
    };
  } catch (e) {
    // A missing table (pre-migration) or a D1 blip must not silently drop a
    // student's support message.
    console.error('telegram update registry unavailable', safeErrorText(e, env));
    return { state: 'unavailable', updateId };
  }
}

// Returns true only when the update is provably marked complete. Callers must
// refuse the delivery otherwise — see the call site.
async function completeTelegramUpdate(env, updateId, claimVersion, kind) {
  if (!env.DB || updateId == null || !Number.isSafeInteger(claimVersion)) return false;
  try {
    const result = await env.DB.prepare(
      `UPDATE telegram_updates SET completed_at = ?2, result_kind = ?3, lease_until = 0
       WHERE update_id = ?1 AND claimed_at = ?4 AND completed_at IS NULL`
    ).bind(
      updateId, Date.now(), String(kind || '').slice(0, 64) || null, claimVersion
    ).run();
    return (result?.meta?.changes || 0) > 0;
  } catch (e) {
    console.error('telegram update completion write failed', safeErrorText(e, env));
    return false;
  }
}

async function releaseTelegramUpdate(env, updateId, claimVersion) {
  if (!env.DB || updateId == null || !Number.isSafeInteger(claimVersion)) return;
  try {
    await env.DB.prepare(
      `UPDATE telegram_updates SET lease_until = 0
       WHERE update_id = ?1 AND claimed_at = ?2 AND completed_at IS NULL`
    ).bind(updateId, claimVersion).run();
  } catch (e) {
    // Not fatal: the lease expires on its own and the retry proceeds then.
    console.error('telegram update release failed', safeErrorText(e, env));
  }
}

export async function pruneTelegramUpdates(env, now = Date.now()) {
  if (!env.DB) return 0;
  const result = await env.DB.prepare(
    'DELETE FROM telegram_updates WHERE claimed_at <= ?1'
  ).bind(now - TELEGRAM_UPDATE_RETENTION_MS).run();
  return Number(result?.meta?.changes || 0);
}

function summarizeUpdate(u = {}) {
  const m = u.message;
  const cq = u.callback_query;
  if (cq) return { type: 'callback_query', data: cq.data, from: cq.from?.id };
  if (m) {
    const rawText = m.text || m.caption || null;
    const text = typeof rawText === 'string'
      ? rawText.replace(/\bpay_[A-Za-z0-9_-]{20,64}\b/g, 'pay_[REDACTED]')
      : rawText;
    return {
      type: 'message', from: m.from?.id, chat: m.chat?.id,
      text, is_reply: !!m.reply_to_message
    };
  }
  return { type: 'other', keys: Object.keys(u).filter((k) => k !== 'update_id') };
}

// One-time helper: registers this worker's own URL as the bot's webhook, using
// the tokens it already has stored. Operator helpers use the independent
// ADMIN_SECRET header; the webhook credential never appears in a URL.
//   POST /telegram/setup  (X-Admin-Token: <ADMIN_SECRET>)
async function handleTelegramSetup(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!payments.telegramWebhookSecretValid(env)) return error(400, 'invalid_webhook_secret');
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
    }),
    redirect: 'manual'
  });
  const data = await readUpstreamJson(res);

  // Also register the command menu (the blue «/» button) so the bot feels official.
  const cmdRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'start', description: 'Меню бота' },
        { command: 'sub', description: 'Моя подписка: срок и устройство' },
        { command: 'help', description: 'Помощь и как пользоваться' }
      ]
    }),
    redirect: 'manual'
  });
  const commands = await readUpstreamJson(cmdRes);

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
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, {
    redirect: 'manual'
  });
  return json(await readUpstreamJson(res), { headers: { 'Cache-Control': 'no-store' } });
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
    body: JSON.stringify({ chat_id: chat, text: '✅ Проверка связи: бот СМЭШ AI работает.' }),
    redirect: 'manual'
  });
  return json(await readUpstreamJson(res), { headers: { 'Cache-Control': 'no-store' } });
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

async function handleCreateCheckoutSession(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const malformedExhausted = await payments.malformedOrderBudgetExhausted(env, ip);
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' ||
      Array.isArray(parsed.value)) {
    if (malformedExhausted) return error(429, 'rate_limited', VERIFY_CORS);
    await payments.recordMalformedOrderAttempt(env, ip);
    return error(
      parsed.ok ? 400 : parsed.status,
      parsed.ok ? 'bad_json' : (parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json'),
      VERIFY_CORS
    );
  }
  const result = await payments.createCheckoutSession(
    env, parsed.value, ip, malformedExhausted
  );
  if (!result.ok) return error(result.status, result.reason, VERIFY_CORS);
  return json(result, { headers: VERIFY_CORS });
}

async function handleCheckoutStatus(request, env) {
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' ||
      Array.isArray(parsed.value)) {
    return error(
      parsed.ok ? 400 : parsed.status,
      parsed.ok ? 'bad_json' : (parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json'),
      VERIFY_CORS
    );
  }
  const result = await payments.checkoutStatus(env, parsed.value.token);
  if (!result.ok) return error(result.status, result.reason, VERIFY_CORS);
  return json(result, { headers: VERIFY_CORS });
}

async function handleCreateCheckoutPayment(request, env) {
  const parsed = await readJsonBounded(request, 16 * 1024);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' ||
      Array.isArray(parsed.value)) {
    return error(
      parsed.ok ? 400 : parsed.status,
      parsed.ok ? 'bad_json' : (parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json'),
      VERIFY_CORS
    );
  }
  const result = await payments.createCheckoutPayment(env, parsed.value);
  if (!result.ok) return error(result.status, result.reason, VERIFY_CORS);
  return json(result, { headers: VERIFY_CORS });
}

async function handleCreateRobokassaOrder(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const malformedExhausted = await payments.malformedOrderBudgetExhausted(env, ip);
  const parsed = await readJsonBounded(request, 16 * 1024);
  if (!parsed.ok) {
    if (malformedExhausted) return error(429, 'rate_limited', VERIFY_CORS);
    await payments.recordMalformedOrderAttempt(env, ip);
    return error(
      parsed.status,
      parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json',
      VERIFY_CORS
    );
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    if (malformedExhausted) return error(429, 'rate_limited', VERIFY_CORS);
    await payments.recordMalformedOrderAttempt(env, ip);
    return error(400, 'bad_json', VERIFY_CORS);
  }
  const result = await payments.createRobokassaOrder(
    env,
    parsed.value,
    ip,
    malformedExhausted
  );
  if (!result.ok) return error(result.status, result.reason, VERIFY_CORS);
  return json(result, { headers: VERIFY_CORS });
}

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
  catch (e) {
    return error(e?.status === 413 ? 413 : 400, e?.status === 413 ? 'body_too_large' : 'bad_form');
  }

  const environment = payments.paymentEnvironment(env);
  const password2 = payments.robokassaCredential(env, 2);
  if (!environment || !password2) {
    console.error('robokassa: environment-specific callback credential unavailable');
    return error(503, 'payment_config');
  }
  const signed = await robokassa.verifyResultSignature(fields, password2, env.ROBOKASSA_HASH_ALGO);
  if (!signed.ok) {
    console.warn('robokassa: bad signature', signed.reason, robokassa.invoiceId(fields) || '(no invoice)');
    return error(403, 'bad_signature');
  }

  const n = robokassa.normalizeResult(fields);
  if (!n.ok) {
    console.warn('robokassa: invalid signed notification', n.reason);
    return error(400, n.reason);
  }

  // An already-claimed payment is immutable history. Gateway redelivery may
  // arrive after pricing, contacts, preorder state, or default-plan settings
  // change; rejecting/re-journaling it under today's config would strand a
  // key that was already issued. Recover the frozen D1 claim before consulting
  // any mutable purchase configuration.
  let recovered = null;
  try { recovered = await recoverPaymentLicense(env, 'robokassa', n.payment_id); }
  catch (e) {
    console.error('robokassa: payment recovery failed', safeErrorText(e, env));
    return error(500, 'payment_recovery_retry');
  }
  const order = await payments.loadRobokassaOrder(env, n.payment_id);
  // Historical claims created before authoritative orders were introduced are
  // safe to replay only because they cannot mint a new entitlement: the frozen
  // payment_issuance winner already exists. Every new payment requires an order.
  if (!order && recovered) {
    return settleIssuedRobokassaPayment(env, ctx, n, fields, recovered, null, null);
  }
  const bound = payments.validateRobokassaCallbackOrder(env, order, n, fields);
  if (!bound.ok) {
    console.error('robokassa: callback/order mismatch', bound.reason, n.payment_id);
    if (bound.retry) return error(409, bound.reason);
    return ackUnissuedPayment(env, n, fields, bound.reason, order);
  }
  if (recovered) {
    return settleIssuedRobokassaPayment(env, ctx, n, fields, recovered, null, order);
  }

  await payments.markOrderPaid(env, order, n, fields);
  return fulfillAuthorizedRobokassaOrder(env, ctx, order, n, fields);
}

async function fulfillAuthorizedRobokassaOrder(env, ctx, order, n, fields) {
  if (!order.email && !order.telegram_user_id) {
    console.error('robokassa: payment without delivery contact', n.payment_id);
    return ackUnissuedPayment(env, n, fields, 'no_contact', order);
  }
  const plan = order.plan_type === 'subscription'
    ? {
        type: 'subscription',
        subscription_days: Number(order.subscription_days)
      }
    : { type: 'lifetime', subscription_days: null };
  const isPreorder = !!order.is_preorder;

  // Referral: a valid code the buyer entered at checkout (best-effort
  // identity checks reject known self-referral)
  // extends the buyer's OWN subscription by the buyer bonus, and — once the
  // license exists — credits the referrer. A bad/self/absent code is ignored
  // silently: a real payment must never fail over a referral.
  //
  // While the referral switch is off the same "ignored silently" path handles a
  // code typed into a checkout page that has not caught up yet: the claim
  // freezes referral_code:null, so the buyer gets the plain plan and nobody is
  // credited. Licenses issued BEFORE the switch keep their frozen code, and
  // settleIssuedRobokassaPayment still pays those out on a redelivery.
  const referral = referralsEnabled(env)
    ? await referrals.resolveReferral(env, {
        code: order.referral_code,
        buyerDeviceId: order.device_id,
        buyerEmail: order.email,
        buyerTelegramId: order.telegram_user_id
      })
    : { valid: false, reason: REFERRALS_COMING_SOON };
  const baseDurationMs = plan.type === 'subscription'
    ? plan.subscription_days * 24 * 60 * 60 * 1000
    : null;
  const subscriptionDurationMs = referral.valid && baseDurationMs != null
    ? referrals.withBuyerBonusDurationMs(env, baseDurationMs)
    : baseDurationMs;

  const license = await issueLicense(env, {
    gateway: 'robokassa',
    payment_id: n.payment_id,     // InvId must be unique per order
    email: order.email,
    telegram_user_id: order.telegram_user_id,
    type: plan.type,
    expires_at: null,
    subscription_days: plan.subscription_days,
    subscription_duration_ms: subscriptionDurationMs,
    amount_kopecks: n.amount_kopecks,
    is_preorder: isPreorder,
    referral_code: referral.valid ? referral.ref.code : null
  });

  // issueLicense returns the authoritative INSERT OR IGNORE winner, which may
  // belong to a callback that won after the recovery read above. Route that
  // frozen winner through exactly the same amount/status/expiry/referral/
  // preorder settlement path as an ordinary replay; none of this invocation's
  // mutable candidate state may leak into side effects after the claim.
  return settleIssuedRobokassaPayment(env, ctx, n, fields, license, referral, order);
}

function issuedAmountMatches(license, callbackAmountKopecks) {
  if (Number.isSafeInteger(license?.amount_kopecks)) {
    return license.amount_kopecks === callbackAmountKopecks;
  }
  // Historical issue snapshots predate integer money. Accept only an exact
  // two-decimal legacy spelling converted once at this compatibility boundary.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(license?.amount_rub ?? ''));
  if (!match) return false;
  const legacy = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(legacy) && legacy === callbackAmountKopecks;
}

async function frozenReferralForPayment(env, license, fields, candidateReferral = null) {
  // All claims issued since referral support was added freeze this property,
  // including explicit null. Never reinterpret a current null as a referral
  // merely because a later callback carries a different signed Shp_ref_code.
  if (Object.prototype.hasOwnProperty.call(license, 'referral_code')) {
    if (!license.referral_code) return null;
    if (candidateReferral?.valid && candidateReferral.ref?.code === license.referral_code) {
      return candidateReferral.ref;
    }
    const frozen = (await referrals.adminReferralLookup(
      env, { code: license.referral_code }
    )).ref;
    if (!frozen || frozen.code !== license.referral_code) {
      throw new Error('frozen referral record unavailable');
    }
    return frozen;
  }

  // Compatibility for claims created before referral_code existed: only the
  // integrity-bound callback code is eligible (never a mutable order:<id>
  // fallback), and self-referral is checked against frozen buyer identity.
  const legacyCode = fields.Shp_ref_code || fields.Shp_ref || '';
  if (!legacyCode) return null;
  const checked = await referrals.resolveReferral(env, {
    code: legacyCode,
    buyerDeviceId: fields.Shp_device_id || fields.Shp_device || '',
    buyerEmail: license.email,
    buyerTelegramId: license.telegram_user_id
  });
  return checked.valid ? checked.ref : null;
}

async function settleIssuedRobokassaPayment(
  env, ctx, n, fields, license, candidateReferral = null, order = null
) {
  // Robokassa requires one unique InvId per payment. A second validly signed
  // callback that canonicalizes to the same invoice but reports a different
  // amount is not a redelivery of this frozen claim. Keep the winner immutable,
  // suppress delivery/referral side effects, and journal the anomaly.
  if (!issuedAmountMatches(license, n.amount_kopecks)) {
    console.error('robokassa: issued payment amount mismatch', n.payment_id);
    return ackUnissuedPayment(env, n, fields, 'issued_amount_mismatch', order);
  }

  const frozenPreorder = !!license.is_preorder;
  const frozenExpiry = license.expires_at == null ? null : Date.parse(license.expires_at);
  const validActiveClaim = license.status === 'active' &&
    (frozenExpiry == null || Number.isFinite(frozenExpiry));
  const deliverable = validActiveClaim &&
    (frozenExpiry == null || frozenExpiry > Date.now());

  // Durable delivery first: once this row exists the cron trigger owns retries.
  // Revoked, expired, and malformed-expiry winners are acknowledged but never
  // placed back into delivery, regardless of the losing callback's local plan.
  let outboxDurable = true;
  if (deliverable) {
    try { await enqueueDelivery(env, license, frozenPreorder); }
    catch (e) {
      outboxDurable = false;
      console.error('delivery outbox enqueue failed', safeErrorText(e, env));
    }
  }

  try {
    // A refund/fraud revocation is authoritative. Replays may retain an
    // already-applied credit according to business policy, but must never
    // create a previously-missing reward after the purchase was revoked.
    if (validActiveClaim) {
      const frozenReferral = await frozenReferralForPayment(
        env, license, fields, candidateReferral
      );
      if (frozenReferral) {
        await referrals.creditReferrerForPurchase(env, frozenReferral, license.key);
      }
    }
  } catch (e) {
    console.error('referral credit recovery', safeErrorText(e, env));
    const durable = await referrals.hasDurableCredit(env, license.key).catch(() => false);
    if (!durable) {
      if (deliverable && outboxDurable) ctx.waitUntil(deliverAndSettle(env, license, frozenPreorder));
      return error(500, 'referral_credit_retry');
    }
  }

  if (!outboxDurable) return error(500, 'delivery_outbox_retry');
  if (order) {
    try { await payments.markOrderFulfilled(env, order, license.key); }
    catch (e) {
      console.error('robokassa: order fulfillment journal failed', safeErrorText(e, env));
      return error(500, 'payment_order_retry');
    }
  }
  if (deliverable) ctx.waitUntil(deliverAndSettle(env, license, frozenPreorder));
  return robokassa.okResponse(n.invoice_id);
}

/**
 * A signed ResultURL callback is money that already moved. Every path that
 * acks Robokassa WITHOUT issuing a license (missing contact, unconfigured or
 * unmatched pricing) must first land a durable review row: the ack stops
 * gateway retries forever, and console logs are the only other trace. If the
 * journal write cannot land, answer non-OK — gateway redelivery is the sole
 * remaining durable channel. INSERT OR IGNORE keeps redeliveries idempotent.
 */
async function ackUnissuedPayment(env, n, fields, reason, order = null) {
  try {
    if (!env.DB) throw new Error('payment review journal unavailable');
    // Keep only non-PII evidence needed to reconcile the provider invoice.
    // This also excludes SignatureValue, which would be an offline target for
    // Password #2 guessing.
    const stored = payments.robokassaResultEvidence(fields);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO payment_review
         (gateway, payment_id, invoice_id, amount_rub, environment,
          amount_kopecks, reason, fields_json, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      'robokassa', n.payment_id, n.invoice_id, n.amount_rub,
      order?.environment || payments.paymentEnvironment(env) || null,
      n.amount_kopecks, reason, JSON.stringify(stored), Date.now()
    ).run();
    if (order && !['fulfilled', 'refunded'].includes(order.status)) {
      await env.DB.prepare(
        `UPDATE payment_orders SET status = 'review'
         WHERE order_id = ?1 AND status IN ('pending', 'paid', 'review')`
      ).bind(String(order.order_id)).run();
    }
  } catch (e) {
    console.error('robokassa: paid-but-unissued journal failed', reason, safeErrorText(e, env));
    return error(500, 'payment_review_retry');
  }
  return robokassa.okResponse(n.invoice_id);
}

/**
 * Legacy amount→plan pricing knobs. Issuance itself is driven by the
 * authoritative `payment_orders` row (see fulfillAuthorizedRobokassaOrder), so
 * nothing maps an amount to a plan any more. What survives here is only the
 * readiness view of that configuration:
 *   MIN_PAYMENT_RUB / SUBSCRIPTION_MIN_RUB / LIFETIME_MIN_RUB — floors
 *   SUBSCRIPTION_DAYS — subscription length in days (default 30)
 * The mapping function itself was deleted deliberately: keeping a working
 * amount→plan minting path around invites a caller to reintroduce it.
 */
function configFloor(raw) {
  if (raw == null || String(raw) === '') return { ok: true, value: 0 };
  // Pricing is a money boundary, even though the input is operator-controlled.
  // Reject Number()'s whitespace/exponent coercions and fractions smaller than
  // one kopeck so readiness cannot bless a silently different threshold.
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(raw));
  if (!match) return { ok: false, value: 0 };
  const kopecks = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(kopecks)
    ? { ok: true, value: kopecks / 100 }
    : { ok: false, value: 0 };
}

function subscriptionDays(env) {
  const raw = env.SUBSCRIPTION_DAYS;
  if (raw == null || String(raw) === '') return 30;
  const text = String(raw);
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  // Bound both accidental zero/negative plans and Date overflow. Ten years is
  // already far beyond the intended subscription product while remaining a
  // valid finite ISO expiry.
  return Number.isSafeInteger(days) && days >= 1 && days <= 3650 ? days : null;
}

function paymentPlanConfigValid(env) {
  const explicit = configFloor(env.MIN_PAYMENT_RUB);
  const subscription = configFloor(env.SUBSCRIPTION_MIN_RUB);
  const lifetime = configFloor(env.LIFETIME_MIN_RUB);
  if (!explicit.ok || !subscription.ok || !lifetime.ok) return false;

  const hasPlanFloor = subscription.value > 0 || lifetime.value > 0;
  const defaultType = String(env.DEFAULT_LICENSE_TYPE || 'lifetime').trim();
  if (!hasPlanFloor && defaultType !== 'lifetime' && defaultType !== 'subscription') return false;
  const canIssueSubscription = subscription.value > 0 || (!hasPlanFloor && defaultType === 'subscription');
  return !canIssueSubscription || subscriptionDays(env) != null;
}

/**
 * Hard floor on what counts as a purchase at all, applied before any plan
 * mapping. Explicit MIN_PAYMENT_RUB wins; otherwise the lowest configured
 * plan floor. Returns 0 (no floor) only when nothing is configured — the
 * handlers log a loud warning in that state.
 */
function minPaymentRub(env) {
  const explicit = configFloor(env.MIN_PAYMENT_RUB).value;
  if (explicit > 0) return explicit;
  const floors = [configFloor(env.SUBSCRIPTION_MIN_RUB).value, configFloor(env.LIFETIME_MIN_RUB).value]
    .filter((n) => n > 0);
  return floors.length ? Math.min(...floors) : 0;
}

/* ---------------------------- delivery glue --------------------------- */

const DELIVERY_RETRY_DELAY_MS = 10 * 1000;
const DEFAULT_DELIVERY_MARKER_TIMEOUT_MS = 5 * 1000;

function deliveryMarkerTimeoutMs(env) {
  const configured = Number(env.DELIVERY_MARKER_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 100 && configured <= 10_000
    ? configured
    : DEFAULT_DELIVERY_MARKER_TIMEOUT_MS;
}

async function boundedDeliveryMarker(env, operation) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('delivery marker timeout')),
          deliveryMarkerTimeoutMs(env)
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deliveryState(settled) {
  if (settled.status === 'rejected') return 'failed';
  if (settled.value?.ok === true) return 'ok';
  if (settled.value?.skipped === true) return 'skipped';
  return 'failed';
}

function parseDeliveryMarker(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const valid = new Set(['ok', 'failed', 'skipped']);
    if (!valid.has(value.tg) || !valid.has(value.email)) return null;
    return value;
  } catch {
    return null;
  }
}

function isLegacyDeliveryMarker(raw) {
  const parsed = Date.parse(raw || '');
  if (!Number.isFinite(parsed)) return false;
  try { return new Date(parsed).toISOString() === raw; }
  catch { return false; }
}

// Telegram-bound checkout makes the bot the promised delivery channel. Email
// remains a useful fallback copy, but it must not close the durable outbox or
// make checkout status say "delivered" while the bot is still failing. Legacy
// email-only purchases complete on email as before.
function requiredDeliverySucceeded(state, recipient) {
  if (!state || !recipient) return false;
  if (recipient.telegram_user_id) return state.tg === 'ok';
  if (recipient.email) return state.email === 'ok';
  return false;
}

// Returns the final per-channel state ({ tg, email } of ok|failed|skipped) so
// callers can settle the durable delivery_outbox row. `retry:false` skips the
// in-process second attempt — the cron sweep IS the retry when it's the caller.
export async function deliverKey(env, license, isPreorder, { force = false, retry = true } = {}) {
  const marker = `delivered:${license.key}`;
  let previous = null;
  if (!force) {
    try {
      const raw = await boundedDeliveryMarker(env, () => env.LICENSES.get(marker));
      if (raw) {
        previous = parseDeliveryMarker(raw);
        if (!previous) {
          // Legacy ISO markers predate per-channel state and mean the buyer was
          // already sent a key. Never reinterpret them and risk a duplicate DM.
          // Anything else is an unreadable marker: fall through and deliver
          // rather than dereferencing the null this branch just proved.
          if (isLegacyDeliveryMarker(raw)) return { tg: 'ok', email: 'ok' };
        } else if (requiredDeliverySucceeded(previous, license)) {
          return { tg: previous.tg, email: previous.email };
        }
      }
    }
    catch { /* delivery still proceeds; marker is best-effort dedup only */ }
  }

  const sendTg = () => sendLicenseTelegram(env, {
    user_id: license.telegram_user_id,
    key: license.key,
    isPreorder,
    amount_kopecks: Number.isSafeInteger(license.amount_kopecks)
      ? license.amount_kopecks
      : null,
    type: license.type,
    expires_at: license.expires_at,
    payment_id: license.payment_id,
    email: license.email
  });
  const sendEmail = () => sendLicenseEmail(env, {
    to: license.email,
    key: license.key,
    isPreorder,
    type: license.type,
    expires_at: license.expires_at,
    dedupe: !force
  });
  const skippedOk = (channel) => Promise.resolve({ skipped: false, ok: true, deduped: channel });
  const [tg, em] = await Promise.allSettled([
    previous?.tg === 'ok' ? skippedOk('tg') : sendTg(),
    previous?.email === 'ok' ? skippedOk('email') : sendEmail()
  ]);
  if (tg.status === 'rejected') console.error('tg deliver', safeErrorText(tg.reason, env));
  if (em.status === 'rejected') console.error('email deliver', safeErrorText(em.reason, env));
  const state = { tg: deliveryState(tg), email: deliveryState(em) };

  // A fully unsuccessful attempt gets one in-process retry after the transient
  // outage has had time to clear. Retry failed channels only: skipped contacts
  // cannot become configured mid-call, and a successful channel must not send
  // the same bearer key twice.
  if (retry && !requiredDeliverySucceeded(state, license) &&
      (state.tg === 'failed' || state.email === 'failed')) {
    await new Promise((resolve) => setTimeout(resolve, DELIVERY_RETRY_DELAY_MS));
    const [tgRetry, emailRetry] = await Promise.allSettled([
      state.tg === 'failed' ? sendTg() : skippedOk('tg'),
      state.email === 'failed' ? sendEmail() : skippedOk('email')
    ]);
    if (state.tg === 'failed') {
      if (tgRetry.status === 'rejected') console.error('tg deliver retry', safeErrorText(tgRetry.reason, env));
      state.tg = deliveryState(tgRetry);
    }
    if (state.email === 'failed') {
      if (emailRetry.status === 'rejected') console.error('email deliver retry', safeErrorText(emailRetry.reason, env));
      state.email = deliveryState(emailRetry);
    }
  }

  // Persist final per-channel state for webhook dedup and future recovery.
  // A marker with no successful channel deliberately remains retryable. Bound
  // this best-effort KV operation too: the D1 outbox claim is a two-minute
  // lease, so an unbounded marker get/put must not hold it until another sweep
  // legitimately takes over.
  try {
    await boundedDeliveryMarker(env, () =>
      env.LICENSES.put(marker, JSON.stringify({ ...state, at: new Date().toISOString() }))
    );
  } catch { /* best effort — never turn a completed payment into a retry */ }
  return state;
}

/* ------------------------- durable delivery outbox -------------------- */
// The webhook's in-process attempts only cover a transient blip; once it has
// acked the gateway, nothing external ever retries. The outbox row is that
// missing retry channel: persisted BEFORE the ack, re-driven by the cron
// trigger (scheduled() below) with backoff until one channel confirms.

const DELIVERY_MAX_ATTEMPTS = 30; // ≈5 days at the capped backoff below
// Refund polls back off 5 min doubling to a 6 h ceiling, so six failures is
// roughly half a day of a provider refusing to answer for one order — past
// any transient blip and squarely operator work.
const REFUND_POLL_STALLED_ATTEMPTS = 6;
// Provider calls are individually capped at 20s (delivery/http.js), and the
// webhook's optional second attempt adds at most another 20s plus a 10s wait.
// Keep the exclusive D1 lease comfortably longer than that entire operation.
const DELIVERY_CLAIM_LEASE_MS = 2 * 60 * 1000;

// 1 min doubling to a 6 h ceiling. Attempt 1 is the webhook's claimed
// in-process pair; the cron only sees rows whose next_attempt_at has come due.
function deliveryBackoffMs(attempts) {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60 * 1000);
}

export async function enqueueDelivery(env, license, isPreorder) {
  if (!env.DB) throw new Error('delivery outbox unavailable');
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO delivery_outbox
       (license_key, email, telegram_user_id, is_preorder, created_at, attempts, next_attempt_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`
  ).bind(
    license.key,
    license.email || null,
    license.telegram_user_id || null,
    isPreorder ? 1 : 0,
    now,
    now + deliveryBackoffMs(1)
  ).run();
}

async function claimDeliveryOutboxAttempt(env, licenseKey, expectedAttempts) {
  if (!env.DB) return null;
  const attempts = expectedAttempts + 1;
  const now = Date.now();
  const claimToken = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE delivery_outbox
     SET attempts = ?2, next_attempt_at = ?3, claim_token = ?4, lease_until = ?5
     WHERE license_key = ?1 AND delivered_at IS NULL AND attempts = ?6
       AND (lease_until IS NULL OR lease_until <= ?7)`
  ).bind(
    licenseKey,
    attempts,
    now + deliveryBackoffMs(attempts),
    claimToken,
    now + DELIVERY_CLAIM_LEASE_MS,
    expectedAttempts,
    now
  ).run();
  return (claim?.meta?.changes || 0) > 0 ? claimToken : null;
}

// Proven delivery on the promised channel closes the row. Failed attempts
// need no extra mutation: their exclusive claim already scheduled the next
// cron run, including when the isolate dies after an external send.
async function settleDeliveryOutbox(env, license, claimToken, state) {
  if (!env.DB || !claimToken || !license?.key ||
      !requiredDeliverySucceeded(state, license)) return false;
  try {
    const settled = await env.DB.prepare(
      `UPDATE delivery_outbox
       SET delivered_at = ?2, claim_token = NULL, lease_until = NULL
       WHERE license_key = ?1 AND delivered_at IS NULL AND claim_token = ?3`
    ).bind(license.key, Date.now(), claimToken).run();
    return (settled?.meta?.changes || 0) > 0;
  } catch (e) {
    console.error('delivery outbox settle failed', safeErrorText(e, env));
    return false;
  }
}

async function releaseDeliveryOutboxClaim(env, licenseKey, claimToken) {
  if (!env.DB || !claimToken) return;
  try {
    // Leave attempts/next_attempt_at untouched: the claim already recorded the
    // failed try and its backoff. Token matching prevents an expired holder
    // from clearing a newer sweep's lease.
    await env.DB.prepare(
      `UPDATE delivery_outbox SET claim_token = NULL, lease_until = NULL
       WHERE license_key = ?1 AND delivered_at IS NULL AND claim_token = ?2`
    ).bind(licenseKey, claimToken).run();
  } catch (e) {
    console.error('delivery outbox release failed', safeErrorText(e, env));
  }
}

// The immediate webhook attempt uses the same D1 compare-and-set as cron.
// Concurrent signed callbacks can all enqueue/recover one row, but only the
// invocation that changes attempts 0→1 is allowed to contact providers.
export async function deliverAndSettle(env, license, isPreorder) {
  let claimToken = null;
  try { claimToken = await claimDeliveryOutboxAttempt(env, license.key, 0); }
  catch (e) { console.error('delivery outbox initial claim failed', safeErrorText(e, env)); }
  if (!claimToken) return { claimed: false, state: null };

  let state = null;
  try { state = await deliverKey(env, license, isPreorder); }
  catch (e) { console.error('deliver', safeErrorText(e, env)); }
  const settled = await settleDeliveryOutbox(env, license, claimToken, state);
  if (!settled) await releaseDeliveryOutboxClaim(env, license.key, claimToken);
  return { claimed: true, state };
}

/** Cron sweep: re-drive every due undelivered outbox row. */
export async function retryPendingDeliveries(env, limit = 25) {
  if (!env.DB) return { retried: 0, delivered: 0 };
  let rows;
  try {
    rows = await env.DB.prepare(
      `SELECT outbox.license_key, outbox.email, outbox.telegram_user_id,
              outbox.is_preorder, outbox.attempts, issuance.license_json
       FROM delivery_outbox AS outbox
       LEFT JOIN payment_issuance AS issuance
         ON issuance.license_key = outbox.license_key
       WHERE outbox.delivered_at IS NULL AND outbox.attempts < ?1
         AND outbox.next_attempt_at <= ?2
         AND (outbox.lease_until IS NULL OR outbox.lease_until <= ?2)
       ORDER BY outbox.next_attempt_at LIMIT ?3`
    ).bind(DELIVERY_MAX_ATTEMPTS, Date.now(), Math.max(1, Math.min(50, limit))).all();
  } catch (e) {
    console.error('delivery outbox scan failed', safeErrorText(e, env));
    return { retried: 0, delivered: 0 };
  }
  const due = rows?.results || [];
  let retried = 0;
  let delivered = 0;
  for (const row of due) {
    // Exclusive claim BEFORE any external send: bump attempts/next_attempt_at
    // with a compare-and-set on the attempts value the scan read. A losing
    // sweep (overlapping cron invocations, or a slow sweep lapped by the next
    // tick) matches zero rows and skips — without this, both invocations DM
    // the same bearer key and regress each other's attempt/backoff state.
    // The claim doubles as the failure schedule, so a crash mid-send just
    // burns one bounded attempt instead of ever double-sending.
    const expectedAttempts = Number(row.attempts) || 0;
    let claimToken;
    try {
      claimToken = await claimDeliveryOutboxAttempt(env, row.license_key, expectedAttempts);
    } catch (e) {
      console.error('delivery outbox claim failed', safeErrorText(e, env));
      continue;
    }
    if (!claimToken) continue;
    retried += 1;
    let frozen = null;
    try {
      const candidate = row.license_json ? JSON.parse(row.license_json) : null;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
          candidate.key === row.license_key) frozen = candidate;
    } catch (e) {
      console.error('delivery outbox snapshot invalid', safeErrorText(e, env));
    }
    // D1 outbox contacts remain the routing authority. The immutable issuance
    // snapshot restores payment/subscription metadata for the Telegram copy
    // after a delayed recovery without allowing a malformed snapshot to
    // redirect the bearer key.
    const license = {
      ...(frozen || {}),
      key: row.license_key,
      email: row.email || null,
      telegram_user_id: row.telegram_user_id || null
    };
    let state = null;
    // The cron itself is the retry loop, so each pass makes a single attempt.
    try { state = await deliverKey(env, license, !!row.is_preorder, { retry: false }); }
    catch (e) { console.error('outbox delivery retry failed', safeErrorText(e, env)); }
    // The claim already scheduled the next retry; settle only on success so
    // the loser-safe attempt counter is never bumped twice for one attempt.
    if (requiredDeliverySucceeded(state, license)) {
      if (await settleDeliveryOutbox(env, license, claimToken, state)) {
        delivered += 1;
      } else {
        await releaseDeliveryOutboxClaim(env, row.license_key, claimToken);
      }
    } else {
      await releaseDeliveryOutboxClaim(env, row.license_key, claimToken);
    }
  }
  return { retried, delivered };
}

// Preorder window — flips false on launch day. The extension client treats
// is_preorder as advisory metadata; the gate doesn't care. Stored on the
// license so the receipt email/TG copy can adapt.
//
// Deliberately kept even though issuance now reads the frozen `is_preorder` on
// the payment_orders row: this literal is the BACKEND half of a pinned
// cross-component contract with LICENSE_ENFORCED_FROM in src/lib/config.js, and
// tests/launch-reliability-accessibility-regression.mjs asserts the two name the
// same instant. Do not "clean up" as unused without moving that contract.
function isPreorderNow() {
  return Date.now() < Date.parse('2026-07-25T00:00:00Z');
}

/* ------------------------------ telemetry ---------------------------- */

// POST /t — extension usage events (content-free; see analytics.js). Browser
// CORS is open because extensions have no stable web origin, but admission is
// authenticated by the short-lived device-bound capability from /verify.
async function handleTelemetry(request, env) {
  if (!env.DB) return error(503, 'no_db', VERIFY_CORS);
  const attestation = await verifyTelemetryToken(
    env,
    request.headers.get('x-telemetry-token') || ''
  );
  if (!attestation.ok) return error(401, attestation.reason, VERIFY_CORS);
  const result = await analytics.handleIngest(request, env, attestation.device_id);
  return json(result, { status: result.status || (result.ok ? 200 : 400), headers: VERIFY_CORS });
}

// POST /t/ai — opted-in SERVER-observed AI usage from the VPS proxy
// (ai.smeshapi.site). The VPS emits only when the extension request carries
// strict telemetry_opt_in:true. Guarded by the INGEST_KEY shared secret;
// browser callers are rejected outright, so the open /t endpoint can never
// be used to forge server-observed rows.
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

// POST /t/delete — user-initiated erasure authenticated by the long-lived,
// deletion-only capability issued by /verify. A public UUID is an identifier,
// not authorization: accepting it directly allowed third parties to erase
// another installation's data and manufacture tombstones indefinitely.
async function handleTelemetryDelete(request, env) {
  if (!env.DB) return error(503, 'no_db', VERIFY_CORS);
  const attestation = await verifyErasureToken(env, request.headers.get('x-erasure-token') || '');
  if (!attestation.ok) return error(401, attestation.reason, VERIFY_CORS);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const day = analytics.mskDay();
  // Reserve the narrow source budget first. An already-blocked IP must not be
  // able to drain the global allowance merely by repeating rejected deletes.
  const ipUse = await analytics.reserveDailyBudget(env, day, 'erase_ip', ip, 1, 20);
  if (ipUse > 20) return error(429, 'rate_limited', VERIFY_CORS);
  const globalUse = await analytics.reserveDailyBudget(
    env, day, 'erase_global', 'all', 1, 2000
  );
  if (globalUse > 2000) {
    await analytics.releaseDailyBudget(env, day, 'erase_ip', ip, 1);
    return error(429, 'rate_limited', VERIFY_CORS);
  }
  const result = await analytics.handleDeleteDevice(request, env, attestation.device_id);
  // A delete that erased nothing (unknown device, or one already erased) used
  // no erasure capacity, so the SHARED allowance must not stay charged for it.
  // Erasure tokens live 400 days and carry no replay protection, so without
  // this a single valid token replayed against an already-erased device could
  // spend the whole global budget and 429 everyone else's right to erasure for
  // the rest of the day. The per-IP charge deliberately stands — that is the
  // anti-abuse control, and the replayer should still pay it.
  if (result.ok && result.deleted === false) {
    await analytics.releaseDailyBudget(env, day, 'erase_global', 'all', 1)
      .catch(() => { /* over-counting the shared budget fails closed */ });
  }
  return json(result, { status: result.status || (result.ok ? 200 : 400), headers: VERIFY_CORS });
}

/* --------------------------- /admin/stats/* --------------------------- */

// Bound every reporting window before it reaches a date computation. `days` is
// caller-supplied, and daysBack() runs it through Date#toISOString: an
// unclamped `?days=1e12` left the Date range, threw RangeError out of a route
// with no try/catch of its own, and answered 500 instead of a sane window.
// Ten years already exceeds any question this dashboard asks. Mirrors the clamp
// statsPurchases applies to the same parameter in purchaseListOptions.
const STATS_MAX_DAYS = 3650;
function statsDays(params, fallback = 0) {
  const days = Math.trunc(Number(params.get('days')));
  return Number.isFinite(days) && days > 0 ? Math.min(days, STATS_MAX_DAYS) : fallback;
}

const STATS_ROUTES = {
  overview:   (env, q) => analytics.statsOverview(env, statsDays(q)),
  timeseries: (env, q) => analytics.statsTimeseries(env, statsDays(q, 30)),
  users:      (env, q) => analytics.statsUsers(env, { ...Object.fromEntries(q), days: statsDays(q) }),
  user:       (env, q) => analytics.statsUserDetail(env, q.get('device_id') || ''),
  subjects:   (env, q) => analytics.statsSubjects(env, statsDays(q)),
  purchases:  (env, q) => analytics.statsPurchases(env, Object.fromEntries(q)),
  retention:  (env)    => analytics.statsRetention(env),
  referrals:  (env)    => analytics.statsReferrals(env),
  errors:     (env, q) => analytics.statsErrors(env, statsDays(q)),
  feedback:   (env, q) => analytics.statsFeedback(env, statsDays(q)),
  tickets:    (env, q) => analytics.statsTickets(env, Number(q.get('limit')) || 50),
  subscriptions: (env) => analytics.statsSubscriptions(env),
  funnel:     (env, q) => analytics.statsFunnel(env, statsDays(q)),
  margin:     (env, q) => analytics.statsMargin(env, statsDays(q),
    Number(q.get('limit')) || 100),
  worklists:  (env)    => analytics.statsWorklists(env, WORKLIST_THRESHOLDS),
  rate:       (env, q) => analytics.statsRate(env, q.get('force') === '1')
};

// The retry ceilings the senders actually enforce, handed to the shared
// worklist rollup so /admin/health and the dashboard cannot drift apart.
const WORKLIST_THRESHOLDS = {
  deliveryMaxAttempts: DELIVERY_MAX_ATTEMPTS,
  refundPollStalledAttempts: REFUND_POLL_STALLED_ATTEMPTS,
  supportForwardMaxAttempts: SUPPORT_FORWARD_MAX_ATTEMPTS,
  subscriptionNotifyMaxAttempts: SUBSCRIPTION_NOTIFY_MAX_ATTEMPTS
};

// GET /admin/stats/<name> — aggregation endpoints for the owner dashboard
// (browser, dashboard origin only) and CLI/server-to-server callers.
async function handleAdminStats(request, env, path) {
  const cors = statsCors(request, env);
  const gate = await statsGate(request, env, cors);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db', cors || {});
  const name = path.slice('/admin/stats/'.length);
  // Resolve own properties only. A bare STATS_ROUTES[name] also returns
  // Object.prototype members, and /admin/stats/constructor then evaluated
  // Object(env, params) — which returns `env` and serialized every configured
  // secret straight into the response body.
  const route = Object.hasOwn(STATS_ROUTES, name) ? STATS_ROUTES[name] : null;
  if (typeof route !== 'function') return error(404, 'not_found', cors || {});
  const result = await route(env, new URL(request.url).searchParams);
  return json(result, { status: result.status || (result.ok ? 200 : 400), headers: cors || {} });
}

// POST /admin/backfill-licenses — re-mirror every KV license into D1.
async function handleAdminBackfill(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db');
  const [result, privacy] = await Promise.all([
    analytics.backfillLicenses(env),
    analytics.purgeLegacyIdentifiers(env)
  ]);
  return json({ ok: true, ...result, legacy_identifiers_purged: privacy.rows });
}

/* ------------------------------- /admin ------------------------------ */

async function adminGuard(request, env, dashboardCors = null) {
  // Browser fetches send Origin; reject them before checking the token —
  // UNLESS the route explicitly allowed the owner dashboard origin
  // (dashboardCors is non-null only when Origin matched it exactly).
  if (request.headers.get('origin') && !dashboardCors) return false;
  const token = request.headers.get('x-admin-token') || '';
  if (typeof env.ADMIN_SECRET !== 'string' || env.ADMIN_SECRET.length < 32) return false;
  return constantTimeStringEqual(env.ADMIN_SECRET, token);
}

async function statsGuard(request, env, dashboardCors = null) {
  if (request.headers.get('origin') && !dashboardCors) return false;
  const token = request.headers.get('x-stats-token') || '';
  if (typeof env.STATS_SECRET !== 'string' || env.STATS_SECRET.length < 32) return false;
  return constantTimeStringEqual(env.STATS_SECRET, token);
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
  const day = analytics.mskDay();
  try {
    if (bump) {
      return await analytics.bumpDailyBudget(env, day, 'admin_fail', ip, 1, ADMIN_FAIL_DAILY_LIMIT);
    }
    // The pre-token read gate: once this isolate has seen the IP over its
    // limit today, answer 429 from memory instead of a D1 read per attempt.
    if (analytics.budgetBlockedToday(day, 'admin_fail', ip)) return ADMIN_FAIL_DAILY_LIMIT;
    const row = await env.DB.prepare(
      'SELECT count FROM telemetry_budget WHERE day = ? AND scope = ? AND budget_key = ?'
    ).bind(day, 'admin_fail', ip).first();
    const count = Number(row?.count) || 0;
    if (count >= ADMIN_FAIL_DAILY_LIMIT) analytics.markBudgetBlocked(day, 'admin_fail', ip);
    return count;
  } catch (e) {
    console.error('admin fail counter unavailable', String(e));
    return 0;
  }
}

// Returns an error Response (401/429) or null when the caller may proceed.
async function adminGate(request, env, dashboardCors = null, { recordFailures = true } = {}) {
  const headers = dashboardCors || {};
  // During a cross-store backup, even the brute-force counter is a forbidden
  // D1 write. Readiness remains available through the same strong token, but
  // failed probes are answered without consulting or mutating the counter.
  if (!recordFailures) {
    return (await adminGuard(request, env, dashboardCors))
      ? null
      : error(401, 'unauthorized', headers);
  }
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

// Read-only analytics uses an independent capability. Compromise of the
// browser dashboard can expose aggregate data, but cannot issue/revoke
// licenses, backfill stores, resolve payments, or trigger refunds.
async function statsGate(request, env, dashboardCors = null) {
  const headers = dashboardCors || {};
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if ((await adminFailures(env, ip, false)) >= ADMIN_FAIL_DAILY_LIMIT) {
    return error(429, 'too_many_attempts', headers);
  }
  if (!(await statsGuard(request, env, dashboardCors))) {
    await adminFailures(env, ip, true);
    return error(401, 'unauthorized', headers);
  }
  return null;
}

// Tables the PAID paths query at runtime. A stale deployment whose database
// misses one of these fails closed per-route; this list makes that visible to
// monitoring instead of only to the first affected buyer.
// Ordered table signatures mirror scripts/adopt-current-schema.sql:
// name:type:notnull:default:pk. Merely finding the expected column names is
// not enough for payment/idempotency safety — a hand-built lookalike can omit
// the PRIMARY KEY, NOT NULL, or default that makes concurrent paths correct.
const HEALTH_REQUIRED_TABLE_SIGNATURES = {
  counters: 'name:TEXT:0::1|value:INTEGER:1::0',
  delivery_outbox:
    'license_key:TEXT:0::1|email:TEXT:0::0|telegram_user_id:INTEGER:0::0|is_preorder:INTEGER:1:0:0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|claim_token:TEXT:0::0|lease_until:INTEGER:0::0|delivered_at:INTEGER:0::0',
  device_tombstones: 'device_id:TEXT:0::1|deleted_at:INTEGER:1::0',
  devices:
    'device_id:TEXT:0::1|first_seen:INTEGER:1::0|last_seen:INTEGER:1::0|browser:TEXT:0::0|ua:TEXT:0::0|version:TEXT:0::0|provider:TEXT:0::0|license_key:TEXT:0::0|license_ref:TEXT:0::0|license_type:TEXT:0::0',
  events:
    'id:INTEGER:0::1|ts:INTEGER:1::0|day:TEXT:1::0|device_id:TEXT:1::0|type:TEXT:1::0|subject:TEXT:0::0|provider:TEXT:0::0|model:TEXT:0::0|tokens_in:INTEGER:1:0:0|tokens_out:INTEGER:1:0:0|cost_usd:REAL:1:0:0|files_pdf:INTEGER:1:0:0|files_img:INTEGER:1:0:0|meta:TEXT:0::0',
  kv_apply_locks: 'name:TEXT:0::1|lease_until:INTEGER:1::0',
  kv_materializations: 'name:TEXT:0::1|materialized_at:INTEGER:1::0',
  license_activations:
    'license_key:TEXT:0::1|status:TEXT:1::0|device_id:TEXT:0::0|token_hash:TEXT:0::0|generation:INTEGER:1:1:0|activated_at:INTEGER:0::0|last_seen_at:INTEGER:0::0|deactivated_at:INTEGER:0::0',
  license_devices: 'license_key:TEXT:1::1|device_id:TEXT:1::2|added_at:INTEGER:1::0',
  license_release_fence:
    'license_key:TEXT:0::1|device_id:TEXT:1::0|released_at:INTEGER:1::0|released_by:TEXT:0::0',
  license_revocations: 'license_key:TEXT:0::1|revoked_at:INTEGER:1::0|reason:TEXT:0::0',
  license_telegram_links:
    'license_key:TEXT:0::1|telegram_user_id:TEXT:1::0|linked_at:INTEGER:1::0',
  payment_issuance:
    'gateway:TEXT:1::1|payment_id:TEXT:1::2|license_key:TEXT:1::0|license_json:TEXT:1::0|created_at:INTEGER:1::0',
  payment_events:
    'id:INTEGER:0::1|gateway:TEXT:1::0|payment_id:TEXT:1::0|order_id:INTEGER:0::0|environment:TEXT:0::0|event_type:TEXT:1::0|amount_kopecks:INTEGER:0::0|currency:TEXT:0::0|details_json:TEXT:0::0|created_at:INTEGER:1::0',
  payment_orders:
    'order_id:INTEGER:0::1|gateway:TEXT:1::0|environment:TEXT:1::0|status:TEXT:1::0|amount_kopecks:INTEGER:1::0|currency:TEXT:1::0|plan_type:TEXT:1::0|subscription_days:INTEGER:0::0|email:TEXT:0::0|telegram_user_id:TEXT:0::0|referral_code:TEXT:0::0|device_id:TEXT:0::0|is_preorder:INTEGER:1:0:0|fiscalization_mode:TEXT:1::0|receipt_json:TEXT:0::0|created_at:INTEGER:1::0|expires_at:INTEGER:1::0|paid_at:INTEGER:0::0|fulfilled_at:INTEGER:0::0|provider_op_key:TEXT:0::0|reconciled_at:INTEGER:0::0|refund_request_id:TEXT:0::0|refund_status:TEXT:0::0|refund_kopecks:INTEGER:0::0|refunded_at:INTEGER:0::0',
  payment_refund_poll:
    'order_id:INTEGER:0::1|attempts:INTEGER:1:0:0|next_poll_at:INTEGER:1:0:0|last_error:TEXT:0::0|last_error_at:INTEGER:0::0',
  payment_review:
    'gateway:TEXT:1::1|payment_id:TEXT:1::2|invoice_id:TEXT:0::0|amount_rub:REAL:0::0|reason:TEXT:1::0|fields_json:TEXT:0::0|created_at:INTEGER:1::0|resolved_at:INTEGER:0::0|environment:TEXT:0::0|amount_kopecks:INTEGER:0::0|resolution:TEXT:0::0|resolution_note:TEXT:0::0',
  proxy_quota: 'day:TEXT:1::1|license_key:TEXT:1::2|provider:TEXT:1::3|count:INTEGER:1:0:0',
  purchases:
    'license_key:TEXT:0::1|gateway:TEXT:0::0|payment_id:TEXT:0::0|type:TEXT:0::0|status:TEXT:0::0|amount_rub:REAL:0::0|email:TEXT:0::0|telegram_user_id:TEXT:0::0|issued_at:INTEGER:0::0|expires_at:INTEGER:0::0|is_preorder:INTEGER:0:0:0|note:TEXT:0::0|device_ids:TEXT:0::0|amount_kopecks:INTEGER:0::0',
  referral_apply_locks: 'ref_code:TEXT:0::1|lease_until:INTEGER:1::0',
  referral_auth_claims: 'auth_hash:TEXT:0::1|code:TEXT:1::0|created_at:INTEGER:1::0',
  referral_credit_state:
    'license_key:TEXT:0::1|ref_code:TEXT:1::0|days:INTEGER:1::0|status:TEXT:1::0|created_at:INTEGER:1::0|applied_at:INTEGER:0::0|materialized_at:INTEGER:0::0|target_kind:TEXT:0::0|target_key:TEXT:0::0|target_expiry:TEXT:0::0|target_generation:INTEGER:1:0:0|retry_attempts:INTEGER:1:0:0|retry_after:INTEGER:1:0:0|last_error_at:INTEGER:0::0',
  referral_credits: 'license_key:TEXT:0::1|ref_code:TEXT:1::0|claimed_at:INTEGER:1::0',
  runtime_write_fence:
    'singleton:INTEGER:0::1|write_epoch:INTEGER:1::0|writes_enabled:INTEGER:1:1:0|updated_at:INTEGER:1::0',
  subscription_notifications:
    'id:INTEGER:0::1|license_key:TEXT:1::0|stage:TEXT:1::0|telegram_user_id:TEXT:1::0|due_at:INTEGER:1::0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|claim_token:TEXT:0::0|lease_until:INTEGER:0::0|sent_at:INTEGER:0::0|cancelled_at:INTEGER:0::0|answer_code:TEXT:0::0|answered_at:INTEGER:0::0',
  support_forward_outbox:
    'ticket_no:TEXT:0::1|source_chat_id:TEXT:0::0|source_message_id:INTEGER:0::0|has_attachment:INTEGER:1:0:0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|claim_token:TEXT:0::0|lease_until:INTEGER:0::0|text_forwarded_at:INTEGER:0::0|attachment_forwarded_at:INTEGER:0::0|forwarded_at:INTEGER:0::0',
  telegram_updates:
    'update_id:INTEGER:0::1|claimed_at:INTEGER:1::0|lease_until:INTEGER:1::0|completed_at:INTEGER:0::0|result_kind:TEXT:0::0|ticket_no:TEXT:0::0',
  telemetry_budget: 'day:TEXT:1::1|scope:TEXT:1::2|budget_key:TEXT:1::3|count:INTEGER:1:0:0'
};

// The production database was adopted into numbered migrations after
// `license_ref` had been appended to the existing devices table. Its columns
// are therefore complete but retain the harmless historical order
// `license_type, license_ref`; every runtime read/write names these columns.
// Accept only that exact observed signature in addition to the canonical fresh
// schema so readiness does not demand a risky table rebuild just for ordering.
const HEALTH_ACCEPTED_LEGACY_TABLE_SIGNATURES = {
  devices: [
    'device_id:TEXT:0::1|first_seen:INTEGER:1::0|last_seen:INTEGER:1::0|browser:TEXT:0::0|ua:TEXT:0::0|version:TEXT:0::0|provider:TEXT:0::0|license_key:TEXT:0::0|license_type:TEXT:0::0|license_ref:TEXT:0::0'
  ]
};

// Complete canonical sqlite_master DDL. Column PRAGMAs do not expose CHECKs,
// table-level UNIQUE constraints, collations, generated expressions, foreign
// keys, or STRICT/WITHOUT ROWID options. Requiring one known complete CREATE
// statement closes all of those lookalike-schema paths. Direct SQLite loading
// retains the snapshot's inline comments, while Wrangler/D1 file ingestion
// strips them before prepare and rebuild migrations are also comment-free.
// Both known complete products are listed exactly.
const HEALTH_REQUIRED_TABLE_DDL = {
  counters: ['createtablecounters(nametextprimarykey,valueintegernotnull)'],
  delivery_outbox: ['createtabledelivery_outbox(license_keytextprimarykey,emailtext,telegram_user_idinteger,is_preorderintegernotnulldefault0,created_atintegernotnull,attemptsintegernotnulldefault0,next_attempt_atintegernotnull,claim_tokentext,lease_untilinteger,delivered_atinteger)'],
  device_tombstones: [
    'createtabledevice_tombstones(device_idtextprimarykey,deleted_atintegernotnull--msepoch)',
    'createtabledevice_tombstones(device_idtextprimarykey,deleted_atintegernotnull)'
  ],
  devices: [
    'createtabledevices(device_idtextprimarykey,first_seenintegernotnull,--msepochlast_seenintegernotnull,--msepochbrowsertext,--chrome|yandex|opera|edge|firefox|otheruatext,--legacy,alwaysnullnow(rawuaisnotstored)versiontext,--extensionversionprovidertext,--lastselectedaiproviderlicense_keytext,--legacy,alwaysnullnowlicense_reftext,--legacypseudonym,nolongerwrittenlicense_typetext--lifetime|subscription|none)',
    'createtabledevices(device_idtextprimarykey,first_seenintegernotnull,last_seenintegernotnull,browsertext,uatext,versiontext,providertext,license_keytext,license_reftext,license_typetext)',
    'createtabledevices(device_idtextprimarykey,first_seenintegernotnull,--msepochlast_seenintegernotnull,--msepochbrowsertext,--chrome|yandex|opera|edge|firefox|otheruatext,--rawua,fordebuggingoddbrowsersversiontext,--extensionversionprovidertext,--lastselectedaiproviderlicense_keytext,--lastknownkeyonthisdevice(maybenull)license_typetext--lifetime|subscription|none,license_reftext)'
  ],
  events: [
    'createtableevents(idintegerprimarykeyautoincrement,tsintegernotnull,--msepoch(client,server-clamped)daytextnotnull,--yyyy-mm-dd,moscowtimedevice_idtextnotnull,typetextnotnull,--install|update|heartbeat|solve|test_solve|test_requestion|gdz_pull|errorsubjecttext,--meshsubjectname(solves/gdz)providertext,--openrouter|groq|qwen|deepseekmodeltext,--exactmodelidtheproviderreportedtokens_inintegernotnulldefault0,tokens_outintegernotnulldefault0,cost_usdrealnotnulldefault0,--exactprovidercostwhenreported,elseestimatefiles_pdfintegernotnulldefault0,--pdfattachmentsonthissolvefiles_imgintegernotnulldefault0,--imageattachments(photos/screenshots)metatext--fixed-vocabulary,typedmetricsonly(seeanalytics.js))',
    'createtableevents(idintegerprimarykeyautoincrement,tsintegernotnull,--msepoch(client,server-clamped)daytextnotnull,--yyyy-mm-dd,moscowtimedevice_idtextnotnull,typetextnotnull,--install|update|heartbeat|solve|test_solve|test_requestion|gdz_pull|errorsubjecttext,--meshsubjectname(solves/gdz)providertext,--openrouter|groq|qwen|deepseekmodeltext,--exactmodelidtheproviderreportedtokens_inintegernotnulldefault0,tokens_outintegernotnulldefault0,cost_usdrealnotnulldefault0,--exactprovidercostwhenreported,elseestimatefiles_pdfintegernotnulldefault0,--pdfattachmentsonthissolvefiles_imgintegernotnulldefault0,--imageattachments(photos/screenshots)metatext--smalljson:{mode,gdz_auto,refused,msg,...})',
    'createtableevents(idintegerprimarykeyautoincrement,tsintegernotnull,daytextnotnull,device_idtextnotnull,typetextnotnull,subjecttext,providertext,modeltext,tokens_inintegernotnulldefault0,tokens_outintegernotnulldefault0,cost_usdrealnotnulldefault0,files_pdfintegernotnulldefault0,files_imgintegernotnulldefault0,metatext)'
  ],
  kv_apply_locks: ['createtablekv_apply_locks(nametextprimarykey,lease_untilintegernotnull)'],
  kv_materializations: ['createtablekv_materializations(nametextprimarykey,materialized_atintegernotnull)'],
  license_activations: [
    "createtablelicense_activations(license_keytextprimarykey,statustextnotnullcheck(statusin('active','inactive')),device_idtext,token_hashtext,generationintegernotnulldefault1check(generation>=1),activated_atinteger,last_seen_atinteger,deactivated_atinteger,check((status='active'anddevice_idisnotnullandtoken_hashisnotnullandactivated_atisnotnullandlast_seen_atisnotnull)or(status='inactive'anddevice_idisnullandtoken_hashisnull)))"
  ],
  license_devices: [
    'createtablelicense_devices(license_keytextnotnull,device_idtextnotnull,added_atintegernotnull,--msepochprimarykey(license_key,device_id))',
    'createtablelicense_devices(license_keytextnotnull,device_idtextnotnull,added_atintegernotnull,primarykey(license_key,device_id))'
  ],
  license_release_fence: [
    'createtablelicense_release_fence(license_keytextprimarykey,device_idtextnotnull,released_atintegernotnull,released_bytext)'
  ],
  license_revocations: [
    'createtablelicense_revocations(license_keytextprimarykey,revoked_atintegernotnull,--msepochreasontext)',
    'createtablelicense_revocations(license_keytextprimarykey,revoked_atintegernotnull,reasontext)'
  ],
  license_telegram_links: [
    'createtablelicense_telegram_links(license_keytextprimarykey,telegram_user_idtextnotnull,linked_atintegernotnull)'
  ],
  payment_issuance: ['createtablepayment_issuance(gatewaytextnotnull,payment_idtextnotnull,license_keytextnotnullunique,license_jsontextnotnull,created_atintegernotnull,primarykey(gateway,payment_id))'],
  payment_events: ['createtablepayment_events(idintegerprimarykeyautoincrement,gatewaytextnotnull,payment_idtextnotnull,order_idinteger,environmenttext,event_typetextnotnull,amount_kopecksinteger,currencytext,details_jsontext,created_atintegernotnull)'],
  payment_orders: ["createtablepayment_orders(order_idintegerprimarykeyautoincrement,gatewaytextnotnullcheck(gateway='robokassa'),environmenttextnotnullcheck(environmentin('production','test')),statustextnotnullcheck(statusin('pending','paid','fulfilled','review','refund_pending','refunded','expired')),amount_kopecksintegernotnullcheck(amount_kopecks>0),currencytextnotnullcheck(currency='rub'),plan_typetextnotnullcheck(plan_typein('lifetime','subscription')),subscription_daysintegercheck(subscription_daysisnullorsubscription_daysbetween1and3650),emailtext,telegram_user_idtext,referral_codetext,device_idtext,is_preorderintegernotnulldefault0check(is_preorderin(0,1)),fiscalization_modetextnotnullcheck(fiscalization_modein('provider','external')),receipt_jsontext,created_atintegernotnull,expires_atintegernotnull,paid_atinteger,fulfilled_atinteger,provider_op_keytext,reconciled_atinteger,refund_request_idtext,refund_statustext,refund_kopecksintegercheck(refund_kopecksisnullorrefund_kopecks>0),refunded_atinteger,check((fiscalization_mode='provider'andreceipt_jsonisnotnull)or(fiscalization_mode='external'andreceipt_jsonisnull)))"],
  payment_refund_poll: ['createtablepayment_refund_poll(order_idintegerprimarykey,attemptsintegernotnulldefault0check(attempts>=0),next_poll_atintegernotnulldefault0,last_errortext,last_error_atinteger)'],
  payment_review: [
    'createtablepayment_review(gatewaytextnotnull,payment_idtextnotnull,invoice_idtext,amount_rubreal,reasontextnotnull,--invalid_plan_config|no_floor_configured|below_floor|no_contact|no_plan_matchedfields_jsontext,created_atintegernotnull,--msepochresolved_atinteger,environmenttext,amount_kopecksinteger,resolutiontext,resolution_notetext,primarykey(gateway,payment_id))',
    'createtablepayment_review(gatewaytextnotnull,payment_idtextnotnull,invoice_idtext,amount_rubreal,reasontextnotnull,--no_floor_configured|below_floor|no_contact|no_plan_matchedfields_jsontext,created_atintegernotnull,--msepochresolved_atinteger,environmenttext,amount_kopecksinteger,resolutiontext,resolution_notetext,primarykey(gateway,payment_id))',
    'createtablepayment_review(gatewaytextnotnull,payment_idtextnotnull,invoice_idtext,amount_rubreal,reasontextnotnull,fields_jsontext,created_atintegernotnull,resolved_atinteger,environmenttext,amount_kopecksinteger,resolutiontext,resolution_notetext,primarykey(gateway,payment_id))'
  ],
  proxy_quota: [
    "createtableproxy_quota(daytextnotnull,--yyyy-mm-dd,moscowtimelicense_keytextnotnull,--normalizedkey,or'*'forglobalprovidertextnotnull,--qwen|deepseek|'all'(globalrow)countintegernotnulldefault0,primarykey(day,license_key,provider))",
    'createtableproxy_quota(daytextnotnull,license_keytextnotnull,providertextnotnull,countintegernotnulldefault0,primarykey(day,license_key,provider))'
  ],
  purchases: [
    'createtablepurchases(license_keytextprimarykey,gatewaytext,--robokassa|manual|referral|...payment_idtext,typetext,--lifetime|subscriptionstatustext,--active|revokedamount_rubreal,--nullforcomp/referralkeysemailtext,telegram_user_idtext,issued_atinteger,--msepochexpires_atinteger,--msepoch,null=lifetimeis_preorderintegerdefault0,notetext,device_idstext,--jsonarrayofactivateddeviceidsamount_kopecksinteger--authoritativeminorunitsformoney)',
    'createtablepurchases(license_keytextprimarykey,gatewaytext,--robokassa|manual|referral|...payment_idtext,typetext,--lifetime|subscriptionstatustext,--active|revokedamount_rubreal,--nullforcomp/referralkeysemailtext,telegram_user_idtext,issued_atinteger,--msepochexpires_atinteger,--msepoch,null=lifetimeis_preorderintegerdefault0,notetext,device_idstext--jsonarrayofactivateddeviceids,amount_kopecksinteger)',
    'createtablepurchases(license_keytextprimarykey,gatewaytext,payment_idtext,typetext,statustext,amount_rubreal,emailtext,telegram_user_idtext,issued_atinteger,expires_atinteger,is_preorderintegerdefault0,notetext,device_idstext,amount_kopecksinteger)'
  ],
  referral_apply_locks: ['createtablereferral_apply_locks(ref_codetextprimarykey,lease_untilintegernotnull)'],
  referral_auth_claims: ['createtablereferral_auth_claims(auth_hashtextprimarykey,codetextnotnull,created_atintegernotnull)'],
  referral_credit_state: [
    'createtablereferral_credit_state(license_keytextprimarykey,ref_codetextnotnull,daysintegernotnull,statustextnotnull,--pending|appliedcreated_atintegernotnull,applied_atinteger,materialized_atinteger,--setafterd1-derivedref:*kvrewritetarget_kindtext,--owner|rewardtarget_keytext,target_expirytext,--fixedisoexpiryforreplaytarget_generationintegernotnulldefault0,retry_attemptsintegernotnulldefault0,retry_afterintegernotnulldefault0,--msepoch;failedcodesbackofflast_error_atinteger)',
    'createtablereferral_credit_state(license_keytextprimarykey,ref_codetextnotnull,daysintegernotnull,statustextnotnull,created_atintegernotnull,applied_atinteger,materialized_atinteger,target_kindtext,target_keytext,target_expirytext,target_generationintegernotnulldefault0,retry_attemptsintegernotnulldefault0,retry_afterintegernotnulldefault0,last_error_atinteger)'
  ],
  referral_credits: ['createtablereferral_credits(license_keytextprimarykey,ref_codetextnotnull,claimed_atintegernotnull)'],
  runtime_write_fence: ['createtableruntime_write_fence(singletonintegerprimarykeycheck(singleton=1),write_epochintegernotnullcheck(write_epoch>=1),writes_enabledintegernotnulldefault1check(writes_enabledin(0,1)),updated_atintegernotnull)'],
  subscription_notifications: [
    "createtablesubscription_notifications(idintegerprimarykeyautoincrement,license_keytextnotnull,stagetextnotnullcheck(stagein('expiry_3d','expiry_1d','expired','winback')),telegram_user_idtextnotnull,due_atintegernotnull,created_atintegernotnull,attemptsintegernotnulldefault0check(attempts>=0),next_attempt_atintegernotnull,claim_tokentext,lease_untilinteger,sent_atinteger,cancelled_atinteger,answer_codetext,answered_atinteger,unique(license_key,stage))"
  ],
  support_forward_outbox: ['createtablesupport_forward_outbox(ticket_notextprimarykey,source_chat_idtext,source_message_idinteger,has_attachmentintegernotnulldefault0check(has_attachmentin(0,1)),created_atintegernotnull,attemptsintegernotnulldefault0check(attempts>=0),next_attempt_atintegernotnull,claim_tokentext,lease_untilinteger,text_forwarded_atinteger,attachment_forwarded_atinteger,forwarded_atinteger,check(has_attachment=0orforwarded_atisnotnullor(source_chat_idisnotnullandsource_message_idisnotnull)))'],
  telegram_updates: ['createtabletelegram_updates(update_idintegerprimarykey,claimed_atintegernotnull,lease_untilintegernotnull,completed_atinteger,result_kindtext,ticket_notext)'],
  telemetry_budget: [
    'createtabletelemetry_budget(daytextnotnull,scopetextnotnull,--ip|device|admin_fail|verify_failbudget_keytextnotnull,countintegernotnulldefault0,primarykey(day,scope,budget_key))',
    'createtabletelemetry_budget(daytextnotnull,scopetextnotnull,--ip|devicebudget_keytextnotnull,countintegernotnulldefault0,primarykey(day,scope,budget_key))',
    'createtabletelemetry_budget(daytextnotnull,scopetextnotnull,budget_keytextnotnull,countintegernotnulldefault0,primarykey(day,scope,budget_key))'
  ]
};
const HEALTH_OPTIONAL_PLATFORM_TABLE_DDL = {
  d1_migrations: [
    'createtabled1_migrations(idintegerprimarykeyautoincrement,nametextunique,applied_attimestampdefaultcurrent_timestampnotnull)'
  ],
  _cf_KV: ['createtable_cf_kv(keytextprimarykey,valueblob)withoutrowid'],
  _cf_METADATA: ['createtable_cf_metadata(keyintegerprimarykey,valueblob)']
};
const HEALTH_REQUIRED_TABLES = Object.keys(HEALTH_REQUIRED_TABLE_SIGNATURES);
const HEALTH_REQUIRED_INDEXES = {
  idx_license_activations_device: {
    table: 'license_activations', unique: false, partial: true,
    columns: ['device_id'],
    ddl: "createindexidx_license_activations_deviceonlicense_activations(device_id)wherestatus='active'"
  },
  idx_delivery_outbox_due: {
    table: 'delivery_outbox', unique: false,
    columns: ['delivered_at', 'next_attempt_at', 'lease_until'],
    ddl: 'createindexidx_delivery_outbox_dueondelivery_outbox(delivered_at,next_attempt_at,lease_until)'
  },
  idx_events_day: {
    table: 'events', unique: false, columns: ['day'],
    ddl: 'createindexidx_events_dayonevents(day)'
  },
  idx_events_device: {
    table: 'events', unique: false, columns: ['device_id', 'day'],
    ddl: 'createindexidx_events_deviceonevents(device_id,day)'
  },
  idx_events_type: {
    table: 'events', unique: false, columns: ['type', 'day'],
    ddl: 'createindexidx_events_typeonevents(type,day)'
  },
  idx_license_devices_device: {
    table: 'license_devices', unique: false, columns: ['device_id'],
    ddl: 'createindexidx_license_devices_deviceonlicense_devices(device_id)'
  },
  idx_payment_events_payment: {
    table: 'payment_events', unique: false, columns: ['gateway', 'payment_id', 'created_at'],
    ddl: 'createindexidx_payment_events_paymentonpayment_events(gateway,payment_id,created_at)'
  },
  idx_payment_orders_status: {
    table: 'payment_orders', unique: false, columns: ['environment', 'status', 'created_at'],
    ddl: 'createindexidx_payment_orders_statusonpayment_orders(environment,status,created_at)'
  },
  idx_payment_refund_poll_due: {
    table: 'payment_refund_poll', unique: false, columns: ['next_poll_at'],
    ddl: 'createindexidx_payment_refund_poll_dueonpayment_refund_poll(next_poll_at)'
  },
  idx_purchases_issued: {
    table: 'purchases', unique: false, columns: ['issued_at'],
    ddl: 'createindexidx_purchases_issuedonpurchases(issued_at)'
  },
  idx_purchases_telegram: {
    table: 'purchases', unique: false, columns: ['telegram_user_id'],
    ddl: 'createindexidx_purchases_telegramonpurchases(telegram_user_id)'
  },
  idx_license_telegram_links_user: {
    table: 'license_telegram_links', unique: false, columns: ['telegram_user_id'],
    ddl: 'createindexidx_license_telegram_links_useronlicense_telegram_links(telegram_user_id)'
  },
  idx_subscription_notifications_due: {
    table: 'subscription_notifications', unique: false,
    columns: ['sent_at', 'cancelled_at', 'next_attempt_at', 'lease_until'],
    ddl: 'createindexidx_subscription_notifications_dueonsubscription_notifications(sent_at,cancelled_at,next_attempt_at,lease_until)'
  },
  idx_telegram_updates_claimed: {
    table: 'telegram_updates', unique: false, columns: ['claimed_at'],
    ddl: 'createindexidx_telegram_updates_claimedontelegram_updates(claimed_at)'
  },
  idx_referral_auth_claims_code: {
    table: 'referral_auth_claims', unique: true, columns: ['code'],
    ddl: 'createuniqueindexidx_referral_auth_claims_codeonreferral_auth_claims(code)'
  },
  idx_referral_credit_retry: {
    table: 'referral_credit_state', unique: false,
    columns: ['status', 'materialized_at', 'retry_after', 'created_at'],
    ddl: 'createindexidx_referral_credit_retryonreferral_credit_state(status,materialized_at,retry_after,created_at)'
  },
  idx_support_forward_outbox_due: {
    table: 'support_forward_outbox', unique: false,
    columns: ['forwarded_at', 'next_attempt_at', 'lease_until'],
    ddl: 'createindexidx_support_forward_outbox_dueonsupport_forward_outbox(forwarded_at,next_attempt_at,lease_until)'
  }
};
const HEALTH_REQUIRED_UNIQUE_CONSTRAINTS = [{
  label: 'payment_issuance.UNIQUE(license_key)',
  table: 'payment_issuance',
  columns: ['license_key'],
  origin: 'u'
}, {
  // The send-once guarantee for every subscription reminder. Without the
  // constraint a retry that lost its completion write mails the buyer twice.
  label: 'subscription_notifications.UNIQUE(license_key, stage)',
  table: 'subscription_notifications',
  columns: ['license_key', 'stage'],
  origin: 'u'
}];
function tableColumnSignature(columns) {
  return (columns || []).map((column) => [
    column.name,
    String(column.type || '').toUpperCase(),
    Number(column.notnull) || 0,
    column.dflt_value == null ? '' : String(column.dflt_value),
    Number(column.pk) || 0
  ].join(':')).join('|');
}

const signatureColumnNames = (signature) =>
  String(signature).split('|').map((part) => part.split(':', 1)[0]);

function compactSchemaSql(value) {
  return String(value || '').toLowerCase().replace(/["`\[\]\s]/g, '');
}

// GET /admin/health — READINESS, admin-gated because component and config
// state must not leak publicly (the open /health stays pure liveness).
// 503 whenever a dependency of the paid paths is broken, so monitoring can
// alert on exactly the state where /health smiles while nothing can be sold.
// `worklists` are the human queues: money moved but an operator must act.
async function handleAdminHealth(request, env) {
  const gate = await adminGate(
    request,
    env,
    null,
    { recordFailures: !backupMaintenanceEnabled(env) }
  );
  if (gate) return gate;

  const checks = {
    backup_maintenance: !backupMaintenanceEnabled(env),
    write_fence: false,
    kv: false,
    db: false,
    schema: false,
    worklists: false,
    payment_floor: minPaymentRub(env) > 0,
    payment_plan: paymentPlanConfigValid(env),
    payment_config: payments.paymentConfigValid(env),
    checkout_config: payments.checkoutConfigValid(env),
    checkout_capability_secret: payments.checkoutCapabilitySecretValid(env),
    payment_refunds: payments.paymentRefundConfigValid(env),
    device_limit: deviceLimitConfigValid(env),
    robokassa_password2: !!payments.robokassaCredential(env, 2),
    robokassa_hash: robokassa.isSupportedHashAlgorithm(env.ROBOKASSA_HASH_ALGO),
    delivery_channel: !!(env.RESEND_API_KEY || env.TELEGRAM_BOT_TOKEN),
    support_owner: supportConfigValid(env),
    telegram_webhook_secret: payments.telegramWebhookSecretValid(env),
    admin_secret: typeof env.ADMIN_SECRET === 'string' && env.ADMIN_SECRET.length >= 32,
    stats_secret: typeof env.STATS_SECRET === 'string' && env.STATS_SECRET.length >= 32,
    // Production has one quota/admission authority: the VPS. The Worker route
    // remains available only as an explicit emergency compatibility switch.
    ai_proxy_key: !legacyAiProxyEnabled(env) || !!env.AI_PROXY_API_KEY,
    ingest_key: typeof env.INGEST_KEY === 'string' && env.INGEST_KEY.length >= 32
  };
  let missingTables = [];
  const missingColumns = [];
  const invalidTableShapes = [];
  const missingIndexes = [];
  const invalidConstraints = [];
  const unexpectedSchemaObjects = [];
  const writeFence = {
    configured_epoch: configuredWriteEpoch(env),
    database_epoch: null,
    writes_enabled: null
  };
  const worklists = {
    delivery_exhausted: null,
    payment_review_open: null,
    payment_reconciliation_errors: null,
    refund_submission_unknown: null,
    refund_poll_stalled: null,
    referral_unsettled: null,
    referral_legacy_unjournaled: null,
    support_forward_exhausted: null,
    subscription_notify_exhausted: null
  };

  try {
    if (env.LICENSES) { await env.LICENSES.get('health:probe'); checks.kv = true; }
  } catch (e) {
    console.error('health: kv probe failed', safeErrorText(e, env));
  }
  if (env.DB) {
    try {
      const rows = await env.DB.prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE type IN ('table', 'index', 'view', 'trigger')`
      ).all();
      checks.db = true;
      const schemaRows = rows?.results || [];
      const present = new Set(
        schemaRows.filter((row) => row.type === 'table').map((row) => row.name)
      );
      const tableSql = new Map(
        schemaRows
          .filter((row) => row.type === 'table')
          .map((row) => [row.name, compactSchemaSql(row.sql)])
      );
      const indexSql = new Map(
        schemaRows
          .filter((row) => row.type === 'index' && row.sql != null)
          .map((row) => [row.name, compactSchemaSql(row.sql)])
      );
      const requiredTables = new Set(HEALTH_REQUIRED_TABLES);
      const requiredIndexes = new Set(Object.keys(HEALTH_REQUIRED_INDEXES));
      for (const row of schemaRows) {
        const name = String(row.name || '');
        if (!name || name.startsWith('sqlite_')) continue;
        if (row.type === 'table') {
          if (requiredTables.has(name)) continue;
          const optionalDdl = HEALTH_OPTIONAL_PLATFORM_TABLE_DDL[name];
          if (optionalDdl?.includes(compactSchemaSql(row.sql))) continue;
          if (optionalDdl) invalidTableShapes.push(name);
          else unexpectedSchemaObjects.push(`table:${name}`);
          continue;
        }
        if (row.type === 'index' && requiredIndexes.has(name)) continue;
        // Autoindexes use sqlite_* names and were skipped above. Every other
        // index/view/trigger can alter accepted writes or application reads.
        unexpectedSchemaObjects.push(`${row.type}:${name}`);
      }
      missingTables = HEALTH_REQUIRED_TABLES.filter((t) => !present.has(t));
      if (missingTables.length === 0) {
        for (const [table, expectedSignature] of
          Object.entries(HEALTH_REQUIRED_TABLE_SIGNATURES)) {
          const columns = await env.DB.prepare(
            `PRAGMA table_xinfo("${table}")`
          ).all();
          const foundColumns = columns?.results || [];
          const found = new Set(foundColumns.map((column) => column.name));
          for (const column of signatureColumnNames(expectedSignature)) {
            if (!found.has(column)) missingColumns.push(`${table}.${column}`);
          }
          const acceptedSignatures = [
            expectedSignature,
            ...(HEALTH_ACCEPTED_LEGACY_TABLE_SIGNATURES[table] || [])
          ];
          if (!acceptedSignatures.includes(tableColumnSignature(foundColumns))) {
            invalidTableShapes.push(table);
          }
          if (foundColumns.some((column) => Number(column.hidden) !== 0) ||
              !HEALTH_REQUIRED_TABLE_DDL[table]?.includes(tableSql.get(table) || '')) {
            if (!invalidTableShapes.includes(table)) invalidTableShapes.push(table);
          }
        }
        for (const [name, requirement] of Object.entries(HEALTH_REQUIRED_INDEXES)) {
          const indexList = await env.DB.prepare(
            `PRAGMA index_list("${requirement.table}")`
          ).all();
          const foundIndex = (indexList?.results || []).find((index) => index.name === name);
          let columns = [];
          if (foundIndex) {
            const info = await env.DB.prepare(`PRAGMA index_info("${name}")`).all();
            columns = (info?.results || [])
              .slice()
              .sort((left, right) => Number(left.seqno) - Number(right.seqno))
              .map((column) => column.name);
          }
          if (!foundIndex || Boolean(foundIndex.unique) !== requirement.unique ||
              foundIndex.origin !== 'c' ||
              Boolean(Number(foundIndex.partial)) !== Boolean(requirement.partial) ||
              columns.join('|') !== requirement.columns.join('|') ||
              indexSql.get(name) !== requirement.ddl) {
            missingIndexes.push(name);
          }
        }
        for (const requirement of HEALTH_REQUIRED_UNIQUE_CONSTRAINTS) {
          const indexList = await env.DB.prepare(
            `PRAGMA index_list("${requirement.table}")`
          ).all();
          let matched = false;
          for (const index of indexList?.results || []) {
            if (!index.unique || index.origin !== requirement.origin) continue;
            const info = await env.DB.prepare(`PRAGMA index_info("${index.name}")`).all();
            const columns = (info?.results || [])
              .slice()
              .sort((left, right) => Number(left.seqno) - Number(right.seqno))
              .map((column) => column.name);
            if (columns.join('|') === requirement.columns.join('|')) {
              matched = true;
              break;
            }
          }
          if (!matched) invalidConstraints.push(requirement.label);
        }
      }
      checks.schema = missingTables.length === 0 &&
        missingColumns.length === 0 && invalidTableShapes.length === 0 &&
        missingIndexes.length === 0 && invalidConstraints.length === 0 &&
        unexpectedSchemaObjects.length === 0;
    } catch (e) {
      console.error('health: schema probe failed', safeErrorText(e, env));
    }
    try {
      const row = await env.DB.prepare(
        'SELECT write_epoch, writes_enabled FROM runtime_write_fence WHERE singleton = 1'
      ).first();
      writeFence.database_epoch = Number.isSafeInteger(Number(row?.write_epoch))
        ? Number(row.write_epoch)
        : null;
      writeFence.writes_enabled = Number(row?.writes_enabled) === 0 ||
        Number(row?.writes_enabled) === 1
        ? Number(row.writes_enabled)
        : null;
      const expectedEnabled = backupMaintenanceEnabled(env) ? 0 : 1;
      checks.write_fence = writeFence.configured_epoch != null &&
        writeFence.database_epoch === writeFence.configured_epoch &&
        writeFence.writes_enabled === expectedEnabled;
    } catch (e) {
      console.error('health: write fence probe failed', safeErrorText(e, env));
    }
    if (checks.schema) {
      try {
        Object.assign(worklists, await analytics.collectWorklists(env, WORKLIST_THRESHOLDS));
        checks.worklists = true;
      } catch (e) {
        console.error('health: worklist probe failed', safeErrorText(e, env));
      }
    }
  }

  // Every named item above is a launch/readiness invariant. Derive the verdict
  // from the collection itself so a newly added check cannot be displayed as
  // false while the endpoint still reports HTTP 200.
  const ok = Object.values(checks).every(Boolean);
  return json(
    {
      ok,
      checks,
      missing_tables: missingTables,
      missing_columns: missingColumns,
      invalid_table_shapes: invalidTableShapes,
      missing_indexes: missingIndexes,
      invalid_constraints: invalidConstraints,
      unexpected_schema_objects: unexpectedSchemaObjects,
      write_fence: writeFence,
      worklists
    },
    { status: ok ? 200 : 503 }
  );
}

async function handleAdminIssue(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  const parsed = await readJsonBounded(request, 16 * 1024);
  if (!parsed.ok) return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json');
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_json');

  // Reject shapes issueLicense would refuse anyway, but as a 400 the operator
  // can read: unknown types and subscriptions whose expiry is absent or
  // unparseable would otherwise verify as "never expires".
  const type = body.type || 'lifetime';
  if (type !== 'lifetime' && type !== 'subscription') return error(400, 'bad_type');
  if (body.expires_at != null && !normalizeExpiry(body.expires_at)) {
    return error(400, 'bad_expiry');
  }
  const subscriptionDays = body.subscription_days == null
    ? null
    : Number(body.subscription_days);
  if (body.subscription_days != null &&
      (!Number.isSafeInteger(subscriptionDays) || subscriptionDays < 1 || subscriptionDays > 3650)) {
    return error(400, 'bad_subscription_days');
  }
  if (type === 'subscription' && body.expires_at == null && subscriptionDays == null) {
    return error(400, 'bad_expiry');
  }

  const license = await issueLicense(env, {
    gateway: body.gateway || 'manual',
    payment_id: body.payment_id || null,
    email: body.email || null,
    telegram_user_id: body.telegram_user_id || null,
    type: body.type || 'lifetime',
    expires_at: body.expires_at || null,
    subscription_days: subscriptionDays,
    amount_rub: body.amount_rub || null,
    is_preorder: !!body.is_preorder,
    note: body.note || null
  });

  if (body.deliver !== false) {
    // Admins intentionally use this route to resend an existing key.
    await deliverKey(env, license, !!body.is_preorder, { force: true });
  }
  return json({ ok: true, license });
}

async function handleAdminRevoke(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json');
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'bad_json');
  // revokeLicense records the revocation in D1 first (strongly consistent,
  // insert-only) so a concurrent /verify device-mirror write can never
  // resurrect the KV row back to active. D1 failures propagate as 500 —
  // the admin retries rather than trusting a KV-only revoke.
  const license = await revokeLicense(env, body.key, body.reason || null);
  if (!license) return error(404, 'not_found');
  await referrals.reverseReferralCreditForPurchase(env, license.key);
  return json({ ok: true, license });
}

async function handleAdminPaymentReviewResolve(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db');
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) {
    return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json');
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return error(400, 'bad_json');
  }
  const result = await payments.resolvePaymentReview(env, parsed.value);
  return result.ok ? json(result) : error(result.status, result.reason);
}

async function settleReconciledRobokassaPayment(env, ctx, result) {
  const order = result.order;
  const n = {
    ok: true,
    gateway: 'robokassa',
    invoice_id: String(order.order_id),
    payment_id: String(order.order_id),
    amount_kopecks: Number(order.amount_kopecks),
    amount_rub: Number(order.amount_kopecks) / 100
  };
  const fields = {
    Shp_environment: order.environment,
    Shp_order_id: String(order.order_id)
  };
  const recovered = await recoverPaymentLicense(env, 'robokassa', n.payment_id);
  const response = recovered
    ? await settleIssuedRobokassaPayment(env, ctx, n, fields, recovered, null, order)
    : await fulfillAuthorizedRobokassaOrder(env, ctx, order, n, fields);
  if (!response.ok) return response;
  // Both settlement paths answer the gateway contract. Re-read the durable
  // order before claiming to an operator/cron that fulfillment succeeded.
  const settled = await payments.loadRobokassaOrder(env, n.payment_id);
  if (settled?.status !== 'fulfilled') {
    return json({
      ok: false,
      paid: true,
      fulfilled: false,
      reason: 'payment_review_required',
      order_status: settled?.status || null,
      order_id: n.payment_id
    }, { status: 409 });
  }
  return json({ ok: true, paid: true, fulfilled: true, order_id: n.payment_id });
}

async function handleAdminPaymentReconcile(request, env, ctx) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db');
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) {
    return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json');
  }
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      !/^\d+$/.test(String(body.order_id || ''))) {
    return error(400, 'bad_order');
  }
  const result = await payments.reconcileRobokassaOrder(env, String(body.order_id));
  if (!result.ok) return error(result.status, result.reason);
  if (!result.paid) {
    return json({ ok: true, paid: false, state_code: result.provider.state_code });
  }
  return settleReconciledRobokassaPayment(env, ctx, result);
}

async function handleAdminPaymentRefund(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db');
  const parsed = await readJsonBounded(request, 4096);
  if (!parsed.ok) {
    return error(parsed.status, parsed.reason === 'too_large' ? 'body_too_large' : 'bad_json');
  }
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return error(400, 'bad_json');
  }
  const result = await payments.initiateRobokassaRefund(env, parsed.value);
  return result.ok ? json(result) : error(result.status, result.reason);
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

// CLI-only recovery for durable incomplete or stale user-visible credits.
async function handleAdminReferralRetryPending(request, env) {
  const gate = await adminGate(request, env);
  if (gate) return gate;
  if (!env.DB) return error(503, 'no_db');
  const result = await referrals.retryPendingReferralCredits(env, 50);
  return json({ ok: true, ...result });
}
