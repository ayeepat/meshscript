/**
 * License-gated AI proxy: Qwen + DeepSeek via 302.AI (OpenAI-compatible
 * reseller — no Alibaba KYC needed for the key) for licensed users WITHOUT
 * their own API key. The extension sends its СМЭШ license key + device id as
 * the credential; this worker holds the single AI_PROXY_API_KEY secret (a
 * 302.AI key), re-verifies the license, enforces quotas, and pipes the
 * upstream SSE stream back to the client UNPARSED (a byte passthrough —
 * near-zero CPU, and the extension's existing postStream() consumes it
 * unchanged, usage frames included).
 *
 * Spend protection — this must never be an open tap:
 *   1. A valid ACTIVE license is required, verified server-side per request
 *      (unlike the extension's client-side gate, this cannot be bypassed).
 *      verifyLicense also enforces the DEVICE_LIMIT device cap.
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
import { mskDay } from './analytics.js';

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
    modelDefault: 'deepseek-v4-flash',
    modelVar: 'PROXY_DEEPSEEK_MODEL',
    name: 'DeepSeek',
    capVar: 'PROXY_DEEPSEEK_DAILY',
    capDefault: 150,
    // DeepSeek V4's documented effort knob, confirmed live through 302.AI
    // (medium → ~55 reasoning tokens, high → ~141 on the same question).
    reasoningEffort: true
  }
};

// The only effort values the client may pick; anything else is dropped so a
// scripted caller can't smuggle arbitrary strings into the upstream request.
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

const MAX_BODY_BYTES = 8 * 1024 * 1024; // base64 photos of worksheets fit; nothing sane exceeds this
const MAX_MESSAGES = 60;                // system + capped history + current turn
const MAX_PARTS = 20;                   // content parts per message (text + attachments)
const MAX_TEXT_PART_CHARS = 50000;      // matches the client's own file-text truncation (qwen.js/deepseek.js)
const MAX_IMAGE_DATA_URI_CHARS = 6 * 1024 * 1024; // ~4.4MB decoded (base64 inflates ~4/3) per image
const MAX_IMAGES_PER_REQUEST = 6;       // across the whole message array, history included
const MAX_TOKENS_OUT = 8192;            // output spend bound; solves never come close
const GLOBAL_DAILY_DEFAULT = 3000;

// Same open CORS as /verify: the extension calls from chrome-extension://
// origins, no credentials involved.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const UNAVAILABLE = 'ИИ-сервис временно недоступен. Попробуйте позже или переключитесь на другой провайдер в настройках.';
const NEED_LICENSE = 'Qwen и DeepSeek работают по лицензии СМЭШ. Введите ключ доступа (SMESH-…) в настройках расширения.';
const NEED_DEVICE_ID = 'Не удалось подтвердить устройство. Обновите расширение СМЭШ AI до последней версии и попробуйте снова.';

// License failure → what the student should actually do. Mirrors the
// extension's REASON_MESSAGES but phrased for the "license = access to
// Qwen/DeepSeek" situation.
const LICENSE_ERRORS = {
  not_found: 'Ключ лицензии не найден. Проверьте его в настройках расширения.',
  expired: 'Срок действия лицензии истёк. Продлите её, чтобы пользоваться Qwen и DeepSeek.',
  revoked: 'Эта лицензия была отозвана. Напишите в поддержку.',
  device_limit: 'Достигнут лимит устройств для этой лицензии.'
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

function providerConfig(env, providerId) {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  const model = String(env[p.modelVar] || p.modelDefault).trim() || p.modelDefault;
  return { ...p, model };
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

  // Content-Length is a client-supplied header — a scripted caller can omit
  // it or lie, so it's only a fast-path rejection for honest oversized
  // uploads, never the real guard. The actual guard is the byte count of what
  // we ACTUALLY read below, which no header can spoof.
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) {
    return errResponse(413, 'Запрос слишком большой. Уберите часть вложений и попробуйте снова.');
  }

  let raw;
  try { raw = await request.text(); }
  catch { return errResponse(400, 'Некорректный запрос.'); }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return errResponse(413, 'Запрос слишком большой. Уберите часть вложений и попробуйте снова.');
  }

  let body;
  try { body = JSON.parse(raw); }
  catch { return errResponse(400, 'Некорректный запрос.'); }

  const provider = providerConfig(env, body.provider);
  if (!provider) return errResponse(400, 'Неизвестный провайдер.');

  const licenseKey = normalizeKey(typeof body.license_key === 'string' ? body.license_key : '');
  const deviceId = typeof body.device_id === 'string' ? body.device_id.slice(0, 64) : '';
  if (!licenseKey) return errResponse(403, NEED_LICENSE);
  // verifyLicense only enforces DEVICE_LIMIT when a device id is present — an
  // empty one skips binding entirely. Real clients always send one (a
  // crypto.randomUUID() persisted in chrome.storage.local, see history.js);
  // requiring it here closes that off for a scripted caller with a bare
  // license key.
  if (!deviceId) return errResponse(403, NEED_DEVICE_ID);

  const verdict = await verifyLicense(env, licenseKey, deviceId);
  if (!verdict.ok) return errResponse(403, LICENSE_ERRORS[verdict.reason] || NEED_LICENSE);

  const messages = sanitizeMessages(body.messages);
  if (!messages) return errResponse(400, 'Некорректный формат сообщений.');
  const hasImages = hasImageParts(messages);

  const quota = await chargeQuota(env, licenseKey, body.provider, provider);
  if (!quota.ok) return errResponse(429, quota.message);

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
    if (body.response_format === 'json_object') {
      upstreamBody.response_format = { type: 'json_object' };
    }
    if (provider.reasoningEffort && REASONING_EFFORTS.has(body.reasoning_effort)) {
      upstreamBody.reasoning_effort = body.reasoning_effort;
    }

    try {
      res = await fetch(upstreamUrl(env), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${upstreamKey(env)}`
        },
        body: JSON.stringify(upstreamBody)
      });
    } catch (e) {
      console.error('ai-proxy: upstream fetch failed', String(e));
      return errResponse(502, `${provider.name}: не удалось связаться с ИИ-сервисом. Попробуйте ещё раз через минуту.`);
    }

    if (res.ok) break;
    const text = await res.text().catch(() => '');
    lastFailure = { status: res.status, text, model };
    if (isUnpurchased(res.status, text)) {
      console.warn('ai-proxy: model not enabled, trying fallback', model, text.slice(0, 300));
      continue;
    }
    break;
  }

  if (!res?.ok) {
    const status = lastFailure?.status || res?.status || 502;
    const text = lastFailure?.text || '';
    // 401/403/402: OUR shared key, endpoint, model entitlement or balance is
    // broken — loud in the logs, calm and key-free for the student.
    if (status === 401 || status === 403 || status === 402 || isUnpurchased(status, text)) {
      console.error('ai-proxy: UPSTREAM KEY/BILLING/MODEL PROBLEM', status, lastFailure?.model || usedModel, text.slice(0, 500));
      return errResponse(503, UNAVAILABLE);
    }
    if (status === 429) {
      return errResponse(429, `${provider.name}: сервис перегружен. Подождите минуту и попробуйте снова.`);
    }
    console.error('ai-proxy: upstream error', status, lastFailure?.model || usedModel, text.slice(0, 500));
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
          part.image_url.url.startsWith('data:image/')) {
        if (part.image_url.url.length > MAX_IMAGE_DATA_URI_CHARS) return null;
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
async function chargeQuota(env, licenseKey, providerId, provider) {
  const day = mskDay();
  const cap = intVar(env[provider.capVar], provider.capDefault);
  const globalCap = intVar(env.PROXY_GLOBAL_DAILY, GLOBAL_DAILY_DEFAULT);

  const bump = (key, prov) => env.DB.prepare(
    `INSERT INTO proxy_quota (day, license_key, provider, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(day, license_key, provider) DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(day, key, prov).first('count');

  const mine = await bump(licenseKey, providerId);
  if (mine > cap) {
    return {
      ok: false,
      message: `Дневной лимит ${provider.name} по вашей лицензии исчерпан (${cap} запросов). ` +
        'Счётчик сбросится завтра; пока можно переключиться на другой провайдер в настройках.'
    };
  }

  const total = await bump('*', 'all');
  if (total > globalCap) {
    console.error('ai-proxy: GLOBAL DAILY BREAKER TRIPPED', total, '>', globalCap);
    return { ok: false, message: 'Сервер СМЭШ сейчас перегружен. Попробуйте позже или переключитесь на другой провайдер в настройках.' };
  }

  return { ok: true };
}
