/**
 * Remote runtime config (background service worker only).
 *
 * Mesh (school.mos.ru) is a living React app — its DOM shifts without notice,
 * and a store re-publish to fix a broken scrape takes days of review. This lets
 * you push a hot-fix the SAME day: host a tiny JSON file on your site and the
 * extension picks it up within RUNTIME_CONFIG_TTL_MS, overriding the few values
 * most likely to break, plus an optional "please update" notice.
 *
 * Hard rules:
 *  - EVERYTHING is optional and validated. A 404, a wrong host, malformed JSON
 *    or a junk field changes nothing — the extension falls back to the values
 *    baked into this build. The remote file can only ever *narrow* the blast
 *    radius of a Mesh change, never widen it.
 *  - The config is data, not code. We never eval it; the selector is only ever
 *    passed to querySelector (which can't execute anything) and is length- and
 *    shape-checked first.
 *
 * Expected JSON shape (all keys optional):
 *   {
 *     "configVersion": 3,
 *     "homeworkAnchorSelector": "a[href*=\"/diary/homeworks/homeworks/\"]",
 *     "subjectVocabulary": ["Алгебра", "Геометрия", ...],
 *     "minExtensionVersion": "0.6.0",      // below this → popup shows update notice
 *     "notice": { "text": "…", "url": "https://…" }   // optional banner
 *   }
 */

import { RUNTIME_CONFIG_URL, RUNTIME_CONFIG_TTL_MS } from './config.js';

const CACHE_KEY = 'runtimeConfig';
const FETCH_TIMEOUT_MS = 8000;

// What the popup/scraper actually consume. Overrides default to null/empty so a
// missing field cleanly means "use the value compiled into the extension".
function emptyConfig() {
  return {
    configVersion: 0,
    subjectVocabulary: null,        // string[] | null
    homeworkAnchorSelector: null,   // string | null
    minExtensionVersion: null,      // "x.y.z" | null
    notice: null,                   // { text, url? } | null
    fetchedAt: 0
  };
}

/* ---------- validation (remote data is untrusted) ---------- */

function cleanVocabulary(v) {
  if (!Array.isArray(v)) return null;
  const out = v.filter((s) => typeof s === 'string' && s.trim().length > 1 && s.length < 60)
    .map((s) => s.trim())
    .slice(0, 120);
  return out.length ? out : null;
}

// A CSS selector, not arbitrary anything. Keep it short and restricted to the
// character set real attribute/tag selectors use, so a hostile string can't even
// be an interesting payload (querySelector can't execute, but defence in depth).
function cleanSelector(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t || t.length > 200) return null;
  if (!/^[\w\s.#>~+:*\[\]"'=^$|()\-\/,]+$/.test(t)) return null;
  return t;
}

function cleanVersion(s) {
  return (typeof s === 'string' && /^\d+(\.\d+){0,3}$/.test(s.trim())) ? s.trim() : null;
}

function cleanNotice(n) {
  if (!n || typeof n !== 'object') return null;
  const text = typeof n.text === 'string' ? n.text.trim().slice(0, 300) : '';
  if (!text) return null;
  // Parse with URL() and keep the normalized href so a stray quote/space can't
  // survive into the banner's href attribute. https only.
  let url = null;
  if (typeof n.url === 'string') {
    try { const u = new URL(n.url.trim()); if (u.protocol === 'https:') url = u.href; }
    catch { /* not a valid URL — drop it */ }
  }
  return url ? { text, url } : { text };
}

function sanitize(raw) {
  const cfg = emptyConfig();
  if (raw && typeof raw === 'object') {
    if (Number.isFinite(raw.configVersion)) cfg.configVersion = raw.configVersion;
    cfg.subjectVocabulary = cleanVocabulary(raw.subjectVocabulary);
    cfg.homeworkAnchorSelector = cleanSelector(raw.homeworkAnchorSelector);
    cfg.minExtensionVersion = cleanVersion(raw.minExtensionVersion);
    cfg.notice = cleanNotice(raw.notice);
  }
  cfg.fetchedAt = Date.now();
  return cfg;
}

/* ---------- fetch + cache ---------- */

async function fetchFresh() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RUNTIME_CONFIG_URL, { cache: 'no-store', credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) return null;
    const raw = await res.json();
    return sanitize(raw);
  } catch {
    return null; // unreachable / not hosted yet / bad JSON — fall back to defaults
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the runtime config, refreshing from the network at most once per TTL.
 * Never throws and never blocks longer than the fetch timeout; on any failure
 * it returns the last good cache, or the empty (all-fallback) config.
 *
 * @param {{force?:boolean}} [opts]
 */
export async function getRuntimeConfig({ force = false } = {}) {
  const { [CACHE_KEY]: cached } = await chrome.storage.local.get(CACHE_KEY);
  if (!force && cached && Date.now() - (cached.fetchedAt || 0) < RUNTIME_CONFIG_TTL_MS) {
    return cached;
  }
  const fresh = await fetchFresh();
  if (fresh) {
    await chrome.storage.local.set({ [CACHE_KEY]: fresh });
    return fresh;
  }
  return cached || emptyConfig();
}

/**
 * Compare two dotted version strings. Returns true when `version` is strictly
 * older than `min` (i.e. an update is required). Lenient: missing parts = 0.
 */
export function isVersionBelow(version, min) {
  if (!min) return false;
  const a = String(version || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}
