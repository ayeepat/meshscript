/**
 * Per-provider daily request cap, persisted in chrome.storage.local.
 * Keeps a runaway loop or curious user from torching a paid balance, and
 * lets the user raise/lower the caps in Settings.
 *
 * Storage:
 *   rateLimits:  { openrouter: number, groq: number, ... }   // user-set caps
 *   rateUsage:   { openrouter: { day, count }, groq: { day, count }, ... }
 *   rateHistory: { 'YYYY-MM-DD': { openrouter: number, groq: number, ... } }  // per-day, last 14 days
 *
 * `day` is a local-time YYYY-MM-DD string; when it rolls over, the counter
 * resets implicitly (no background sweep needed). rateHistory keeps a short
 * append-only trail so Settings can chart requests/day; it's pruned on write.
 */

export const DEFAULT_LIMITS = { openrouter: 80, groq: 300, qwen: 80, deepseek: 150 };

// Human-readable provider names for the over-limit error message.
const PROVIDER_NAMES = { openrouter: 'OpenRouter', groq: 'Groq', qwen: 'Qwen', deepseek: 'DeepSeek' };
const HISTORY_DAYS = 14;

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Ascending list of the last `n` local-time YYYY-MM-DD strings (today last).
function lastNDays(n) {
  const pad = (k) => String(k).padStart(2, '0');
  const today = new Date();
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(today);
    x.setDate(today.getDate() - i);
    days.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`);
  }
  return days;
}

// Drop history entries older than the window so the map can't grow unbounded.
function pruneHistory(hist) {
  const keep = new Set(lastNDays(HISTORY_DAYS));
  const out = {};
  for (const k of Object.keys(hist || {})) if (keep.has(k)) out[k] = hist[k];
  return out;
}

async function load() {
  const { rateLimits = {}, rateUsage = {}, rateHistory = {} } =
    await chrome.storage.local.get(['rateLimits', 'rateUsage', 'rateHistory']);
  return { rateLimits, rateUsage, rateHistory };
}

function limitFor(rateLimits, provider) {
  const v = Number(rateLimits[provider]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LIMITS[provider] ?? 100;
}

function currentCount(slot, day) {
  if (!slot || slot.day !== day) return 0;
  const n = Number(slot.count);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Charge one call against `provider`'s daily budget. Throws a Russian-language
 * Error when over the cap so the existing service-worker try/catch surfaces it
 * to the UI verbatim.
 */
export async function chargeOne(provider) {
  const { rateLimits, rateUsage, rateHistory } = await load();
  const limit = limitFor(rateLimits, provider);
  const day = todayKey();
  const used = currentCount(rateUsage[provider], day);
  if (used >= limit) {
    const name = PROVIDER_NAMES[provider] || provider;
    throw new Error(
      `Дневной лимит ${name} исчерпан (${used}/${limit}). ` +
      `Изменить лимит можно в настройках расширения, либо дождитесь завтра — счётчик сбросится.`
    );
  }
  const next = { ...rateUsage, [provider]: { day, count: used + 1 } };
  // Mirror the charge into the per-day trail (pruned) so Settings can chart it.
  const hist = pruneHistory(rateHistory);
  const row = hist[day] || {};
  hist[day] = { ...row, [provider]: (Number(row[provider]) || 0) + 1 };
  await chrome.storage.local.set({ rateUsage: next, rateHistory: hist });
}

/** Snapshot of today's usage for each provider. Used by Settings. */
export async function getUsage() {
  const { rateLimits, rateUsage } = await load();
  const day = todayKey();
  const out = {};
  for (const p of ['openrouter', 'groq', 'qwen', 'deepseek']) {
    out[p] = {
      used: currentCount(rateUsage[p], day),
      limit: limitFor(rateLimits, p)
    };
  }
  return out;
}

/**
 * Per-day request counts for the last `days` days (ascending, today last).
 * Gaps are zero-filled so the Settings chart always has a full axis. Every
 * provider is first-class (its own cap + today's-usage tile), so each gets
 * charted alongside the others — chargeOne already records them all.
 * @returns {Promise<Array<{day:string, openrouter:number, groq:number, qwen:number, deepseek:number}>>}
 */
export async function getUsageHistory(days = HISTORY_DAYS) {
  const { rateHistory } = await load();
  return lastNDays(days).map((day) => ({
    day,
    openrouter: Number(rateHistory[day]?.openrouter) || 0,
    groq: Number(rateHistory[day]?.groq) || 0,
    qwen: Number(rateHistory[day]?.qwen) || 0,
    deepseek: Number(rateHistory[day]?.deepseek) || 0
  }));
}
