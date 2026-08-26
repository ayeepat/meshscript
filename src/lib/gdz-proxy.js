/**
 * Client for the licensed GDZ proxy (backend/src/gdz.js, POST /gdz/fetch).
 *
 * Every GDZ request used to leave the browser directly, which needed three
 * host permissions AND a `declarativeNetRequest` session rule — the rule
 * existed only to set `User-Agent: okhttp/4.9.1`, because gdz-ru.com's
 * DDoS-Guard 403s a browser UA and MV3 fetch() cannot set that header. A
 * Cloudflare Worker can, so the network hop moved server-side and the
 * extension dropped both the permission and the hosts.
 *
 * Background service worker only: it holds the license credential, and
 * lib/gdz-api.js (its only caller) is already worker-only for the same reason.
 */

import { BACKEND_URL } from './config.js';
import { getLicenseStatus } from './license.js';
import { getDeviceId } from './history.js';
import { fetchBounded } from './bounded-fetch.js';

const ENDPOINT = `${BACKEND_URL}/gdz/fetch`;

// The proxy answers JSON only. The catalog is the big one (~6.5 MB raw, and
// the Worker forwards it verbatim for the client to trim); a base64 answer
// image is ~4/3 of its byte size. This ceiling covers both with headroom and
// still bounds a hostile or wedged response.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
// Matches the Worker's own upstream ceiling plus room for its round trip, so a
// slow-but-alive GDZ surfaces as the Worker's 502 rather than a client abort
// that looks identical to being offline.
const TIMEOUT_MS = 25000;

const NEED_LICENSE =
  'Готовые ответы из ГДЗ работают по лицензии СМЭШ. ' +
  'Введите ключ доступа (SMESH-…) в настройках расширения.';

const isBackendUrl = (url) => {
  try { return new URL(url).origin === new URL(BACKEND_URL).origin; }
  catch { return false; }
};

/**
 * One round trip to the proxy.
 *
 * @param {'json'|'image'|'human'} kind which upstream shape to fetch
 * @param {string} url the gdz-ru.com (json/image) or gdz.ru (human) URL
 * @returns {Promise<object>} the proxy's payload minus its `ok` flag
 * @throws {Error} with a ready Russian sentence — callers surface it directly
 */
export async function gdzProxyFetch(kind, url) {
  // Only require that a key has been ENTERED; the server re-verifies and its
  // verdict comes back as a finished message. Mirrors askViaProxy: a stale
  // local cache must not block a user whose license is actually fine.
  const status = await getLicenseStatus();
  if (!status?.key) throw new Error(NEED_LICENSE);
  const deviceId = await getDeviceId();

  const { res, bytes } = await fetchBounded(ENDPOINT, {
    maxBytes: MAX_RESPONSE_BYTES,
    timeoutMs: TIMEOUT_MS,
    allowedUrl: isBackendUrl,
    maxRedirects: 0,
    credentials: 'omit',
    cache: 'no-store',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind,
      url,
      license_key: status.key,
      device_id: deviceId,
      activation_token: status.activation_token
    })
  });

  let payload = null;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* handled below */ }

  if (!res.ok || !payload?.ok) {
    // The proxy phrases its own failures for a student (bad license, daily cap,
    // GDZ unreachable). Prefer that text; fall back to a status only when the
    // body was unreadable, which means we never reached the handler.
    throw new Error(payload?.error?.message || `ГДЗ: сервер ответил ${res.status}.`);
  }
  return payload;
}
