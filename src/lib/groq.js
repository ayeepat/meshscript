/**
 * Groq API wrapper (OpenAI-compatible chat completions).
 * Free tier, no card / no deposit required. Runs ONLY in the background
 * service worker. Key is entered in Settings and stored in
 * chrome.storage.local. Never hardcoded, never exposed to content scripts.
 *
 * Groq is the cheap workhorse: classification and other menial tasks go here
 * so the paid OpenRouter budget is spent only on real solving.
 *
 * Models:
 *  - Text:  llama-3.3-70b-versatile
 *  - Vision (images/PDF page photos): meta-llama/llama-4-scout-17b-16e-instruct
 * Get a free key at https://console.groq.com/keys
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies. (json_object disables streaming — parsed whole.)
 */

import { postJson, postStream } from './http.js';
import { isImageFile } from './file-kinds.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TEXT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

async function getKey() {
  const { groqApiKey } = await chrome.storage.local.get('groqApiKey');
  if (!groqApiKey) throw new Error('Ключ Groq не задан. Откройте настройки расширения.');
  return groqApiKey;
}

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {Array<{mimeType:string, dataBase64:string}>} files inline files
 * @param {Array<{role:string, content:string}>} history prior chat turns
 * @param {{onDelta?:(c:string)=>void, responseFormat?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function askGroq(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null } = opts;
  const key = await getKey();
  const hasImages = files.some(isImageFile);
  const model = hasImages ? VISION_MODEL : TEXT_MODEL;

  // Build OpenAI-style content. Images go as data URLs; non-image files
  // (e.g. PDF/Word) can't be read directly here, so we note them in text.
  const userContent = [{ type: 'text', text: userText }];
  for (const f of files) {
    if (isImageFile(f)) {
      const m = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${m};base64,${f.dataBase64}` }
      });
    } else {
      userContent.push({
        type: 'text',
        text: `[Приложен файл ${f.name || ''} (${f.mimeType}), который нельзя прочитать напрямую. Попросите фото/скриншот или PDF, если нужен текст. Не выдумывай его содержимое.]`
      });
    }
  }

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      // files.length (not hasImages): a PDF/Word attachment still needs its
      // "can't read this directly" note delivered to the model.
      { role: 'user', content: files.length ? userContent : userText }
    ],
    temperature: 0.3
  };
  if (responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const headers = { Authorization: `Bearer ${key}` };

  if (onDelta && responseFormat !== 'json_object') {
    return postStream(ENDPOINT, { headers, body, label: 'Groq', onDelta });
  }

  const json = await postJson(ENDPOINT, { headers, body, label: 'Groq' });
  return json?.choices?.[0]?.message?.content || '(пустой ответ)';
}
