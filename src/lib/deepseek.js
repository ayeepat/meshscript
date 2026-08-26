/**
 * DeepSeek API wrapper — deepseek-v4-flash. Runs ONLY in the background
 * service worker. Same two paths as qwen.js: by DEFAULT requests go through
 * the СМЭШ proxy (license key as credential, no user API key anywhere); a
 * hidden BYO qwenApiKey in storage switches to calling Alibaba Model
 * Studio's OpenAI-compatible endpoint directly (Model Studio hosts DeepSeek
 * alongside Qwen under the SAME account/key, so this file reuses qwen.js's
 * getByoKey() rather than a separate stored key).
 *
 * Role: the cheap SECONDARY solve provider — TEXT ONLY. DeepSeek V4 shipped
 * without vision (roadmap item, not live at launch), so unlike every other
 * provider here, images are NEVER sent as image_url parts — an attached
 * photo/screenshot gets the same "can't read this directly" note as any
 * other unreadable file, so the model never guesses at content it can't see.
 * The askAI dispatcher (ai.js) auto-upgrades image-bearing requests to Qwen
 * (same key), so in practice this note only fires for direct callers.
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies.
 */

import { postStream } from './http.js';
import { askViaProxy } from './smesh-proxy.js';
import { isPdfFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { getByoKey } from './qwen.js';
import { getLicenseStatus } from './license.js';
import { clipText } from './clip-text.js';

// Independent of the proxy's env-configured model (ai-proxy.js
// PROXY_DEEPSEEK_MODEL, now served via 302.AI) — see the matching comment in
// qwen.js: this BYO constant/endpoint was untouched by the 302.AI migration.
const ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

// One file -> one OpenAI-style content part. No image_url branch on purpose —
// see the module docstring: DeepSeek V4 has no vision, so a photo/screenshot
// falls through to the generic "can't read this directly" note below.
// PDFs are the exception, proxy path only (`allowPdf`): the server swaps a
// PDF-carrying job onto its Gemini chain regardless of provider, so the part
// never actually reaches DeepSeek itself.
function fileToContentPart(f, allowPdf) {
  if (allowPdf && isPdfFile(f)) {
    return {
      type: 'file',
      file: { filename: f.name || 'document.pdf', file_data: `data:application/pdf;base64,${f.dataBase64}` }
    };
  }
  if (isTextFile(f)) {
    // Inline a marked prefix so clipped source material is never presented as
    // if DeepSeek received the complete attachment.
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
    // Model-facing, but a model can echo a vendor name straight into the
    // answer the student reads — keep it anonymous.
    text: `[Приложен файл ${f.name || ''} (${f.mimeType}), который эта модель не читает (нет ни изображений, ни PDF — только текст). ` +
      `Попросите текст, если нужно содержимое. Не выдумывай его содержимое.]`
  };
}

function buildUserContent(userText, files, allowPdf) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f, allowPdf));
  return content;
}

function historyToMessage(m, allowPdf) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) return { role, content: buildUserContent(m.content || '', m.files, allowPdf) };
  return { role, content: m.content };
}

export async function askDeepseek(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, reasoning = null, signal = null, onUsage = null } = opts;
  // Key decides the message SHAPE, so resolve it before building: only the
  // proxy can carry PDF file parts (see fileToContentPart).
  const key = await getByoKey();
  const allowPdf = !key;

  // See qwen.js: a known missing/invalid proxy credential must fail before it
  // consumes this local UX quota. The server remains authoritative whenever a
  // key is present but its cached status is inconclusive.
  let skipLocalCharge = false;
  if (!key) {
    const license = await getLicenseStatus();
    if (!license?.key || (license.ok === false && license.reason !== 'network')) {
      skipLocalCharge = true;
    }
  }

  const userContent = buildUserContent(userText, files, allowPdf);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => historyToMessage(m, allowPdf)),
    { role: 'user', content: files.length ? userContent : userText }
  ];
  const wantJson = responseFormat === 'json_object';

  const reservation = skipLocalCharge ? null : await reserveOne('deepseek');

  try {
    if (!key) {
      // The solver's reasoning {effort} rides along; the proxy maps it to
      // DeepSeek V4's reasoning_effort (verified live on 302.AI — the model
      // provably reasons longer on 'high'). The model thinks by default either
      // way; postStream ignores the reasoning_content deltas, so students only
      // ever see the final answer.
      const result = await askViaProxy('deepseek', messages, {
        label: 'DeepSeek', onDelta, onUsage, signal, reasoning,
        responseFormat: wantJson ? 'json_object' : null
      });
      if (reservation) await commitOne(reservation);
      return result;
    }

    // BYO path goes to DashScope (a real Alibaba key), where reasoning_effort
    // support is unverified — deliberately NOT forwarded here to avoid 400ing
    // power users on an untestable param.
    const body = {
      model: MODEL,
      messages,
      temperature: 0.3,
      stream_options: { include_usage: true }
    };
    if (wantJson) body.response_format = { type: 'json_object' };

    const headers = { Authorization: `Bearer ${key}` };
    const result = await postStream(ENDPOINT, { headers, body, label: 'DeepSeek', onDelta, onUsage, signal });
    if (reservation) await commitOne(reservation);
    return result;
  } catch (e) {
    if (reservation) {
      try { await cancelOne(reservation); } catch { /* orphan expires without becoming usage */ }
    }
    throw e;
  }
}
