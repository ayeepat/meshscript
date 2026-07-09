#!/usr/bin/env bash
# СМЭШ AI streaming proxy — one-shot installer for Ubuntu 22.04/24.04 (EC2).
# Installs Node.js 20 + Caddy, drops the proxy app + systemd unit + Caddy TLS
# for $DOMAIN, and starts everything. Safe to re-run. Override the domain with:
#   DOMAIN=ai.smeshapi.site bash setup.sh
set -euo pipefail

DOMAIN="${DOMAIN:-ai.smeshapi.site}"
APP_DIR=/opt/smesh-proxy
DATA_DIR=/var/lib/smesh-proxy
ENV_FILE=/etc/smesh-proxy.env

echo ">> Installing Node.js 20 + Caddy ..."
sudo apt-get update -y
sudo apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https ca-certificates gnupg
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo ">> Writing app to $APP_DIR ..."
sudo install -d -m 755 "$APP_DIR"
sudo install -d -m 750 "$DATA_DIR"
sudo tee "$APP_DIR/server.js" >/dev/null <<'SMESH_SERVER_EOF'
/**
 * СМЭШ AI proxy — the OFF-CLOUDFLARE half of the backend (AWS EC2 box).
 *
 * Why this exists, v2 (2026-07-08): Russian DPI (TSPU) applies a bandwidth
 * clamp keyed on the TLS SNI `*.smeshapi.site` — ANY connection to that name
 * that lives longer than ~6–12s gets throttled to zero, on Cloudflare AND on
 * this box alike. Proven from an RU client: the same 2s-heartbeat probe died
 * at ~6s via the CF worker and ~12s via this box (h2, so not QUIC), while a
 * 66-second stream from httpbin.org on the SAME RU connection completed fine.
 * Short requests finish before the clamp bites — that's why /verify and
 * /health always worked from RU. So the v1 premise ("move off Cloudflare and
 * streaming works") was wrong: streaming to RU is off the table on any host
 * carrying this SNI.
 *
 * The fix: the extension uses a POLLING pseudo-stream, where every RU-facing
 * request is sub-second:
 *
 *   POST /ai/start  → verify license (via the CF worker /verify), charge the
 *                     daily quota, return { job_id } IMMEDIATELY; the 302.AI
 *                     stream is opened server-side in the background (this
 *                     box ↔ 302.AI never touches Russia) and its SSE bytes
 *                     accumulate in memory.
 *   GET  /ai/poll   → ?job=<id>&cursor=<n>: return the buffered SSE text
 *                     since <n> plus { done, error }. The client feeds the
 *                     chunks into the same SSE parser it uses for direct
 *                     streams, so the UI still reveals tokens progressively.
 *   POST /ai/cancel → abort the upstream fetch (stop paying 302.AI) when the
 *                     student aborts / closes the tab.
 *
 * The old byte-for-byte streaming POST /ai/chat is kept for curl diagnostics
 * and non-RU use; the extension no longer calls it.
 *
 * Same trust model as backend/src/ai-proxy.js:
 *   - license is verified per request by calling the EXISTING Cloudflare
 *     worker /verify (a quick request, works from anywhere) — no license
 *     data is duplicated here;
 *   - per-license + global daily quotas are enforced locally (JSON file);
 *   - the single 302.AI key lives in this box's env (AI_PROXY_API_KEY),
 *     never in the client.
 *
 * Zero npm dependencies on purpose (Node 18+ built-ins only): global fetch,
 * node:http, node:stream, node:fs, node:crypto. Runs behind Caddy, which
 * terminates TLS and reverse-proxies to 127.0.0.1:PORT with
 * `flush_interval -1` (only the legacy streaming route still needs that).
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { StringDecoder } = require('node:string_decoder');

/* ------------------------------- config ------------------------------- */

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

// The Cloudflare worker that still owns licenses. A quick GET, works from RU/AWS.
const LICENSE_VERIFY_URL = (process.env.LICENSE_VERIFY_URL || 'https://smeshapi.site/verify').replace(/\/+$/, '');

// 302.AI (OpenAI-compatible). ai-proxy.js appends /chat/completions itself.
const UPSTREAM_BASE_URL = (process.env.AI_PROXY_BASE_URL || 'https://api.302.ai/v1').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.AI_PROXY_API_KEY || '';

// Where the daily quota counters persist (survives restarts; best-effort).
const QUOTA_FILE = process.env.QUOTA_FILE || '/var/lib/smesh-proxy/quota.json';

const env = process.env;
const intVar = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const PROVIDERS = {
  qwen: {
    name: 'Qwen',
    model: (env.PROXY_QWEN_MODEL || 'qwen3.7-plus').trim(),
    fallbacks: (env.PROXY_QWEN_FALLBACK_MODELS || 'qwen-vl-plus,qwen-plus'),
    visionFallbacks: (env.PROXY_QWEN_VISION_FALLBACK_MODELS || 'qwen-vl-plus'),
    cap: intVar(env.PROXY_QWEN_DAILY, 80),
    reasoningEffort: false
  },
  deepseek: {
    name: 'DeepSeek',
    model: (env.PROXY_DEEPSEEK_MODEL || 'deepseek-v4-flash').trim(),
    fallbacks: '',
    visionFallbacks: '',
    cap: intVar(env.PROXY_DEEPSEEK_DAILY, 150),
    reasoningEffort: true
  }
};
const GLOBAL_DAILY = intVar(env.PROXY_GLOBAL_DAILY, 3000);

// PDF-capable model. Neither Qwen nor DeepSeek reads PDFs through the
// OpenAI-compat endpoint, but 302.AI's Gemini does (verified live 2026-07-08:
// a {type:'file'} data-URI part came back correctly read, streaming). Any
// job that carries a PDF part is routed to THIS model chain instead of the
// provider's own — the quota is still charged to the provider the student
// picked.
const PDF_MODEL = (env.PROXY_PDF_MODEL || 'gemini-2.5-flash').trim();
const PDF_FALLBACK_MODELS = env.PROXY_PDF_FALLBACK_MODELS || 'gemini-2.0-flash';

const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES = 60;
const MAX_PARTS = 20;
const MAX_TEXT_PART_CHARS = 50000;
const MAX_IMAGE_DATA_URI_CHARS = 6 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 6;
const MAX_PDF_DATA_URI_CHARS = 8 * 1024 * 1024; // ~5.8 MB raw; fits (with JSON overhead) inside one MAX_BLOB_CHARS messages blob
// 6, not 1-2: follow-ups replay up to 4 prior user turns WITH their files
// (see the extension's MAX_HISTORY_MESSAGES), so the same PDF can legally
// appear several times in one request. MAX_BODY_BYTES gates the real weight.
const MAX_PDFS_PER_REQUEST = 6;
const MAX_TOKENS_OUT = 8192;

// Poll-job lifecycle. A job whose client stops polling is abandoned (abort
// upstream so we stop paying 302.AI); finished jobs linger briefly so a
// client can drain the tail even across a flaky poll or two.
const MAX_ACTIVE_JOBS = 100;            // running upstream fetches at once
const JOB_ABANDON_MS = 90 * 1000;       // running + unpolled this long → dead client
const JOB_LINGER_MS = 5 * 60 * 1000;    // done + unpolled this long → GC
const JOB_GC_INTERVAL_MS = 30 * 1000;

// Long-poll hold: /ai/poll waits up to this long for new tokens before
// returning (a heartbeat with an empty chunk if none arrive). Two reasons it's
// short: (1) each poll connection must stay well under the RU DPI clamp window
// (~6s on Cloudflare, ~12s here — proven), and (2) the client re-polls with NO
// setTimeout gap, so a fetch is ALWAYS pending → the MV3 service worker stays
// alive (a bare setTimeout does not keep it alive; that killed the first cut).
const POLL_HOLD_MS = 4000;
const POLL_CHECK_MS = 100;

// Chunked upload store (the UPLOAD mirror of the poll transport). A large
// image / PDF can't ride one /ai/start POST from RU — the upload clamps mid-
// body — so the client slices it into /ai/blob chunks that reassemble here,
// then references the blob from a tiny /ai/start. Blobs are ephemeral and
// bounded: no license check per chunk (a quick /verify per chunk would defeat
// the point), so the store is capped hard and swept on a short TTL. A blob is
// USELESS without a valid /ai/start, which still verifies the license.
const BLOB_TTL_MS = 90 * 1000;
const MAX_BLOBS = 120;                       // concurrent uploads (complete or in-progress)
const MAX_BLOB_CHARS = 9 * 1024 * 1024;      // one blob: a whole messages JSON incl. a ~5 MB PDF's data URI
const MAX_TOTAL_BLOB_CHARS = 80 * 1024 * 1024; // across ALL blobs — bounds worst-case memory
const MAX_CHUNK_CHARS = 256 * 1024;          // per-chunk sanity (client sends ~8 KB)
const MAX_BLOB_PARTS = 4096;

// Student-facing copy — identical wording to ai-proxy.js. Never mentions keys.
const UNAVAILABLE = 'ИИ-сервис временно недоступен. Попробуйте позже или переключитесь на другой провайдер в настройках.';
const NEED_LICENSE = 'Qwen и DeepSeek работают по лицензии СМЭШ. Введите ключ доступа (SMESH-…) в настройках расширения.';
const NEED_DEVICE_ID = 'Не удалось подтвердить устройство. Обновите расширение СМЭШ AI до последней версии и попробуйте снова.';
const OVERLOADED = 'Сервер СМЭШ сейчас перегружен. Попробуйте позже или переключитесь на другой провайдер в настройках.';
const JOB_NOT_FOUND = 'Сессия ответа не найдена или устарела. Задайте вопрос ещё раз.';
const LICENSE_ERRORS = {
  not_found: 'Ключ лицензии не найден. Проверьте его в настройках расширения.',
  expired: 'Срок действия лицензии истёк. Продлите её, чтобы пользоваться Qwen и DeepSeek.',
  revoked: 'Эта лицензия была отозвана. Напишите в поддержку.',
  device_limit: 'Достигнут лимит устройств для этой лицензии.'
};
const TOO_BIG = 'Запрос слишком большой. Уберите часть вложений и попробуйте снова.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/* ------------------------------ helpers ------------------------------- */

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS, ...extraHeaders });
  res.end(body);
}
function sendErr(res, status, message) {
  sendJson(res, status, { ok: false, error: { message } });
}

// Moscow calendar day (UTC+3, no DST) — matches the worker's mskDay().
function mskDay() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function normalizeKey(k) {
  return String(k || '').trim().toUpperCase();
}

function upstreamUrl() {
  return UPSTREAM_BASE_URL.endsWith('/chat/completions')
    ? UPSTREAM_BASE_URL
    : `${UPSTREAM_BASE_URL}/chat/completions`;
}

function modelChoices(p, hasImages, hasPdfs) {
  const seen = new Set();
  const out = [];
  const add = (m) => { m = String(m || '').trim(); if (m && !seen.has(m)) { seen.add(m); out.push(m); } };
  // A PDF part overrides the provider's model chain entirely: only the Gemini
  // chain can read the file, and a PDF sent to qwen/deepseek would 400 (or
  // worse, be silently dropped and hallucinated about).
  if (hasPdfs) {
    add(PDF_MODEL);
    for (const m of String(PDF_FALLBACK_MODELS || '').split(',')) add(m);
    return out;
  }
  add(p.model);
  const list = (hasImages && p.visionFallbacks) ? p.visionFallbacks : p.fallbacks;
  for (const m of String(list || '').split(',')) add(m);
  return out;
}

// 302.AI answers an unknown/unentitled model with 503 + err_code -10008.
function isUnpurchased(text) {
  return /No available models|"err_code"\s*:\s*-10008|AccessDenied\.Unpurchased|access to model denied|eligible for using the model/i.test(text || '');
}

/* ------------------------------ quota (local) ------------------------- */
// In-memory counters mirrored to a JSON file so they survive a restart. Low
// pre-launch traffic, so a plain read-modify-write is plenty (no SQLite).

let quota = { day: mskDay(), counts: {} };
try {
  const raw = fs.readFileSync(QUOTA_FILE, 'utf8');
  const loaded = JSON.parse(raw);
  if (loaded && typeof loaded === 'object') quota = { day: loaded.day || mskDay(), counts: loaded.counts || {} };
} catch { /* first run / missing file */ }

let saveTimer = null;
function persistQuota() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
      fs.writeFileSync(QUOTA_FILE, JSON.stringify(quota));
    } catch (e) { console.error('quota persist failed', String(e)); }
  }, 500);
}

function bump(key) {
  const today = mskDay();
  if (quota.day !== today) quota = { day: today, counts: {} };
  quota.counts[key] = (quota.counts[key] || 0) + 1;
  persistQuota();
  return quota.counts[key];
}

// Returns { ok:true } or { ok:false, message } — mirrors chargeQuota().
function chargeQuota(licenseKey, providerId, provider) {
  const mine = bump(`${licenseKey}|${providerId}`);
  if (mine > provider.cap) {
    return {
      ok: false,
      message: `Дневной лимит ${provider.name} по вашей лицензии исчерпан (${provider.cap} запросов). ` +
        'Счётчик сбросится завтра; пока можно переключиться на другой провайдер в настройках.'
    };
  }
  const total = bump('*|all');
  if (total > GLOBAL_DAILY) {
    console.error('GLOBAL DAILY BREAKER TRIPPED', total, '>', GLOBAL_DAILY);
    return { ok: false, message: OVERLOADED };
  }
  return { ok: true };
}

/* --------------------------- license verify --------------------------- */
// Delegate to the Cloudflare worker /verify. Fails CLOSED: without a positive
// verdict we do not spend upstream tokens.

async function verifyLicense(licenseKey, deviceId) {
  const url = `${LICENSE_VERIFY_URL}?key=${encodeURIComponent(licenseKey)}&device_id=${encodeURIComponent(deviceId)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, reason: 'not_found' };
    const j = await r.json();
    return (j && typeof j === 'object') ? j : { ok: false, reason: 'not_found' };
  } catch (e) {
    console.error('verify unreachable', String(e));
    return { ok: false, reason: '_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------- message sanitizer -------------------------- */
// Rebuild from scratch — accept only the shapes the extension produces. Same
// caps as ai-proxy.js sanitizeMessages().

function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const out = [];
  let imageCount = 0;
  let pdfCount = 0;
  for (const m of raw) {
    const role = m && m.role;
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
      if (part && part.type === 'text' && typeof part.text === 'string') {
        if (part.text.length > MAX_TEXT_PART_CHARS) return null;
        parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part && part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string' &&
          part.image_url.url.startsWith('data:image/')) {
        if (part.image_url.url.length > MAX_IMAGE_DATA_URI_CHARS) return null;
        if (++imageCount > MAX_IMAGES_PER_REQUEST) return null;
        parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        continue;
      }
      // PDF as an OpenAI-style file part (data URI only — never a URL, so this
      // box can't be turned into a fetch proxy). Routed to the Gemini chain by
      // modelChoices; 302.AI passes the file through to the model (verified).
      if (part && part.type === 'file' && part.file && typeof part.file.file_data === 'string' &&
          part.file.file_data.startsWith('data:application/pdf;base64,')) {
        if (part.file.file_data.length > MAX_PDF_DATA_URI_CHARS) return null;
        if (++pdfCount > MAX_PDFS_PER_REQUEST) return null;
        const filename = String(part.file.filename || 'document.pdf').slice(0, 120);
        parts.push({ type: 'file', file: { filename, file_data: part.file.file_data } });
        continue;
      }
      return null;
    }
    out.push({ role, content: parts });
  }
  return out;
}

function hasImageParts(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
}

function hasPdfParts(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'file'));
}

/* ----------------------------- blob store ----------------------------- */
// Reassembles chunk-uploaded attachments (see /ai/blob). blob_id → { parts,
// total, chars, mime, name, done, data, lastAccess }. `data` is the
// reassembled STRING — the raw messages JSON a start references by
// `messages_blob`. Bounded + TTL'd.

const blobs = new Map();
let totalBlobChars = 0;

function freeBlob(id) {
  const b = blobs.get(id);
  if (!b) return;
  totalBlobChars -= b.chars || 0;
  if (totalBlobChars < 0) totalBlobChars = 0;
  blobs.delete(id);
}

// One chunk of a blob. Chunks are plain SUBSTRINGS concatenated in seq order
// — the server never decodes anything, it just reassembles the original
// string. Idempotent per (blob_id, seq): a retried chunk is ignored.
function handleBlob(req, res, rawBody) {
  let b;
  try { b = JSON.parse(rawBody); } catch { return sendErr(res, 400, 'Некорректный запрос.'); }
  const id = typeof b.blob_id === 'string' ? b.blob_id.slice(0, 64) : '';
  const seq = Math.floor(Number(b.seq));
  const total = Math.floor(Number(b.total));
  const chunk = typeof b.chunk === 'string' ? b.chunk : null;
  if (!id || chunk === null || !Number.isFinite(seq) || seq < 0 ||
      !Number.isFinite(total) || total < 1 || total > MAX_BLOB_PARTS || seq >= total) {
    return sendErr(res, 400, 'Некорректный запрос.');
  }
  if (chunk.length > MAX_CHUNK_CHARS) return sendErr(res, 413, TOO_BIG);

  let blob = blobs.get(id);
  if (!blob) {
    if (blobs.size >= MAX_BLOBS || totalBlobChars + chunk.length > MAX_TOTAL_BLOB_CHARS) {
      return sendErr(res, 503, OVERLOADED);
    }
    blob = {
      parts: new Map(), total, chars: 0, done: false, data: '',
      mime: typeof b.mime === 'string' ? b.mime.slice(0, 80) : '',
      name: typeof b.name === 'string' ? b.name.slice(0, 120) : '',
      lastAccess: Date.now()
    };
    blobs.set(id, blob);
  }
  blob.lastAccess = Date.now();

  if (!blob.done && !blob.parts.has(seq)) {
    if (blob.chars + chunk.length > MAX_BLOB_CHARS || totalBlobChars + chunk.length > MAX_TOTAL_BLOB_CHARS) {
      freeBlob(id);
      return sendErr(res, 413, TOO_BIG);
    }
    blob.parts.set(seq, chunk);
    blob.chars += chunk.length;
    totalBlobChars += chunk.length;
  }
  if (!blob.done && blob.parts.size >= blob.total) {
    let s = '';
    for (let i = 0; i < blob.total; i++) s += blob.parts.get(i) || '';
    blob.data = s;
    blob.parts.clear();     // free the piecewise copy; keep only the joined string
    blob.done = true;
  }
  sendJson(res, 200, { ok: true, blob_id: id, received: blob.done ? blob.total : blob.parts.size, complete: !!blob.done });
}

/* --------------------- shared request preparation --------------------- */
// Everything /ai/chat and /ai/start have in common: parse, validate, verify
// the license, charge the quota. Returns { err: { status, message } } or the
// prepared context. Quota is charged HERE — by the time a job exists it has
// already paid.

async function prepareChat(rawBody) {
  if (!UPSTREAM_KEY) { console.error('AI_PROXY_API_KEY not set'); return { err: { status: 503, message: UNAVAILABLE } }; }

  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { err: { status: 413, message: TOO_BIG } };
  let body;
  try { body = JSON.parse(rawBody); } catch { return { err: { status: 400, message: 'Некорректный запрос.' } }; }

  const provider = PROVIDERS[body.provider];
  if (!provider) return { err: { status: 400, message: 'Неизвестный провайдер.' } };

  // A big request arrives with its messages chunk-uploaded to /ai/blob (the
  // whole /ai/start body must stay tiny — RU DPI gives each connection only a
  // ~16 KB transfer allowance) and referenced here. The blob holds the raw
  // messages JSON; parse it and continue exactly as if it were inline.
  if (typeof body.messages_blob === 'string') {
    const blob = blobs.get(body.messages_blob);
    if (!blob || !blob.done) {
      return { err: { status: 410, message: 'Загруженное вложение устарело. Пришлите его ещё раз.' } };
    }
    try { body.messages = JSON.parse(blob.data); }
    catch { freeBlob(body.messages_blob); return { err: { status: 400, message: 'Некорректный запрос.' } }; }
    freeBlob(body.messages_blob);
  }

  const licenseKey = normalizeKey(typeof body.license_key === 'string' ? body.license_key : '');
  const deviceId = typeof body.device_id === 'string' ? body.device_id.slice(0, 64) : '';
  if (!licenseKey) return { err: { status: 403, message: NEED_LICENSE } };
  if (!deviceId) return { err: { status: 403, message: NEED_DEVICE_ID } };

  const verdict = await verifyLicense(licenseKey, deviceId);
  if (!verdict.ok) {
    if (verdict.reason === '_unreachable') return { err: { status: 503, message: UNAVAILABLE } };
    return { err: { status: 403, message: LICENSE_ERRORS[verdict.reason] || NEED_LICENSE } };
  }

  const messages = sanitizeMessages(body.messages);
  if (!messages) return { err: { status: 400, message: 'Некорректный формат сообщений.' } };
  const hasImages = hasImageParts(messages);
  const hasPdfs = hasPdfParts(messages);

  const q = chargeQuota(licenseKey, body.provider, provider);
  if (!q.ok) return { err: { status: 429, message: q.message } };

  return { provider, body, messages, hasImages, hasPdfs };
}

/* ------------------------ upstream connection ------------------------- */
// Open the 302.AI stream, walking the model fallback chain. Returns
// { upstream } (a fetch Response with .ok) or { err: { status, message } }.
// Shared by the legacy streaming route and the poll-job runner.

// Two solves fired at once (each a PDF-sized body) can make the OUTBOUND
// fetch to 302.AI itself throw — not a 4xx/5xx from 302.AI, but a transport-
// level failure (reset connection, DNS hiccup, or this box's own CPU/network
// briefly saturated re-serializing two multi-MB JSON bodies at once on a
// t3.micro). Observed live: one of two concurrent PDF solves got exactly this
// path while the other succeeded. The 45s connect timeout already rules out
// "just needs more time"; what actually helps is trying again a moment later,
// once the other job has released whatever it was contending for. Retried
// ONLY on a thrown fetch (this loop's catch) — an honest 4xx/5xx from 302.AI
// itself is handled below and is not retried here (isUnpurchased fallback,
// or a real error code the caller should see).
const UPSTREAM_CONNECT_RETRIES = 2;
const UPSTREAM_CONNECT_RETRY_DELAY_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectUpstream(provider, body, messages, hasImages, hasPdfs, signal = null) {
  let upstream = null, lastFailure = null, usedModel = null;
  for (const model of modelChoices(provider, hasImages, hasPdfs)) {
    usedModel = model;
    const upstreamBody = {
      model, messages, temperature: 0.3, max_tokens: MAX_TOKENS_OUT,
      stream: true, stream_options: { include_usage: true }
    };
    if (body.response_format === 'json_object') upstreamBody.response_format = { type: 'json_object' };
    // reasoning_effort is a DeepSeek knob; a PDF job runs on the Gemini chain
    // instead, where the param is unverified — never send it there.
    if (!hasPdfs && provider.reasoningEffort && REASONING_EFFORTS.has(body.reasoning_effort)) {
      upstreamBody.reasoning_effort = body.reasoning_effort;
    }
    // Serialize ONCE per model attempt, not once per retry — retries resend
    // the identical bytes, no need to re-stringify a possibly multi-MB body.
    const upstreamPayload = JSON.stringify(upstreamBody);

    let connectErr = null;
    for (let attempt = 0; attempt <= UPSTREAM_CONNECT_RETRIES && !upstream; attempt++) {
      if (signal?.aborted) return { err: { status: 499, message: UNAVAILABLE } };
      if (attempt > 0) await sleep(UPSTREAM_CONNECT_RETRY_DELAY_MS * attempt);

      // Timeout the CONNECT only (getting response headers); the stream body
      // then flows with no timeout so long answers aren't cut off.
      const ctrl = new AbortController();
      const connectTimer = setTimeout(() => ctrl.abort(), 45000);
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      try {
        upstream = await fetch(upstreamUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UPSTREAM_KEY}` },
          body: upstreamPayload,
          signal: ctrl.signal
        });
        connectErr = null;
      } catch (e) {
        // A cancelled job aborts the connect too — expected, not an upstream problem.
        if (signal && signal.aborted) {
          return { err: { status: 499, message: UNAVAILABLE } };
        }
        connectErr = e;
        console.error('upstream fetch failed', usedModel, 'attempt', attempt + 1, String(e));
      } finally {
        clearTimeout(connectTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    if (connectErr) {
      return { err: { status: 502, message: `${provider.name}: не удалось связаться с ИИ-сервисом. Попробуйте ещё раз через минуту.` } };
    }

    if (upstream.ok) break;
    const text = await upstream.text().catch(() => '');
    lastFailure = { status: upstream.status, text, model };
    upstream = null;
    if (isUnpurchased(text)) { console.warn('model not enabled, trying fallback', model, text.slice(0, 200)); continue; }
    break;
  }

  if (!upstream) {
    const status = lastFailure ? lastFailure.status : 502;
    const text = lastFailure ? lastFailure.text : '';
    if (status === 401 || status === 403 || status === 402 || isUnpurchased(text)) {
      console.error('UPSTREAM KEY/BILLING/MODEL PROBLEM', status, usedModel, text.slice(0, 500));
      return { err: { status: 503, message: UNAVAILABLE } };
    }
    if (status === 429) return { err: { status: 429, message: `${provider.name}: сервис перегружен. Подождите минуту и попробуйте снова.` } };
    console.error('upstream error', status, usedModel, text.slice(0, 500));
    return { err: { status: 502, message: `${provider.name}: не удалось получить ответ. Попробуйте ещё раз.` } };
  }

  return { upstream };
}

/* --------------------------- poll-job store --------------------------- */

const jobs = new Map(); // job_id → { text, done, error, ctrl, lastAccess }

function activeJobCount() {
  let n = 0;
  for (const j of jobs.values()) if (!j.done) n += 1;
  return n;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!job.done && now - job.lastAccess > JOB_ABANDON_MS) {
      console.warn('job abandoned (client stopped polling), aborting upstream', id);
      try { job.ctrl.abort(); } catch { }
      jobs.delete(id);
    } else if (job.done && now - job.lastAccess > JOB_LINGER_MS) {
      jobs.delete(id);
    }
  }
  // Sweep stale blobs: a completed upload whose /ai/start never came, or an
  // upload the client gave up on mid-way. prepareChat frees a blob the instant
  // /ai/start inlines it, so anything left here is genuinely orphaned.
  for (const [id, blob] of blobs) {
    if (now - blob.lastAccess > BLOB_TTL_MS) freeBlob(id);
  }
}, JOB_GC_INTERVAL_MS).unref();

// Background pump: open the upstream stream and accumulate its SSE bytes as
// a string (StringDecoder so a chunk boundary can't split a multi-byte char).
async function runJob(job, provider, body, messages, hasImages, hasPdfs) {
  const conn = await connectUpstream(provider, body, messages, hasImages, hasPdfs, job.ctrl.signal);
  if (!conn.upstream) {
    job.error = conn.err.message;
    job.done = true;
    return;
  }
  const dec = new StringDecoder('utf8');
  try {
    for await (const chunk of Readable.fromWeb(conn.upstream.body)) {
      job.text += dec.write(chunk);
    }
    job.text += dec.end();
  } catch (e) {
    // Either the client cancelled (abort — expected) or 302.AI dropped the
    // stream. With partial text we deliver what arrived (the old streaming
    // path behaved the same way); with NOTHING delivered, surface an error
    // instead of an empty answer.
    if (!job.ctrl.signal.aborted) {
      console.error('job stream broke', String(e));
      if (!job.text) job.error = `${provider.name}: не удалось получить ответ. Попробуйте ещё раз.`;
    }
  }
  job.done = true;
}

/* ---------------------- /ai/start /ai/poll /ai/cancel ----------------- */

async function handleAiStart(req, res, rawBody) {
  // Refuse BEFORE charging quota when we're at capacity.
  if (activeJobCount() >= MAX_ACTIVE_JOBS) {
    console.error('MAX_ACTIVE_JOBS reached', MAX_ACTIVE_JOBS);
    return sendErr(res, 503, OVERLOADED);
  }

  const prep = await prepareChat(rawBody);
  if (prep.err) return sendErr(res, prep.err.status, prep.err.message);

  const id = crypto.randomUUID();
  const job = { text: '', done: false, error: null, ctrl: new AbortController(), lastAccess: Date.now() };
  jobs.set(id, job);

  runJob(job, prep.provider, prep.body, prep.messages, prep.hasImages, prep.hasPdfs).catch((e) => {
    console.error('job runner crashed', e && e.stack || String(e));
    job.error = job.error || UNAVAILABLE;
    job.done = true;
  });

  sendJson(res, 200, { ok: true, job_id: id });
}

function handleAiPoll(req, res, url) {
  const id = url.searchParams.get('job') || '';
  const cursor = Math.max(0, Math.floor(Number(url.searchParams.get('cursor')) || 0));
  const job = jobs.get(id);
  if (!job) return sendErr(res, 404, JOB_NOT_FOUND);
  job.lastAccess = Date.now();

  // Long-poll: return the moment there's new text (or the job finished),
  // otherwise hold the connection ~4s and return a heartbeat. Holding here
  // means the client's fetch stays pending with no client-side timer gap.
  const deadline = Date.now() + POLL_HOLD_MS;
  let closed = false;
  res.on('close', () => { closed = true; });

  const reply = () => {
    job.lastAccess = Date.now();
    sendJson(res, 200, {
      ok: true,
      chunk: cursor < job.text.length ? job.text.slice(cursor) : '',
      cursor: job.text.length,
      done: job.done,
      error: job.error
    });
  };

  const tick = () => {
    if (closed) return;                                   // client hung up
    if (job.text.length > cursor || job.done || Date.now() >= deadline) return reply();
    setTimeout(tick, POLL_CHECK_MS);
  };
  tick();
}

function handleAiCancel(req, res, rawBody) {
  let id = '';
  try { id = String(JSON.parse(rawBody).job || ''); } catch { /* idempotent */ }
  const job = jobs.get(id);
  if (job) {
    try { job.ctrl.abort(); } catch { }
    jobs.delete(id);
  }
  sendJson(res, 200, { ok: true });
}

/* ---------------------- /ai/chat (legacy streaming) ------------------- */
// Byte-for-byte SSE passthrough. NOT used by the extension anymore (RU DPI
// kills long-lived connections to this SNI) — kept for curl diagnostics.

async function handleAiChat(req, res, rawBody) {
  const prep = await prepareChat(rawBody);
  if (prep.err) return sendErr(res, prep.err.status, prep.err.message);

  const conn = await connectUpstream(prep.provider, prep.body, prep.messages, prep.hasImages, prep.hasPdfs);
  if (!conn.upstream) return sendErr(res, conn.err.status, conn.err.message);
  const upstream = conn.upstream;

  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    ...CORS
  });
  try {
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch { } });
    // If the student closes the tab, stop pulling from (and paying) upstream.
    res.on('close', () => { try { nodeStream.destroy(); } catch { } });
    nodeStream.pipe(res);
  } catch (e) {
    console.error('stream pipe failed', String(e));
    try { res.end(); } catch { }
  }
}

/* ---------------------------- /ai/streamtest -------------------------- */
// RU-DPI probe: a data: frame every `interval` ms for `seconds` s, no AI.
// This is how the SNI clamp was proven — keep it, it costs nothing and lets
// us re-measure RU behavior any time.

function handleStreamTest(req, res, url) {
  const interval = Math.min(Math.max(Number(url.searchParams.get('interval')) || 2000, 500), 10000);
  const seconds = Math.min(Math.max(Number(url.searchParams.get('seconds')) || 30, 2), 90);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  });
  const t0 = Date.now();
  let n = 0;
  const timer = setInterval(() => {
    if (Date.now() - t0 >= seconds * 1000) {
      clearInterval(timer);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    n += 1;
    res.write(`data: {"n":${n},"elapsed_ms":${Date.now() - t0}}\n\n`);
  }, interval);
  res.on('close', () => clearInterval(timer));
}

/* ------------------------------- server ------------------------------- */

// Collect a bounded request body, then hand off. Shared by all POST routes.
function withBody(req, res, handler) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) { aborted = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (aborted) return sendErr(res, 413, TOO_BIG);
    Promise.resolve(handler(Buffer.concat(chunks).toString('utf8')))
      .catch((e) => { console.error('handler unexpected', e && e.stack || String(e)); if (!res.headersSent) sendErr(res, 503, UNAVAILABLE); });
  });
  req.on('error', () => { if (!res.headersSent) sendErr(res, 400, 'Некорректный запрос.'); });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathName = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (pathName === '/health') return sendJson(res, 200, { ok: true });
  if (pathName === '/ai/streamtest' && req.method === 'GET') return handleStreamTest(req, res, url);
  if (pathName === '/ai/poll' && req.method === 'GET') return handleAiPoll(req, res, url);
  if (pathName === '/ai/blob' && req.method === 'POST') return withBody(req, res, (raw) => handleBlob(req, res, raw));
  if (pathName === '/ai/start' && req.method === 'POST') return withBody(req, res, (raw) => handleAiStart(req, res, raw));
  if (pathName === '/ai/cancel' && req.method === 'POST') return withBody(req, res, (raw) => handleAiCancel(req, res, raw));
  if (pathName === '/ai/chat' && req.method === 'POST') return withBody(req, res, (raw) => handleAiChat(req, res, raw));

  sendJson(res, 404, { ok: false, reason: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`smesh-proxy listening on ${HOST}:${PORT} → upstream ${upstreamUrl()} · verify ${LICENSE_VERIFY_URL}`);
});
SMESH_SERVER_EOF

echo ">> Writing env file (add your 302.AI key here) ..."
if [ ! -f "$ENV_FILE" ]; then
  sudo tee "$ENV_FILE" >/dev/null <<'ENV_EOF'
# Paste your 302.AI key after the = (no quotes), then:
#   sudo systemctl restart smesh-proxy
AI_PROXY_API_KEY=
PORT=8080
HOST=127.0.0.1
QUOTA_FILE=/var/lib/smesh-proxy/quota.json
# Optional overrides (defaults already match the Cloudflare worker):
# AI_PROXY_BASE_URL=https://api.302.ai/v1
# LICENSE_VERIFY_URL=https://smeshapi.site/verify
# PROXY_QWEN_DAILY=80
# PROXY_DEEPSEEK_DAILY=150
# PROXY_GLOBAL_DAILY=3000
# PROXY_PDF_MODEL=gemini-2.5-flash
# PROXY_PDF_FALLBACK_MODELS=gemini-2.0-flash
ENV_EOF
  sudo chmod 600 "$ENV_FILE"
fi

echo ">> Creating systemd service ..."
sudo tee /etc/systemd/system/smesh-proxy.service >/dev/null <<'UNIT_EOF'
[Unit]
Description=СМЭШ AI streaming proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/smesh-proxy.env
ExecStart=/usr/bin/node /opt/smesh-proxy/server.js
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
UNIT_EOF

echo ">> Configuring Caddy (TLS + unbuffered reverse proxy, HTTP/1.1-only) ..."
# HTTP/1.1 ONLY + Connection: close — load-bearing for RU. The DPI clamp on the
# *.smeshapi.site SNI is per-CONNECTION (~6-12s lifetime), and Chrome pools one
# TLS connection per origin: with h2 (Caddy's default) every /ai/poll would ride
# the SAME connection opened at /ai/start and stall once it ages past the clamp
# (observed live: polls 1-2 fine, poll 3 hung forever). h1 + Connection: close
# forces a FRESH connection per request; each lives ~4-5s max and never clamps.
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY_EOF
{
    servers {
        protocols h1
    }
}

${DOMAIN} {
    header Connection close
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1
    }
}
CADDY_EOF

sudo systemctl daemon-reload
sudo systemctl enable --now smesh-proxy
sudo systemctl restart caddy

echo
echo ">> Installed. Final steps:"
echo "   1) sudo nano $ENV_FILE      # paste your 302.AI key after AI_PROXY_API_KEY="
echo "   2) sudo systemctl restart smesh-proxy"
echo "   3) curl -s https://${DOMAIN}/health      # expect {\"ok\":true}"
