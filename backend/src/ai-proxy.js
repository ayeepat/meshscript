/**
 * Retired license-gated AI proxy: stable Think + Auto routes via 302.AI
 * reseller — no Alibaba KYC needed for the key) for licensed users WITHOUT
 * their own API key. The extension sends its СМЭШ license key + device id +
 * random activation bearer as the credential; this worker holds the single AI_PROXY_API_KEY secret (a
 * 302.AI key), re-verifies the license, enforces quotas, and pipes the
 * upstream SSE stream back to the client UNPARSED (a byte passthrough —
 * near-zero CPU, and the extension's existing postStream() consumes it
 * unchanged, usage frames included).
 *
 * Spend protection — this must never be an open tap:
 *   1. A valid ACTIVE license is required, verified server-side per request
 *      (unlike the extension's client-side gate, this cannot be bypassed).
 *      verifyLicense also enforces the one-active-device activation lease.
 *   2. Per-license per-provider daily caps (PROXY_QWEN_DAILY /
 *      PROXY_DEEPSEEK_DAILY vars) — a leaked or scripted key is bounded.
 *   3. A global daily circuit breaker across ALL users (PROXY_GLOBAL_DAILY)
 *      — the total bill physically cannot run away.
 *   4. Request hygiene: fixed model per provider (client input ignored),
 *      clamped temperature/max_tokens, message/part/body-size caps, images
 *      accepted only as data: URIs.
 *
 * Counters live in D1 (proxy_quota, see schema.sql) via atomic upserts,
 * keyed by Moscow calendar day like the rest of analytics.
 *
 * Student-facing errors are ready-made Russian sentences and NEVER mention
 * API keys — an upstream auth/billing failure is the OWNER's problem and
 * surfaces here as console.error for `wrangler tail`, not to the student.
 */

import { verifyLicense, normalizeKey } from './licenses.js';
import { readBodyBounded, readJsonBounded } from './request-body.js';
import { mskDay } from './analytics.js';
import { cleanPublicDeviceId } from './referrals.js';

const DEFAULT_COMPAT_BASE_URL = 'https://api.302.ai/v1';

const PROVIDERS = {
  qwen: {
    modelDefault: 'qwen3.7-plus',
    modelVar: 'PROXY_QWEN_MODEL',
    fallbackVar: 'PROXY_QWEN_FALLBACK_MODELS',
    // A live probe found qwen-plus (text-only) answers a vision request with
    // HTTP 200 and a WRONG guess ("Unknown" for a solid-red image) instead of
    // erroring — a silent bad answer, worse than no answer. So when the
    // request carries an image, only vision-capable fallbacks are tried (see
    // modelChoices / hasImages). qwen-vl-plus is vision-capable (verified
    // live: correctly named a red test image).
    visionFallbackVar: 'PROXY_QWEN_VISION_FALLBACK_MODELS',
    name: 'Qwen',
    capVar: 'PROXY_QWEN_DAILY',
    capDefault: 80
    // No reasoningEffort: qwen3.7-plus THINKS BY DEFAULT on 302.AI and has no
    // effort levels — only enable_thinking/thinking_budget, neither of which
    // maps to the solver's medium/high effort semantics.
  },
  deepseek: {
    // Frozen route id for old extension builds; it is not the upstream vendor.
    modelDefault: 'qwen3.7-plus',
    modelVar: 'PROXY_AUTO_MODEL',
    // qwen3.7-plus is multimodal, so Auto needs no separate vision model; the
    // vision fallback stays vision-capable for the same reason as PROVIDERS.qwen.
    visionFallbackVar: 'PROXY_AUTO_VISION_FALLBACK_MODELS',
    name: 'Auto',
    capVar: 'PROXY_DEEPSEEK_DAILY',
    capDefault: 150,
    // Kept true so an env switch back to DeepSeek/GLM restores passthrough; the
    // per-model policy below suppresses it while Auto resolves to Qwen.
    reasoningEffort: true
  }
};

// The only effort values the client may pick; anything else is dropped so a
// scripted caller can't smuggle arbitrary strings into the upstream request.
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const GLM_53_FLASH = /^glm-5\.3-flash$/i;
// Qwen thinks by default and exposes no OpenAI-style effort levels (only
// enable_thinking/thinking_budget), so reasoning_effort is never sent to it.
// Mirrors backend-vps/server.js QWEN_MODEL — keep both in sync.
const QWEN_MODEL = /^qwen/i;

const MAX_BODY_BYTES = 8 * 1024 * 1024; // base64 photos of worksheets fit; nothing sane exceeds this
const MAX_MESSAGES = 60;                // system + capped history + current turn
const MAX_PARTS = 20;                   // content parts per message (text + attachments)
const MAX_TEXT_PART_CHARS = 50000;      // matches the client's own file-text truncation (qwen.js/deepseek.js)
const MAX_IMAGE_DATA_URI_CHARS = 6 * 1024 * 1024; // ~4.4MB decoded (base64 inflates ~4/3) per image
const MAX_IMAGE_DECODED_BYTES = 4.5 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 6;       // across the whole message array, history included
const MAX_TOKENS_OUT = 8192;            // output spend bound; solves never come close
const GLOBAL_DAILY_DEFAULT = 3000;
// Keep active/complex formats such as SVG away from the shared paid upstream
// parser. The extension only produces these raster formats.
const SAFE_IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isSafeImageDataUri(value) {
  if (value.length > MAX_IMAGE_DATA_URI_CHARS) return false;
  const match = SAFE_IMAGE_DATA_URI.exec(value);
  if (!match) return false;
  const payload = match[1];
  if (payload.length % 4 !== 0) return false;

  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const decodedBytes = (payload.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > MAX_IMAGE_DECODED_BYTES) return false;

  // Correct padding length is not enough for canonical base64: unused bits in
  // the final sextet must be zero (otherwise strings such as "Zh==" are
  // alternate encodings of the same byte). FileReader emits canonical data.
  if (padding === 2 && (BASE64_ALPHABET.indexOf(payload.at(-3)) & 0x0f) !== 0) return false;
  if (padding === 1 && (BASE64_ALPHABET.indexOf(payload.at(-2)) & 0x03) !== 0) return false;
  return true;
}

// Same open CORS as /verify: the extension calls from chrome-extension://
// origins, no credentials involved.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const UNAVAILABLE = 'ИИ-сервис временно недоступен. Попробуйте позже или переключитесь на другой провайдер в настройках.';
const NEED_LICENSE = 'Модели СМЭШ работают по лицензии. Введите ключ доступа (SMESH-…) в настройках расширения.';
const NEED_DEVICE_ID = 'Не удалось подтвердить устройство. Обновите расширение СМЭШ AI до последней версии и попробуйте снова.';

// License failure → what the student should actually do. Mirrors the
// extension's REASON_MESSAGES but phrased for the licensed-model situation.
const LICENSE_ERRORS = {
  not_found: 'Ключ лицензии не найден. Проверьте его в настройках расширения.',
  expired: 'Срок действия лицензии истёк. Продлите её, чтобы пользоваться моделями СМЭШ.',
  revoked: 'Эта лицензия была отозвана. Напишите в поддержку.',
  device_in_use: 'Ключ уже используется на устройстве №1. Сначала нажмите «Деактивировать ключ» на устройстве №1.',
  device_limit: 'Ключ уже используется на устройстве №1. Сначала деактивируйте его там.',
  bad_activation: 'Не удалось подтвердить активацию. Деактивируйте ключ на устройстве №1 или напишите в поддержку.',
  activation_mismatch: 'Ключ активирован на другом устройстве. Сначала деактивируйте его на устройстве №1.',
  bad_device: NEED_DEVICE_ID
};

const errResponse = (status, message) => new Response(
  JSON.stringify({ ok: false, error: { message } }),
  { status, headers: { 'Content-Type': 'application/json', ...CORS } }
);

function intVar(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function upstreamUrl(env) {
  const raw = String(env.AI_PROXY_BASE_URL || DEFAULT_COMPAT_BASE_URL).trim();
  const base = raw.replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

// No fallback to the legacy DASHSCOPE_API_KEY secret on purpose: it holds a
// real Alibaba key, which is not a valid credential for 302.AI (a different
// provider) — treating it as an interchangeable fallback would silently pair
// the wrong key with the 302.AI URL instead of failing loudly. Delete that
// orphaned secret with `wrangler secret delete DASHSCOPE_API_KEY` whenever.
function upstreamKey(env) {
  return env.AI_PROXY_API_KEY || '';
}

// Own-property lookup only: `PROVIDERS[providerId]` also resolves
// Object.prototype members, so `provider:"constructor"` used to pass the
// unknown-provider gate with a config that has no capVar/capDefault. The VPS
// twin of this function (backend-vps/server.js providerById) must stay in sync.
function providerConfig(env, providerId) {
  if (typeof providerId !== 'string' || !Object.hasOwn(PROVIDERS, providerId)) return null;
  const p = PROVIDERS[providerId];
  const model = String(env[p.modelVar] || p.modelDefault).trim() || p.modelDefault;
  return { ...p, model };
}

function licenseErrorMessage(reason) {
  return (typeof reason === 'string' && Object.hasOwn(LICENSE_ERRORS, reason)
    ? LICENSE_ERRORS[reason]
    : '') || NEED_LICENSE;
}

function modelChoices(env, provider, hasImages) {
  const seen = new Set();
  const out = [];
  const add = (model) => {
    const m = String(model || '').trim();
    if (m && !seen.has(m)) { seen.add(m); out.push(m); }
  };
  add(provider.model);
  // Vision requests only fall back within vision-capable models — see the
  // visionFallbackVar comment on PROVIDERS.qwen for why this matters.
  const fallbackVar = (hasImages && provider.visionFallbackVar) || provider.fallbackVar;
  if (fallbackVar) {
    for (const m of String(env[fallbackVar] || '').split(',')) add(m);
  }
  return out;
}

// "This model isn't served to you" — the only failure worth retrying with a
// fallback model. 302.AI answers an unknown/unavailable model with HTTP 503 +
// {"error":{"err_code":-10008,"message":"No available models currently…"}}
// (captured live 2026-07-07). The DashScope patterns stay as harmless history
// in case an old base URL is configured back in.
function isUnpurchased(_status, text) {
  return /No available models|"err_code"\s*:\s*-10008|AccessDenied\.Unpurchased|access to model denied|eligible for using the model/i.test(text || '');
}

/**
 * Statuses that prove the provider REFUSED the request instead of running it.
 * Reading any response at all means the request reached 302.AI, so the only
 * safe releases are its own explicit rejections: auth/billing refusals, quota
 * refusals, malformed-request rejections, and the "no such model for you"
 * marker (isUnpurchased, which 302.AI serves as a 503).
 *
 * Everything NOT listed here — a cancelled or reset connection, a timeout, an
 * ambiguous 5xx — may have executed a paid completion whose bytes we simply
 * never saw. Those keep the reservation: over-counting bounds the bill, while
 * refunding ambiguous work makes the daily caps stop bounding it at all.
 */
const NON_BILLABLE_STATUSES = new Set([400, 401, 402, 403, 404, 405, 413, 422, 429]);

function isNonBillableRejection(status, text) {
  return NON_BILLABLE_STATUSES.has(status) || isUnpurchased(status, text);
}

/**
 * POST /ai/chat — thin wrapper so ANY uncaught failure inside (a missing
 * proxy_quota table, a D1 outage, a future bug) still returns the friendly
 * Russian 503 WITH the proxy's CORS headers. Without this, an exception here
 * falls through to worker.js's generic top-level catch, which returns a bare
 * {ok:false,reason:'server_error'} with NO Access-Control-Allow-Origin — the
 * browser blocks the extension from ever reading it, so the student sees an
 * opaque network/CORS failure instead of "сервис недоступен".
 */
export async function handleAiChat(request, env) {
  try {
    return await handleAiChatInner(request, env);
  } catch (e) {
    console.error('ai-proxy: unexpected error', e?.stack || String(e));
    return errResponse(503, UNAVAILABLE);
  }
}

async function handleAiChatInner(request, env) {
  // Fail CLOSED when misconfigured: serving without the key is impossible,
  // serving without D1 would mean serving without quota protection.
  if (!upstreamKey(env)) {
    console.error('ai-proxy: AI_PROXY_API_KEY secret is not set');
    return errResponse(503, UNAVAILABLE);
  }
  if (!env.DB) {
    console.error('ai-proxy: D1 binding missing — refusing to serve without quotas');
    return errResponse(503, UNAVAILABLE);
  }

  const parsed = await readJsonBounded(request, MAX_BODY_BYTES);
  if (!parsed.ok && parsed.reason === 'too_large') {
    return errResponse(413, 'Запрос слишком большой. Уберите часть вложений и попробуйте снова.');
  }
  if (!parsed.ok) return errResponse(400, 'Некорректный запрос.');
  const body = parsed.value;
  // JSON `null`/scalars/arrays parse fine but are not a request object;
  // dereferencing them below would turn malformed client input into a
  // TypeError logged as an outage instead of this ordinary 400.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errResponse(400, 'Некорректный запрос.');
  }

  const provider = providerConfig(env, body.provider);
  if (!provider) return errResponse(400, 'Неизвестный провайдер.');

  const licenseKey = normalizeKey(typeof body.license_key === 'string' ? body.license_key : '');
  const deviceId = cleanPublicDeviceId(body.device_id);
  const activationToken = typeof body.activation_token === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(body.activation_token) ? body.activation_token : '';
  if (!licenseKey) return errResponse(403, NEED_LICENSE);
  // Activation binding requires a device id. Real clients always send one (a
  // crypto.randomUUID() persisted in chrome.storage.local, see history.js);
  // requiring it here closes that off for a scripted caller with a bare
  // license key.
  if (!deviceId) return errResponse(403, NEED_DEVICE_ID);
  if (!activationToken) return errResponse(403, NEED_DEVICE_ID);

  const verdict = await verifyLicense(env, licenseKey, deviceId, activationToken);
  if (!verdict.ok) {
    if (verdict.reason === 'service_unavailable') return errResponse(503, UNAVAILABLE);
    return errResponse(403, licenseErrorMessage(verdict.reason));
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages) return errResponse(400, 'Некорректный формат сообщений.');
  const hasImages = hasImageParts(messages);

  const quota = await chargeQuota(env, licenseKey, body.provider, provider);
  if (!quota.ok) return errResponse(429, quota.message);
  // Released ONLY where the provider provably did no billable work — see
  // isNonBillableRejection. A failure we cannot positively classify keeps its
  // slot: the caps exist to bound the bill, and ambiguous provider work is
  // exactly what they have to cover.
  const refundUnusedQuota = () => releaseQuota(env, quota.day, licenseKey, body.provider);

  let res, usedModel = null, lastFailure = null;
  for (const model of modelChoices(env, provider, hasImages)) {
    usedModel = model;
    const upstreamBody = {
      model,
      messages,
      temperature: 0.3,
      max_tokens: MAX_TOKENS_OUT,
      stream: true,
      stream_options: { include_usage: true }
    };
    // Qwen + an image is the one combination where json_object has proved
    // unreliable (see src/lib/qwen.js wantJson); the test solver's parser
    // recovers its {answers:[{n,a}]} shape from prose, so dropping the flag is
    // the safer half of that trade. Mirrors backend-vps/server.js.
    if (body.response_format === 'json_object' && !(hasImages && QWEN_MODEL.test(model))) {
      upstreamBody.response_format = { type: 'json_object' };
    }
    // Per-ACTUAL-model quality policy, mirroring backend-vps/server.js: Qwen
    // has no effort knob, GLM must be forced to think, everything else keeps
    // the ordinary client passthrough.
    if (QWEN_MODEL.test(model)) {
      // no effort knob to send
    } else if (GLM_53_FLASH.test(model)) {
      upstreamBody.thinking = { type: 'enabled' };
      upstreamBody.reasoning_effort = 'max';
    } else if (provider.reasoningEffort && REASONING_EFFORTS.has(body.reasoning_effort)) {
      upstreamBody.reasoning_effort = body.reasoning_effort;
    }

    try {
      res = await fetch(upstreamUrl(env), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${upstreamKey(env)}`
        },
        body: JSON.stringify(upstreamBody),
        redirect: 'manual'
      });
    } catch (e) {
      // The Workers runtime reports every transport failure as an opaque
      // TypeError — a DNS miss, a refused connection and a reset that dropped
      // an already-delivered POST body are indistinguishable here. Since the
      // request may have reached 302.AI in full, the reservation STAYS.
      console.error('ai-proxy: upstream fetch failed (quota retained, dispatch unknown)', String(e));
      return errResponse(502, `${provider.name}: не удалось связаться с ИИ-сервисом. Попробуйте ещё раз через минуту.`);
    }

    if (res.ok) break;
    const failedBody = await readBodyBounded(res, 64 * 1024);
    const text = failedBody.ok ? failedBody.text : '';
    lastFailure = { status: res.status, text, model };
    if (isUnpurchased(res.status, text)) {
      console.warn('ai-proxy: model not enabled, trying fallback', model);
      continue;
    }
    break;
  }

  if (!res?.ok) {
    const status = lastFailure?.status || res?.status || 502;
    const text = lastFailure?.text || '';
    if (isNonBillableRejection(status, text)) {
      await refundUnusedQuota();
    } else {
      console.warn('ai-proxy: ambiguous upstream failure, quota retained', status);
    }
    // 401/403/402: OUR shared key, endpoint, model entitlement or balance is
    // broken — loud in the logs, calm and key-free for the student.
    if (status === 401 || status === 403 || status === 402 || isUnpurchased(status, text)) {
      console.error('ai-proxy: UPSTREAM KEY/BILLING/MODEL PROBLEM', status, lastFailure?.model || usedModel);
      return errResponse(503, UNAVAILABLE);
    }
    if (status === 429) {
      return errResponse(429, `${provider.name}: сервис перегружен. Подождите минуту и попробуйте снова.`);
    }
    console.error('ai-proxy: upstream error', status, lastFailure?.model || usedModel);
    return errResponse(502, `${provider.name}: не удалось получить ответ. Попробуйте ещё раз.`);
  }

  // Byte-for-byte SSE passthrough — the extension parses the stream itself.
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': res.headers.get('content-type') || 'text/event-stream',
      ...CORS
    }
  });
}

/**
 * Rebuild the message list from scratch, accepting only the shapes the
 * extension actually produces (string content, or text/image_url parts with
 * data: image URIs). Anything else → null → 400. Building a NEW array means
 * no unexpected fields can ride through to the upstream request.
 */
function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out = [];
  let imageCount = 0; // capped across the WHOLE request, not per-message
  for (const m of raw) {
    const role = m?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
    const content = m.content;
    if (typeof content === 'string') {
      if (content.length > MAX_TEXT_PART_CHARS) return null;
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content) || content.length === 0 || content.length > MAX_PARTS) return null;
    const parts = [];
    for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        if (part.text.length > MAX_TEXT_PART_CHARS) return null;
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part?.type === 'image_url' && typeof part.image_url?.url === 'string' &&
          isSafeImageDataUri(part.image_url.url)) {
        if (++imageCount > MAX_IMAGES_PER_REQUEST) return null;
        parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        continue;
      }
      return null;
    }
    out.push({ role, content: parts });
  }
  return out;
}

// True once ANY message carries an image_url part — used to pick a
// vision-safe fallback chain (see modelChoices) instead of blindly trying
// every configured fallback model regardless of whether it can see.
function hasImageParts(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

/**
 * Charge one request against the per-license and global daily counters.
 * Atomic upsert-and-return in D1, so concurrent requests can't slip past the
 * cap. The per-license row is checked first so an over-cap user doesn't eat
 * into the global budget.
 */
let blockedQuotaDay = '';
const blockedQuotaKeys = new Set();

function quotaBlocked(day, key, provider) {
  if (blockedQuotaDay !== day) {
    blockedQuotaDay = day;
    blockedQuotaKeys.clear();
  }
  return blockedQuotaKeys.has(`${key}|${provider}`);
}

function markQuotaBlocked(day, key, provider) {
  quotaBlocked(day, key, provider); // rotate the day-scoped cache first
  blockedQuotaKeys.add(`${key}|${provider}`);
}

function clearQuotaBlocked(day, key, provider) {
  quotaBlocked(day, key, provider); // rotate the day-scoped cache first
  blockedQuotaKeys.delete(`${key}|${provider}`);
}

/**
 * Hand a reservation back when the request PROVABLY bought nothing — i.e. the
 * provider itself refused it (isNonBillableRejection). "The stream never
 * opened" is not sufficient evidence: a POST body can arrive in full and still
 * produce no readable response. Callers must classify before calling this.
 * Both counters advanced inside one transaction, so both are released inside
 * one transaction.
 *
 * Best effort by construction — a lost release over-counts, which fails closed.
 * `day` is the day the charge landed on (never re-derived here): across a
 * Moscow midnight the new day's counters belong to other requests.
 */
export async function releaseQuota(env, day, licenseKey, providerId) {
  if (!env?.DB || !day || !licenseKey || !providerId) return false;
  try {
    // Deliberately sequential rather than one batch, and the global breaker is
    // released only after the per-license row provably gave a slot back. Every
    // way this can be interrupted leaves a counter too HIGH, which fails closed;
    // releasing the shared breaker for a license slot that was never returned
    // would fail open for every other user.
    const mine = await env.DB.prepare(
      `UPDATE proxy_quota SET count = count - 1
       WHERE day = ?1 AND license_key = ?2 AND provider = ?3
         AND typeof(count) = 'integer' AND count > 0
       RETURNING count`
    ).bind(day, licenseKey, providerId).first();
    if (mine?.count == null) return false;
    clearQuotaBlocked(day, licenseKey, providerId);
    const total = await env.DB.prepare(
      `UPDATE proxy_quota SET count = count - 1
       WHERE day = ?1 AND license_key = '*' AND provider = 'all'
         AND typeof(count) = 'integer' AND count > 0
       RETURNING count`
    ).bind(day).first();
    if (total?.count != null) clearQuotaBlocked(day, '*', 'all');
    return true;
  } catch (e) {
    console.error('ai-proxy: quota release failed', String(e));
    return false;
  }
}

export async function chargeQuota(env, licenseKey, providerId, provider) {
  const day = mskDay();
  const cap = intVar(env[provider.capVar], provider.capDefault);
  const globalCap = intVar(env.PROXY_GLOBAL_DAILY, GLOBAL_DAILY_DEFAULT);
  const limitMessage =
    `Дневной лимит ${provider.name} по вашей лицензии исчерпан (${cap} запросов). ` +
    'Счётчик сбросится завтра; пока можно переключиться на другой провайдер в настройках.';
  const globalMessage =
    'Сервер СМЭШ сейчас перегружен. Попробуйте позже или переключитесь на другой провайдер в настройках.';

  // Once this isolate has observed a saturated row, shed it before even
  // preparing another D1 statement. Other isolates still hit the conditional
  // no-op below, so no rejected request can keep incrementing a hot row.
  if (quotaBlocked(day, '*', 'all')) {
    return { ok: false, message: globalMessage };
  }
  if (quotaBlocked(day, licenseKey, providerId)) {
    return { ok: false, message: limitMessage };
  }

  // Reserve both counters in ONE D1 batch. D1 batches are SQLite transactions:
  // their statements execute sequentially and cannot interleave with another
  // batch. The second statement is gated by changes() from the first, so either
  // both counters advance for an admitted request or neither counter changes
  // for a rejected one. Keeping these as two awaited statements left a narrow
  // race at globalCap - 1 where a losing request consumed its license allowance
  // before discovering that another isolate had taken the final global slot.
  const mineStatement = env.DB.prepare(
    `INSERT INTO proxy_quota (day, license_key, provider, count)
     SELECT ?1, ?2, ?3, 1
     WHERE COALESCE((
       SELECT typeof(count) = 'integer' AND count >= 0 AND count < ?4
       FROM proxy_quota
       WHERE day = ?1 AND license_key = '*' AND provider = 'all'
     ), 1)
     ON CONFLICT(day, license_key, provider) DO UPDATE SET
       count = proxy_quota.count + 1
     WHERE typeof(proxy_quota.count) = 'integer'
       AND proxy_quota.count >= 0
       AND proxy_quota.count < ?5
       AND COALESCE((
         SELECT typeof(count) = 'integer' AND count >= 0 AND count < ?4
         FROM proxy_quota
         WHERE day = ?1 AND license_key = '*' AND provider = 'all'
       ), 1)
     RETURNING count`
  ).bind(day, licenseKey, providerId, globalCap, cap);
  const totalStatement = env.DB.prepare(
    `INSERT INTO proxy_quota (day, license_key, provider, count)
     SELECT ?1, '*', 'all', 1
     WHERE changes() = 1
     ON CONFLICT(day, license_key, provider) DO UPDATE SET
       count = proxy_quota.count + 1
     WHERE typeof(proxy_quota.count) = 'integer'
       AND proxy_quota.count >= 0
       AND proxy_quota.count < ?2
     RETURNING count`
  ).bind(day, globalCap);

  if (typeof env.DB.batch !== 'function') {
    throw new Error('D1 batch API missing — refusing non-atomic quota accounting');
  }
  const quotaResults = await env.DB.batch([mineStatement, totalStatement]);
  const rawMine = quotaResults?.[0]?.results?.[0]?.count ?? null;
  const rawTotal = quotaResults?.[1]?.results?.[0]?.count ?? null;

  if (rawMine == null) {
    // `RETURNING` is empty for either saturated row. One read disambiguates the
    // student-facing reason and warms the appropriate isolate cache; it cannot
    // consume the write budget we are protecting.
    const counters = await env.DB.prepare(
      `SELECT
         (SELECT count FROM proxy_quota
          WHERE day = ?1 AND license_key = ?2 AND provider = ?3) AS mine,
         (SELECT count FROM proxy_quota
          WHERE day = ?1 AND license_key = '*' AND provider = 'all') AS total`
    ).bind(day, licenseKey, providerId).first();
    const mineCount = counters?.mine == null ? 0 : Number(counters.mine);
    const globalCount = counters?.total == null ? 0 : Number(counters.total);
    if (!Number.isSafeInteger(mineCount) || mineCount < 0 ||
        !Number.isSafeInteger(globalCount) || globalCount < 0) {
      throw new Error('proxy quota counter returned an invalid value');
    }
    if (globalCount >= globalCap) {
      markQuotaBlocked(day, '*', 'all');
      return { ok: false, message: globalMessage };
    }
    if (mineCount >= cap) {
      markQuotaBlocked(day, licenseKey, providerId);
      return { ok: false, message: limitMessage };
    }
    // The transaction reported no reservation even though neither valid
    // counter is saturated. Treat schema drift/corruption as an outage rather
    // than serving a paid request without dependable accounting.
    throw new Error('proxy quota transaction made no reservation');
  }
  const mine = Number(rawMine);
  if (!Number.isSafeInteger(mine) || mine < 1 || mine > cap) {
    throw new Error('proxy quota counter returned an invalid value');
  }
  const total = Number(rawTotal);
  if (!Number.isSafeInteger(total) || total < 1 || total > globalCap) {
    throw new Error('proxy global quota transaction was not atomic');
  }
  // The current request owns either final slot; cache only affects later calls.
  if (mine === cap) markQuotaBlocked(day, licenseKey, providerId);
  // This request legitimately consumes the final global slot. Mark the row
  // blocked for subsequent requests without rejecting the cap-th request.
  if (total === globalCap) markQuotaBlocked(day, '*', 'all');

  return { ok: true, day };
}
