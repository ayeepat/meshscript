/**
 * Provider dispatcher. Chooses the AI backend based on the 'aiProvider'
 * setting in chrome.storage.local, falling back to config.DEFAULT_PROVIDER.
 *
 * The picker that writes that setting is hidden from students
 * (config.SHOW_PROVIDER_UI), so in practice fresh installs never set it and
 * land on the licensed default. An install that still carries a BYO value from
 * an earlier build keeps working as long as its key is there — see
 * resolveStoredProvider below.
 *
 * Four stable client routes: OpenRouter and Groq for grandfathered BYO users,
 * Think (`qwen`), and Auto (`deepseek`, a legacy wire id). The live VPS model
 * control currently resolves Auto to Qwen 3.7 Plus; retaining the route id
 * lets already-installed Chrome builds switch models without an update.
 * A hidden Alibaba BYO key still makes the legacy route call real DeepSeek
 * directly, so that compatibility path remains text-only.
 */
import { askOpenRouter } from './openrouter.js';
import { askGroq } from './groq.js';
import { askQwen, getByoKey } from './qwen.js';
import { askDeepseek } from './deepseek.js';
import { isImageFile, isPdfFile } from './file-kinds.js';
import { SECURITY_GUARD } from './security-prompt.js';
import { consentNetworkSignal } from './consent.js';
import { DEFAULT_PROVIDER, SHOW_PROVIDER_UI } from './config.js';

export const AI_PROVIDERS = ['openrouter', 'groq', 'qwen', 'deepseek'];

// Which stored providers need a key the user pasted themselves.
const BYO_KEY_FIELD = { openrouter: 'openrouterApiKey', groq: 'groqApiKey' };

export function normalizeAIProvider(provider, fallback = DEFAULT_PROVIDER) {
  return AI_PROVIDERS.includes(provider) ? provider : fallback;
}

/**
 * The licensed Auto route is vision-capable. Only the hidden BYO version still
 * points at text-only DeepSeek and therefore needs Qwen for visual material.
 */
export function routeVisionPreferredProvider(
  provider,
  visionPreferred = false,
  legacyDeepseekByo = false,
) {
  return visionPreferred && legacyDeepseekByo && provider === 'deepseek' ? 'qwen' : provider;
}

/**
 * Resolve the stored `aiProvider` into one that can actually answer.
 *
 * With the picker hidden there is no longer any way to paste an OpenRouter or
 * Groq key, so an install left pointing at one of those without a stored key
 * would dead-end on every «Решить». Grandfather the ones that DO have a key —
 * an existing user who set this up in an earlier build keeps their setup — and
 * route everyone else to the licensed default.
 */
export async function resolveStoredProvider(stored) {
  const chosen = normalizeAIProvider(stored);
  const field = BYO_KEY_FIELD[chosen];
  if (!field || SHOW_PROVIDER_UI) return chosen;
  const { [field]: key } = await chrome.storage.local.get(field);
  return key ? chosen : DEFAULT_PROVIDER;
}

export async function askAI(systemPrompt, userText, files = [], history = [], opts = {}) {
  // SECURITY_GUARD always leads the system message. `systemPrompt` is assembled
  // only from packaged constants and allowlisted modes; all page/user content
  // stays in user-role task data and history.
  const hardenedSystemPrompt = `${SECURITY_GUARD}\n\n${systemPrompt}`;
  const { aiProvider } = await chrome.storage.local.get('aiProvider');
  // opts.provider takes precedence over the stored setting. It still passes
  // through the same availability resolver: the popup and in-page test pill
  // can carry a legacy BYO value, and while the picker is hidden a missing key
  // must fall back to the licensed default instead of dead-ending.
  let chosen = await resolveStoredProvider(
    AI_PROVIDERS.includes(opts.provider) ? opts.provider : aiProvider
  );
  // Images can live in the current turn or replayed history. PDFs count too:
  // direct DashScope cannot consume our file part, while the licensed proxy
  // sends them through its verified PDF chain.
  if (chosen === 'deepseek') {
    const hasImages = files.some(isImageFile) ||
      history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));
    const hasPdfs = files.some(isPdfFile) ||
      history.some((m) => m.role !== 'assistant' && m.files?.some(isPdfFile));
    const needsVisionFallback = opts.visionPreferred === true || hasImages || hasPdfs;
    if (needsVisionFallback) {
      chosen = routeVisionPreferredProvider(chosen, true, Boolean(await getByoKey()));
    }
  }
  // Tag the usage frame with the provider we actually routed to, so callers
  // (telemetry) don't have to re-derive it. Pure pass-through when no onUsage.
  // This is the centralized last gate immediately before any provider
  // dispatcher can call fetch(). It re-reads consent after all slow capture /
  // attachment preparation and aborts an in-flight request on withdrawal.
  const networkSignal = await consentNetworkSignal(opts.signal || null);
  const routed = opts.onUsage
    ? { ...opts, signal: networkSignal, onUsage: (usage) => opts.onUsage(usage, chosen) }
    : { ...opts, signal: networkSignal };
  if (chosen === 'groq') return askGroq(hardenedSystemPrompt, userText, files, history, routed);
  if (chosen === 'qwen') return askQwen(hardenedSystemPrompt, userText, files, history, routed);
  if (chosen === 'deepseek') return askDeepseek(hardenedSystemPrompt, userText, files, history, routed);
  return askOpenRouter(hardenedSystemPrompt, userText, files, history, routed);
}
