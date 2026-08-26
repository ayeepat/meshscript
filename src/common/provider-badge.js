/**
 * Tiny read-only "which AI service is active" indicator (GRQ / OPR / QWN / DSK).
 *
 * A small detail so the user knows which provider will answer BEFORE they hit
 * Solve. Never clickable. Reflects the `aiProvider` setting and updates live if
 * it's changed in another extension page (Settings) while this one is open.
 *
 * The in-page test pill (a classic content script that can't import ES modules)
 * carries its own inlined copy of this — keep PROVIDER_ABBR in sync there.
 *
 * Dormant while config.SHOW_PROVIDER_UI is false: mountProviderBadge leaves the
 * element hidden so no vendor name reaches the student.
 */
import { DEFAULT_PROVIDER, SHOW_PROVIDER_UI } from '../lib/config.js';

export const PROVIDER_ABBR = { groq: 'GRQ', openrouter: 'OPR', qwen: 'QWN', deepseek: 'DSK' };
export const PROVIDER_NAME = { groq: 'Groq', openrouter: 'OpenRouter', qwen: 'Qwen', deepseek: 'DeepSeek' };

function pick(provider) {
  const p = PROVIDER_ABBR[provider] ? provider : DEFAULT_PROVIDER;
  return { abbr: PROVIDER_ABBR[p], name: PROVIDER_NAME[p] };
}

/**
 * Wire an element to always show the current provider abbreviation. Sets its
 * text + a hover title (full name), reveals it, and keeps it in sync when the
 * setting changes elsewhere. Best-effort: a missing element is a silent no-op.
 * @param {HTMLElement|string} elOrId element or its id
 */
export async function mountProviderBadge(elOrId) {
  if (!SHOW_PROVIDER_UI) return;
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  const paint = ({ abbr, name }) => {
    el.textContent = abbr;
    el.title = `Сейчас отвечает: ${name}`;
    el.hidden = false;
  };
  // Subscribe before the initial asynchronous read. Otherwise a Settings
  // change between get() starting and its stale snapshot resolving is missed,
  // and the old snapshot paints over the user's newer provider for the rest of
  // this page lifetime.
  let generation = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.aiProvider) {
      generation++;
      paint(pick(changes.aiProvider.newValue || DEFAULT_PROVIDER));
    }
  });
  const readGeneration = generation;
  const { aiProvider = DEFAULT_PROVIDER } = await chrome.storage.local.get('aiProvider');
  if (generation === readGeneration) paint(pick(aiProvider));
}
