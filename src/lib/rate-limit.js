/**
 * Per-provider daily request cap, persisted in chrome.storage.local.
 * Keeps a runaway loop or curious user from torching the OpenRouter balance,
 * and lets the user raise/lower the caps in Settings.
 *
 * Storage:
 *   rateLimits: { openrouter: number, groq: number }   // user-set caps
 *   rateUsage:  { openrouter: { day, count }, groq: { day, count } }
 *
 * `day` is a local-time YYYY-MM-DD string; when it rolls over, the counter
 * resets implicitly (no background sweep needed).
 */

export const DEFAULT_LIMITS = { openrouter: 80, groq: 300 };

function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function load() {
  const { rateLimits = {}, rateUsage = {} } = await chrome.storage.local.get(['rateLimits', 'rateUsage']);
  return { rateLimits, rateUsage };
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
  const { rateLimits, rateUsage } = await load();
  const limit = limitFor(rateLimits, provider);
  const day = todayKey();
  const used = currentCount(rateUsage[provider], day);
  if (used >= limit) {
    const name = provider === 'openrouter' ? 'OpenRouter' : 'Groq';
    throw new Error(
      `Дневной лимит ${name} исчерпан (${used}/${limit}). ` +
      `Изменить лимит можно в настройках расширения, либо дождитесь завтра — счётчик сбросится.`
    );
  }
  const next = { ...rateUsage, [provider]: { day, count: used + 1 } };
  await chrome.storage.local.set({ rateUsage: next });
}

/** Snapshot of today's usage for each provider. Used by Settings. */
export async function getUsage() {
  const { rateLimits, rateUsage } = await load();
  const day = todayKey();
  const out = {};
  for (const p of ['openrouter', 'groq']) {
    out[p] = {
      used: currentCount(rateUsage[p], day),
      limit: limitFor(rateLimits, p)
    };
  }
  return out;
}
