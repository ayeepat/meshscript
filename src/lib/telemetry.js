/**
 * Opt-in, pseudonymous usage telemetry → the license backend's /t endpoint
 * (analytics.js on the worker; the admin dashboard reads aggregates).
 *
 * OPT-IN: nothing is ever sent unless the user has BOTH accepted the data-
 * processing consent AND enabled the separate «Анонимная статистика» toggle in
 * Settings (`telemetryEnabled`, default off). track() still queues in memory —
 * the double gate is enforced at flush time, so a toggle flipped mid-session
 * takes effect on the very next batch.
 *
 * CONTENT-FREE by design: never sends task text, answers, files or anything a
 * student typed — only event types, canonical subject names, provider/model,
 * fixed metrics and coarse device facts (browser family, extension version,
 * the same pseudonymous device_id that /verify and /referral/* already use).
 * Client-reported token/cost values are not sent or counted as financial
 * truth; the VPS separately reports provider-observed usage. The license KEY
 * is never transmitted — only its type — and errors travel as fixed codes.
 *
 * Fire-and-forget everywhere: telemetry must never slow down or break a
 * solve, so every path swallows its own failures and drops events on error.
 * Runs ONLY in the background service worker.
 */

import { BACKEND_URL, DEFAULT_PROVIDER } from './config.js';
import { getDeviceId } from './history.js';
import { hasConsent } from './consent.js';

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
    model: usage?.model || null
  };
}

/**
 * Fixed error vocabulary — the ONLY error signal telemetry may carry. Raw
 * error strings can embed task fragments, file names or provider echoes, so
 * they never leave the device; the dashboard only needs the failure class.
 */
export function errorCode(err) {
  const m = String(err?.message || err || '').toLowerCase();
  if (/согласи|consent/.test(m)) return 'consent_required';
  if (/лиценз|license/.test(m)) return 'license_invalid';
  if (/ключ.*не задан|api.?key/.test(m)) return 'key_missing';
  if (/переключилась вкладка|скриншот|capture/.test(m)) return 'capture_failed';
  if (/лимит|limit|quota|429/.test(m)) return 'rate_limited';
  if (/таймаут|timeout|timed out|abort/.test(m)) return 'provider_timeout';
  if (/http|код \d{3}|\b\d{3}\b.*(ошибк|error)|сервер/.test(m)) return 'provider_http';
  if (/сеть|network|fetch|offline|соединен/.test(m)) return 'network';
  return 'other';
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
    // Double opt-in gate: the general data-processing consent AND the separate
    // statistics toggle (Settings → «Анонимная статистика», default OFF).
    const { telemetryEnabled, aiProvider = DEFAULT_PROVIDER, licenseStatus } =
      await chrome.storage.local.get(['telemetryEnabled', 'aiProvider', 'licenseStatus']);
    const telemetryToken = typeof licenseStatus?.telemetry_token === 'string'
      ? licenseStatus.telemetry_token
      : '';
    const telemetryExpiresAt = Number(licenseStatus?.telemetry_token_expires_at) || 0;
    if (
      !telemetryEnabled ||
      !(await hasConsent()) ||
      !licenseStatus?.ok ||
      !telemetryToken ||
      telemetryExpiresAt <= Date.now()
    ) return;
    const body = {
      device_id: await getDeviceId(),
      browser: detectBrowser(),
      version: chrome.runtime.getManifest().version,
      provider: aiProvider,
      // Type only — the raw key never rides a telemetry request (the backend
      // discards any legacy-client key it still receives; see analytics.js).
      license_type: licenseStatus?.ok ? (licenseStatus.type || null) : 'none',
      events
    };
    // The gate above was read BEFORE the device lookup awaited, so a toggle
    // during that gap still sent this batch. Re-read both consents at the last
    // possible moment: withdrawing consent must stop the very next request,
    // not the one after it.
    const { telemetryEnabled: stillEnabled } =
      await chrome.storage.local.get('telemetryEnabled');
    if (!stillEnabled || !(await hasConsent())) return;
    // keepalive lets the batch survive the service worker being torn down
    // right after the response that triggered it.
    await fetch(new URL('/t', BACKEND_URL).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telemetry-Token': telemetryToken
      },
      body: JSON.stringify(body),
      redirect: 'error',
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
