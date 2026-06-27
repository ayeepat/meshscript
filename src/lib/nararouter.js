/**
 * NaraRouter API wrapper (OpenAI-compatible chat completions).
 * A free model gateway (router.bynara.id) — 7M tokens/day on the free tier,
 * reset daily at 07:00 WIB, rate-limited to ~10 requests/min. Runs ONLY in the
 * background service worker. Key is entered in Settings and stored in
 * chrome.storage.local. Never hardcoded, never exposed to content scripts.
 *
 * Role: a FREE alternative to OpenRouter for the user's own testing. Like Groq
 * it splits text vs. vision across two models:
 *  - Text only:                 mimo-v2.5-pro-free
 *  - Vision (images / test screenshots / any upload that needs seeing):
 *                               mistral-medium-3.5
 *
 * NOTE on model aliases: these must match what `GET /v1/models` returns for your
 * plan. The free lineup has been seen advertised as `mistral-medium-3-5`
 * (dashes) too — if a call 400s with "unknown model", check the dashboard and
 * adjust the two constants below.
 *
 * Caveats vs. OpenRouter (kept deliberately out of this file's job):
 *  - No native PDF reading — the solver still forces OpenRouter for PDFs.
 *  - No OpenRouter-style `reasoning` channel — we don't forward opts.reasoning.
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies (only sent on the text path; the vision path relies on
 * the prompt + the caller's tiered JSON parser, mirroring groq.js).
 */

import { postStream } from './http.js';
import { isImageFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { chargeOne } from './rate-limit.js';

const ENDPOINT = 'https://router.bynara.id/v1/chat/completions';
const TEXT_MODEL = 'mimo-v2.5-pro-free';
const VISION_MODEL = 'mistral-medium-3.5';

async function getKey() {
  const { nararouterApiKey } = await chrome.storage.local.get('nararouterApiKey');
  if (!nararouterApiKey) throw new Error('Ключ NaraRouter не задан. Откройте настройки расширения.');
  return nararouterApiKey;
}

// One file -> one OpenAI-style content part. NaraRouter (like Groq) has no native
// PDF path, so non-image / non-text files are described in a note. Shared by the
// current message and by replayed history turns so attachments survive follow-ups.
function fileToContentPart(f) {
  if (isImageFile(f)) {
    const m = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (isTextFile(f)) {
    // Plain text and locally-extracted Office docs (see extract.js) — inline the
    // contents so the model actually reads them instead of refusing.
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

export async function askNararouter(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, signal = null } = opts;
  const key = await getKey();
  // Charge the daily budget BEFORE the network round-trip — same reasoning as
  // openrouter.js / groq.js: a runaway loop can't burn through the day's tokens.
  await chargeOne('nararouter');

  // Pick the vision model if EITHER the current message OR a replayed history
  // turn carries an image — otherwise a follow-up would route to the text model
  // and lose the original photo (same logic as groq.js).
  const hasImages = files.some(isImageFile) ||
    history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));
  const model = hasImages ? VISION_MODEL : TEXT_MODEL;

  const userContent = buildUserContent(userText, files);

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map(historyToMessage),
      // files.length (not hasImages): a non-image attachment still needs its
      // "can't read this directly" note delivered to the model.
      { role: 'user', content: files.length ? userContent : userText }
    ],
    temperature: 0.3
  };
  // JSON mode only on the TEXT model. The vision path (mistral-medium-3.5) is the
  // test solver's path, and an unknown free gateway can hard-error on
  // response_format with an image; the TEST_ANSWER prompt already mandates a JSON
  // object and the caller salvages partial/non-JSON replies (parseTestAnswers /
  // formatTestAnswers), so dropping the flag on vision is safe. Mirrors groq.js.
  if (responseFormat === 'json_object' && !hasImages) body.response_format = { type: 'json_object' };

  // We intentionally do NOT forward opts.reasoning: it's an OpenRouter-specific
  // param and these models aren't reasoning models on the free tier.

  const headers = { Authorization: `Bearer ${key}` };

  // ALWAYS stream, same as openrouter.js / groq.js: the per-chunk idle timeout
  // keeps a slow vision reply from tripping the hard timeout that made the test
  // solver hang. onDelta may be null in JSON mode — postStream accumulates and
  // returns the full text.
  return postStream(ENDPOINT, { headers, body, label: 'NaraRouter', onDelta, signal });
}
