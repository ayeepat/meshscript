/**
 * Auto-route wrapper. Runs ONLY in the background service worker. The stable
 * route id is still `deepseek` because released Chrome builds already send it,
 * but the licensed proxy resolves that id through live model control (Qwen 3.7
 * Plus by default). A hidden BYO qwenApiKey preserves the old direct
 * DeepSeek path for owner/power-user compatibility.
 *
 * Licensed Auto accepts images because the live route is multimodal. The
 * BYO DeepSeek path stays text-only; ai.js upgrades its visual requests to the
 * BYO Qwen route before this module is called.
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies.
 */

import { postStream } from './http.js';
import { askViaProxy } from './smesh-proxy.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { getByoKey } from './qwen.js';
import { getLicenseStatus, isUsableLicenseStatus } from './license.js';
import { clipText } from './clip-text.js';

// Independent of the proxy's dashboard-configured Auto model. This constant is
// used only for the hidden direct Alibaba BYO compatibility path.
const ENDPOINT = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';

// One file -> one OpenAI-style content part. Images and PDFs are allowed only
// on the proxy path: the live Auto model sees the former and the VPS swaps the
// latter onto its verified PDF chain. Direct DeepSeek sees neither.
function fileToContentPart(f, { allowImages, allowPdf }) {
  if (allowImages && isImageFile(f)) {
    const mime = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${f.dataBase64}` } };
  }
  if (allowPdf && isPdfFile(f)) {
    return {
      type: 'file',
      file: { filename: f.name || 'document.pdf', file_data: `data:application/pdf;base64,${f.dataBase64}` }
    };
  }
  if (isTextFile(f)) {
    // Inline a marked prefix so clipped source material is never presented as
    // if Auto received the complete attachment.
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

function buildUserContent(userText, files, capabilities) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f, capabilities));
  return content;
}

function historyToMessage(m, capabilities) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) {
    return { role, content: buildUserContent(m.content || '', m.files, capabilities) };
  }
  return { role, content: m.content };
}

export async function askDeepseek(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, reasoning = null, signal = null, onUsage = null } = opts;
  // Key decides the message SHAPE, so resolve it before building.
  const key = await getByoKey();
  const capabilities = { allowImages: !key, allowPdf: !key };

  // See qwen.js: a known missing/invalid proxy credential must fail before it
  // consumes this local UX quota. The server remains authoritative whenever a
  // key is present but its cached status is inconclusive.
  let skipLocalCharge = false;
  if (!key) {
    const license = await getLicenseStatus();
    if (!isUsableLicenseStatus(license)) skipLocalCharge = true;
  }

  const userContent = buildUserContent(userText, files, capabilities);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => historyToMessage(m, capabilities)),
    { role: 'user', content: files.length ? userContent : userText }
  ];
  const wantJson = responseFormat === 'json_object';

  const reservation = skipLocalCharge ? null : await reserveOne('deepseek');

  try {
    if (!key) {
      // The VPS applies the quality policy to the ACTUAL configured model. For
      // Qwen 3.7 Plus it drops the effort hint entirely (Qwen thinks by default
      // and has no effort levels); for GLM-5.3-Flash it forces thinking=max
      // even when an older client sends Auto=low. Either way postStream hides
      // reasoning_content and shows only the answer.
      const result = await askViaProxy('deepseek', messages, {
        label: 'Auto', onDelta, onUsage, signal, reasoning,
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
