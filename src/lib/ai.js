/**
 * Provider dispatcher. Chooses the AI backend based on the 'aiProvider'
 * setting in chrome.storage.local. Defaults to OpenRouter (Gemini 2.5 Flash).
 *
 * Three providers: OpenRouter (paid, main solver), Groq (free, menial tasks),
 * and NaraRouter (free gateway — Mistral Medium 3.5 for vision, MiMo V2.5 Pro
 * for text). opts {onDelta, responseFormat} are forwarded for streaming / JSON.
 */
import { askOpenRouter } from './openrouter.js';
import { askGroq } from './groq.js';
import { askNararouter } from './nararouter.js';

export async function askAI(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { aiProvider = 'openrouter' } = await chrome.storage.local.get('aiProvider');
  // opts.provider forces a backend regardless of the setting. The solver uses
  // it to route PDF solves to OpenRouter: neither Groq nor NaraRouter reads PDFs
  // and would otherwise hallucinate an answer to a file it never actually saw.
  const chosen = opts.provider || aiProvider;
  if (chosen === 'groq') return askGroq(systemPrompt, userText, files, history, opts);
  if (chosen === 'nararouter') return askNararouter(systemPrompt, userText, files, history, opts);
  return askOpenRouter(systemPrompt, userText, files, history, opts);
}
