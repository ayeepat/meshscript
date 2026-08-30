/**
 * Client for the СМЭШ AI proxy (ai.smeshapi.site) — stable Think (`qwen`) and
 * Auto (`deepseek`, legacy id) routes for licensed users. The СМЭШ license
 * key + device id are the credentials; the server holds the real API key,
 * re-verifies the license per request and enforces daily quotas server-side
 * (the caps in rate-limit.js remain as client UX; the server is
 * authoritative). Runs ONLY in the background service worker.
 *
 * TRANSPORT: polling, not streaming — and that's load-bearing. Russian DPI
 * (TSPU) clamps any connection to the smeshapi.site SNI that lives longer
 * than ~6–12s to zero bandwidth (proven with heartbeat probes from an RU
 * client against BOTH the Cloudflare worker and the AWS box, over h2, while
 * a 66s stream from an unrelated host survived on the same connection). So
 * one long SSE fetch dies mid-answer in Russia, but sub-second requests
 * always get through — the flow is:
 *
 *   POST /ai/start            → validates license, charges quota, starts the
 *                               302.AI stream SERVER-side, returns { job_id }
 *   GET  /ai/poll?job&cursor  → the SSE text buffered since `cursor` +
 *                               { done, error }; repeated every ~0.6s
 *   POST /ai/cancel           → on abort/failure, so the server stops paying
 *                               302.AI for an answer nobody will read
 *
 * Each poll's chunk is fed into the SAME SSE parser used for direct streams
 * (createSseSink in http.js), so deltas, usage frames and mid-stream errors
 * behave exactly as before — the UI still reveals the answer progressively.
 *
 * CRITICAL: the clamp is per-CONNECTION, not per-request. Chrome pools one
 * TLS connection per origin (h2 multiplexes everything onto it), so a "short"
 * poll at t=+8s still rides the connection opened at /ai/start — and stalls.
 * Observed live: polls #1–2 fine, poll #3 hung forever. So the server (Caddy)
 * is pinned to HTTP/1.1 + `Connection: close`: every request gets a fresh
 * connection that dies well before the clamp window. Client-side, the hard
 * timeout below covers the WHOLE response (headers + body), because a clamped
 * connection routinely delivers headers and then stalls the body forever.
 *
 * The clamp is symmetric — it kills the UPLOAD direction too, and it is a
 * per-connection TRANSFER ALLOWANCE (~16 KB), not just a time window: a big
 * upload measured from RU delivered exactly 16 KB then crawled to a 408, and
 * 96 KB upload chunks died with 0 bytes through. So EVERY request — including
 * /ai/start itself — must fit under that allowance. The upload fix mirrors
 * the polling download fix: when the /ai/start body would be big (screenshot,
 * PDF, long replayed history), the whole `messages` JSON is split into chunks
 * whose JSON-escaped UTF-8 payload stays under ~8 KB, each POSTed to /ai/blob
 * on its own short-lived connection (a few in parallel — each connection
 * brings its own allowance), reassembled server-side, and referenced from a
 * tiny /ai/start via { messages_blob } (see uploadBlob below).
 */
import { hasConsent } from './consent.js';

import { createSseSink, readResponseTextBounded } from './http.js';
import { AI_BACKEND_URL } from './config.js';
import {
  getLicenseStatus, isUsableLicenseStatus, licenseUsabilityReason, reasonMessage
} from './license.js';
import { getDeviceId } from './history.js';
import { validateProxyMessagesBudget } from './upload-limits.js';

const START_URL = `${AI_BACKEND_URL}/ai/start`;
const POLL_URL = `${AI_BACKEND_URL}/ai/poll`;
const CANCEL_URL = `${AI_BACKEND_URL}/ai/cancel`;
const BLOB_URL = `${AI_BACKEND_URL}/ai/blob`;
const UPLOAD_TICKET_URL = `${AI_BACKEND_URL}/ai/upload-ticket`;

// Chunked upload for large attachments (see the module header). A start body
// whose serialized UTF-8 size exceeds START_INLINE_MAX_BYTES is uploaded in
// small pieces instead of inlined.
//
// CHUNK SIZE IS THE WHOLE FIX FOR RU — the TSPU clamp is not just a time
// window, it is a per-connection TRANSFER ALLOWANCE of ~16 KB: a large upload
// measured from RU delivered EXACTLY 16 KB and then crawled to a 408, and
// 96 KB chunks died with 0 bytes through (net::ERR_TIMED_OUT at ~19 s). Small
// requests (/ai/start with text, every poll) always work because they fit
// under the allowance. The DPI meters BYTES, so a RU-safe chunk is budgeted by
// the exact UTF-8 byte length of its JSON-escaped string payload, not by JS
// UTF-16 characters (Cyrillic is usually 2 bytes; emoji can be 4). It must fit
// WELL under 16 KB *including* the JSON envelope, TLS records and headers →
// 8 KB of serialized payload bytes.
//
// BUT most students are NOT behind that clamp, and 8 KB chunks are needlessly
// slow for them: a 5 MB PDF is ~850 requests, and since every request opens a
// FRESH TLS connection (Caddy runs Connection: close — required for RU, see
// backend-vps/README.md — but it means no connection reuse for ANYONE), that's
// ~850 handshakes. Sizing for the worst case by default was the actual
// regression from "a couple versions ago, uploads were fast": there was no
// RU-clamp workaround at all yet, so a PDF just rode one direct request.
//
// So chunk size is ADAPTIVE, not fixed: start large (fast on any normal
// connection), and only fall back to the RU-safe floor if the large size
// provably can't get a full-budget chunk through — see uploadBlob. The learned
// size is remembered for the browser session, so worker respawns do not repeat
// the probe.
const START_INLINE_MAX_BYTES = 10 * 1024; // /ai/start bodies under this go as-is (fit the RU allowance with headroom)
const PROBE_CHUNK_BYTES = 128 * 1024;  // first try — fast for any normal (non-clamped) connection
const SAFE_CHUNK_BYTES = 8 * 1024;     // RU-DPI-safe floor — used once PROBE is proven to not get through at all
const BLOB_PARALLEL = 6;               // the allowance is per-connection, so parallel sockets multiply throughput; 6 = Chrome's HTTP/1.1 per-host connection cap (Caddy runs Connection: close, so h1 — more sockets than this just queue)
const BLOB_CHUNK_TIMEOUT_MS = 10000;   // an 8 KB chunk should take ~0.5–1 s; 10 s means "stalled, retry/give up"
const BLOB_CHUNK_RETRIES = 4;          // retries at the SAFE size, with growing backoff — worth trying hard here
// Retries at the PROBE size. NOT 1 (i.e. zero retries): a large upload is
// dozens of real HTTP requests, and over that many, a single unrelated
// transient blip (one dropped packet, a brief Wi-Fi hiccup) is ordinary —
// failing the WHOLE upload over one such blip would fight the "works 99% of
// the time" goal for the very connections the probe exists to go fast on.
// 2 retries (3 attempts) tolerates that noise while still detecting a genuine
// clamp fast: a real clamp fails on EVERY chunk from EVERY worker, so the
// `sentAny` check below still falls back promptly regardless of this number.
const PROBE_CHUNK_RETRIES = 3;
let learnedChunkChars = null;          // set once an upload actually completes; reused as the starting size next time

// MV3 service workers are torn down after ~30s idle, so an in-memory-only
// learnedChunkChars is lost constantly — an RU-clamped user would re-run the
// full 128KB→8KB probe/fallback on EVERY respawn. chrome.storage.session is
// session-scoped (survives SW restarts, cleared on browser restart) — exactly
// the lifetime of a "this connection is clamped" fact — so it carries the
// learned size across respawns. Trusts ONLY the two sizes uploadBlob can learn,
// so a corrupt/hostile stored value can never widen a chunk past the RU floor.
// Tradeoff: a user whose network un-clamps mid-session stays on the safe (slow
// but always-working) size until a browser restart; that self-heals and never
// breaks an upload, whereas re-probing a still-clamped connection is the exact
// cost this avoids. TSPU clamping is per-network, so it rarely toggles anyway.
// The storage key name is legacy: persisted values are now byte budgets, but
// keeping the key preserves already-learned 131072/8192 values across updates.
const LEARNED_CHUNK_KEY = 'smeshLearnedChunkChars';
async function loadLearnedChunkChars() {
  if (learnedChunkChars) return learnedChunkChars;
  try {
    const { [LEARNED_CHUNK_KEY]: v } = await chrome.storage.session.get(LEARNED_CHUNK_KEY);
    if (v === PROBE_CHUNK_BYTES || v === SAFE_CHUNK_BYTES) learnedChunkChars = v;
  } catch { /* storage.session unavailable → probe as before */ }
  return learnedChunkChars;
}
function rememberLearnedChunkChars(size) {
  learnedChunkChars = size;
  // storage.session.set() returns a Promise — a synchronous try/catch does NOT
  // catch a rejected write, so guard the sync throw (area missing) AND the
  // async rejection (?.catch). Persistence is best-effort; the in-memory value
  // is authoritative regardless, so a failed write is silently ignored.
  try { chrome.storage.session.set({ [LEARNED_CHUNK_KEY]: size })?.catch(() => {}); }
  catch { /* storage.session unavailable */ }
}

// The server long-polls: each /ai/poll is HELD up to ~4s and returns the
// instant new tokens exist. So the client re-polls IMMEDIATELY (no setTimeout
// gap) — that keeps a fetch permanently pending, which is what keeps the MV3
// service worker alive through a long answer (a bare setTimeout does not, and
// that killed the first cut: the worker was suspended mid-answer and the
// dashboard port dropped as "соединение прервано").
const START_TIMEOUT_MS = 30000;    // /ai/start does license verify + upstream connect — allow it time
const POLL_TIMEOUT_MS = 12000;     // > server hold (~4s) + slack; covers headers AND body (see fetchText)
const HOTSPIN_GUARD_MS = 400;      // if a poll returns empty in <this, briefly back off (server should hold)
const IDLE_TIMEOUT_MS = 90000;     // no NEW bytes for this long → give up
const FAILURE_BACKOFF_MS = 1000;   // wait after a transport hiccup before retrying
const MAX_POLL_FAILURES = 4;       // consecutive transport failures tolerated
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isUuidV4 = (value) => typeof value === 'string' && UUID_V4_RE.test(value);
// The VPS intentionally returns a 256-bit base64url capability for uploads
// (`crypto.randomBytes(32).toString('base64url')`), not a UUID. Keep this
// separate from blob/job identifiers so tightening one wire type cannot break
// the other cross-component contract again.
const UPLOAD_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isUploadToken = (value) => typeof value === 'string' && UPLOAD_TOKEN_RE.test(value);

// Proxy errors are ready-made Russian sentences in { error: { message } }.
function proxyMessage(text, fallback) {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

// fetch AND read the full body under one hard timeout, linked to the caller's
// abort signal. The timeout MUST cover the body read, not just the headers:
// a DPI-clamped connection routinely returns the response headers and then
// stalls the body forever — a text() call outside the timer hangs the whole
// solve with no error (observed live: poll #3 silent for 10+ minutes). An
// aborted read also tears the dead connection out of Chrome's pool, so the
// retry opens a fresh one instead of stalling on the same clamped socket.
async function fetchText(url, init, signal, timeoutMs) {
  // An ALREADY-aborted signal never fires 'abort' again, so registering a
  // listener is not by itself a gate. Without this check a request prepared
  // while the caller was cancelling — e.g. an abort landing during the device
  // lookup — was still dispatched with a fresh, un-aborted internal signal,
  // which is how a cancelled solve could still create an upload ticket and a
  // paid job. Re-read the CURRENT state immediately before every external
  // effect, not just at the start of the operation.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: ctrl.signal });
    // A full poll can contain the VPS's 2 MiB output ceiling plus JSON string
    // escaping. Keep generous headroom while still bounding a hostile server.
    const text = await readResponseTextBounded(res, 6 * 1024 * 1024);
    // readResponseTextBounded intentionally converts reader failures to a
    // bounded partial/empty string. A timeout, however, is transport failure —
    // never misreport headers + a stalled body as a successful empty response.
    if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Abort-aware sleep: resolves early (never rejects) when the signal fires;
// the loop re-checks signal.aborted right after.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal?.removeEventListener('abort', done); resolve(); }, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

const CHUNK_TEXT_ENCODER = new TextEncoder();

// JSON.stringify is the exact wire representation for quotes, backslashes,
// controls and lone surrogates. Subtract the two surrounding quote bytes to
// meter only the string payload embedded in the /ai/blob request envelope.
function serializedChunkBytes(chunk) {
  return CHUNK_TEXT_ENCODER.encode(JSON.stringify(chunk)).byteLength - 2;
}

/** Split text into substrings whose JSON-escaped UTF-8 cost fits byteBudget. */
export function splitChunks(text, byteBudget) {
  if (!Number.isSafeInteger(byteBudget) || byteBudget <= 0) {
    throw new RangeError('byteBudget must be a positive integer');
  }
  const chunks = [];
  for (let start = 0; start < text.length;) {
    // ASCII/base64 fast path: start with byteBudget CHARACTERS, which is exact
    // for the common payload and avoids a binary search or per-character scan.
    let charCount = Math.min(byteBudget, text.length - start);
    let chunk = text.slice(start, start + charCount);
    let measuredBytes = serializedChunkBytes(chunk);
    while (measuredBytes > byteBudget) {
      // Usually one proportional shrink is enough (e.g. Cyrillic halves).
      // Force progress around floor/escaping edges and never emit empty data.
      let nextCount = Math.floor(charCount * byteBudget / measuredBytes);
      if (nextCount >= charCount) nextCount = charCount - 1;
      charCount = Math.max(1, nextCount);
      chunk = text.slice(start, start + charCount);
      measuredBytes = serializedChunkBytes(chunk);
      if (charCount === 1 && measuredBytes > byteBudget) {
        throw new RangeError('byteBudget is too small for one serialized character');
      }
    }
    // A boundary may bisect a surrogate pair. That is safe: JSON.stringify
    // escapes each lone surrogate and JSON.parse + concatenation restores the
    // original pair server-side.
    chunks.push(chunk);
    start += charCount;
  }
  return chunks;
}

// Upload one long STRING (here: the messages JSON) as many small /ai/blob
// POSTs at a FIXED serialized UTF-8 BYTE budget and return the server blob id.
// All boundaries are computed before parallel workers pull sequence numbers.
// Chunks stay plain substrings — the server concatenates them in seq order, no
// base64 round-trip (which would inflate already-base64 images by 33%). Each
// chunk rides its own short-lived connection and fits the per-connection
// allowance. Throws once retries are exhausted; `.sentAny` now means a chunk
// large enough to PROVE this byte budget works was delivered, not merely any
// short remainder, so the adaptive wrapper can distinguish clamp from a real
// mid-upload failure.
async function uploadBlobSized(
  text,
  mime,
  name,
  chunkBytes,
  retries,
  { signal, dbg, blobId, uploadToken, generation }
) {
  const chunks = splitChunks(text, chunkBytes);
  const chunkCosts = chunks.map(serializedChunkBytes);
  const fullSize = chunkCosts.map((bytes) => bytes >= chunkBytes * 0.5);
  const total = chunks.length;
  const tUp = Date.now();
  let nextSeq = 0;
  let sent = 0;
  let sizeProven = false;
  let failure = null; // first fatal error — stops all workers

  const pushChunk = async (seq) => {
    const chunk = chunks[seq];
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < retries; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (failure) return; // sibling already failed — don't burn more time
      try {
        const r = await fetchText(BLOB_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            blob_id: blobId,
            upload_token: uploadToken,
            generation,
            seq,
            total,
            chunk,
            mime,
            name
          })
        }, signal, BLOB_CHUNK_TIMEOUT_MS);
        if (r.ok) {
          sent += 1;
          if (fullSize[seq]) sizeProven = true;
          // Log sparsely: first chunks, then every 10th, then the last.
          if (sent <= 3 || sent % 10 === 0 || sent === total) {
            dbg?.('blob', blobId.slice(0, 8), sent + '/' + total, chunkBytes + 'B budget', '+' + (Date.now() - tUp) + 'ms');
          }
          return;
        }
        lastErr = `status ${r.status}`;
      } catch (e) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        lastErr = e?.name === 'AbortError' ? 'тайм-аут' : (e?.name || String(e));
      }
      // Growing backoff: transient clamp/drop recovers in a second or two.
      if (attempt + 1 < retries) await sleep(FAILURE_BACKOFF_MS * (attempt + 1), signal);
    }
    throw new Error(`не удалось загрузить вложение (${lastErr}). Проверьте интернет и попробуйте ещё раз.`);
  };

  const worker = async () => {
    for (;;) {
      const seq = nextSeq++;
      if (seq >= total || failure) return;
      try { await pushChunk(seq); } catch (e) { failure = failure || e; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BLOB_PARALLEL, total) }, worker));
  // Evaluated AFTER every worker settles. Only a >= half-budget success proves
  // the size; a tiny final remainder can pass a clamp while full chunks fail.
  if (failure) { failure.sentAny = sizeProven; throw failure; }
  dbg?.('blob', blobId.slice(0, 8), 'DONE', total + ' chunks @ ' + chunkBytes + 'B budget', text.length + 'ch', '+' + (Date.now() - tUp) + 'ms');
  return blobId;
}

// Adaptive entry point: try the large PROBE size first (fast on any normal
// connection); if it fails without delivering a FULL-SIZE (>= half-budget)
// chunk — the signature of a hard per-connection clamp — retry the WHOLE
// upload at the RU-safe floor. A successful tiny final remainder does not
// suppress fallback; a proven-size success followed by failure is surfaced as
// a real network error. The working size is remembered for the browser session.
export async function uploadBlob(text, mime, name, opts) {
  const startSize = (await loadLearnedChunkChars()) || PROBE_CHUNK_BYTES;
  const startRetries = startSize <= SAFE_CHUNK_BYTES ? BLOB_CHUNK_RETRIES : PROBE_CHUNK_RETRIES;
  try {
    const id = await uploadBlobSized(text, mime, name, startSize, startRetries, {
      ...opts,
      generation: 0
    });
    rememberLearnedChunkChars(startSize);
    return id;
  } catch (e) {
    if (e?.name === 'AbortError' || e.sentAny || startSize <= SAFE_CHUNK_BYTES) throw e;
    opts.dbg?.('probe size', startSize + 'B failed with no full-size chunk through — falling back to RU-safe', SAFE_CHUNK_BYTES + 'B');
    // A timed-out probe can still reach the VPS after this fallback begins.
    // Advance the upload generation so those late chunks are acknowledged but
    // can never reset or corrupt the authoritative safe-size attempt.
    const id = await uploadBlobSized(text, mime, name, SAFE_CHUNK_BYTES, BLOB_CHUNK_RETRIES, {
      ...opts,
      generation: 1
    });
    rememberLearnedChunkChars(SAFE_CHUNK_BYTES);
    return id;
  }
}

// Blob chunks are intentionally tiny and numerous, so they cannot each afford
// a remote /verify request. Obtain one short-lived, license-bound capability
// first; the VPS binds every chunk and the final /ai/start to it.
async function createUploadTicket(licenseKey, deviceId, activationToken, size, signal) {
  let res;
  try {
    res = await fetchText(UPLOAD_TICKET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key: licenseKey,
        device_id: deviceId,
        activation_token: activationToken,
        size
      })
    }, signal, START_TIMEOUT_MS);
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('Не удалось подтвердить загрузку вложения. Проверьте интернет и попробуйте ещё раз.');
  }
  if (!res.ok) throw new Error(proxyMessage(res.text, 'Не удалось подтвердить загрузку вложения. Попробуйте ещё раз.'));
  let ticket;
  try { ticket = JSON.parse(res.text); } catch { ticket = null; }
  if (!ticket?.ok || !isUploadToken(ticket.upload_token) || !isUuidV4(ticket.blob_id)) {
    throw new Error('Не удалось подтвердить загрузку вложения. Попробуйте ещё раз.');
  }
  return ticket;
}

export async function askViaProxy(provider, messages, { label = 'AI', onDelta = null, onUsage = null, onReasoning = null, signal = null, responseFormat = null, reasoning = null } = {}) {
  // The proxy requires both the public key and the per-installation bearer
  // capability. Keep this defensive check even though normal callers already
  // pass through ensureLicensed(): no direct caller may emit an unauthenticated
  // paid request while the UI claims the installation is active.
  const status = await getLicenseStatus();
  if (!status?.key) {
    throw new Error(
      'Расширение работает по лицензии СМЭШ. ' +
      'Введите ключ доступа (SMESH-…) в настройках расширения.'
    );
  }
  if (!isUsableLicenseStatus(status)) {
    throw new Error(reasonMessage(licenseUsabilityReason(status)));
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const t0 = Date.now();
  const dbg = (...a) => console.log('[smesh-poll]', '+' + (Date.now() - t0) + 'ms', ...a);

  const deviceId = await getDeviceId();
  // Server-side usage reporting follows the same explicit opt-in as client
  // telemetry. Treat every missing, malformed, or unreadable value as false.
  let telemetryOptIn = false;
  try {
    const stored = await chrome.storage.local.get('telemetryEnabled');
    telemetryOptIn = stored.telemetryEnabled === true && await hasConsent();
  } catch { /* privacy-safe default */ }
  // Bound to this logical solve for the whole attempt, including retries: the
  // server launches the upstream job once the RESPONSE is flushed, not once
  // the client reads it, so a lost /ai/start reply would otherwise leave a
  // paid job running and the retry would start a second one.
  const idempotencyKey = crypto.randomUUID();
  const body = {
    provider,
    license_key: status.key,
    device_id: deviceId,
    activation_token: status.activation_token,
    telemetry_opt_in: telemetryOptIn,
    idempotency_key: idempotencyKey,
    messages
  };
  if (responseFormat) body.response_format = responseFormat;
  // OpenRouter-style {effort} → the flat reasoning_effort field the proxy
  // whitelists. The VPS applies the final policy per actual live model (for
  // example, Qwen thinks by default and is sent no effort at all, while
  // GLM-5.3-Flash is forced to thinking=max).
  if (reasoning?.effort) body.reasoning_effort = reasoning.effort;

  // The WHOLE /ai/start body must fit under the per-connection allowance —
  // an attachment, a long system prompt or replayed history can all blow it.
  // When it doesn't fit, ship `messages` via chunked /ai/blob upload and send
  // a tiny start that references the blob instead.
  let payload = JSON.stringify(body);
  if (new TextEncoder().encode(payload).byteLength > START_INLINE_MAX_BYTES) {
    // This is the exact object the VPS reassembles under MAX_BLOB_CHARS. Check
    // its serialized length before obtaining a ticket or uploading any chunk;
    // the attachment-only budget cannot account for long prompts/history.
    const messagesBudget = validateProxyMessagesBudget(messages);
    if (!messagesBudget.ok) throw new Error(`${label}: ${messagesBudget.error}`);
    const messagesJson = messagesBudget.json;
    dbg('start body', payload.length + 'ch — externalizing messages (' + messagesJson.length + 'ch) via /ai/blob');
    let blobId;
    try {
      const ticket = await createUploadTicket(
        status.key, deviceId, status.activation_token, messagesJson.length, signal
      );
      blobId = await uploadBlob(messagesJson, 'application/json', 'messages', {
        signal, dbg, blobId: ticket.blob_id, uploadToken: ticket.upload_token
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(`${label}: ${e?.message || 'не удалось загрузить вложение. Попробуйте ещё раз.'}`);
    }
    const slim = { ...body };
    delete slim.messages;
    slim.messages_blob = blobId;
    payload = JSON.stringify(slim);
  }

  // ---- start: license check + quota charge + server-side stream kickoff ----
  // One retry, carrying the SAME idempotency key. A transport failure here is
  // ambiguous — the server may already have flushed a reply we never read and
  // launched the job — so retrying blind would double the spend. With the key
  // the server answers the retry with the ORIGINAL job instead of starting a
  // second one, which turns a lost reply from wasted quota into a recovery.
  let res;
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      res = await fetchText(START_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      }, signal, START_TIMEOUT_MS);
      break;
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (attempt >= 2) {
        throw new Error(`${label}: не удалось связаться с сервером СМЭШ. Проверьте интернет и попробуйте ещё раз.`);
      }
      dbg('START transport failure, retrying with the same idempotency key');
      await sleep(FAILURE_BACKOFF_MS, signal);
    }
  }
  const startText = res.text;
  if (!res.ok) {
    // Server messages are already student-ready Russian (license, quota,
    // breaker) — pass them through verbatim, like rawErrors in postStream.
    throw new Error(proxyMessage(startText, `${label}: ошибка сервера (${res.status}). Попробуйте ещё раз.`));
  }
  let started;
  try { started = JSON.parse(startText); } catch { started = null; }
  const jobId = started?.ok && isUuidV4(started.job_id) ? started.job_id : '';
  const jobToken = started?.ok && isUuidV4(started.job_token) ? started.job_token : '';
  if (!jobId || !jobToken) throw new Error(`${label}: некорректный ответ сервера. Попробуйте ещё раз.`);
  dbg('START ok', res.status, 'job', jobId.slice(0, 8));

  // Fire-and-forget: free the job / stop the upstream spend. Idempotent.
  const cancelJob = () => {
    const headers = { 'Content-Type': 'application/json', 'X-Job-Token': jobToken };
    fetch(CANCEL_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ job: jobId }),
      redirect: 'error'
    }).catch(() => { });
  };

  // ---- poll loop: drain the buffered SSE text through the shared parser ----
  const sink = createSseSink({ label, onDelta, onUsage, onReasoning, rawErrors: true });
  let cursor = 0;
  let lastDataAt = Date.now();
  let failures = 0;
  let pollN = 0;

  try {
    for (;;) {
      if (signal?.aborted) { dbg('signal aborted before poll'); throw new DOMException('Aborted', 'AbortError'); }

      const pollStart = Date.now();
      let poll = null; // parsed poll body, or null on any transport hiccup
      let notFound = null;
      try {
        const headers = { 'X-Job-Token': jobToken };
        const r = await fetchText(
          `${POLL_URL}?job=${encodeURIComponent(jobId)}&cursor=${cursor}`,
          { method: 'GET', headers },
          signal,
          POLL_TIMEOUT_MS
        );
        if (r.status === 404) {
          // The job is gone server-side (GC'd / restart) — not transient.
          notFound = proxyMessage(r.text, `${label}: сессия ответа устарела. Попробуйте ещё раз.`);
        } else if (r.ok) {
          try { poll = JSON.parse(r.text); } catch { /* transient */ }
          if (!poll?.ok) poll = null;
        }
      } catch (e) { dbg('poll transport error', e?.name || String(e)); /* transient — retried below */ }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (notFound) throw new Error(notFound);

      if (!poll) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          throw new Error(`${label}: соединение с сервером потеряно. Попробуйте ещё раз.`);
        }
        await sleep(FAILURE_BACKOFF_MS, signal);
        continue;
      }
      failures = 0;
      pollN += 1;
      if (pollN <= 3 || pollN % 10 === 0 || poll.done) {
        dbg('poll#' + pollN, 'cursor', cursor, '→', poll.cursor, 'chunk', (poll.chunk || '').length, 'done', poll.done);
      }

      if (poll.chunk) {
        lastDataAt = Date.now();
        sink.push(poll.chunk); // throws on provider error frames
      }
      cursor = Number.isFinite(poll.cursor) ? poll.cursor : cursor;
      if (poll.error) throw new Error(poll.error);
      if (poll.done) return sink.finish();

      if (Date.now() - lastDataAt > IDLE_TIMEOUT_MS) {
        throw new Error(`${label}: превышено время ожидания. Попробуйте ещё раз.`);
      }
      // Server long-poll normally holds ~4s, so re-poll immediately (no gap →
      // a fetch is always pending → the service worker stays alive). Only if a
      // poll comes back empty AND suspiciously fast (misbehaving hop / old
      // server) do we back off briefly to avoid a hot loop.
      if (!poll.chunk && Date.now() - pollStart < HOTSPIN_GUARD_MS) {
        await sleep(HOTSPIN_GUARD_MS, signal);
      }
    }
  } catch (e) {
    dbg('THREW', e?.name, String(e?.message || e), 'aborted=' + !!signal?.aborted, 'polls=' + pollN);
    cancelJob();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw e;
  }
}
