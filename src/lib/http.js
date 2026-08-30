/**
 * Shared HTTP helper for AI provider calls (background service worker only).
 *
 * Adds the things every provider needs but none of them had:
 *  - a request TIMEOUT, so a hung connection surfaces as an error instead of
 *    leaving the UI stuck on "Думаю…" forever;
 *  - FRIENDLY error messages (in Russian) for the failures a student actually
 *    hits — bad key, no credit, rate limit — instead of a raw JSON dump;
 *  - SSE STREAMING (postStream) so answers can be revealed token-by-token.
 */

import { SHOW_PROVIDER_UI } from './config.js';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_STREAM_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_TEXT_BYTES = 64 * 1024;

// Sentinel returned when a stream completes with no content deltas at all.
// Callers detect it to surface a retryable error instead of saving/showing it
// as if it were a real answer.
export const EMPTY_ANSWER = '(пустой ответ)';

/** Pull a human-readable message out of a provider error payload. */
function extractError(text) {
  try {
    const j = JSON.parse(text);
    return j?.error?.message || j?.error || j?.message || text.slice(0, 300);
  } catch {
    return (text || '').slice(0, 300);
  }
}

/**
 * Turn an HTTP status + provider message into a short Russian sentence a
 * student can act on. Falls back to the raw provider message for anything we
 * don't have a friendly phrasing for.
 */
function friendlyMessage(rawLabel, status, providerMsg) {
  // `rawLabel` is the vendor name. It stays in logs and in the raw-error tail,
  // but while the provider UI is hidden it must not reach the student — and
  // neither may advice like "switch to Groq", which points at a control that
  // is no longer there.
  const label = SHOW_PROVIDER_UI ? rawLabel : 'ИИ-сервис';
  const m = (providerMsg || '').toLowerCase();
  const credit = /insufficient|credit|balance|quota|exceeded your|payment|402/.test(m);
  if (status === 401 || status === 403) {
    return SHOW_PROVIDER_UI
      ? `Неверный API-ключ ${label}. Проверьте ключ в настройках расширения.`
      : 'ИИ-сервис отклонил запрос. Проверьте ключ доступа в настройках расширения.';
  }
  if (status === 402 || (status === 400 && credit)) {
    return SHOW_PROVIDER_UI
      ? `На счёте ${label} закончились средства. Пополните баланс или переключитесь на Groq (бесплатно) в настройках.`
      : 'Лимит запросов по лицензии исчерпан. Попробуйте позже или напишите в поддержку.';
  }
  if (status === 429) {
    return SHOW_PROVIDER_UI
      ? `${label}: слишком много запросов, лимит исчерпан. Подождите минуту и попробуйте снова (или переключитесь на Groq в настройках).`
      : `${label}: слишком много запросов подряд. Подождите минуту и попробуйте снова.`;
  }
  if (status >= 500) {
    return `${label}: сервер временно недоступен. Попробуйте ещё раз через минуту.`;
  }
  return SHOW_PROVIDER_UI
    ? `${label} ${status}: ${providerMsg}`
    : `ИИ-сервис вернул ошибку ${status}. Попробуйте ещё раз.`;
}

/** Build the friendly Error for a non-OK response (shared by both helpers). */
export function httpError(label, status, bodyText) {
  return new Error(friendlyMessage(label, status, extractError(bodyText)));
}

/** Read at most `maxBytes` from an upstream response, then cancel the rest. */
export async function readResponseTextBounded(response, maxBytes = MAX_RESPONSE_TEXT_BYTES) {
  if (!response?.body?.getReader || !Number.isFinite(maxBytes) || maxBytes < 0) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      const take = Math.min(value.byteLength, maxBytes - total);
      if (take) chunks.push(value.subarray(0, take));
      total += take;
      if (take < value.byteLength || total >= maxBytes) {
        try { await reader.cancel('response body limit reached'); } catch { /* already closed */ }
        break;
      }
    }
  } catch { return ''; }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * The timeout must cover the body read, not only response headers: stalled
 * connections routinely deliver headers and then hang the body. This is the
 * same transport constraint that requires smesh-proxy.js to own its fetchText.
 */
export async function fetchTextBounded(url, init = {}, { timeoutMs = 15000, maxBytes } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await readResponseTextBounded(res, maxBytes);
    if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Incremental OpenAI-style SSE parser, decoupled from any transport. Feed it
 * text with push() (as many times as you like, chunk boundaries anywhere —
 * partial lines are buffered), then call finish() for the accumulated answer.
 *
 * Two consumers: postStream() below (one long HTTP stream) and the СМЭШ
 * proxy's poll loop (smesh-proxy.js — the same SSE text arrives sliced into
 * short poll responses, because RU DPI kills long-lived connections). One
 * parser, so frame handling can never drift between the two paths.
 *
 * push() THROWS on provider error frames (same semantics postStream had
 * inline); finish() fires onUsage once and returns the full text — or THROWS
 * when the stream never delivered its terminal `data: [DONE]` frame, because
 * a cleanly closed socket without it is an incomplete answer, not a result.
 */
export function createSseSink({ label = 'AI', onDelta = null, onUsage = null, onReasoning = null, rawErrors = false }) {
  let buffer = '';
  let full = '';
  // OpenAI-style streams terminate every COMPLETED answer with `data: [DONE]`.
  // A body that merely ends (proxy idle cut, upstream dying with a clean FIN)
  // has exactly the shape of a truncated answer, so finish() refuses to treat
  // it as success — graceful EOF is not a completion signal.
  let sawDone = false;
  // Token/cost accounting rides the SAME stream. The final frame carries a
  // `usage` object (OpenRouter with usage.include; Groq/OpenAI-compat with
  // stream_options.include_usage — Groq nests it under x_groq.usage), and the
  // model id sits at the frame top level. Captured here, surfaced via onUsage
  // after a clean finish so telemetry never affects the answer path.
  let usage = null;
  let model = null;

  function processLine(line) {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { sawDone = true; return; }
    let json;
    try { json = JSON.parse(data); }
    catch { return; } // incomplete / non-JSON frame — ignore, never fatal
    // A 200 OK can still carry a provider error MID-STREAM: a rate limit hit
    // while generating, a moderation block, or an upstream model drop. The
    // old code only read delta.content, so such a frame was silently dropped
    // and the user got "(пустой ответ)" / a truncated answer with no reason.
    // Surface it as the same friendly error a pre-stream failure would.
    if (json?.error) {
      // Proxied streams (rawErrors) relay the UPSTREAM provider's frames —
      // an English DashScope error or a bogus status would mistranslate,
      // so collapse mid-stream failures to one generic retry message.
      if (rawErrors) {
        throw new Error(`${label}: сервис прервал ответ. Попробуйте ещё раз.`);
      }
      const code = Number(json.error.code) || Number(json.error.status) || 0;
      throw code
        ? httpError(label, code, JSON.stringify(json))
        : new Error(`${label}: ${json.error.message || 'провайдер прервал ответ ошибкой. Попробуйте ещё раз.'}`);
    }
    if (!model && json?.model) model = json.model;
    if (json?.usage) usage = json.usage;
    else if (json?.x_groq?.usage) usage = json.x_groq.usage;
    const delta = json?.choices?.[0]?.delta?.content;
    if (delta) { full += delta; onDelta?.(delta); }
    // The model's PRIVATE thinking channel. Providers spell it differently —
    // OpenRouter/OpenAI-compat use `reasoning`, DashScope/DeepSeek/GLM use
    // `reasoning_content` — and it must never reach `full`: the visible answer
    // is answers-only JSON, and folding reasoning into it is exactly the bug
    // openrouter.js documents (a panel that shows raw thinking, and an answers
    // array truncated by the blob in front of it).
    //
    // It is surfaced ONLY through this opt-in side channel, which nothing but
    // the owner-gated diagnostics recorder subscribes to. No subscriber ⇒ the
    // deltas are read and dropped, exactly as before.
    if (onReasoning) {
      const reasoningDelta = json?.choices?.[0]?.delta?.reasoning ??
        json?.choices?.[0]?.delta?.reasoning_content;
      // Providers emit `""` on non-reasoning frames; only forward real text.
      if (typeof reasoningDelta === 'string' && reasoningDelta) onReasoning(reasoningDelta);
    }
  }

  return {
    push(text) {
      if (buffer.length + full.length + String(text).length > MAX_STREAM_CHARS) {
        throw new Error(`${label}: ответ превысил безопасный лимит. Задайте более короткий вопрос.`);
      }
      buffer += text;
      // SSE frames are separated by blank lines; process complete lines.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        processLine(line);
      }
    },
    finish() {
      if (buffer) {
        const line = buffer;
        buffer = '';
        processLine(line);
      }
      if (!sawDone) {
        throw new Error(`${label}: ответ получен не полностью. Попробуйте ещё раз.`);
      }
      if (onUsage && (usage || model)) {
        try { onUsage({ ...(usage || {}), model }); } catch { /* telemetry never breaks the answer */ }
      }
      return full || EMPTY_ANSWER;
    }
  };
}

/**
 * POST a streaming (SSE) chat-completions request. Parses OpenAI-style
 * `data: {...}` deltas, calls onDelta(textChunk) as tokens arrive, and
 * resolves with the full accumulated text.
 *
 * No retries here: once bytes have streamed to the UI we can't cleanly restart.
 * A pre-first-byte failure (bad key, no credit) still surfaces as a friendly
 * Error from the response status.
 *
 * @param {string} url
 * @param {object} opts
 * @param {object} [opts.headers]
 * @param {object} opts.body        request body (stream:true is added)
 * @param {string} [opts.label]
 * @param {(chunk:string)=>void} opts.onDelta
 * @param {(usage:object)=>void} [opts.onUsage] final token/cost usage frame,
 *        merged with the top-level `model` id. Fired once, only on a clean
 *        finish. Pure side channel for telemetry — the return value is unchanged.
 * @param {(chunk:string)=>void} [opts.onReasoning] the model's private thinking
 *        deltas. Never part of the returned text; see createSseSink.
 * @param {number} [opts.timeoutMs] idle timeout between chunks
 * @param {boolean} [opts.rawErrors] pass server error messages through
 *        VERBATIM instead of the friendly status mapping. For the СМЭШ proxy
 *        (smesh-proxy.js): its errors are already ready-made Russian sentences
 *        (license, quota, breaker), and the status mapping would mistranslate
 *        them — a 403 there means "no license", not "bad API key".
 * @returns {Promise<string>} full message text
 */
export async function postStream(url, { headers = {}, body, label = 'AI', onDelta, onUsage = null, onReasoning = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, rawErrors = false }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const ctrl = new AbortController();
  // Reset the idle timer on every chunk so long answers don't trip it.
  let timedOut = false;
  const armTimeout = () => setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  let timer = armTimeout();
  const bump = () => {
    clearTimeout(timer);
    // Once an idle timer has fired the controller is permanently aborted.
    // Do not let a queued final chunk reset `timedOut` and turn the following
    // read failure back into a raw AbortError.
    if (!ctrl.signal.aborted) timer = armTimeout();
  };
  // Link the caller's signal to our internal controller so a port disconnect
  // tears down the SSE read loop immediately — otherwise the upstream provider
  // keeps streaming (and charging) until idle timeout.
  const onExternalAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ ...body, stream: true }),
      redirect: 'error',
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut && e.name === 'AbortError') {
      throw new Error(`${label}: превышено время ожидания. Попробуйте ещё раз.`);
    }
    throw e;
  }

  if (!res.ok) {
    const text = await readResponseTextBounded(res);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
    // readResponseTextBounded deliberately swallows reader failures. Restore
    // the caller/timeout semantics here so an abort during a stalled error
    // body is not misreported as an HTTP/provider failure.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut && ctrl.signal.aborted) {
      throw new Error(`${label}: превышено время ожидания. Попробуйте ещё раз.`);
    }
    if (rawErrors) {
      throw new Error(extractError(text) || `${label}: ошибка сервера (${res.status}). Попробуйте ещё раз.`);
    }
    throw httpError(label, res.status, text);
  }

  // A 200 with no readable body stream can't be consumed — surface it as a
  // clear error instead of throwing a raw TypeError on getReader().
  if (!res.body) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error(`${label}: пустой ответ сервера (нет потока данных).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sink = createSseSink({ label, onDelta, onUsage, onReasoning, rawErrors });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      sink.push(decoder.decode(value, { stream: true }));
    }
    sink.push(decoder.decode());
  } catch (e) {
    ctrl.abort(); // stop a malicious/oversized/erroring upstream immediately
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (timedOut && (e?.name === 'AbortError' || ctrl.signal.aborted)) {
      throw new Error(`${label}: превышено время ожидания. Попробуйте ещё раз.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
  return sink.finish();
}
