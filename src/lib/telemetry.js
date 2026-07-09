/**
 * Anonymous usage telemetry → the license backend's /t endpoint (analytics.js
 * on the worker; the admin dashboard reads the aggregates).
 *
 * CONTENT-FREE by design: never sends task text, answers, files or anything a
 * student typed — only event types, subject names, token counts, provider
 * costs and coarse device facts (browser family, extension version, the same
 * anonymous device_id that /verify and /referral/* already use).
 *
 * Fire-and-forget everywhere: telemetry must never slow down or break a
 * solve, so every path swallows its own failures and drops events on error.
 * Runs ONLY in the background service worker.
 */

import { BACKEND_URL } from './config.js';
import { getDeviceId } from './history.js';

const FLUSH_DELAY_MS = 1500;   // short: MV3 service workers die young
const MAX_QUEUE = 20;
const HEARTBEAT_EVERY_MS = 6 * 60 * 60 * 1000;

/** Browser family from the UA. Yandex ships "YaBrowser", Opera "OPR". */
export function detectBrowser() {
  const ua = navigator.userAgent || '';
  if (/YaBrowser/i.test(ua)) return 'yandex';
  if (/OPR\/|Opera/i.test(ua)) return 'opera';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Chrome\//i.test(ua)) return 'chrome';
  return 'other';
}

/**
 * Per-request provider cost in USD. OpenRouter reports the EXACT cost in the
 * stream's final usage frame when asked (usage.include) — prefer that when
 * present. Everyone else (Qwen/DeepSeek via Model Studio's plain OpenAI-
 * compatible mode, no such extension) falls back to a published list rate
 * below. Groq has no entry here — it's genuinely free, so falls through to 0.
 * These rates are approximate (e.g. Qwen's real pricing is bracket-tiered by
 * input length) and will drift as providers reprice — good enough for the
 * Settings spend chart, not a billing-grade figure.
 */
const FALLBACK_RATES = {
  openrouter: { in: 0.30 / 1e6, out: 2.50 / 1e6 },  // google/gemini-2.5-flash
  qwen: { in: 0.32 / 1e6, out: 1.28 / 1e6 },         // qwen3.7-plus, short-context tier
  deepseek: { in: 0.20 / 1e6, out: 0.40 / 1e6 }      // deepseek-v4-flash
};
export function costFromUsage(provider, usage) {
  if (!usage) return 0;
  const exact = Number(usage.cost);
  if (Number.isFinite(exact) && exact > 0) return exact;
  const rate = FALLBACK_RATES[provider];
  if (!rate) return 0;
  const tin = Number(usage.prompt_tokens) || 0;
  const tout = Number(usage.completion_tokens) || 0;
  return tin * rate.in + tout * rate.out;
}

/** The standard per-request fields for an AI-call event. */
export function usageFields(provider, usage) {
  return {
    provider: provider || null,
    model: usage?.model || null,
    tokens_in: Number(usage?.prompt_tokens) || 0,
    tokens_out: Number(usage?.completion_tokens) || 0,
    cost_usd: costFromUsage(provider, usage)
  };
}

let queue = [];
let timer = null;

/**
 * Queue one event; batches flush after a short debounce (or when the queue
 * fills). Types the backend accepts: install, update, heartbeat, solve,
 * test_solve, test_requestion, gdz_pull, error.
 */
export function track(type, fields = {}) {
  try {
    queue.push({ ts: Date.now(), type, ...fields });
    if (queue.length >= MAX_QUEUE) { void flush(); return; }
    if (!timer) timer = setTimeout(() => { void flush(); }, FLUSH_DELAY_MS);
  } catch { /* telemetry never breaks the caller */ }
}

async function flush() {
  clearTimeout(timer);
  timer = null;
  const events = queue.splice(0, 25);
  if (!events.length) return;
  try {
    // Kill switch for a future settings toggle; unset = on.
    const { telemetryDisabled, aiProvider = 'openrouter', licenseStatus } =
      await chrome.storage.local.get(['telemetryDisabled', 'aiProvider', 'licenseStatus']);
    if (telemetryDisabled) return;
    const body = {
      device_id: await getDeviceId(),
      browser: detectBrowser(),
      ua: (navigator.userAgent || '').slice(0, 240),
      version: chrome.runtime.getManifest().version,
      provider: aiProvider,
      license_key: licenseStatus?.ok ? licenseStatus.key : null,
      license_type: licenseStatus?.ok ? (licenseStatus.type || null) : 'none',
      events
    };
    // keepalive lets the batch survive the service worker being torn down
    // right after the response that triggered it.
    await fetch(new URL('/t', BACKEND_URL).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    });
  } catch { /* offline / backend down — drop, never retry-loop */ }
}

/**
 * Daily-active signal. Called on every service-worker spin-up; self-throttles
 * to one heartbeat per 6h so SW churn doesn't spam the backend.
 */
export async function heartbeat() {
  try {
    const { tmLastHb = 0 } = await chrome.storage.local.get('tmLastHb');
    if (Date.now() - tmLastHb < HEARTBEAT_EVERY_MS) return;
    await chrome.storage.local.set({ tmLastHb: Date.now() });
    track('heartbeat');
  } catch { /* no-op */ }
}
