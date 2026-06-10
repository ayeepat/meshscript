/**
 * OpenRouter API wrapper (OpenAI-compatible chat completions).
 * Main model: google/gemini-2.5-flash (handles text, images AND PDFs natively).
 * Runs ONLY in the background service worker. Key is entered in Settings and
 * stored in chrome.storage.local. Never hardcoded, never exposed to content scripts.
 * Get a key at https://openrouter.ai/keys
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';

async function getKey() {
  const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
  if (!openrouterApiKey) throw new Error('OpenRouter API key not set. Open Settings.');
  return openrouterApiKey;
}

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {Array<{mimeType:string, dataBase64:string, name?:string}>} files inline files
 * @returns {Promise<string>}
 */
export async function askOpenRouter(systemPrompt, userText, files = []) {
  const key = await getKey();

  const content = [{ type: 'text', text: userText }];
  for (const f of files) {
    const mime = f.mimeType || 'application/octet-stream';
    if (mime.startsWith('image/')) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${f.dataBase64}` }
      });
    } else if (mime === 'application/pdf') {
      // OpenRouter supports PDFs directly via the 'file' content part.
      content.push({
        type: 'file',
        file: { filename: f.name || 'file.pdf', file_data: `data:${mime};base64,${f.dataBase64}` }
      });
    } else {
      content.push({
        type: 'text',
        text: `[Приложен файл ${mime}, который нельзя прочитать напрямую. Попросите фото/скриншот или PDF.]`
      });
    }
  }

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: files.length ? content : userText }
    ],
    temperature: 0.3
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      'HTTP-Referer': 'https://gitlab.com/tes738882-group/meshscript',
      'X-Title': 'meshscript'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || '(пустой ответ)';
}
