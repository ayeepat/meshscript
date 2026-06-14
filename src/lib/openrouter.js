/**
 * OpenRouter API wrapper (OpenAI-compatible chat completions).
 * Main model: google/gemini-2.5-flash (text, images AND PDFs natively).
 * Runs ONLY in the background service worker.
 *
 * Streams when opts.onDelta is given; otherwise does a single JSON round-trip.
 * Set opts.responseFormat = 'json_object' for structured replies (test solver).
 */

import { postJson, postStream } from './http.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';

// Decode a base64 payload to UTF-8 text (service worker has no FileReader).
function b64ToUtf8(b64) {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { return null; }
}

async function getKey() {
  const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
  if (!openrouterApiKey) throw new Error('Ключ OpenRouter не задан. Откройте настройки расширения.');
  return openrouterApiKey;
}

export async function askOpenRouter(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null } = opts;
  const key = await getKey();

  const content = [{ type: 'text', text: userText }];
  for (const f of files) {
    const mime = f.mimeType || 'application/octet-stream';
    const name = f.name || '';
    if (isImageFile(f)) {
      const m = mime.startsWith('image/') ? mime : 'image/png';
      content.push({ type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } });
    } else if (isPdfFile(f)) {
      // Gemini 2.5 reads PDFs (incl. scanned pages) natively; OpenRouter routes
      // the file to the model directly when no file-parser plugin is set.
      content.push({ type: 'file', file: { filename: name || 'file.pdf', file_data: `data:application/pdf;base64,${f.dataBase64}` } });
    } else if (isTextFile(f)) {
      // Plain-text files (.txt/.csv/.md/…) can't go as a "file" part, but we CAN
      // read them — inline the contents so the model actually sees the task.
      const text = b64ToUtf8(f.dataBase64);
      content.push({
        type: 'text',
        text: text
          ? `[Содержимое приложенного файла «${name || 'файл'}»]:\n${text.slice(0, 50000)}`
          : `[Приложен файл ${name || mime}, не удалось прочитать его как текст.]`
      });
    } else {
      // Office formats (Word/PowerPoint/Excel) aren't readable by this provider.
      // Say so honestly — the guard forbids inventing their contents.
      content.push({
        type: 'text',
        text: `[Приложен файл ${name || ''} (${mime}). Офисные файлы (Word/PowerPoint/Excel) я не читаю напрямую — пришлите PDF, фото или скриншот его содержимого. НЕ выдумывай содержимое этого файла.]`
      });
    }
  }

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      { role: 'user', content: files.length ? content : userText }
    ],
    temperature: 0.3
  };
  if (responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const headers = {
    Authorization: `Bearer ${key}`,
    'HTTP-Referer': 'https://gitlab.com/tes738882-group/meshscript',
    'X-Title': 'meshscript'
  };

  // Stream only for free-form solves; JSON-mode replies are parsed whole.
  if (onDelta && responseFormat !== 'json_object') {
    return postStream(ENDPOINT, { headers, body, label: 'OpenRouter', onDelta });
  }

  const json = await postJson(ENDPOINT, { headers, body, label: 'OpenRouter' });
  return json?.choices?.[0]?.message?.content || '(пустой ответ)';
}
