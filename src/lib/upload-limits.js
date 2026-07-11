/**
 * Shared guard for files selected manually in extension pages.
 *
 * Automatic Mesh downloads enforce the same limits in the content script and
 * service worker. Keeping the manual path bounded too prevents an oversized
 * FileReader/base64 conversion from exhausting extension memory or storage
 * before the proxy gets a chance to reject the request.
 */

import { isAudioFile } from './file-kinds.js';

// The licensed proxy stores the complete messages JSON under a 9 MiB ceiling.
// At most 6 raw MiB becomes at most 8 MiB of base64, reserving the remaining
// MiB for data-URI/JSON structure, prompts and replayed text. This is one shared
// budget across current and historical files, not a per-file allowance.
export const MAX_STANDARD_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_REQUEST_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_REQUEST_FILE_COUNT = 12;
// Must match backend-vps/server.js MAX_BLOB_CHARS. The server stores the
// messages JSON as JavaScript string chunks, so UTF-16 `.length` is the exact
// unit enforced at both ends (not an estimate based on attachment bytes).
export const MAX_PROXY_MESSAGES_CHARS = 9 * 1024 * 1024;

function formatMegabytes(bytes) {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * Throws a user-ready Russian error when a browser File is not safe to inline.
 * The caller still owns FileReader error handling; this guard runs before any
 * base64 allocation.
 */
export function assertUploadAllowed(file) {
  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    throw new Error('Не удалось прочитать файл. Выберите непустой файл и попробуйте ещё раз.');
  }
  const maxBytes = isAudioFile({ name: file.name, mimeType: file.type })
    ? MAX_AUDIO_UPLOAD_BYTES
    : MAX_STANDARD_UPLOAD_BYTES;
  if (file.size > maxBytes) {
    throw new Error(
      `Файл слишком большой (${formatMegabytes(file.size)} МБ). ` +
      `Максимум для этого типа файла — ${formatMegabytes(maxBytes)} МБ.`
    );
  }
}

// Base64 length is enough to recover the decoded byte count; decoding here
// would allocate a second copy of every attachment precisely where this guard
// is supposed to protect memory. Padding can only remove one or two bytes.
function decodedBase64Bytes(dataBase64) {
  const data = typeof dataBase64 === 'string' ? dataBase64 : '';
  if (!data) return 0;
  const padding = data.endsWith('==') ? 2 : (data.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

function fileReplayKey(file) {
  const data = typeof file?.dataBase64 === 'string' ? file.dataBase64 : '';
  return `${String(file?.name || '')}\u0000${data.length}\u0000${data.slice(0, 256)}`;
}

/**
 * Remove a file repeated by the current turn/history replay. The intentionally
 * cheap fingerprint is the contract for this path: Mesh files are already
 * base64 in memory, so hashing every multi-megabyte body again would add a large
 * latency/allocation tax merely to suppress an identical replay.
 */
export function deduplicateRequestFiles(files = [], history = []) {
  const seen = new Set();
  const keep = (list) => (Array.isArray(list) ? list : []).filter((file) => {
    const key = fileReplayKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Keep current-turn files first: if the same attachment also appears in an
  // older replayed turn, the model still receives it with the user's current
  // instruction and the redundant historical copy is the one discarded.
  const nextFiles = keep(files);
  const nextHistory = (Array.isArray(history) ? history : []).map((message) => {
    if (!Array.isArray(message?.files) || !message.files.length) return message;
    const messageFiles = keep(message.files);
    return messageFiles.length ? { ...message, files: messageFiles } : { ...message, files: [] };
  });
  const allFiles = nextFiles.concat(nextHistory.flatMap((message) => message?.files || []));
  return { files: nextFiles, history: nextHistory, allFiles };
}

/**
 * Enforce one decoded attachment budget over the exact set sent to a provider,
 * including replayed history. Returns a user-ready result instead of throwing
 * so both UI and service-worker boundaries can surface the same Russian error.
 */
export function validateRequestFileBudget(fullFileList) {
  const files = Array.isArray(fullFileList) ? fullFileList : [];
  if (files.length > MAX_REQUEST_FILE_COUNT) {
    return {
      ok: false,
      error: `Слишком много вложений в одном запросе: ${files.length}. ` +
        `Максимум — ${MAX_REQUEST_FILE_COUNT} файлов, включая файлы из истории.`
    };
  }
  const totalBytes = files.reduce((sum, file) => sum + decodedBase64Bytes(file?.dataBase64), 0);
  if (totalBytes > MAX_REQUEST_FILE_BYTES) {
    return {
      ok: false,
      error: `Общий размер вложений — ${formatMegabytes(totalBytes)} МБ. ` +
        `Максимум — ${formatMegabytes(MAX_REQUEST_FILE_BYTES)} МБ, включая файлы из истории.`
    };
  }
  return { ok: true, fileCount: files.length, totalBytes };
}

/** Serialize and enforce the licensed proxy's exact whole-messages ceiling. */
export function validateProxyMessagesBudget(messages) {
  let json;
  try { json = JSON.stringify(messages); } catch { json = null; }
  if (typeof json !== 'string') {
    return { ok: false, error: 'Не удалось подготовить запрос. Попробуйте ещё раз.' };
  }
  if (json.length > MAX_PROXY_MESSAGES_CHARS) {
    return {
      ok: false,
      error: 'Запрос вместе с вложениями и историей слишком большой. ' +
        'Начните новый чат или отправьте меньше файлов и текста.'
    };
  }
  return { ok: true, json, totalChars: json.length };
}
