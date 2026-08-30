/**
 * License-gated GDZ fetch proxy.
 *
 * WHY THIS EXISTS: gdz-ru.com (the gdz.ru mobile-app backend) sits behind
 * DDoS-Guard, which returns data only to the mobile app's `okhttp` User-Agent
 * and 403s a browser one. MV3 `fetch()` cannot set User-Agent, so the
 * extension used to install a `declarativeNetRequest` session rule to rewrite
 * the header on its own requests. That permission is the single most
 * questioned item in Chrome Web Store review, and it existed for this one
 * header. A Worker `fetch()` sets User-Agent freely, so moving the GDZ network
 * hop here lets the extension drop `declarativeNetRequest` AND all three GDZ
 * host permissions — after this, the extension makes no third-party request
 * for GDZ at all.
 *
 * The extension keeps every bit of parsing, matching, ranking and caching. Only
 * the network hop moved, so the client-side GDZ logic and its regressions are
 * unchanged.
 *
 * Route: POST /gdz/fetch  { license_key, device_id, activation_token, kind, url }
 *   kind 'json'  → the mobile API (catalog, book structure, task) → { data }
 *   kind 'image' → an answer image → { image: { mimeType, dataBase64 } }
 *   kind 'cover' → a book cover (either GDZ host) → same shape as 'image'
 *   kind 'human' → the public gdz.ru book page → { ref: { base, suffix } }
 *
 * Abuse bounds — this must never become an open GDZ scraper:
 *   1. A valid ACTIVE license, verified server-side per request, including the
 *      one-active-device activation lease (same gate as the AI proxy).
 *   2. Per-license daily request caps — GDZ_DAILY_LIMIT for lookups, and a
 *      separate GDZ_COVER_DAILY_LIMIT so browsing the textbook picker cannot
 *      spend the day's answer allowance on thumbnails.
 *   3. A server-side host allowlist. The client's own check is a UX nicety;
 *      this one is the security boundary, so it is deliberately duplicated
 *      rather than imported from the extension tree.
 *   4. Byte ceilings and a timeout on every upstream read, with redirects
 *      followed manually and re-validated hop by hop.
 *
 * The 6.5 MB catalog and the book covers are identical for every user, so both
 * use Cloudflare's Cache API. That cache is local to an edge data center: the
 * first request there warms a copy for later requests handled at the same edge.
 */

import { verifyLicense, normalizeKey } from './licenses.js';
import { readJsonBounded, readBytesBounded } from './request-body.js';
import { cleanPublicDeviceId } from './referrals.js';
import { mskDay, reserveDailyBudget, releaseDailyBudget } from './analytics.js';

// DDoS-Guard allowlists this exact User-Agent. It is the whole reason this
// module exists — see the file header.
const GDZ_API_UA = 'okhttp/4.9.1';
// The public SEO site is NOT behind the okhttp allowlist; it wants a plausible
// browser. Sending okhttp here returns the challenge page instead of the HTML
// whose exercise links we tally.
const GDZ_HUMAN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const API_BASE = 'https://gdz-ru.com';
const CATALOG_PATH = '/full-book-list';
const CATALOG_COUNTRY_ID = '1';

const MAX_REQUEST_BYTES = 4 * 1024;
const JSON_MAX_BYTES = 4 * 1024 * 1024;
const CATALOG_MAX_BYTES = 24 * 1024 * 1024;
// Mirrors MAX_STANDARD_UPLOAD_BYTES in the extension (src/lib/upload-limits.js):
// the client re-checks this after decoding, so anything larger would be
// fetched, base64-encoded to ~4/3 its size, shipped, and only then thrown away.
// Reject it here instead. Keep the two in step if that constant moves.
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
const HUMAN_PAGE_MAX_BYTES = 3 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 3;

// Per-edge copy of the book catalog. A week matches the extension's own catalog
// TTL, so a client that expires its copy usually finds a warm local edge entry.
const CATALOG_CACHE_TTL_S = 7 * 24 * 60 * 60;
// Cover art for a published textbook does not change. A month keeps the picker
// instant without pinning stale art forever.
const COVER_CACHE_TTL_S = 30 * 24 * 60 * 60;

const DEFAULT_GDZ_DAILY_LIMIT = 600;
// Covers get their OWN budget. They are decorative thumbnails in the textbook
// picker and a student browsing the catalog renders dozens of them per search —
// on a shared counter that browsing would quietly eat the day's answer
// allowance and leave «Решить» with no ГДЗ. Separate bucket, larger cap.
const DEFAULT_GDZ_COVER_DAILY_LIMIT = 2000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const UNAVAILABLE = 'Не удалось получить готовые ответы. Попробуйте позже.';
const NEED_LICENSE =
  'Готовые ответы из ГДЗ работают по лицензии СМЭШ. Введите ключ доступа (SMESH-…) в настройках расширения.';
const NEED_DEVICE_ID =
  'Не удалось подтвердить устройство. Обновите расширение СМЭШ AI до последней версии и попробуйте снова.';
const OVER_LIMIT = 'Слишком много запросов к ГДЗ за сегодня. Счётчик сбросится завтра.';

const LICENSE_ERRORS = {
  not_found: 'Ключ лицензии не найден. Проверьте его в настройках расширения.',
  expired: 'Срок действия лицензии истёк. Продлите её, чтобы пользоваться готовыми ответами.',
  revoked: 'Эта лицензия была отозвана. Напишите в поддержку.',
  device_in_use: 'Ключ уже используется на другом устройстве. Сначала деактивируйте его там.',
  device_limit: 'Ключ уже используется на другом устройстве. Сначала деактивируйте его там.',
  bad_activation: 'Не удалось подтвердить активацию. Деактивируйте ключ на первом устройстве или напишите в поддержку.',
  activation_mismatch: 'Ключ активирован на другом устройстве. Сначала деактивируйте его там.',
  bad_device: NEED_DEVICE_ID
};

const errResponse = (status, message) => new Response(
  JSON.stringify({ ok: false, error: { message } }),
  { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } }
);

const okResponse = (body) => new Response(
  JSON.stringify({ ok: true, ...body }),
  { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } }
);

function licenseErrorMessage(reason) {
  return (typeof reason === 'string' && Object.hasOwn(LICENSE_ERRORS, reason)
    ? LICENSE_ERRORS[reason]
    : '') || NEED_LICENSE;
}

/* ---------- Host allowlist (security boundary — do not import the client's) ---------- */

/**
 * Mirrors src/lib/gdz-hosts.js. Same policy, restated server-side because the
 * client's copy is advisory: a scripted caller can send whatever it likes, so
 * the value that reaches `fetch()` has to be re-derived from a trusted rule.
 *
 * HTTPS only; the exact registrable host or a real subdomain label under it
 * (`img.gdz-ru.com` yes, `evilgdz-ru.com` and `gdz-ru.com.evil.com` no); no
 * embedded credentials; no non-default port. Anything invalid fails closed.
 */
function allowedHttpsUrl(value, baseHost) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:') return '';
    if (parsed.username || parsed.password || parsed.port) return '';
    const host = parsed.hostname;
    if (host !== baseHost && !host.endsWith(`.${baseHost}`)) return '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

const gdzApiUrl = (value) => allowedHttpsUrl(value, 'gdz-ru.com');
const gdzHumanUrl = (value) => allowedHttpsUrl(value, 'gdz.ru');
// Book covers are the one asset the catalog serves from either host.
const gdzCoverUrl = (value) => gdzApiUrl(value) || gdzHumanUrl(value);

/* ---------- Bounded upstream fetch ---------- */

/**
 * Fetch with a byte ceiling, a hard timeout, and manual redirect handling so
 * every hop is re-validated against the allowlist. `redirect: 'manual'` is what
 * makes the re-validation possible: automatic following would let a 302 walk
 * off the allowed host before we ever see the final URL.
 *
 * @returns {Promise<{ok:true,status:number,url:string,contentType:string,bytes:Uint8Array}
 *                  |{ok:false,reason:string}>}
 */
async function fetchUpstream(startUrl, { userAgent, maxBytes, allow, accept }) {
  let current = allow(startUrl);
  if (!current) return { ok: false, reason: 'bad_host' };

  const controller = new AbortController();
  // gdz-ru.com can hold a connection open without ever answering. Without this
  // the Worker invocation would sit on it until the platform kills it, and the
  // student would watch an empty chat the whole time.
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res;
      try {
        res = await fetch(current, {
          method: 'GET',
          headers: { 'User-Agent': userAgent, Accept: accept },
          redirect: 'manual',
          signal: controller.signal
        });
      } catch {
        return { ok: false, reason: 'network' };
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location') || '';
        if (!location) return { ok: false, reason: 'bad_redirect' };
        let next;
        try { next = new URL(location, current).href; } catch { return { ok: false, reason: 'bad_redirect' }; }
        const validated = allow(next);
        if (!validated) return { ok: false, reason: 'redirect_off_allowlist' };
        current = validated;
        continue;
      }

      if (!res.ok) return { ok: false, reason: `status_${res.status}`, status: res.status };

      const read = await readBytesBounded(res, maxBytes);
      if (!read.ok) return { ok: false, reason: read.reason };
      return {
        ok: true,
        status: res.status,
        url: current,
        contentType: (res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase(),
        bytes: read.bytes
      };
    }
    return { ok: false, reason: 'too_many_redirects' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- kind: json ---------- */

/**
 * Is this THE book catalog — the one large, user-independent document worth a
 * 24 MB ceiling and an edge-cache entry?
 *
 * Exact origin, pathname and query. Pathname alone was a hole: `gdzApiUrl`
 * accepts subdomains, and accepting arbitrary query strings would let a
 * scripted licensed caller create hundreds of distinct 24 MB cache entries.
 * The extension requests one representation, so only that representation gets
 * the larger ceiling and the edge-cache path.
 */
function isCatalogUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === API_BASE && parsed.pathname === CATALOG_PATH &&
      parsed.search === `?country_id=${CATALOG_COUNTRY_ID}`;
  } catch { return false; }
}

async function fetchGdzJson(url, ctx) {
  const isCatalog = isCatalogUrl(url);
  const maxBytes = isCatalog ? CATALOG_MAX_BYTES : JSON_MAX_BYTES;

  // Shared edge copy for the catalog only. Everything else is per-book and
  // caching it would trade a large key space for a tiny hit rate.
  // `caches` exists in the Workers runtime but not under plain Node, where this
  // module is imported by regressions — degrade to an uncached fetch rather
  // than throwing a ReferenceError that would surface as a bogus 503.
  const cache = isCatalog && typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = cache ? new Request(url, { method: 'GET' }) : null;
  if (cache) {
    let hit = null;
    try { hit = await cache.match(cacheKey); }
    catch { /* cache is an optimization; use the live upstream */ }
    if (hit) {
      const parsed = await readJsonBounded(hit, maxBytes);
      if (parsed.ok) return { ok: true, data: parsed.value };
      // A corrupt or truncated entry must not poison the week. Fall through to
      // a live fetch, which overwrites it below.
    }
  }

  const res = await fetchUpstream(url, {
    userAgent: GDZ_API_UA,
    maxBytes,
    allow: gdzApiUrl,
    accept: 'application/json'
  });
  if (!res.ok) return res;

  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(res.bytes));
  } catch {
    // A 200 carrying HTML means DDoS-Guard served a challenge page instead of
    // data — i.e. the User-Agent above stopped being accepted.
    return { ok: false, reason: 'not_json' };
  }

  if (cache) {
    // Behind waitUntil: writing several megabytes to the edge cache must not
    // sit between the student and their answer. If the invocation ends first
    // the next request simply re-fetches.
    let write;
    try {
      write = cache.put(cacheKey, new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CATALOG_CACHE_TTL_S}`
        }
      })).catch(() => { /* caching is an optimization, never a failure mode */ });
    } catch {
      write = Promise.resolve();
    }
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }
  return { ok: true, data };
}

/* ---------- kind: image ---------- */

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Chunked: a one-shot String.fromCharCode over a multi-megabyte JPEG blows the
// stack (same reason the extension chunks its own encoder).
function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * @param {string} url
 * @param {boolean} cover true for a book cover, which may sit on EITHER GDZ
 *   host; answer images only ever come from the mobile API host.
 */
async function fetchGdzImage(url, cover = false, ctx = null) {
  // Covers are public, immutable and identical for every student, so the first
  // request at an edge data center warms a copy for later requests there.
  // Answer images are equally cacheable in principle but their key space is
  // the whole of GDZ; left uncached deliberately rather than churning the cache.
  const cache = cover && typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = cache ? new Request(url, { method: 'GET' }) : null;
  if (cache) {
    let hit = null;
    try { hit = await cache.match(cacheKey); }
    catch { /* cache is an optimization; use the live upstream */ }
    if (hit) {
      const read = await readBytesBounded(hit, IMAGE_MAX_BYTES);
      const mimeType = (hit.headers.get('content-type') || '').toLowerCase();
      if (read.ok && IMAGE_TYPES.has(mimeType)) {
        return { ok: true, image: { mimeType, dataBase64: bytesToBase64(read.bytes), sourceUrl: url } };
      }
      // Corrupt entry: fall through and overwrite it below.
    }
  }

  const onApiHost = !!gdzApiUrl(url);
  const res = await fetchUpstream(url, {
    // The okhttp allowlist is a gdz-ru.com thing; a cover served from the
    // public site needs the browser UA the SEO pages expect.
    userAgent: onApiHost ? GDZ_API_UA : GDZ_HUMAN_UA,
    maxBytes: IMAGE_MAX_BYTES,
    allow: cover ? gdzCoverUrl : gdzApiUrl,
    accept: 'image/*'
  });
  if (!res.ok) return res;
  // DDoS-Guard and misrouted redirects can still answer 200 with HTML. The
  // extension re-checks the type AND the container dimensions after decoding
  // the base64 (see gdz-api.js), so this is the outer of two gates, not the
  // only one.
  if (!IMAGE_TYPES.has(res.contentType)) return { ok: false, reason: 'not_image' };

  if (cache) {
    let write;
    try {
      write = cache.put(cacheKey, new Response(res.bytes, {
        headers: {
          'Content-Type': res.contentType,
          'Cache-Control': `public, max-age=${COVER_CACHE_TTL_S}`
        }
      })).catch(() => { /* caching is an optimization, never a failure mode */ });
    } catch {
      write = Promise.resolve();
    }
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }

  return {
    ok: true,
    image: { mimeType: res.contentType, dataBase64: bytesToBase64(res.bytes), sourceUrl: res.url }
  };
}

/* ---------- kind: human ---------- */

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Derive the public gdz.ru link template for a book.
 *
 * The mobile-API path is not the human path: it 301s to the book page and
 * carries no exercise. The human exercise URL is `{canonicalBook}{N}-{suffix}/`
 * where the suffix is per-book ("-task", "-nom", "-item"…). Fetch the book page
 * once, take the canonical base from the redirect chain, and tally
 * `{base}{digits}-{letters}/` links — the most common suffix is the book's main
 * numbered exercise series.
 *
 * Moved here from the extension along with the fetch: shipping 3 MB of HTML to
 * the client just to run this regex would cost far more than the ~20 bytes the
 * answer actually is.
 */
async function fetchGdzHumanRef(url) {
  const res = await fetchUpstream(url, {
    userAgent: GDZ_HUMAN_UA,
    maxBytes: HUMAN_PAGE_MAX_BYTES,
    allow: gdzHumanUrl,
    accept: 'text/html'
  });
  // A transport/status failure is not a verdict about this book. Propagate it
  // so the route refunds the reserved slot and the client does not cache an
  // outage as "no exact exercise link" for seven days.
  if (!res.ok) return res;

  const base = res.url.endsWith('/') ? res.url : `${res.url}/`;
  const parsed = new URL(base);
  const relative = `${parsed.pathname}${parsed.search}`;
  const html = new TextDecoder().decode(res.bytes);

  const pattern = new RegExp(`href="${escapeRe(relative)}(\\d+)-([a-z]+)/"`, 'gi');
  const counts = new Map();
  let match;
  while ((match = pattern.exec(html))) {
    const suffix = match[2];
    counts.set(suffix, (counts.get(suffix) || 0) + 1);
  }
  let suffix = null;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best) { best = count; suffix = candidate; }
  }
  return { ok: true, ref: { base, suffix } };
}

/* ---------- Route ---------- */

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Covers are metered separately from everything else — see
// DEFAULT_GDZ_COVER_DAILY_LIMIT for why.
function budgetFor(env, kind) {
  return kind === 'cover'
    ? { scope: 'gdz_cover', limit: positiveInt(env.GDZ_COVER_DAILY_LIMIT, DEFAULT_GDZ_COVER_DAILY_LIMIT) }
    : { scope: 'gdz', limit: positiveInt(env.GDZ_DAILY_LIMIT, DEFAULT_GDZ_DAILY_LIMIT) };
}

/**
 * Bucket a license into the shared daily-budget table without storing the key.
 *
 * `proxy_quota` holds raw keys by design, but `telemetry_budget` is the
 * privacy-minimized side of the schema — the same table the deletion endpoint
 * and the retention sweep reason about. A stable SHA-256 gives an identical
 * per-license bucket with nothing reversible at rest.
 */
async function licenseBudgetKey(licenseKey) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(licenseKey));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Did GDZ fail us, or did the caller pick a request that could only fail? Only
// the former refunds the reserved slot. `network` is a thrown fetch; a 5xx/429
// is upstream refusing to serve. Content-validation failures (`not_json`,
// `not_image`) and 4xx statuses carry no such proof and are not credited back.
function isUpstreamOutage(result) {
  if (result?.reason === 'network') return true;
  const status = Number(result?.status);
  return Number.isInteger(status) && (status === 429 || status >= 500);
}

export async function handleGdzFetch(request, env, ctx) {
  try {
    return await handleGdzFetchInner(request, env, ctx);
  } catch (e) {
    console.error('gdz-proxy: unexpected error', e?.stack || String(e));
    return errResponse(503, UNAVAILABLE);
  }
}

async function handleGdzFetchInner(request, env, ctx) {
  // Without D1 there is no per-license cap, and an uncapped proxy is exactly
  // what this route must never be. Fail closed like the AI proxy does.
  if (!env.DB) {
    console.error('gdz-proxy: D1 binding missing — refusing to serve without a request cap');
    return errResponse(503, UNAVAILABLE);
  }

  const parsed = await readJsonBounded(request, MAX_REQUEST_BYTES);
  if (!parsed.ok) return errResponse(parsed.status === 413 ? 413 : 400, 'Некорректный запрос.');
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errResponse(400, 'Некорректный запрос.');
  }

  const licenseKey = normalizeKey(typeof body.license_key === 'string' ? body.license_key : '');
  const deviceId = cleanPublicDeviceId(body.device_id);
  const activationToken = typeof body.activation_token === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(body.activation_token) ? body.activation_token : '';
  if (!licenseKey) return errResponse(403, NEED_LICENSE);
  if (!deviceId || !activationToken) return errResponse(403, NEED_DEVICE_ID);

  const kind = body.kind;
  const ALLOW_BY_KIND = { json: gdzApiUrl, image: gdzApiUrl, cover: gdzCoverUrl, human: gdzHumanUrl };
  if (!Object.hasOwn(ALLOW_BY_KIND, kind)) return errResponse(400, 'Некорректный запрос.');
  // Validate the URL against the allowlist for THIS kind before spending a
  // license verification on a request that can never be served.
  const url = ALLOW_BY_KIND[kind](body.url);
  if (!url) return errResponse(400, 'Некорректный адрес ГДЗ.');

  const verdict = await verifyLicense(env, licenseKey, deviceId, activationToken);
  if (!verdict.ok) {
    if (verdict.reason === 'service_unavailable') return errResponse(503, UNAVAILABLE);
    return errResponse(403, licenseErrorMessage(verdict.reason));
  }

  const { scope, limit } = budgetFor(env, kind);
  const day = mskDay();
  const budgetKey = await licenseBudgetKey(licenseKey);
  const used = await reserveDailyBudget(env, day, scope, budgetKey, 1, limit);
  if (used > limit) return errResponse(429, OVER_LIMIT);

  let result;
  try {
    result = kind === 'json' ? await fetchGdzJson(url, ctx)
      : kind === 'human' ? await fetchGdzHumanRef(url)
        : await fetchGdzImage(url, kind === 'cover', ctx);
  } catch (error) {
    // Exceptions after admission (Cache API failure, encoding/runtime error)
    // must follow the same accounting rule as an ordinary upstream failure.
    // Otherwise one platform incident can consume the entire daily allowance.
    await releaseDailyBudget(env, day, scope, budgetKey, 1).catch(() => {});
    throw error;
  }

  if (!result.ok) {
    // Give the slot back for a genuine GDZ outage: the cap exists to stop
    // scraping, not to burn a student's whole day of ГДЗ lookups on requests
    // that returned nothing. Best-effort: a failed release leaves it spent.
    //
    // Only an outage, though. Every other failure here is CALLER-SELECTABLE —
    // aim `image` at an HTML page (`not_image`), point `json` at a challenge
    // page (`not_json`), pick a path that 404s, or use a URL that redirects off
    // the allowlist — and refunding those made each one a free upstream fetch.
    // That is an uncapped proxy reachable with one licence key, i.e. exactly
    // what this route must never become. Mirrors the AI proxy's discipline of
    // classifying a failure before crediting it back (isNonBillableRejection).
    if (isUpstreamOutage(result)) {
      await releaseDailyBudget(env, day, scope, budgetKey, 1).catch(() => {});
    }
    // Upstream detail goes to `wrangler tail`, never to the student: the reason
    // strings name hosts and status codes that mean nothing to them and would
    // only make a transient GDZ hiccup look like a broken license.
    console.error('gdz-proxy: upstream failure', kind, result.reason || 'unknown');
    return errResponse(502, UNAVAILABLE);
  }

  const { ok: _ok, ...payload } = result;
  return okResponse(payload);
}

// Exported for regressions: the allowlist is the security boundary of this
// module, and it must be testable without standing up a Worker.
export const __test = {
  gdzApiUrl, gdzHumanUrl, gdzCoverUrl, isCatalogUrl, fetchUpstream, fetchGdzHumanRef,
  GDZ_API_UA, GDZ_HUMAN_UA
};
