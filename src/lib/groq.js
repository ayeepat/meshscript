/**
 * Groq API wrapper (OpenAI-compatible chat completions).
 * Free tier, no card / no deposit required. Runs ONLY in the background
 * service worker. Key is entered in Settings and stored in
 * chrome.storage.local, which the worker locks to TRUSTED_CONTEXTS at startup
 * (service-worker.js) — extension pages can read it, content scripts cannot
 * on the manifest's Chrome 102+ baseline, and page scripts never could. Never
 * hardcoded.
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

import { postStream, httpError, readResponseTextBounded, fetchTextBounded } from './http.js';
import { isImageFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8, base64ToBytes } from './extract.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { clipText } from './clip-text.js';
import { consentNetworkSignal } from './consent.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TEXT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

// Whisper on Groq (free tier) — turns a listening (аудирование) clip into text
// so the normal solver can answer it. Multipart endpoint, NOT chat completions.
const TRANSCRIBE_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const WHISPER_MODEL = 'whisper-large-v3';
const TRANSCRIBE_TIMEOUT_MS = 90000; // a few-MB clip can take a while to process

// Cheapest authenticated endpoint: lists models without spending tokens.
const MODELS_ENDPOINT = 'https://api.groq.com/openai/v1/models';

async function getKey() {
  const { groqApiKey } = await chrome.storage.local.get('groqApiKey');
  if (!groqApiKey) throw new Error('Ключ Groq не задан. Откройте настройки расширения.');
  return groqApiKey;
}

/**
 * Validate a Groq API key for onboarding: 200 = works, 401/403 = definitively
 * rejected. Anything else (network error, 5xx, rate limit) is ambiguous and
 * reported as 'unreachable' so callers can keep a possibly-good key instead of
 * bouncing the user — mirroring license.js's keep-last-good policy.
 * @param {string} apiKey the candidate key (NOT read from storage)
 * @returns {Promise<{ok:true}|{ok:false,reason:'bad_key'|'unreachable'}>}
 */
export async function verifyGroqKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'bad_key' };
  try {
    const res = await fetchTextBounded(MODELS_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error'
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'bad_key' };
    return { ok: false, reason: 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
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
    // Plain text and locally-extracted Office docs (see extract.js) — inline a
    // marked prefix so Groq reads them and knows if the source is clipped.
    const text = base64ToUtf8(f.dataBase64);
    return {
      type: 'text',
      text: text
        ? `[Содержимое приложенного файла «${f.name || 'файл'}»]:\n${clipText(text, 50000)}`
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
  const { onDelta = null, responseFormat = null, signal = null, onUsage = null, onReasoning = null } = opts;
  const key = await getKey();
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
    temperature: 0.3,
    // Emit a final usage frame (token counts) at the end of the stream —
    // postStream picks it up for telemetry. Groq is free, so cost stays 0;
    // the token counts still feed the usage charts.
    stream_options: { include_usage: true }
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
  const reservation = await reserveOne('groq');
  try {
    const result = await postStream(ENDPOINT, { headers, body, label: 'Groq', onDelta, onUsage, onReasoning, signal });
    await commitOne(reservation);
    return result;
  } catch (e) {
    try { await cancelOne(reservation); } catch { /* orphan expires without becoming usage */ }
    throw e;
  }
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
  const reservation = await reserveOne('groq');

  try {
    const bytes = base64ToBytes(file.dataBase64 || '');
    const blob = new Blob([bytes], { type: file.mimeType || 'audio/mpeg' });
    const form = new FormData();
    // The filename's extension is how Groq infers the codec, so keep a real one.
    form.append('file', blob, file.name || 'audio.mp3');
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');
    if (language) form.append('language', language);
    if (prompt) form.append('prompt', prompt);

    // Re-read consent after hashing/cache/key/quota preparation, at the actual
    // transcription network boundary. An already-aborted combined signal
    // prevents fetch from emitting a request at all.
    const networkSignal = await consentNetworkSignal(signal);
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, TRANSCRIBE_TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    if (networkSignal) networkSignal.addEventListener('abort', onAbort, { once: true });
    const throwIfReadAborted = () => {
      if (!ctrl.signal.aborted) return;
      if (networkSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timedOut) {
        throw new Error('Groq (расшифровка аудио): превышено время ожидания. Попробуйте ещё раз.');
      }
      throw new DOMException('Aborted', 'AbortError');
    };
    try {
      const res = await fetch(TRANSCRIBE_ENDPOINT, {
        method: 'POST',
        // Authorization only — let fetch set the multipart Content-Type boundary.
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        redirect: 'error',
        signal: ctrl.signal
      });
      if (!res.ok) {
        const text = await readResponseTextBounded(res);
        // The bounded reader deliberately converts body-stream failures into a
        // partial/empty string. Restore timeout/caller-abort semantics before
        // interpreting that string as a provider response.
        throwIfReadAborted();
        throw httpError('Groq (расшифровка аудио)', res.status, text);
      }
      let json = null;
      const responseText = await readResponseTextBounded(res);
      throwIfReadAborted();
      try { json = JSON.parse(responseText || 'null'); } catch { /* malformed */ }
      const text = (json && typeof json.text === 'string') ? json.text.trim() : '';
      await commitOne(reservation);
      return text;
    } finally {
      clearTimeout(timer);
      if (networkSignal) networkSignal.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    try { await cancelOne(reservation); } catch { /* orphan expires without becoming usage */ }
    throw e;
  }
}
