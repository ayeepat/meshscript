/**
 * GDZ (gdz-ru.com) API client. Network operations run ONLY in the background
 * service worker; normalizeGdzApiUrl is the pure helper shared with Settings.
 *
 * The host is the gdz.ru mobile-app backend (NOT the public gdz.ru website,
 * which sits behind a JS challenge). DDoS-Guard allowlists the User-Agent:
 * only an okhttp UA returns 200; a browser UA gets 403. MV3 fetch() cannot
 * set User-Agent, so a session declarativeNetRequest rule scoped to this
 * extension rewrites the UA on its own gdz-ru.com requests.
 *
 * Public surface:
 *   - getCatalog()           : trimmed { books, subjects, classes } (cached)
 *   - searchBooks(opts)      : grade + subject + subtype + free-text query
 *   - listTasks(bookUrl)     : flatten the book structure to {section, num, url}
 *   - resolveTask(bookUrl, n): find a task by exercise number, return its images
 *
 * Everything is client-side after the catalog fetch — zero AI cost. Resolved
 * tasks are cached per (bookUrl, n) so re-opens are free.
 */

import { parseRefs } from './gdz-match.js';
import { fetchBounded } from './bounded-fetch.js';
import { buildGdzUaRule, GDZ_UA_RULE_ID } from './gdz-ua-rule.js';
import { isGdzApiUrl, isGdzHumanUrl } from './gdz-hosts.js';
import { MAX_STANDARD_UPLOAD_BYTES } from './upload-limits.js';
import { imageDimensions } from './image-compress.js';

const BASE = 'https://gdz-ru.com';
const CATALOG_PATH = '/full-book-list?country_id=1';

/**
 * Canonical representation for every mobile-API book/task URL that crosses an
 * extension boundary or enters a cache: one absolute URL on the exact API
 * origin. The live catalog and older storage may contain root-relative paths;
 * accepting both here keeps those installs readable without ever concatenating
 * BASE onto a value that is already absolute.
 *
 * Invalid and foreign-origin values fail closed with an empty string so the
 * same helper can be used by message validators as well as fetch callers.
 */
export function normalizeGdzApiUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const input = value.trim();
    // The API emits root-relative paths. Reject ambiguous bare relatives such
    // as "gdz.ru/book" instead of silently turning them into an API pathname.
    const parsed = input.startsWith('/') ? new URL(input, `${BASE}/`) : new URL(input);
    parsed.hash = '';
    return parsed.origin === BASE && isGdzApiUrl(parsed.href) ? parsed.href : '';
  } catch {
    return '';
  }
}

function requireGdzApiUrl(value) {
  const url = normalizeGdzApiUrl(value);
  if (!url) throw new Error('GDZ: invalid API URL');
  return url;
}

function gdzApiPath(value) {
  const parsed = new URL(requireGdzApiUrl(value));
  return `${parsed.pathname}${parsed.search}`;
}

// 7-day catalog TTL: the book list grows slowly (new editions are rare). A
// week is short enough to pick up new books, long enough that the 6.5 MB
// payload is fetched ~once.
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_KEY = 'gdzCatalog';
const TASK_CACHE_KEY = 'gdzTaskCache';
const TASK_CACHE_MAX = 200; // LRU-ish cap on resolved tasks
export const GDZ_MAX_STRUCTURE_NODES = 20000;
export const GDZ_MAX_TASKS = 10000;

// The public human site. Its URL scheme differs entirely from the mobile API
// (BASE), and the API never exposes a human link, so we derive one per book.
const HUMAN = 'https://gdz.ru';
const HUMAN_REF_KEY = 'gdzHumanRefs';                  // storage.local: bookUrl -> {base,suffix,at}
const HUMAN_REF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const humanRefCache = new Map();                        // in-mem: bookUrl -> {base,suffix}

// The human-reference cache is one storage.local object, so each prune + add is
// a read-modify-write transaction. Re-read it behind a per-worker queue to keep
// concurrent book resolutions from committing stale snapshots over each other.
// Keep a recovered tail for later writes, but return the original operation so
// this helper preserves the previous caller-visible storage failure behavior.
let humanRefCacheWrite = Promise.resolve();
function updateHumanRefCache(canonicalBookUrl, ref) {
  const write = humanRefCacheWrite.then(async () => {
    const { [HUMAN_REF_KEY]: store = {} } = await chrome.storage.local.get(HUMAN_REF_KEY);
    const now = Date.now();
    const fresh = {};
    for (const [key, entry] of Object.entries(store)) {
      if (entry && Number.isFinite(entry.at) && now - entry.at < HUMAN_REF_TTL_MS) {
        fresh[key] = entry;
      }
    }
    fresh[canonicalBookUrl] = { base: ref.base, suffix: ref.suffix, at: now };
    await chrome.storage.local.set({ [HUMAN_REF_KEY]: fresh });
  });
  humanRefCacheWrite = write.catch(() => {});
  return write;
}

// In-flight catalog promise: dedupe concurrent cold loads so the 6.5 MB list
// is fetched once even if the picker fires several searches at startup.
let catalogInFlight = null;
// Per-book flattened task lists, in memory only (the service worker may be torn
// down — that's fine, it's a cache). Resolving several exercises from one book
// then costs a single structure fetch instead of one per exercise.
const taskListCache = new Map(); // bookUrl -> { tasks, at }
const TASK_LIST_TTL_MS = 30 * 60 * 1000;

/* ---------- HTTP ---------- */

// gdz-ru.com sits behind DDoS-Guard and can stall a connection open without
// ever responding. A bare fetch() then hangs forever — and because the GDZ
// lookup gates the dashboard's AI solve, that hang would strand the user on a
// blank chat. Abort every GDZ request after a fixed ceiling so a wedged
// connection surfaces as a throw (caller falls back to the AI / skips the image).
const FETCH_TIMEOUT_MS = 15000;
const JSON_MAX_BYTES = 4 * 1024 * 1024;
const CATALOG_MAX_BYTES = 24 * 1024 * 1024;
const HUMAN_PAGE_MAX_BYTES = 3 * 1024 * 1024;
export const GDZ_IMAGE_MAX_PIXELS = 25_000_000;
const GDZ_IMAGE_MAX_SIDE = 12_000;

/**
 * editions[].images is third-party data, so fanout is bounded before any fetch
 * loop. Real multi-page answers are a handful of scans; dozens indicate a
 * malformed or hostile task payload.
 */
export const MAX_ANSWER_IMAGES = 8;

// Session rules vanish on browser restart. This promise is memoized only for
// the current service-worker lifetime, so every new worker registers it again.
let uaRulePromise = null;
function ensureUaRule() {
  if (!uaRulePromise) {
    uaRulePromise = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [GDZ_UA_RULE_ID],
      addRules: [buildGdzUaRule(chrome.runtime.id)]
    }).catch((error) => {
      uaRulePromise = null;
      throw error;
    });
  }
  return uaRulePromise;
}

// API requests rely on the DNR rule to rewrite User-Agent. We don't set it
// directly (and can't — it's a forbidden header).
async function getJson(url, { maxBytes = JSON_MAX_BYTES } = {}) {
  await ensureUaRule();
  const { res, bytes } = await fetchBounded(url, {
    maxBytes,
    timeoutMs: FETCH_TIMEOUT_MS,
    allowedUrl: isGdzApiUrl,
    maxRedirects: 3,
    credentials: 'omit',
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`GDZ ${res.status} ${url}`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // A 200 with a non-JSON (HTML) body means DDoS-Guard served a challenge
    // page instead of data — almost always the UA-rewrite rule didn't apply.
    throw new Error('GDZ: ответ не JSON — правило подмены User-Agent не сработало.');
  }
}

function nameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'gdz-answer.jpg'; }
  catch { return 'gdz-answer.jpg'; }
}

async function getBlobAsBase64(url) {
  await ensureUaRule();
  // Name the host on failure. Answer images may be served from a different
  // gdz-ru.com host than the API; if that host is missing from host_permissions
  // (network fail) or from the DNR UA rule (403), the error must say WHICH host
  // so GDZ_SELFTEST points right at the manifest/rule fix instead of failing
  // silently.
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw url */ }
  if (!isGdzApiUrl(url)) throw new Error(`GDZ image: bad host ${host}`);
  let res, bytes;
  try {
    ({ res, bytes } = await fetchBounded(url, {
      maxBytes: MAX_STANDARD_UPLOAD_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      allowedUrl: isGdzApiUrl,
      maxRedirects: 3,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'manual'
    }));
  } catch (e) {
    throw new Error(`GDZ image: network fail for ${host} (missing host permission or UA rule?) — ${e}`);
  }
  if (!res.ok) throw new Error(`GDZ image ${res.status} ${host}`);
  let finalHost = res.url;
  try { finalHost = new URL(res.url).host; } catch { /* error names the raw final URL */ }
  if (!isGdzApiUrl(res.url)) throw new Error(`GDZ image: redirect left allowlist for ${finalHost}`);
  const mimeType = (res.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  // DDoS-Guard and off-origin redirects can still return 200 HTML. Only real
  // images may cross into the dashboard as inline attachments.
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
    throw new Error(`GDZ image: unsupported content type from ${finalHost}`);
  }
  // Unlike the general upload compressor (which is fail-open), GDZ is a remote
  // trust boundary. Require parseable container dimensions and reject before
  // any decoder/model sees a decompression bomb.
  const dimensions = imageDimensions(bytes);
  if (!dimensions || dimensions.w < 1 || dimensions.h < 1 ||
      dimensions.w * dimensions.h > GDZ_IMAGE_MAX_PIXELS ||
      Math.max(dimensions.w, dimensions.h) > GDZ_IMAGE_MAX_SIDE) {
    throw new Error(`GDZ image: unsafe dimensions from ${finalHost}`);
  }
  // Shape matches the rest of the codebase's inline-file objects {mimeType,
  // dataBase64, name} so a resolved answer can be attached like any upload.
  return {
    mimeType,
    dataBase64: abToBase64(bytes),
    name: nameFromUrl(res.url)
  };
}

// Chunked btoa: a one-shot String.fromCharCode on a multi-megabyte JPEG
// blows the JS stack.
function abToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/* ---------- Catalog ---------- */

// Keep only the fields the picker + matcher use. The raw payload is ~6.5 MB
// (descriptions, marketing keywords, multiple author transliterations); the
// trimmed version is a fraction of that and still has everything we need.
function trimBook(b) {
  const url = normalizeGdzApiUrl(b.url);
  if (!url) return null;
  return {
    id: b.id,
    title: b.title,
    breadcrumb: b.breadcrumb,             // short author/series label for the picker
    subject_id: b.subject_id,
    classes: b.classes || [],
    year: b.year,
    authors: b.authors || [],
    publisher: b.publisher,
    subtype: b.subtype,                   // Учебник / Рабочая тетрадь / ...
    study_level: b.study_level || '',     // Базовый / Углублённый (decisive!)
    cover_url: (b.cover && b.cover.url) || b.cover_url || '',
    url,
    priority: b.priority || 0,
    is_paid: !!b.is_paid,                 // some books are paywalled — let the picker flag them
    search_keywords: b.search_keywords || ''
  };
}

function trimCatalog(raw) {
  return {
    fetchedAt: Date.now(),
    subjects: (raw.subjects || []).map((s) => ({ id: s.id, title: s.title })),
    classes: (raw.classes || []).map((c) => ({ id: c.id, title: c.title })),
    books: (raw.books || []).map(trimBook).filter(Boolean)
  };
}

// Catalogs fetched before canonical URLs were introduced remain cached for up
// to seven days. Normalize that legacy payload on every read so users do not
// have to wait for expiry (or manually clear extension storage) before add and
// resolve start working.
function normalizeCatalogUrls(catalog) {
  return {
    ...catalog,
    books: (catalog.books || []).map((book) => {
      const url = normalizeGdzApiUrl(book?.url);
      return url ? { ...book, url } : null;
    }).filter(Boolean)
  };
}

export async function getCatalog({ force = false } = {}) {
  if (!force) {
    const { [CATALOG_KEY]: cached } = await chrome.storage.local.get(CATALOG_KEY);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return normalizeCatalogUrls(cached);
  }
  if (catalogInFlight) return catalogInFlight; // a load is already running — join it
  catalogInFlight = (async () => {
    const raw = await getJson(BASE + CATALOG_PATH, { maxBytes: CATALOG_MAX_BYTES });
    if (!raw || raw.success === false) throw new Error('GDZ catalog: bad payload');
    const trimmed = trimCatalog(raw);
    await chrome.storage.local.set({ [CATALOG_KEY]: trimmed });
    return trimmed;
  })();
  try { return await catalogInFlight; }
  finally { catalogInFlight = null; }
}

/* ---------- Search ---------- */

/**
 * Filter the catalog. All inputs are optional.
 * - grade: clamp to books that contain that grade (multi-grade books like
 *   Атанасян 7–9 match for 7, 8, AND 9 automatically).
 * - subjectId: a single subject; null/''/'all' browses every subject for the grade.
 * - subtype: default to "Учебник"; pass null/'' to skip the filter (Учебник + тетради).
 * - query: space-separated tokens, all must appear in search_keywords (case-
 *   insensitive). Empty → returns everything that passes the other filters.
 *
 * Ranked by the catalog's `priority` field so the popular default sits up top.
 */
export function searchBooks(catalog, { grade, subjectId, subtype = 'Учебник', query = '' }) {
  // Coerce types: the settings <select> yields a STRING grade, but catalog
  // `classes` are numbers — [9].includes("9") is false, so without this every
  // search would silently return nothing.
  const g = (grade == null || grade === '') ? null : Number(grade);
  // null / '' / 'all' → browse every subject for the grade (no subject filter).
  const sid = (subjectId == null || subjectId === '' || subjectId === 'all') ? null : Number(subjectId);
  const st = (subtype === '' ) ? null : subtype;
  const q = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  return (catalog.books || [])
    .map((book) => {
      const url = normalizeGdzApiUrl(book?.url);
      return url ? { ...book, url } : null;
    })
    .filter(Boolean)
    .filter((b) =>
      (sid == null || Number.isNaN(sid) || b.subject_id === sid) &&
      (g == null || Number.isNaN(g) || (b.classes || []).includes(g)) &&
      (st == null || b.subtype === st) &&
      q.every((tok) => (b.search_keywords || '').toLowerCase().includes(tok))
    )
    // Free books first — paid ones return NO answer images via the API (the
    // paywall is enforced server-side), so a paid pick can never show pictures.
    // Then by the catalog's own popularity ranking.
    .sort((a, b) => (a.is_paid ? 1 : 0) - (b.is_paid ? 1 : 0) || (b.priority || 0) - (a.priority || 0));
}

/* ---------- Resolve ---------- */

// Walk the nested structure → topics → tasks tree the API returns, into a flat
// list of {section, num, url}. Section is the human label of the topic the
// task lives under ("упражнение", "вопросы и задания" — see live data); it's
// useful when a book has multiple parallel numberings (e.g. exercises vs.
// review questions) and we need to disambiguate later.
function flattenTasks(structure) {
  const out = [];
  // Third-party JSON can be deeply nested. Use an explicit bounded stack so a
  // pathological book cannot overflow the worker stack or create an enormous
  // task cache. Reverse-push preserves the API's original display order.
  const roots = Array.isArray(structure) ? structure : [];
  const stack = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push({ node: roots[i], parentSec: '' });
  let visited = 0;
  while (stack.length) {
    const { node, parentSec } = stack.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    visited++;
    if (visited > GDZ_MAX_STRUCTURE_NODES) throw new Error('GDZ: структура учебника слишком большая.');
    const sec = String(node.title_short || node.title || parentSec || '').trim().slice(0, 512);
    const tasks = Array.isArray(node.tasks) ? node.tasks : [];
    for (const task of tasks) {
      if (!task || typeof task !== 'object') continue;
      const url = normalizeGdzApiUrl(task.url);
      if (!url) continue;
      if (out.length >= GDZ_MAX_TASKS) throw new Error('GDZ: в учебнике слишком много заданий.');
      out.push({ section: sec, num: String(task.title ?? '').trim().slice(0, 256), url });
    }
    const topics = Array.isArray(node.topics) ? node.topics : [];
    for (let i = topics.length - 1; i >= 0; i--) stack.push({ node: topics[i], parentSec: sec });
  }
  return out;
}

export async function listTasks(bookUrl) {
  const canonicalBookUrl = requireGdzApiUrl(bookUrl);
  const hit = taskListCache.get(canonicalBookUrl);
  if (hit && Date.now() - hit.at < TASK_LIST_TTL_MS) return hit.tasks;
  const data = await getJson(canonicalBookUrl);
  const tasks = flattenTasks(data.structure);
  taskListCache.set(canonicalBookUrl, { tasks, at: Date.now() });
  return tasks;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Serialise resolved-task cache writes. The cache is a single storage.local
// object; two concurrent resolves doing read-modify-write would clobber each
// other's entries. Chain every write behind the previous one and re-read the
// latest cache inside the chain so merges never lose an entry.
let taskCacheWrite = Promise.resolve();
function updateTaskCache(cacheKey, result) {
  taskCacheWrite = taskCacheWrite.then(async () => {
    const { [TASK_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(TASK_CACHE_KEY);
    cache[cacheKey] = { v: result, at: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > TASK_CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - TASK_CACHE_MAX)) delete cache[k];
    }
    await chrome.storage.local.set({ [TASK_CACHE_KEY]: cache });
  }).catch(() => { /* cache write is best-effort — never fail the resolve */ });
  return taskCacheWrite;
}

/**
 * Derive a human gdz.ru link template for a book. The mobile-API path scheme
 * (BASE + "/po-algebre/…") is NOT the human scheme and carries no exercise: it
 * 301-redirects to the book page, so a naive `HUMAN + task.url` only ever lands
 * on the book. The human exercise URL is `{canonicalBook}{N}-{suffix}/`, where
 * the suffix is per-book ("-task", "-nom", "-item"…). We fetch the book page
 * once, take the canonical base from the redirect and the *dominant* one-number
 * link suffix (= the book's main numbered exercises), and cache the pair so
 * every exercise link is then a string concat.
 *
 * gdz.ru keeps the real browser UA (the DNR rule rewrites only gdz-ru.com),
 * which is what passes DDoS-Guard for these SEO pages.
 *
 * @returns {Promise<{base:string|null, suffix:string|null}>} base may be set
 *   without a suffix (link to the book); both null on network/challenge failure.
 */
async function resolveHumanRef(bookUrl) {
  const canonicalBookUrl = requireGdzApiUrl(bookUrl);
  const legacyBookPath = gdzApiPath(canonicalBookUrl);
  if (humanRefCache.has(canonicalBookUrl)) return humanRefCache.get(canonicalBookUrl);
  const { [HUMAN_REF_KEY]: store = {} } = await chrome.storage.local.get(HUMAN_REF_KEY);
  const cached = store[canonicalBookUrl] || store[legacyBookPath];
  if (cached && Date.now() - cached.at < HUMAN_REF_TTL_MS) {
    const ref = { base: cached.base, suffix: cached.suffix };
    humanRefCache.set(canonicalBookUrl, ref);
    return ref;
  }

  const ref = { base: null, suffix: null };
  try {
    const { res, bytes } = await fetchBounded(new URL(legacyBookPath, HUMAN).href, {
      maxBytes: HUMAN_PAGE_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      allowedUrl: isGdzHumanUrl,
      maxRedirects: 3,
      credentials: 'omit',
      redirect: 'manual'
    });
    if (res.ok && isGdzHumanUrl(res.url)) {
      ref.base = res.url.endsWith('/') ? res.url : res.url + '/';   // canonical book page
      const relUrl = new URL(ref.base);
      const rel = `${relUrl.pathname}${relUrl.search}`;
      const html = new TextDecoder().decode(bytes);
      // Tally `{base}{digits}-{letters}/` links; the most common suffix is the
      // book's main exercise numbering (Виленкин "-nom", Макарычев "-task"…).
      const re = new RegExp('href="' + escapeRe(rel) + '(\\d+)-([a-z]+)/"', 'gi');
      const counts = new Map();
      let m;
      while ((m = re.exec(html))) counts.set(m[2], (counts.get(m[2]) || 0) + 1);
      let best = 0;
      for (const [s, c] of counts) if (c > best) { best = c; ref.suffix = s; }
    }
  } catch { /* network down or DDoS-Guard challenge — leave nulls, link to book */ }

  humanRefCache.set(canonicalBookUrl, ref);
  // This is the one cache no retention sweep touches (it is public book
  // metadata, so deleteAllLocalData deliberately keeps it). Prune on every
  // serialized write so it remains bounded without losing concurrent entries.
  await updateHumanRefCache(canonicalBookUrl, ref);
  return ref;
}

/**
 * Resolve a single number against a book.
 *
 * mode:
 *  - 'exercise' (default): "Упр. N" — prefer an exercises section over review
 *    questions. Used by textbooks (algebra etc.).
 *  - 'page': "с. N" — prefer a "страница" section. Used by page-structured
 *    workbooks, whose answer image for a page covers all its exercises.
 *
 * Returns null if nothing matches (caller falls back to AI). The result carries
 * a public gdz.ru link (the human site) so the student can open the source.
 */
export async function resolveTask(bookUrl, number, { mode = 'exercise' } = {}) {
  const canonicalBookUrl = requireGdzApiUrl(bookUrl);
  const num = String(number).trim();
  // v2: link is now the exact-exercise URL, not the book — orphan v1 entries.
  const cacheKey = `v2|${canonicalBookUrl}|${mode}|${num}`;
  const legacyCacheKey = `v2|${gdzApiPath(canonicalBookUrl)}|${mode}|${num}`;

  const { [TASK_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(TASK_CACHE_KEY);
  const cached = cache[cacheKey] || cache[legacyCacheKey];
  if (cached) {
    const value = (typeof cached === 'object' && 'v' in cached) ? cached.v : cached;
    const taskUrl = normalizeGdzApiUrl(value?.taskUrl);
    const normalized = taskUrl && taskUrl !== value.taskUrl ? { ...value, taskUrl } : value;
    return Array.isArray(normalized?.images)
      ? { ...normalized, images: normalized.images.slice(0, MAX_ANSWER_IMAGES) }
      : normalized;
  }

  const tasks = await listTasks(canonicalBookUrl);
  const exact = tasks.filter((t) => t.num === num);
  if (!exact.length) return null;

  // Rank candidate sections so the right numbering wins, and within one rank the
  // earliest edition wins (sort is stable, exact keeps edition order).
  const rank = mode === 'page'
    ? (s = '') => (/страниц/i.test(s) ? 0 : 1)
    : (s = '') => {
        const x = s.toLowerCase();
        if (/упраж|exercise/.test(x)) return 0;          // real exercises first
        if (/вопрос/.test(x)) return 3;                  // review questions last
        if (/номер|^№|задани/.test(x)) return 1;
        return 2;
      };
  const match = exact.slice().sort((a, b) => rank(a.section) - rank(b.section))[0];

  const taskData = await getJson(match.url);
  const editions = taskData.editions || [];
  const images = editions
    .flatMap((e) => (e.images || []).map((i) => i.url))
    .filter((url) => isGdzApiUrl(url))
    .slice(0, MAX_ANSWER_IMAGES);
  if (!images.length) return null;

  // Build a link to the exact exercise. For a plain numbered exercise we can
  // construct `{canonicalBook}{N}-{suffix}/`; otherwise (page-numbered workbooks,
  // §-questions, or a failed lookup) we link to the book — never worse than before.
  const ref = await resolveHumanRef(canonicalBookUrl);
  let link;
  if (ref.base && ref.suffix && mode === 'exercise' && /^\d+$/.test(num)) {
    link = `${ref.base}${num}-${ref.suffix}/`;
  } else if (ref.base) {
    link = ref.base;
  } else {
    link = new URL(gdzApiPath(match.url), HUMAN).href; // last resort: mobile path (redirects to the book)
  }

  const result = {
    taskUrl: match.url,
    section: match.section,
    images,
    link
  };

  // LRU-ish cache: keep the most recent TASK_CACHE_MAX entries. Writes are
  // serialised (and re-read the latest cache) so concurrent resolves don't
  // clobber each other — see updateTaskCache.
  await updateTaskCache(cacheKey, result);
  return result;
}

/**
 * Resolve every reference in a homework task against a configured book.
 * Detects the book's numbering (page- vs exercise-structured) from its own
 * task sections, picks the matching context (workbook books read Р.т. refs,
 * textbooks read the rest), and resolves each number.
 *
 * @returns {{mode:'page'|'exercise', ctx:'workbook'|'textbook', answers:Array}}
 */
export async function resolveForTask(book, taskText) {
  const tasks = await listTasks(book.url);
  const hasPage = tasks.some((t) => /страниц/i.test(t.section || ''));
  const hasExercise = tasks.some((t) => /упраж|номер|задани/i.test(t.section || ''));
  const isWorkbook = /тетрад|рабоч|workbook|activity/i.test(`${book.subtype || ''} ${book.title || ''}`);
  // Resolve by page when the book is page-structured — for workbooks this holds
  // even if a few exercise-named sections also exist; for everything else only
  // when there are no exercise sections at all. Otherwise resolve by exercise.
  const mode = hasPage && (isWorkbook || !hasExercise) ? 'page' : 'exercise';

  const ctx = isWorkbook ? 'workbook' : 'textbook';
  const refs = parseRefs(taskText);

  // Resolve ONLY the book's own context. A configured workbook answers the Р.т.
  // refs; a textbook answers the rest. We do NOT borrow the other context: a
  // textbook page number ≠ the same workbook page number (different physical
  // books), and the "Текст с. 112" reading pages must never resolve against a
  // workbook. A miss here just falls through to the AI — far better than a
  // confidently-wrong answer image.
  const nums = [...new Set(mode === 'page' ? refs[ctx].pages : refs[ctx].exercises)].slice(0, 12);

  const answers = [];
  for (const n of nums) {
    const r = await resolveTask(book.url, String(n), { mode });
    answers.push(r
      ? { num: n, found: true, link: r.link, images: r.images, section: r.section }
      : { num: n, found: false });
  }
  return { mode, ctx, answers };
}

/** Download a resolved-task image as inline base64. The dashboard can render
 *  it directly without a network round-trip from the renderer process. */
export async function fetchTaskImage(imageUrl) {
  return getBlobAsBase64(imageUrl);
}
