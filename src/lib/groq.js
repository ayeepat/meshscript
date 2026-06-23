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

import { postStream, httpError } from './http.js';
import { isImageFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8, base64ToBytes } from './extract.js';
import { chargeOne } from './rate-limit.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TEXT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// Whisper on Groq (free tier) — turns a listening (аудирование) clip into text
// so the normal solver can answer it. Multipart endpoint, NOT chat completions.
const TRANSCRIBE_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';
const TRANSCRIBE_TIMEOUT_MS = 90000; // a few-MB clip can take a while to process

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
  const { onDelta = null, responseFormat = null, signal = null } = opts;
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

  // ALWAYS stream, same as openrouter.js: the idle-timeout-per-chunk behaviour
  // keeps a slow vision reply from tripping the hard timeout that made the test
  // solver hang. onDelta may be null in JSON mode — postStream accumulates and
  // returns the full text. (On the vision path response_format is intentionally
  // dropped above, so the streamed text may be plain prose; the popup's tiered
  // parser salvages it.)
  return postStream(ENDPOINT, { headers, body, label: 'Groq', onDelta, signal });
}

/**
 * Transcribe an audio file with Groq Whisper. Listening homework ships as an
 * audio clip the solver model can't hear; turning it into text here lets the
 * normal solve path answer it. Returns the transcript (possibly empty).
 *
 * Uses the multipart transcriptions endpoint (NOT chat), so we fetch directly
 * instead of going through postStream/postJson — but non-OK responses still get
 * the shared friendly-Russian error mapping via httpError.
 *
 * @param {{mimeType?:string, dataBase64:string, name?:string}} file
 * @param {{language?:string, prompt?:string, signal?:AbortSignal}} [opts]
 * @returns {Promise<string>}
 */
export async function transcribeAudio(file, opts = {}) {
  const { language = null, prompt = null, signal = null } = opts;
  const key = await getKey();
  // Charge BEFORE the round-trip, same as askGroq — a transcription is a real
  // Groq call and counts against the daily cap.
  await chargeOne('groq');

  const bytes = base64ToBytes(file.dataBase64 || '');
  const blob = new Blob([bytes], { type: file.mimeType || 'audio/mpeg' });
  const form = new FormData();
  // The filename's extension is how Groq infers the codec, so keep a real one.
  form.append('file', blob, file.name || 'audio.mp3');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRANSCRIBE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(TRANSCRIBE_ENDPOINT, {
      method: 'POST',
      // Authorization only — let fetch set the multipart Content-Type boundary.
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw httpError('Groq (расшифровка аудио)', res.status, text);
    }
    const json = await res.json().catch(() => null);
    return (json && typeof json.text === 'string') ? json.text.trim() : '';
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
