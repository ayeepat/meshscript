/**
 * Provider dispatcher. Chooses the AI backend based on the 'aiProvider'
 * setting in chrome.storage.local. Defaults to Groq (free, no billing).
 *   - 'groq'   -> Groq (recommended; free, no card)
 *   - 'gemini' -> Google Gemini (requires working free tier / billing)
 */
import { askGroq } from './groq.js';
import { askGemini } from './gemini.js';

export async function askAI(systemPrompt, userText, files = []) {
  const { aiProvider = 'groq' } = await chrome.storage.local.get('aiProvider');
  if (aiProvider === 'gemini') return askGemini(systemPrompt, userText, files);
  return askGroq(systemPrompt, userText, files);
}
