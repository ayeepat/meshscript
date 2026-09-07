/**
 * Qwen licensed-route wrapper. Runs only in the background service worker and
 * sends content exclusively through the СМЭШ gateway. Vendor credentials are
 * deployment-only and never read from extension storage.
 *
 * Model: whatever the gateway's live routing resolves this route to — today
 * qwen3.8-flash, multimodal, with qwen3.7-plus behind it as a fallback. One
 * model handles both images and text, so — unlike Groq — there's no separate
 * vision/text model to switch between here.
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies (test solver); dropped on the vision path, mirroring
 * groq.js — providers in this codebase have shown unreliable JSON-mode
 * behaviour once an image is in the request.
 */

import { askViaProxy } from './smesh-proxy.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { getLicenseStatus, isUsableLicenseStatus } from './license.js';
import { clipText } from './clip-text.js';

// One file -> one OpenAI-style content part. Shared by the current message and
// by replayed history turns so an attachment survives into follow-ups.
function fileToContentPart(f) {
  if (isImageFile(f)) {
    const m = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (isPdfFile(f)) {
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

export async function askQwen(systemPrompt, userText, files = [], history = [], opts = {}) {
  // opts.reasoning ({effort}) is deliberately NOT wired here (same as groq.js).
  // Think is a frontier route: the gateway runs it at the deepest setting the
  // live model offers no matter what a client asks for (see QWEN_38_FLASH in
  // backend-vps/server.js), so forwarding a hint could only ever ask for LESS
  // thinking on МЭШ homework. The cheap any-site path is where a hint changes
  // anything, and that one goes out through deepseek.js with tier:'standard'.
  const {
    onDelta = null, responseFormat = null, signal = null, onUsage = null,
    onReasoning = null, tier = null,
  } = opts;
  // Vision if EITHER the current message OR a replayed history turn carries an
  // image, so a follow-up doesn't lose the original photo's context.
  const hasImages = files.some(isImageFile) ||
    history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));

  // The proxy is the authority for licensed traffic. Do not burn the local UX
  // limit on a credential failure that cannot possibly reach the model (for
  // example, an empty or known-revoked license); valid/unknown credentials keep
  // the existing pre-flight limit behaviour.
  const license = await getLicenseStatus();
  const skipLocalCharge = !isUsableLicenseStatus(license);

  const userContent = buildUserContent(userText, files);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => historyToMessage(m)),
    // files.length (not hasImages): a non-image attachment still needs its
    // "can't read this directly" note delivered to the model.
    { role: 'user', content: files.length ? userContent : userText }
  ];
  const wantJson = responseFormat === 'json_object' && !hasImages;

  const reservation = skipLocalCharge ? null : await reserveOne('qwen');

  try {
    const result = await askViaProxy('qwen', messages, {
      label: 'Qwen', onDelta, onUsage, onReasoning, signal, tier,
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
