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
import { isImageFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { chargeOne } from './rate-limit.js';

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
// One file -> one OpenAI-style content part. Groq has no native PDF path, so
// non-image / non-text files are described in a note. Shared by the current
// message and by replayed history turns so attachments survive follow-ups.
function fileToContentPart(f) {
  if (isImageFile(f)) {
    const m = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (isTextFile(f)) {
    // Plain text and locally-extracted Office docs (see extract.js) — inline
    // the contents so Groq actually reads them instead of refusing.
    const text = base64ToUtf8(f.dataBase64);
    return {
      type: 'text',
      text: text
        ? `[Содержимое приложенного файла «${f.name || 'файл'}»]:\n${text.slice(0, 50000)}`
        : `[Приложен файл ${f.name || ''}, не удалось прочитать его как текст.]`
    };
  }
  return {
    type: 'text',
    text: `[Приложен файл ${f.name || ''} (${f.mimeType}), который нельзя прочитать напрямую. Попросите фото/скриншот или PDF, если нужен текст. Не выдумывай его содержимое.]`
  };
}

function buildUserContent(userText, files) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f));
  return content;
}

function historyToMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) return { role, content: buildUserContent(m.content || '', m.files) };
  return { role, content: m.content };
}

export async function askGroq(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null } = opts;
  const key = await getKey();
  // Charge the daily budget BEFORE the network round-trip — same reasoning as
  // openrouter.js. classify-ai imports askGroq directly, so charging here
  // covers every Groq call path, not just the dispatcher's.
  await chargeOne('groq');
  // Pick the vision model if EITHER the current message OR a replayed history
  // turn carries an image — otherwise a follow-up would route to the text model
  // and lose the original photo.
  const hasImages = files.some(isImageFile) ||
    history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));
  const model = hasImages ? VISION_MODEL : TEXT_MODEL;

  // Build OpenAI-style content. Images go as data URLs; non-image files
  // (e.g. PDF/Word) can't be read directly here, so we note them in text.
  const userContent = buildUserContent(userText, files);

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map(historyToMessage),
      // files.length (not hasImages): a PDF/Word attachment still needs its
      // "can't read this directly" note delivered to the model.
      { role: 'user', content: files.length ? userContent : userText }
    ],
    temperature: 0.3
  };
  // Groq's vision model (llama-4-scout) does NOT reliably honour
  // response_format:json_object — the call can hard-error or return non-JSON.
  // So request JSON mode only on the TEXT model. The TEST_ANSWER prompt already
  // mandates a JSON object, and the popup salvages partial/non-JSON replies
  // (see formatTestAnswers), so dropping the flag here is safe on the vision path.
  if (responseFormat === 'json_object' && !hasImages) body.response_format = { type: 'json_object' };

  const headers = { Authorization: `Bearer ${key}` };

  if (onDelta && responseFormat !== 'json_object') {
    return postStream(ENDPOINT, { headers, body, label: 'Groq', onDelta });
  }

  const json = await postJson(ENDPOINT, { headers, body, label: 'Groq' });
  return json?.choices?.[0]?.message?.content || '(пустой ответ)';
}
