/**
 * GDZ (gdz-ru.com) API client. Runs ONLY in the background service worker.
 *
 * The host is the gdz.ru mobile-app backend (NOT the public gdz.ru website,
 * which sits behind a JS challenge). DDoS-Guard allowlists the User-Agent:
 * only an okhttp UA returns 200; a browser UA gets 403. MV3 fetch() cannot
 * set User-Agent, so a static declarativeNetRequest rule (rules/gdz-ua.json,
 * wired in the manifest) rewrites the UA on every gdz-ru.com request.
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

const BASE = 'https://gdz-ru.com';
const CATALOG_PATH = '/full-book-list?country_id=1';

// 7-day catalog TTL: the book list grows slowly (new editions are rare). A
// week is short enough to pick up new books, long enough that the 6.5 MB
// payload is fetched ~once.
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOG_KEY = 'gdzCatalog';
const TASK_CACHE_KEY = 'gdzTaskCache';
const TASK_CACHE_MAX = 200; // LRU-ish cap on resolved tasks

// The public human site. Its URL scheme differs entirely from the mobile API
// (BASE), and the API never exposes a human link, so we derive one per book.
const HUMAN = 'https://gdz.ru';
const HUMAN_REF_KEY = 'gdzHumanRefs';                  // storage.local: bookUrl -> {base,suffix,at}
const HUMAN_REF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const humanRefCache = new Map();                        // in-mem: bookUrl -> {base,suffix}

// In-flight catalog promise: dedupe concurrent cold loads so the 6.5 MB list
// is fetched once even if the picker fires several searches at startup.
let catalogInFlight = null;
// Per-book flattened task lists, in memory only (the service worker may be torn
// down — that's fine, it's a cache). Resolving several exercises from one book
// then costs a single structure fetch instead of one per exercise.
const taskListCache = new Map(); // bookUrl -> { tasks, at }
const TASK_LIST_TTL_MS = 30 * 60 * 1000;

/* ---------- HTTP ---------- */

// All requests rely on the DNR rule to rewrite User-Agent. We don't set it
// here (and can't — it's a forbidden header).
async function getJson(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`GDZ ${res.status} ${url}`);
  try {
    return await res.json();
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
  // Name the host on failure. Answer images may be served from a different
  // gdz-ru.com host than the API; if that host is missing from host_permissions
  // (network fail) or from the DNR UA rule (403), the error must say WHICH host
  // so GDZ_SELFTEST points right at the manifest/rule fix instead of failing
  // silently.
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw url */ }
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    throw new Error(`GDZ image: network fail for ${host} (missing host permission or UA rule?) — ${e}`);
  }
  if (!res.ok) throw new Error(`GDZ image ${res.status} ${host}`);
  const buf = await res.arrayBuffer();
  // Shape matches the rest of the codebase's inline-file objects {mimeType,
  // dataBase64, name} so a resolved answer can be attached like any upload.
  return {
    mimeType: res.headers.get('content-type') || 'image/jpeg',
    dataBase64: abToBase64(buf),
    name: nameFromUrl(url)
  };
}

// Chunked btoa: a one-shot String.fromCharCode on a multi-megabyte JPEG
// blows the JS stack.
function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
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
    url: b.url,
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
    books: (raw.books || []).map(trimBook)
  };
}

export async function getCatalog({ force = false } = {}) {
  if (!force) {
    const { [CATALOG_KEY]: cached } = await chrome.storage.local.get(CATALOG_KEY);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
  }
  if (catalogInFlight) return catalogInFlight; // a load is already running — join it
  catalogInFlight = (async () => {
    const raw = await getJson(BASE + CATALOG_PATH);
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
  // Recurse: some books nest topics within topics, so a fixed 2-level walk
  // would drop tasks. Carry the nearest named section down for labelling.
  const walk = (nodes, parentSec) => {
    for (const node of nodes || []) {
      const sec = node.title_short || node.title || parentSec || '';
      for (const t of node.tasks || []) out.push({ section: sec, num: String(t.title).trim(), url: t.url });
      if (node.topics && node.topics.length) walk(node.topics, sec);
    }
  };
  walk(structure, '');
  return out;
}

export async function listTasks(bookUrl) {
  const hit = taskListCache.get(bookUrl);
  if (hit && Date.now() - hit.at < TASK_LIST_TTL_MS) return hit.tasks;
  const data = await getJson(BASE + bookUrl);
  const tasks = flattenTasks(data.structure);
  taskListCache.set(bookUrl, { tasks, at: Date.now() });
  return tasks;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

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
  if (humanRefCache.has(bookUrl)) return humanRefCache.get(bookUrl);
  const { [HUMAN_REF_KEY]: store = {} } = await chrome.storage.local.get(HUMAN_REF_KEY);
  const cached = store[bookUrl];
  if (cached && Date.now() - cached.at < HUMAN_REF_TTL_MS) {
    const ref = { base: cached.base, suffix: cached.suffix };
    humanRefCache.set(bookUrl, ref);
    return ref;
  }

  const ref = { base: null, suffix: null };
  try {
    const res = await fetch(HUMAN + bookUrl, { credentials: 'omit', redirect: 'follow' });
    if (res.ok) {
      ref.base = res.url.endsWith('/') ? res.url : res.url + '/';   // canonical book page
      const rel = ref.base.replace(HUMAN, '');
      const html = await res.text();
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

  humanRefCache.set(bookUrl, ref);
  store[bookUrl] = { base: ref.base, suffix: ref.suffix, at: Date.now() };
  await chrome.storage.local.set({ [HUMAN_REF_KEY]: store });
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
  const num = String(number).trim();
  // v2: link is now the exact-exercise URL, not the book — orphan v1 entries.
  const cacheKey = `v2|${bookUrl}|${mode}|${num}`;

  const { [TASK_CACHE_KEY]: cache = {} } = await chrome.storage.local.get(TASK_CACHE_KEY);
  if (cache[cacheKey]) return cache[cacheKey];

  const tasks = await listTasks(bookUrl);
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

  const taskData = await getJson(BASE + match.url);
  const editions = taskData.editions || [];
  const images = editions.flatMap((e) => (e.images || []).map((i) => i.url)).filter(Boolean);
  if (!images.length) return null;

  // Build a link to the exact exercise. For a plain numbered exercise we can
  // construct `{canonicalBook}{N}-{suffix}/`; otherwise (page-numbered workbooks,
  // §-questions, or a failed lookup) we link to the book — never worse than before.
  const ref = await resolveHumanRef(bookUrl);
  let link;
  if (ref.base && ref.suffix && mode === 'exercise' && /^\d+$/.test(num)) {
    link = `${ref.base}${num}-${ref.suffix}/`;
  } else if (ref.base) {
    link = ref.base;
  } else {
    link = HUMAN + match.url;   // last resort: mobile path (redirects to the book)
  }

  const result = {
    taskUrl: match.url,
    section: match.section,
    images,
    link
  };

  // LRU-ish cache: keep the most recent TASK_CACHE_MAX entries.
  cache[cacheKey] = result;
  const keys = Object.keys(cache);
  if (keys.length > TASK_CACHE_MAX) {
    for (const k of keys.slice(0, keys.length - TASK_CACHE_MAX)) delete cache[k];
  }
  await chrome.storage.local.set({ [TASK_CACHE_KEY]: cache });
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
