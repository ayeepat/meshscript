/**
 * Provider dispatcher. Chooses the AI backend based on the 'aiProvider'
 * setting in chrome.storage.local. Defaults to OpenRouter (Gemini 2.5 Flash).
 */
import { askOpenRouter } from './openrouter.js';
import { askGroq } from './groq.js';
import { askGemini } from './gemini.js';

export async function askAI(systemPrompt, userText, files = [], history = []) {
  const { aiProvider = 'openrouter' } = await chrome.storage.local.get('aiProvider');
  if (aiProvider === 'gemini') return askGemini(systemPrompt, userText, files, history);
  if (aiProvider === 'groq') return askGroq(systemPrompt, userText, files, history);
  return askOpenRouter(systemPrompt, userText, files, history);
}
