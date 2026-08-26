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
 * Four providers: OpenRouter (BYO key, main solver, reads PDFs natively),
 * Groq (BYO free key, vision + text, also transcribes listening audio — see
 * groq.js's transcribeAudio), Qwen (qwen3.7-plus —
 * vision + text) and DeepSeek (deepseek-v4-flash — cheapest, TEXT ONLY, no
 * vision). Qwen and DeepSeek need NO user key: they run through the СМЭШ
 * license proxy (smesh-proxy.js), with a hidden BYO Alibaba-key path for
 * power users (see qwen.js/deepseek.js). opts {onDelta, responseFormat} are
 * forwarded for streaming / JSON.
 */
import { askOpenRouter } from './openrouter.js';
import { askGroq } from './groq.js';
import { askQwen } from './qwen.js';
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
  // DeepSeek V4 has no vision at all — a test screenshot or photo sent there
  // would come back as a guess about an image the model never saw. Requests
  // that carry an image (in this turn OR replayed history) auto-upgrade to
  // Qwen: both run on the same Alibaba Model Studio key, so if DeepSeek was
  // selectable at all, Qwen is guaranteed to work too.
  if (chosen === 'deepseek') {
    const hasImages = files.some(isImageFile) ||
      history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));
    // A PDF in a replayed turn is still part of this provider request. Looking
    // only at the current turn silently routed follow-ups to a text-only model,
    // which then guessed about the document it could not read.
    const hasPdfs = files.some(isPdfFile) ||
      history.some((m) => m.role !== 'assistant' && m.files?.some(isPdfFile));
    if (hasImages || hasPdfs) chosen = 'qwen';
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
