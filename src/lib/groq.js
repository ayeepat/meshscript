/**
 * Groq API wrapper (OpenAI-compatible chat completions).
 * Free tier, no card / no deposit required. Runs ONLY in the background
 * service worker. Key is entered in Settings and stored in
 * chrome.storage.local. Never hardcoded, never exposed to content scripts.
 *
 * Models:
 *  - Text:  llama-3.3-70b-versatile
 *  - Vision (images/PDF page photos): meta-llama/llama-4-scout-17b-16e-instruct
 * Get a free key at https://console.groq.com/keys
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TEXT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

async function getKey() {
  const { groqApiKey } = await chrome.storage.local.get('groqApiKey');
  if (!groqApiKey) throw new Error('Groq API key not set. Open Settings.');
  return groqApiKey;
}

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {Array<{mimeType:string, dataBase64:string}>} files inline files
 * @param {Array<{role:string, content:string}>} history prior chat turns
 * @returns {Promise<string>}
 */
export async function askGroq(systemPrompt, userText, files = [], history = []) {
  const key = await getKey();
  const hasImages = files.some((f) => (f.mimeType || '').startsWith('image/'));
  const model = hasImages ? VISION_MODEL : TEXT_MODEL;

  // Build OpenAI-style content. Images go as data URLs; non-image files
  // (e.g. PDF/Word) can't be read directly here, so we note them in text.
  const userContent = [{ type: 'text', text: userText }];
  for (const f of files) {
    if ((f.mimeType || '').startsWith('image/')) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${f.mimeType};base64,${f.dataBase64}` }
      });
    } else {
      userContent.push({
        type: 'text',
        text: `[Приложен файл ${f.mimeType}, который нельзя прочитать напрямую. Попросите фото/скриншот, если нужен текст.]`
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

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json?.choices?.[0]?.message?.content || '(пустой ответ)';
}
