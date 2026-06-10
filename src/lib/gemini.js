/**
 * Gemini API wrapper. Runs ONLY in the background service worker.
 * The API key is entered by the user in Settings and stored in
 * chrome.storage.local. It is NEVER hardcoded and NEVER exposed to
 * content scripts.
 */

const MODEL = 'gemini-2.0-flash';
const ENDPOINT = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;

async function getKey() {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
  if (!geminiApiKey) throw new Error('Gemini API key not set. Open Settings.');
  return geminiApiKey;
}

/**
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {Array<{mimeType:string, dataBase64:string}>} files inline files
 * @param {Array<{role:string, content:string}>} history prior chat turns
 * @returns {Promise<string>}
 */
export async function askGemini(systemPrompt, userText, files = [], history = []) {
  const key = await getKey();
  const parts = [{ text: userText }];
  for (const f of files) {
    parts.push({ inline_data: { mime_type: f.mimeType, data: f.dataBase64 } });
  }
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [
      ...history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      { role: 'user', parts }
    ]
  };
  const res = await fetch(ENDPOINT(key), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const out = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n');
  return out || '(пустой ответ)';
}
