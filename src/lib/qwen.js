/**
 * Qwen API wrapper (OpenAI-compatible chat completions via Alibaba Cloud
 * Model Studio / DashScope International). Runs ONLY in the background
 * service worker.
 *
 * DEFAULT PATH — the СМЭШ proxy: students never see an API key. Requests go
 * to the license backend (smesh-proxy.js), authenticated by the license key;
 * the server holds the one real Model Studio key and enforces quotas.
 *
 * HIDDEN BYO PATH — if a `qwenApiKey` sits in chrome.storage.local (owner /
 * power users; the Settings field is gone, set it via the console; the area
 * is locked to TRUSTED_CONTEXTS so content scripts can't read it), calls go
 * straight to DashScope with it. The SAME key also authenticates DeepSeek
 * (see deepseek.js): Model Studio is one account/key across its whole
 * catalogue, Qwen's own models and hosted third-party ones alike.
 *
 * Model: qwen3.7-plus — the vision+reasoning sibling of the Qwen3.7 line
 * (Qwen3.7-Max, despite the flagship name, is TEXT ONLY). One model handles
 * both images and text, so — unlike Groq — there's no separate vision/text
 * model to switch between here.
 *
 * PDFs: the DIRECT DashScope endpoint can't read them, but the СМЭШ proxy
 * can — it routes any PDF-carrying job to a Gemini model on 302.AI (verified
 * live). So on the proxy path PDFs ride along as OpenAI-style file parts;
 * on the BYO path they still fall through to the "can't read" note (and the
 * solve() gate upstream routes BYO users to OpenRouter instead).
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies (test solver); dropped on the vision path, mirroring
 * groq.js — providers in this codebase have shown unreliable JSON-mode
 * behaviour once an image is in the request.
 */

import { postStream } from './http.js';
import { askViaProxy } from './smesh-proxy.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { getLicenseStatus } from './license.js';
import { clipText } from './clip-text.js';

// Independent of the proxy's env-configured model (ai-proxy.js
// PROXY_QWEN_MODEL, now served via 302.AI) — this constant talks to
// DashScope directly with a user's OWN Alibaba key, untouched by the 302.AI
// migration. Whether a given power user's own account is entitled to this
// exact model name is that account's own DashScope entitlement, unrelated to
// 302.AI verification.
const ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'qwen3.7-plus';

/**
 * Bring-your-own Model Studio key, or null → use the СМЭШ proxy. Also used
 * by deepseek.js (same Alibaba account covers both models).
 */
export async function getByoKey() {
  const { qwenApiKey } = await chrome.storage.local.get('qwenApiKey');
  return qwenApiKey || null;
}

// One file -> one OpenAI-style content part. Shared by the current message and
// by replayed history turns so an attachment survives into follow-ups.
// `allowPdf` is true ONLY on the proxy path: the server swaps a PDF-carrying
// job onto its Gemini chain, while direct DashScope would 400 on a file part.
function fileToContentPart(f, allowPdf) {
  if (isImageFile(f)) {
    const m = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (allowPdf && isPdfFile(f)) {
    return {
      type: 'file',
      file: { filename: f.name || 'document.pdf', file_data: `data:application/pdf;base64,${f.dataBase64}` }
    };
  }
  if (isTextFile(f)) {
    // Plain text and locally-extracted Office docs (see extract.js) — inline a
    // marked prefix so the model reads them and knows if the source is clipped.
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
    text: `[Приложен файл ${f.name || ''} (${f.mimeType}), который нельзя прочитать напрямую. Попросите фото/скриншот или текст, если нужно содержимое. Не выдумывай его содержимое.]`
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

export async function askQwen(systemPrompt, userText, files = [], history = [], opts = {}) {
  // opts.reasoning ({effort}) is deliberately NOT wired here (same as groq.js):
  // qwen3.7-plus has no effort levels — it THINKS BY DEFAULT on every request
  // (verified live on 302.AI; reasoning_content deltas that postStream hides),
  // and its only knobs are enable_thinking/thinking_budget, which don't map to
  // medium/high effort. The solver's effort setting is already honored where a
  // real knob exists: OpenRouter (body.reasoning) and DeepSeek (reasoning_effort).
  const { onDelta = null, responseFormat = null, signal = null, onUsage = null } = opts;
  // Vision if EITHER the current message OR a replayed history turn carries an
  // image, so a follow-up doesn't lose the original photo's context.
  const hasImages = files.some(isImageFile) ||
    history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));

  // Key decides the message SHAPE, so resolve it before building: only the
  // proxy can carry PDF file parts (see fileToContentPart).
  const key = await getByoKey();
  const allowPdf = !key;

  // The proxy is the authority for licensed traffic. Do not burn the local UX
  // limit on a credential failure that cannot possibly reach the model (for
  // example, an empty or known-revoked license); valid/unknown credentials keep
  // the existing pre-flight limit behaviour.
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
    // files.length (not hasImages): a non-image attachment still needs its
    // "can't read this directly" note delivered to the model.
    { role: 'user', content: files.length ? userContent : userText }
  ];
  const wantJson = responseFormat === 'json_object' && !hasImages;

  const reservation = skipLocalCharge ? null : await reserveOne('qwen');

  try {
    if (!key) {
      const result = await askViaProxy('qwen', messages, {
        label: 'Qwen', onDelta, onUsage, signal,
        responseFormat: wantJson ? 'json_object' : null
      });
      if (reservation) await commitOne(reservation);
      return result;
    }

    const body = {
      model: MODEL,
      messages,
      temperature: 0.3,
      stream_options: { include_usage: true }
    };
    if (wantJson) body.response_format = { type: 'json_object' };

    const headers = { Authorization: `Bearer ${key}` };
    const result = await postStream(ENDPOINT, { headers, body, label: 'Qwen', onDelta, onUsage, signal });
    if (reservation) await commitOne(reservation);
    return result;
  } catch (e) {
    if (reservation) {
      try { await cancelOne(reservation); } catch { /* orphan expires without becoming usage */ }
    }
    throw e;
  }
}
