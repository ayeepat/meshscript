/**
 * Authenticated remote runtime config (background service worker only).
 *
 * The hosted document is a signed envelope, not bare config JSON:
 *   { "payload": "<base64url UTF-8 JSON>", "signature": "<base64url P-256 signature>" }
 * Signature verification happens before sanitization and on every cache read.
 * Unsigned legacy caches and malformed/tampered envelopes fail closed.
 */

import {
  RUNTIME_CONFIG_URL,
  RUNTIME_CONFIG_TTL_MS,
  RUNTIME_CONFIG_PUBLIC_KEY_JWK
} from './config.js';
import { fetchBounded } from './bounded-fetch.js';

const CACHE_KEY = 'runtimeConfig';
const FETCH_TIMEOUT_MS = 8000;
const FETCH_MAX_BYTES = 64 * 1024;
const SIGNATURE_BYTES = 64; // WebCrypto ECDSA P-256 uses IEEE-P1363 r || s.
const CONFIG_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SIGNED_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;
const NOTICE_ORIGINS = new Set([
  'https://smeshai.xyz',
  'https://www.smeshai.xyz',
  'https://chromewebstore.google.com'
]);
const FEATURE_IDS = [
  'ai_text', 'ai_images', 'ai_documents', 'mesh_attachments',
  'autofill', 'other_sites', 'telemetry', 'gdz'
];
// These are remote KILL switches, so their resting state is on: a student
// offline, behind a blocked config host, or on a build predating a new switch
// keeps every shipped capability. Only an authentic signed `false` takes one
// down. The VPS stays authoritative for AI admission — it re-checks each job
// against the same switches — so an unreachable config host cannot be used to
// re-enable something the operator disabled server-side.
const defaultFeatures = () => Object.fromEntries(FEATURE_IDS.map((id) => [id, true]));

// Finite policy, deliberately duplicated in the classic content script as a
// second trust-boundary check. Remote config may select a pre-reviewed DOM path;
// it cannot invent a new querySelector program.
export const APPROVED_HOMEWORK_SELECTORS = Object.freeze([
  'a[href*="/diary/homeworks/homeworks/"]',
  'a[href*="/diary/homeworks/"]',
  'a[href*="/diary/homework/"]'
]);

function emptyConfig() {
  return {
    configVersion: 0,
    issuedAt: 0,
    expiresAt: 0,
    subjectVocabulary: null,
    homeworkAnchorSelector: null,
    minExtensionVersion: null,
    notice: null,
    features: defaultFeatures(),
    fetchedAt: 0
  };
}

function cleanVocabulary(v) {
  if (!Array.isArray(v)) return null;
  const out = v.filter((s) => typeof s === 'string' && s.trim().length > 1 && s.length < 60)
    .map((s) => s.trim())
    .slice(0, 120);
  return out.length ? out : null;
}

function cleanSelector(s) {
  if (typeof s !== 'string') return null;
  const selector = s.trim();
  return APPROVED_HOMEWORK_SELECTORS.includes(selector) ? selector : null;
}

function cleanVersion(s) {
  return (typeof s === 'string' && /^\d+(\.\d+){0,3}$/.test(s.trim())) ? s.trim() : null;
}

function cleanNotice(n) {
  if (!n || typeof n !== 'object') return null;
  const text = typeof n.text === 'string' ? n.text.trim().slice(0, 300) : '';
  if (!text) return null;
  let url = null;
  if (typeof n.url === 'string') {
    try {
      const u = new URL(n.url.trim());
      if (u.protocol === 'https:' && NOTICE_ORIGINS.has(u.origin)) url = u.href;
    }
    catch { /* invalid URL — omit it */ }
  }
  return url ? { text, url } : { text };
}

function cleanFeatures(value) {
  const features = defaultFeatures();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return features;
  for (const id of FEATURE_IDS) {
    if (typeof value[id] === 'boolean') features[id] = value[id];
  }
  return features;
}

export function sanitizeRuntimeConfig(raw, fetchedAt = Date.now()) {
  const cfg = emptyConfig();
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Number.isSafeInteger(raw.configVersion) && raw.configVersion >= 0) {
      cfg.configVersion = raw.configVersion;
    }
    if (Number.isSafeInteger(raw.issuedAt)) cfg.issuedAt = raw.issuedAt;
    if (Number.isSafeInteger(raw.expiresAt)) cfg.expiresAt = raw.expiresAt;
    cfg.subjectVocabulary = cleanVocabulary(raw.subjectVocabulary);
    cfg.homeworkAnchorSelector = cleanSelector(raw.homeworkAnchorSelector);
    cfg.minExtensionVersion = cleanVersion(raw.minExtensionVersion);
    cfg.notice = cleanNotice(raw.notice);
    cfg.features = cleanFeatures(raw.features);
  }
  cfg.fetchedAt = fetchedAt;
  return cfg;
}

function decodeBase64Url(value, maxBytes) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  if (value.length > Math.ceil(maxBytes * 4 / 3) + 4) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    if (binary.length > maxBytes) return null;
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch { return null; }
}

let verificationKeyPromise = null;
function verificationKey(publicJwk) {
  if (publicJwk !== RUNTIME_CONFIG_PUBLIC_KEY_JWK) {
    return crypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  if (!verificationKeyPromise) {
    verificationKeyPromise = crypto.subtle.importKey(
      'jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    ).catch((error) => {
      verificationKeyPromise = null;
      throw error;
    });
  }
  return verificationKeyPromise;
}

export async function verifySignedConfigEnvelope(envelope, {
  publicJwk = RUNTIME_CONFIG_PUBLIC_KEY_JWK,
  fetchedAt = Date.now(),
  now = Date.now()
} = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const payloadBytes = decodeBase64Url(envelope.payload, FETCH_MAX_BYTES);
  const signature = decodeBase64Url(envelope.signature, SIGNATURE_BYTES);
  if (!payloadBytes || !signature || signature.byteLength !== SIGNATURE_BYTES) return null;
  try {
    const key = await verificationKey(publicJwk);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, key, signature, payloadBytes
    );
    if (!valid) return null;
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        !Number.isSafeInteger(raw.configVersion) || raw.configVersion < 0 ||
        !Number.isSafeInteger(raw.issuedAt) || !Number.isSafeInteger(raw.expiresAt) ||
        raw.issuedAt < 0 || raw.issuedAt > now + CONFIG_CLOCK_SKEW_MS ||
        raw.expiresAt <= now || raw.expiresAt <= raw.issuedAt ||
        raw.expiresAt - raw.issuedAt > MAX_SIGNED_VALIDITY_MS) return null;
    return sanitizeRuntimeConfig(raw, fetchedAt);
  } catch { return null; }
}

function policyValue(config) {
  return {
    configVersion: config.configVersion,
    subjectVocabulary: config.subjectVocabulary,
    homeworkAnchorSelector: config.homeworkAnchorSelector,
    minExtensionVersion: config.minExtensionVersion,
    notice: config.notice,
    features: config.features
  };
}

/** Same signed policy, allowing only its issuance/expiry/cache timestamps to renew. */
export function sameRuntimePolicy(left, right) {
  return JSON.stringify(policyValue(left)) === JSON.stringify(policyValue(right));
}

async function validateCached(cached) {
  if (!cached || typeof cached !== 'object') return null;
  const fetchedAt = Number(cached.fetchedAt);
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || fetchedAt > Date.now()) return null;
  const config = await verifySignedConfigEnvelope(cached.envelope, { fetchedAt, now: Date.now() });
  return config ? { config, envelope: cached.envelope, fetchedAt } : null;
}

async function fetchFresh() {
  try {
    const { res, bytes } = await fetchBounded(RUNTIME_CONFIG_URL, {
      maxBytes: FETCH_MAX_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error'
    });
    if (!res.ok) return null;
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const fetchedAt = Date.now();
    const config = await verifySignedConfigEnvelope(envelope, { fetchedAt });
    return config ? { config, envelope, fetchedAt } : null;
  } catch { return null; }
}

/**
 * One refresh at a time, per context.
 *
 * Concurrent callers each fetched and then each stored UNCONDITIONALLY, and the
 * only rollback guard compared against the cache snapshot read BEFORE that
 * caller's fetch — a window as long as the fetch itself. A slow v2 racing a
 * fast v3 therefore left the verified cache back on v2, silently downgrading
 * every consumer to older signed config.
 */
let refreshInFlight = null;

function refreshRemoteConfig() {
  if (!refreshInFlight) {
    refreshInFlight = commitFreshConfig().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function commitFreshConfig() {
  const fresh = await fetchFresh();
  if (!fresh) return null;

  // Re-read and re-verify the cache immediately before committing. The
  // pre-fetch snapshot is stale by exactly the fetch duration; this narrows the
  // regression window to two adjacent storage operations and also covers a
  // writer in another extension context, which single-flight alone cannot.
  let currentRaw = null;
  try { ({ [CACHE_KEY]: currentRaw = null } = await chrome.storage.local.get(CACHE_KEY)); }
  catch { return fresh.config; }
  const current = await validateCached(currentRaw);

  if (current && fresh.config.configVersion < current.config.configVersion) {
    return current.config;
  }
  if (current && fresh.config.configVersion === current.config.configVersion) {
    // The sequence number identifies one immutable policy. Timestamps need to
    // renew so an unchanged revision remains usable, but any same-version
    // semantic change is equivocation and must advance the dashboard revision.
    if (!sameRuntimePolicy(fresh.config, current.config)) return current.config;
    const refreshed = { envelope: fresh.envelope, fetchedAt: fresh.fetchedAt };
    try { await chrome.storage.local.set({ [CACHE_KEY]: refreshed }); } catch { /* cache is optional */ }
    return fresh.config;
  }
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { envelope: fresh.envelope, fetchedAt: fresh.fetchedAt }
    });
  } catch { /* verified in-memory config remains safe for this call */ }
  return fresh.config;
}

/** Return a verified config, refreshing at most once per TTL. Never throws. */
export async function getRuntimeConfig({ force = false } = {}) {
  let cachedRaw = null;
  try { ({ [CACHE_KEY]: cachedRaw = null } = await chrome.storage.local.get(CACHE_KEY)); }
  catch { return emptyConfig(); }

  const cached = await validateCached(cachedRaw);
  if (cachedRaw && !cached) {
    try { await chrome.storage.local.remove(CACHE_KEY); } catch { /* revalidation still failed closed */ }
  }
  if (!force && cached && Date.now() - cached.fetchedAt < RUNTIME_CONFIG_TTL_MS) {
    return cached.config;
  }

  const refreshed = await refreshRemoteConfig();
  return refreshed || cached?.config || emptyConfig();
}

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
