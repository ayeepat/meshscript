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

const DEFAULT_TIMEOUT_MS = 60000;

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
function friendlyMessage(label, status, providerMsg) {
  const m = (providerMsg || '').toLowerCase();
  const credit = /insufficient|credit|balance|quota|exceeded your|payment|402/.test(m);
  if (status === 401 || status === 403) {
    return `Неверный API-ключ ${label}. Проверьте ключ в настройках расширения.`;
  }
  if (status === 402 || (status === 400 && credit)) {
    return `На счёте ${label} закончились средства. Пополните баланс или переключитесь на Groq (бесплатно) в настройках.`;
  }
  if (status === 429) {
    return `${label}: слишком много запросов, лимит исчерпан. Подождите минуту и попробуйте снова (или переключитесь на Groq в настройках).`;
  }
  if (status >= 500) {
    return `${label}: сервер временно недоступен. Попробуйте ещё раз через минуту.`;
  }
  return `${label} ${status}: ${providerMsg}`;
}

/** Build the friendly Error for a non-OK response (shared by both helpers). */
export function httpError(label, status, bodyText) {
  return new Error(friendlyMessage(label, status, extractError(bodyText)));
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
 * inline); finish() fires onUsage once and returns the full text.
 */
export function createSseSink({ label = 'AI', onDelta = null, onUsage = null, rawErrors = false }) {
  let buffer = '';
  let full = '';
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
    if (data === '[DONE]') return;
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
  }

  return {
    push(text) {
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
      if (onUsage && (usage || model)) {
        try { onUsage({ ...(usage || {}), model }); } catch { /* telemetry never breaks the answer */ }
      }
      return full || '(пустой ответ)';
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
 * @param {number} [opts.timeoutMs] idle timeout between chunks
 * @param {boolean} [opts.rawErrors] pass server error messages through
 *        VERBATIM instead of the friendly status mapping. For the СМЭШ proxy
 *        (smesh-proxy.js): its errors are already ready-made Russian sentences
 *        (license, quota, breaker), and the status mapping would mistranslate
 *        them — a 403 there means "no license", not "bad API key".
 * @returns {Promise<string>} full message text
 */
export async function postStream(url, { headers = {}, body, label = 'AI', onDelta, onUsage = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null, rawErrors = false }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const ctrl = new AbortController();
  // Reset the idle timer on every chunk so long answers don't trip it.
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), timeoutMs); };
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
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (e.name === 'AbortError') {
      throw new Error(`${label}: превышено время ожидания. Попробуйте ещё раз.`);
    }
    throw e;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
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
    throw new Error(`${label}: пустой ответ сервера (нет потока данных).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sink = createSseSink({ label, onDelta, onUsage, rawErrors });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      sink.push(decoder.decode(value, { stream: true }));
    }
    sink.push(decoder.decode());
  } catch (e) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
  return sink.finish();
}
