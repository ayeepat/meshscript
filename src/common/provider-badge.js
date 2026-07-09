/**
 * Tiny read-only "which AI service is active" indicator (GRQ / OPR / QWN / DSK).
 *
 * A small detail so the user knows which provider will answer BEFORE they hit
 * Solve. Never clickable. Reflects the `aiProvider` setting and updates live if
 * it's changed in another extension page (Settings) while this one is open.
 *
 * The in-page test pill (a classic content script that can't import ES modules)
 * carries its own inlined copy of this — keep PROVIDER_ABBR in sync there.
 */

export const PROVIDER_ABBR = { groq: 'GRQ', openrouter: 'OPR', qwen: 'QWN', deepseek: 'DSK' };
const PROVIDER_NAME = { groq: 'Groq', openrouter: 'OpenRouter', qwen: 'Qwen', deepseek: 'DeepSeek' };

function pick(provider) {
  const p = PROVIDER_ABBR[provider] ? provider : 'openrouter';
  return { abbr: PROVIDER_ABBR[p], name: PROVIDER_NAME[p] };
}

/**
 * Wire an element to always show the current provider abbreviation. Sets its
 * text + a hover title (full name), reveals it, and keeps it in sync when the
 * setting changes elsewhere. Best-effort: a missing element is a silent no-op.
 * @param {HTMLElement|string} elOrId element or its id
 */
export async function mountProviderBadge(elOrId) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  const paint = ({ abbr, name }) => {
    el.textContent = abbr;
    el.title = `Сейчас отвечает: ${name}`;
    el.hidden = false;
  };
  const { aiProvider = 'openrouter' } = await chrome.storage.local.get('aiProvider');
  paint(pick(aiProvider));
  // Live-update if the provider is switched in Settings while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.aiProvider) paint(pick(changes.aiProvider.newValue || 'openrouter'));
  });
}
