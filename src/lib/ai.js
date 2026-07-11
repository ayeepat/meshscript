/**
 * Provider dispatcher. Chooses the AI backend based on the 'aiProvider'
 * setting in chrome.storage.local. Defaults to OpenRouter (Gemini 2.5 Flash).
 *
 * Four providers: OpenRouter (BYO key, main solver, reads PDFs natively),
 * Groq (BYO free key, vision + text, also the fallback for classification/
 * audio — see classify-ai.js/groq.js's transcribeAudio), Qwen (qwen3.7-plus —
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

export const AI_PROVIDERS = ['openrouter', 'groq', 'qwen', 'deepseek'];

export function normalizeAIProvider(provider, fallback = 'openrouter') {
  return AI_PROVIDERS.includes(provider) ? provider : fallback;
}

export async function askAI(systemPrompt, userText, files = [], history = [], opts = {}) {
  // SECURITY_GUARD always leads the system message. `systemPrompt` is assembled
  // only from packaged constants and allowlisted modes; all page/user content
  // stays in user-role task data and history.
  const hardenedSystemPrompt = `${SECURITY_GUARD}\n\n${systemPrompt}`;
  const { aiProvider } = await chrome.storage.local.get('aiProvider');
  // opts.provider forces a backend regardless of the setting. The solver uses
  // it to route PDF solves to OpenRouter when the СМЭШ proxy can't take them
  // (Groq / BYO-key paths don't read PDFs and would otherwise hallucinate an
  // answer to a file they never saw; the proxy re-routes PDFs to Gemini itself).
  let chosen = normalizeAIProvider(opts.provider, normalizeAIProvider(aiProvider));
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
  const routed = opts.onUsage
    ? { ...opts, onUsage: (usage) => opts.onUsage(usage, chosen) }
    : opts;
  if (chosen === 'groq') return askGroq(hardenedSystemPrompt, userText, files, history, routed);
  if (chosen === 'qwen') return askQwen(hardenedSystemPrompt, userText, files, history, routed);
  if (chosen === 'deepseek') return askDeepseek(hardenedSystemPrompt, userText, files, history, routed);
  return askOpenRouter(hardenedSystemPrompt, userText, files, history, routed);
}
