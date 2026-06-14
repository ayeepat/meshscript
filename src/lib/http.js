/**
 * Shared HTTP helper for AI provider calls (background service worker only).
 *
 * Adds the things every provider needs but none of them had:
 *  - a request TIMEOUT, so a hung connection surfaces as an error instead of
 *    leaving the UI stuck on "Думаю…" forever;
 *  - RETRIES with exponential backoff on transient failures (HTTP 429 and 5xx,
 *    plus network drops), so a single rate-limit blip doesn't reach the user;
 *  - FRIENDLY error messages (in Russian) for the failures a student actually
 *    hits — bad key, no credit, rate limit — instead of a raw JSON dump;
 *  - SSE STREAMING (postStream) so answers can be revealed token-by-token.
 */

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (status === 402 || (status === 400 && credit) || credit) {
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
function httpError(label, status, bodyText) {
  return new Error(friendlyMessage(label, status, extractError(bodyText)));
}

/**
 * POST a JSON body and return the parsed JSON response.
 * Throws Error(friendlyMessage) on failure.
 *
 * @param {string} url
 * @param {object} opts
 * @param {object} [opts.headers]   extra headers (Content-Type is added)
 * @param {object} opts.body        JSON-serialisable request body
 * @param {string} [opts.label]     provider name, used in error messages
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<object>}
 */
export async function postJson(url, { headers = {}, body, label = 'AI', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(timer);

      if (res.ok) return res.json();

      const text = await res.text().catch(() => '');
      // Retry only on rate-limit / transient server errors.
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        lastErr = httpError(label, res.status, text);
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw httpError(label, res.status, text);
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        lastErr = new Error(`${label}: превышено время ожидания (${Math.round(timeoutMs / 1000)} с). Попробуйте ещё раз.`);
      } else {
        lastErr = e;
      }
      // Retry timeouts and network errors; surface everything else immediately.
      if (attempt < MAX_RETRIES && (e.name === 'AbortError' || e.name === 'TypeError')) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr; // exhausted retries
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
 * @param {number} [opts.timeoutMs] idle timeout between chunks
 * @returns {Promise<string>} full message text
 */
export async function postStream(url, { headers = {}, body, label = 'AI', onDelta, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const ctrl = new AbortController();
  // Reset the idle timer on every chunk so long answers don't trip it.
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), timeoutMs); };

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
    if (e.name === 'AbortError') {
      throw new Error(`${label}: превышено время ожидания. Попробуйте ещё раз.`);
    }
    throw e;
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw httpError(label, res.status, text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bump();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines; process complete lines.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onDelta?.(delta); }
        } catch { /* keep partial frame for the next chunk */ }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return full || '(пустой ответ)';
}
