/**
 * Licensed AI dispatcher. The two stable wire ids are server-controlled routes:
 * Think (`qwen`) and Auto (`deepseek`). Legacy stored provider ids are reduced
 * to the licensed default. Homework content therefore has one network boundary:
 * the СМЭШ gateway in smesh-proxy.js.
 */
import { askQwen } from './qwen.js';
import { askDeepseek } from './deepseek.js';
import { SECURITY_GUARD } from './security-prompt.js';
import { consentNetworkSignal } from './consent.js';
import { DEFAULT_PROVIDER } from './config.js';

export const AI_PROVIDERS = ['qwen', 'deepseek'];

export function normalizeAIProvider(provider, fallback = DEFAULT_PROVIDER) {
  return AI_PROVIDERS.includes(provider) ? provider : fallback;
}

/**
 * The licensed Auto route is vision-capable. Only the hidden BYO version still
 * points at text-only DeepSeek and therefore needs Qwen for visual material.
 */
export function routeVisionPreferredProvider(provider) {
  return normalizeAIProvider(provider);
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
  return normalizeAIProvider(stored);
}

export async function askAI(systemPrompt, userText, files = [], history = [], opts = {}) {
  // SECURITY_GUARD always leads the system message. `systemPrompt` is assembled
  // only from packaged constants and allowlisted modes; all page/user content
  // stays in user-role task data and history.
  const hardenedSystemPrompt = `${SECURITY_GUARD}\n\n${systemPrompt}`;
  const { aiProvider } = await chrome.storage.local.get('aiProvider');
  // opts.provider takes precedence, but both values pass through the licensed
  // allowlist. Old OpenRouter/Groq selections cannot resurrect direct egress.
  let chosen = await resolveStoredProvider(
    AI_PROVIDERS.includes(opts.provider) ? opts.provider : aiProvider
  );
  // Tag the usage frame with the provider we actually routed to, so callers
  // (telemetry) don't have to re-derive it. Pure pass-through when no onUsage.
  // This is the centralized last gate immediately before any provider
  // dispatcher can call fetch(). It re-reads consent after all slow capture /
  // attachment preparation and aborts an in-flight request on withdrawal.
  const networkSignal = await consentNetworkSignal(opts.signal || null);
  const routed = opts.onUsage
    ? { ...opts, signal: networkSignal, onUsage: (usage) => opts.onUsage(usage, chosen) }
    : { ...opts, signal: networkSignal };
  if (chosen === 'qwen') return askQwen(hardenedSystemPrompt, userText, files, history, routed);
  return askDeepseek(hardenedSystemPrompt, userText, files, history, routed);
}
