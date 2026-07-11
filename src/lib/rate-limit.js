/**
 * Per-provider daily request cap, persisted in chrome.storage.local.
 * Keeps a runaway loop or curious user from torching a paid balance, and
 * lets the user raise/lower the caps in Settings.
 *
 * Storage:
 *   rateLimits:  { openrouter: number, groq: number, ... }   // user-set caps
 *   rateUsage:   { openrouter: { day, count }, groq: { day, count }, ... }
 *   rateAttempts: { openrouter: { day, count }, groq: { day, count }, ... }
 *   rateReservations: { [id]: { provider, day, expiresAt } }
 *   rateHistory: { 'YYYY-MM-DD': { openrouter: number, groq: number, ... } }  // per-day, last 14 days
 *
 * `day` is a local-time YYYY-MM-DD string; when it rolls over, the counter
 * resets implicitly (no background sweep needed). rateHistory keeps a short
 * trail so Settings can chart successful requests/day; it's pruned on write.
 */

export const DEFAULT_LIMITS = { openrouter: 80, groq: 300, qwen: 80, deepseek: 150 };

// Human-readable provider names for the over-limit error message.
const PROVIDER_NAMES = { openrouter: 'OpenRouter', groq: 'Groq', qwen: 'Qwen', deepseek: 'DeepSeek' };
const HISTORY_DAYS = 14;
const RESERVATION_TTL_MS = 15 * 60 * 1000;

// chrome.storage.local has no compare-and-swap. Serialising every reservation
// transition inside this service worker prevents simultaneous solves from
// overwriting one another's state.
let chargeQueue = Promise.resolve();

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
  const { rateLimits = {}, rateUsage = {}, rateAttempts = {}, rateHistory = {}, rateReservations = {} } =
    await chrome.storage.local.get(
      ['rateLimits', 'rateUsage', 'rateAttempts', 'rateHistory', 'rateReservations']
    );
  return { rateLimits, rateUsage, rateAttempts, rateHistory, rateReservations };
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
 * Reserve one slot against `provider`'s daily budget. A reservation is not a
 * charge: only commitOne() moves it into usage/history. This makes a failed call
 * unchargeable even if its cleanup write fails or the worker is torn down; the
 * orphan can only block a slot until its short expiry.
 */
async function reserveOneInner(provider) {
  const { rateLimits, rateUsage, rateAttempts, rateReservations } = await load();
  const limit = limitFor(rateLimits, provider);
  const day = todayKey();
  const used = currentCount(rateUsage[provider], day);
  const now = Date.now();
  const reservations = {};
  let pending = 0;
  for (const [id, reservation] of Object.entries(rateReservations || {})) {
    if (!reservation || !Number.isFinite(reservation.expiresAt) || reservation.expiresAt <= now) continue;
    reservations[id] = reservation;
    if (reservation.provider === provider && reservation.day === day) pending++;
  }
  if (used + pending >= limit) {
    const name = PROVIDER_NAMES[provider] || provider;
    throw new Error(
      `Дневной лимит ${name} исчерпан (${used + pending}/${limit}). ` +
      `Изменить лимит можно в настройках расширения, либо дождитесь завтра — счётчик сбросится.`
    );
  }
  const attempts = currentCount(rateAttempts[provider], day);
  if (attempts >= limit * 3) {
    throw new Error(
      `Слишком много попыток за сегодня (${attempts}). ` +
      `Попробуйте завтра или измените лимит в настройках.`
    );
  }
  const nextAttempts = { ...rateAttempts, [provider]: { day, count: attempts + 1 } };
  const id = crypto.randomUUID();
  reservations[id] = { provider, day, expiresAt: now + RESERVATION_TTL_MS };
  await chrome.storage.local.set({ rateAttempts: nextAttempts, rateReservations: reservations });
  return id;
}

export function reserveOne(provider) {
  const run = chargeQueue.then(() => reserveOneInner(provider));
  // Keep later reservations usable after an over-limit error while preserving that
  // error for this caller.
  chargeQueue = run.catch(() => {});
  return run;
}

async function commitOneInner(id) {
  const { rateUsage, rateHistory, rateReservations } = await load();
  const reservation = rateReservations?.[id];
  if (!reservation) throw new Error('Rate-limit reservation expired before commit.');

  const reservations = { ...rateReservations };
  delete reservations[id];
  const { provider, day } = reservation;
  const usage = { ...rateUsage };
  // rateUsage is only today's compact snapshot. An old reservation completing
  // after midnight belongs in history but must not overwrite the new day's slot.
  if (day === todayKey()) {
    usage[provider] = { day, count: currentCount(rateUsage[provider], day) + 1 };
  }
  const hist = pruneHistory(rateHistory);
  const row = hist[day] || {};
  hist[day] = { ...row, [provider]: (Number(row[provider]) || 0) + 1 };
  await chrome.storage.local.set({ rateUsage: usage, rateHistory: hist, rateReservations: reservations });
}

export function commitOne(id) {
  const run = chargeQueue.then(() => commitOneInner(id));
  chargeQueue = run.catch(() => {});
  return run;
}

async function cancelOneInner(id) {
  const { rateReservations } = await load();
  if (!rateReservations || !Object.hasOwn(rateReservations, id)) return;
  const reservations = { ...rateReservations };
  delete reservations[id];
  await chrome.storage.local.set({ rateReservations: reservations });
}

export function cancelOne(id) {
  const run = chargeQueue.then(() => cancelOneInner(id));
  chargeQueue = run.catch(() => {});
  return run;
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
 * charted alongside the others — commitOne records every successful call.
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
