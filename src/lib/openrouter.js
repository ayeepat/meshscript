/**
 * OpenRouter API wrapper (OpenAI-compatible chat completions).
 * Main model: google/gemini-2.5-flash (text, images AND PDFs natively).
 * Runs ONLY in the background service worker.
 *
 * Streams when opts.onDelta is given; otherwise does a single JSON round-trip.
 * Set opts.responseFormat = 'json_object' for structured replies (test solver).
 */

import { postStream } from './http.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';
import { chargeOne } from './rate-limit.js';

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

// One file -> one OpenAI-style content part. Shared by the current message and
// by replayed history turns, so a file attached on an earlier turn stays in
// context on follow-ups instead of being dropped.
function fileToContentPart(f) {
  const mime = f.mimeType || 'application/octet-stream';
  const name = f.name || '';
  if (isImageFile(f)) {
    const m = mime.startsWith('image/') ? mime : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (isPdfFile(f)) {
    // Gemini 2.5 reads PDFs (incl. scanned pages) natively; OpenRouter routes
    // the file to the model directly when no file-parser plugin is set.
    return { type: 'file', file: { filename: name || 'file.pdf', file_data: `data:application/pdf;base64,${f.dataBase64}` } };
  }
  if (isTextFile(f)) {
    // Plain-text files (.txt/.csv/.md/…) can't go as a "file" part, but we CAN
    // read them — inline the contents so the model actually sees the task.
    const text = b64ToUtf8(f.dataBase64);
    return {
      type: 'text',
      text: text
        ? `[Содержимое приложенного файла «${name || 'файл'}»]:\n${text.slice(0, 50000)}`
        : `[Приложен файл ${name || mime}, не удалось прочитать его как текст.]`
    };
  }
  // Office formats (Word/PowerPoint/Excel) aren't readable by this provider.
  // Non-blocking wording: if there's other readable material (e.g. a PDF),
  // the model must still solve from it and just ignore this file — otherwise
  // a tag-along .docx made it refuse the whole task. Only ask for it if this
  // file is genuinely required. Never invent its contents.
  return {
    type: 'text',
    text: `[Приложен файл ${name || ''} (${mime}). Офисные файлы (Word/PowerPoint/Excel) я не читаю напрямую. ` +
      `Если для этого задания есть другой материал (PDF/фото/текст) — реши по нему, а этот файл просто проигнорируй. ` +
      `Если же он действительно нужен — попроси прислать его как PDF/фото. Содержимое этого файла НЕ выдумывай.]`
  };
}

function buildContent(userText, files) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f));
  return content;
}

// Map a stored history turn to an API message. User turns that carried files are
// rebuilt as multi-part content so the attachment survives into follow-ups.
function historyToMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) return { role, content: buildContent(m.content || '', m.files) };
  return { role, content: m.content };
}

export async function askOpenRouter(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, reasoning = null, signal = null } = opts;
  const key = await getKey();
  // Charge the daily budget BEFORE the network round-trip so a runaway loop
  // can't drain credit; chargeOne throws a Russian-language error past the
  // cap which the existing error path surfaces verbatim to the UI.
  await chargeOne('openrouter');

  const content = buildContent(userText, files);

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map(historyToMessage),
      { role: 'user', content: files.length ? content : userText }
    ],
    temperature: 0.3
  };
  if (responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  // Native model reasoning (OpenRouter `reasoning` param). The test solver uses
  // this so Gemini THINKS fully in its private reasoning channel, then emits a
  // tiny answers-only JSON as the visible content. Two wins:
  //  1. The full step-by-step solving no longer eats the output-token budget,
  //     so the `answers` array can never get truncated (the old cause of the
  //     panel not showing + raw reasoning leaking to the user).
  //  2. Reasoning tokens arrive on `delta.reasoning`, which postStream ignores
  //     for accumulation — so the user NEVER sees the reasoning, only answers.
  // We do NOT set reasoning.exclude: letting the reasoning deltas stream keeps
  // resetting postStream's idle timeout during long thinks (no silent stall).
  if (reasoning) body.reasoning = reasoning;

  const headers = {
    Authorization: `Bearer ${key}`,
    'HTTP-Referer': 'https://gitlab.com/tes738882-group/meshscript',
    'X-Title': 'smesh'
  };

  // ALWAYS stream — including JSON-mode replies (the test solver). This is the
  // fix for the test feature hanging forever on «Решаю…».
  //
  // The old code sent JSON-mode calls through postJson, whose timeout is a HARD
  // 60-s cap on the whole round-trip. google/gemini-2.5-flash is a reasoning
  // model: with a screenshot + JSON output it routinely spends >60 s "thinking"
  // before the first content token, so the request was aborted at 60 s, then
  // silently retried twice more (re-uploading the screenshot each time) — ~3
  // minutes of a frozen spinner that looked like an infinite hang, then a bare
  // timeout error.
  //
  // postStream instead uses an IDLE timeout that resets on every byte received
  // (reasoning deltas / keep-alives included), so a slow-but-progressing answer
  // completes normally and never trips the timeout. onDelta may be null in JSON
  // mode — postStream just accumulates and returns the full text, which is
  // exactly what solveTest/the popup parse. response_format stays in the body,
  // so the streamed content is still a JSON object.
  return postStream(ENDPOINT, { headers, body, label: 'OpenRouter', onDelta, signal });
}
