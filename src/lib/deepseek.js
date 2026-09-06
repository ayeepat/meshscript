/**
 * Auto licensed-route wrapper. The stable wire id remains `deepseek` for old
 * clients, while the gateway resolves the actual model through live control.
 * Content is sent only to the СМЭШ gateway.
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies.
 */

import { askViaProxy } from './smesh-proxy.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { getLicenseStatus, isUsableLicenseStatus } from './license.js';
import { clipText } from './clip-text.js';

// One file -> one OpenAI-style content part. Images and PDFs are allowed only
// after the server-side feature and routing checks.
function fileToContentPart(f) {
  if (isImageFile(f)) {
    const mime = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${f.dataBase64}` } };
  }
  if (isPdfFile(f)) {
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

function buildUserContent(userText, files) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f));
  return content;
}

function historyToMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) {
    return { role, content: buildUserContent(m.content || '', m.files) };
  }
  return { role, content: m.content };
}

export async function askDeepseek(systemPrompt, userText, files = [], history = [], opts = {}) {
  const {
    onDelta = null, responseFormat = null, reasoning = null, signal = null,
    onUsage = null, onReasoning = null, tier = null,
  } = opts;

  // See qwen.js: a known missing/invalid proxy credential must fail before it
  // consumes this local UX quota. The server remains authoritative whenever a
  // key is present but its cached status is inconclusive.
  const license = await getLicenseStatus();
  const skipLocalCharge = !isUsableLicenseStatus(license);

  const userContent = buildUserContent(userText, files);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => historyToMessage(m)),
    { role: 'user', content: files.length ? userContent : userText }
  ];
  const wantJson = responseFormat === 'json_object';

  const reservation = skipLocalCharge ? null : await reserveOne('deepseek');

  try {
    // The VPS applies quality policy to the actual configured model.
    const result = await askViaProxy('deepseek', messages, {
      label: 'Auto', onDelta, onUsage, onReasoning, signal, reasoning, tier,
      responseFormat: wantJson ? 'json_object' : null
    });
    if (reservation) await commitOne(reservation);
    return result;
  } catch (e) {
    if (reservation) {
      try { await cancelOne(reservation); } catch { /* orphan expires without becoming usage */ }
    }
    throw e;
  }
}
