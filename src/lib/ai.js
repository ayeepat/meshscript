/**
 * Provider dispatcher. Chooses the AI backend based on the 'aiProvider'
 * setting in chrome.storage.local. Defaults to OpenRouter (Gemini 2.5 Flash).
 *
 * Two providers only: OpenRouter (paid, main solver) and Groq (free, menial
 * tasks). opts {onDelta, responseFormat} are forwarded for streaming / JSON.
 */
import { askOpenRouter } from './openrouter.js';
import { askGroq } from './groq.js';

export async function askAI(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { aiProvider = 'openrouter' } = await chrome.storage.local.get('aiProvider');
  if (aiProvider === 'groq') return askGroq(systemPrompt, userText, files, history, opts);
  return askOpenRouter(systemPrompt, userText, files, history, opts);
}
