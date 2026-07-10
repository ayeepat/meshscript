/**
 * Client for the СМЭШ AI proxy (ai.smeshapi.site, the AWS box) — Qwen and
 * DeepSeek for licensed users WITHOUT their own Alibaba key. The СМЭШ license
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
 * PDF, long replayed history), the whole `messages` JSON is sliced into ~8 KB
 * chunks, each POSTed to /ai/blob on its own short-lived connection (a few in
 * parallel — each connection brings its own allowance), reassembled server-
 * side, and referenced from a tiny /ai/start via { messages_blob } (see
 * uploadBlob below).
 */

import { createSseSink } from './http.js';
import { AI_BACKEND_URL } from './config.js';
import { getLicenseStatus } from './license.js';
import { getDeviceId } from './history.js';

const START_URL = `${AI_BACKEND_URL}/ai/start`;
const POLL_URL = `${AI_BACKEND_URL}/ai/poll`;
const CANCEL_URL = `${AI_BACKEND_URL}/ai/cancel`;
const BLOB_URL = `${AI_BACKEND_URL}/ai/blob`;
const UPLOAD_TICKET_URL = `${AI_BACKEND_URL}/ai/upload-ticket`;

// Chunked upload for large attachments (see the module header). A part whose
// data URI exceeds INLINE_MAX_CHARS is uploaded in small pieces instead of
// inlined.
//
// CHUNK SIZE IS THE WHOLE FIX FOR RU — the TSPU clamp is not just a time
// window, it is a per-connection TRANSFER ALLOWANCE of ~16 KB: a large upload
// measured from RU delivered EXACTLY 16 KB and then crawled to a 408, and
// 96 KB chunks died with 0 bytes through (net::ERR_TIMED_OUT at ~19 s). Small
// requests (/ai/start with text, every poll) always work because they fit
// under the allowance. So a RU-safe chunk must fit WELL under 16 KB
// *including* the JSON envelope, TLS records and headers → 8 KB of payload.
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
// provably can't get ANY bytes through — see uploadBlob. The learned size is
// remembered for the rest of this service-worker's lifetime, so only the
// FIRST upload after a worker restart ever pays the probe cost.
const START_INLINE_MAX_CHARS = 10 * 1024; // /ai/start bodies under this go as-is (fit the RU allowance with headroom)
const PROBE_CHUNK_CHARS = 128 * 1024;  // first try — fast for any normal (non-clamped) connection
const SAFE_CHUNK_CHARS = 8 * 1024;     // RU-DPI-safe floor — used once PROBE is proven to not get through at all
const BLOB_PARALLEL = 3;               // the allowance is per-connection, so parallel sockets multiply throughput
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
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

// Upload one long STRING (here: the messages JSON) as many small /ai/blob
// POSTs at a FIXED chunk size and return the server blob id. Chunks are plain
// substrings — the server just concatenates them back in seq order, no
// base64 round-trip (a base64 wrapper would inflate the already-base64 image
// payloads by 33%). Each chunk rides its own short-lived connection (fresh
// under Connection: close) and fits under the per-connection transfer
// allowance; a few upload in parallel because each connection has its OWN
// allowance. Throws once every retry at every chunk is exhausted; the thrown
// Error carries `.sentAny` (were ANY chunks delivered before the failure?) so
// the adaptive wrapper below can tell "this size doesn't work at all" (retry
// smaller) apart from "a real error mid-upload" (surface it, don't retry).
async function uploadBlobSized(text, mime, name, chunkChars, retries, { signal, dbg, blobId, uploadToken }) {
  const total = Math.max(1, Math.ceil(text.length / chunkChars));
  const tUp = Date.now();
  let nextSeq = 0;
  let sent = 0;
  let failure = null; // first fatal error — stops all workers

  const pushChunk = async (seq) => {
    const chunk = text.slice(seq * chunkChars, (seq + 1) * chunkChars);
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < retries; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (failure) return; // sibling already failed — don't burn more time
      try {
        const r = await fetchText(BLOB_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blob_id: blobId, upload_token: uploadToken, seq, total, chunk, mime, name })
        }, signal, BLOB_CHUNK_TIMEOUT_MS);
        if (r.ok) {
          sent += 1;
          // Log sparsely: first chunks, then every 10th, then the last.
          if (sent <= 3 || sent % 10 === 0 || sent === total) {
            dbg?.('blob', blobId.slice(0, 8), sent + '/' + total, chunkChars + 'B/chunk', '+' + (Date.now() - tUp) + 'ms');
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
  // Evaluated AFTER every parallel worker has settled, so `sent` is the true
  // final count — a sibling chunk that succeeded a moment after this one gave
  // up still proves the size works, and should NOT trigger a size fallback.
  if (failure) { failure.sentAny = sent > 0; throw failure; }
  dbg?.('blob', blobId.slice(0, 8), 'DONE', total + ' chunks @ ' + chunkChars + 'B', text.length + 'ch', '+' + (Date.now() - tUp) + 'ms');
  return blobId;
}

// Adaptive entry point: try the large PROBE size first (fast on any normal
// connection); if it fails with ZERO chunks delivered — the signature of a
// hard per-connection clamp, not a one-off blip — retry the WHOLE upload at
// the RU-safe floor size instead. A size that gets even one chunk through but
// then fails is a real error (network drop, tab closed), not a size problem,
// so that's surfaced as-is rather than retried smaller. The size that works
// is remembered for the rest of this service-worker's lifetime.
async function uploadBlob(text, mime, name, opts) {
  const startSize = learnedChunkChars || PROBE_CHUNK_CHARS;
  const startRetries = startSize <= SAFE_CHUNK_CHARS ? BLOB_CHUNK_RETRIES : PROBE_CHUNK_RETRIES;
  try {
    const id = await uploadBlobSized(text, mime, name, startSize, startRetries, opts);
    learnedChunkChars = startSize;
    return id;
  } catch (e) {
    if (e?.name === 'AbortError' || e.sentAny || startSize <= SAFE_CHUNK_CHARS) throw e;
    opts.dbg?.('probe size', startSize + 'B failed with 0 bytes through — falling back to RU-safe', SAFE_CHUNK_CHARS + 'B');
    const id = await uploadBlobSized(text, mime, name, SAFE_CHUNK_CHARS, BLOB_CHUNK_RETRIES, opts);
    learnedChunkChars = SAFE_CHUNK_CHARS;
    return id;
  }
}

// Blob chunks are intentionally tiny and numerous, so they cannot each afford
// a remote /verify request. Obtain one short-lived, license-bound capability
// first; the VPS binds every chunk and the final /ai/start to it.
async function createUploadTicket(licenseKey, deviceId, signal) {
  let res;
  try {
    res = await fetchText(UPLOAD_TICKET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: licenseKey, device_id: deviceId })
    }, signal, START_TIMEOUT_MS);
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('Не удалось подтвердить загрузку вложения. Проверьте интернет и попробуйте ещё раз.');
  }
  if (!res.ok) throw new Error(proxyMessage(res.text, 'Не удалось подтвердить загрузку вложения. Попробуйте ещё раз.'));
  let ticket;
  try { ticket = JSON.parse(res.text); } catch { ticket = null; }
  if (!ticket?.ok || typeof ticket.upload_token !== 'string' || typeof ticket.blob_id !== 'string') {
    throw new Error('Не удалось подтвердить загрузку вложения. Попробуйте ещё раз.');
  }
  return ticket;
}

export async function askViaProxy(provider, messages, { label = 'AI', onDelta = null, onUsage = null, signal = null, responseFormat = null, reasoning = null } = {}) {
  // Only require that a key has been ENTERED — the server re-verifies anyway,
  // and its verdict (expired/revoked/…) comes back as a ready Russian message.
  // A stale local cache must not block a user whose license is actually fine.
  const status = await getLicenseStatus();
  if (!status?.key) {
    throw new Error(
      'Qwen и DeepSeek работают по лицензии СМЭШ — API-ключи не нужны. ' +
      'Введите ключ доступа (SMESH-…) в настройках расширения.'
    );
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const t0 = Date.now();
  const dbg = (...a) => console.log('[smesh-poll]', '+' + (Date.now() - t0) + 'ms', ...a);

  const deviceId = await getDeviceId();
  const body = {
    provider,
    license_key: status.key,
    device_id: deviceId,
    messages
  };
  if (responseFormat) body.response_format = responseFormat;
  // OpenRouter-style {effort} → the flat reasoning_effort field the proxy
  // whitelists (it forwards it only where the model has a real effort knob —
  // DeepSeek; Qwen thinks by default and has none).
  if (reasoning?.effort) body.reasoning_effort = reasoning.effort;

  // The WHOLE /ai/start body must fit under the per-connection allowance —
  // an attachment, a long system prompt or replayed history can all blow it.
  // When it doesn't fit, ship `messages` via chunked /ai/blob upload and send
  // a tiny start that references the blob instead.
  let payload = JSON.stringify(body);
  if (payload.length > START_INLINE_MAX_CHARS) {
    const messagesJson = JSON.stringify(messages);
    dbg('start body', payload.length + 'ch — externalizing messages (' + messagesJson.length + 'ch) via /ai/blob');
    let blobId;
    try {
      const ticket = await createUploadTicket(status.key, deviceId, signal);
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
  let res;
  try {
    res = await fetchText(START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }, signal, START_TIMEOUT_MS);
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error(`${label}: не удалось связаться с сервером СМЭШ. Проверьте интернет и попробуйте ещё раз.`);
  }
  const startText = res.text;
  if (!res.ok) {
    // Server messages are already student-ready Russian (license, quota,
    // breaker) — pass them through verbatim, like rawErrors in postStream.
    throw new Error(proxyMessage(startText, `${label}: ошибка сервера (${res.status}). Попробуйте ещё раз.`));
  }
  let started;
  try { started = JSON.parse(startText); } catch { started = null; }
  const jobId = started?.ok && typeof started.job_id === 'string' ? started.job_id : '';
  if (!jobId) throw new Error(`${label}: некорректный ответ сервера. Попробуйте ещё раз.`);
  dbg('START ok', res.status, 'job', jobId.slice(0, 8));

  // Fire-and-forget: free the job / stop the upstream spend. Idempotent.
  const cancelJob = () => {
    fetch(CANCEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: jobId })
    }).catch(() => { });
  };

  // ---- poll loop: drain the buffered SSE text through the shared parser ----
  const sink = createSseSink({ label, onDelta, onUsage, rawErrors: true });
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
        const r = await fetchText(`${POLL_URL}?job=${encodeURIComponent(jobId)}&cursor=${cursor}`, { method: 'GET' }, signal, POLL_TIMEOUT_MS);
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
