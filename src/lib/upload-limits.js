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
// At most 6 raw MiB of NON-AUDIO becomes at most 8 MiB of base64, reserving the
// remaining MiB for data-URI/JSON structure, prompts and replayed text. It is
// one shared standard-file budget across current and historical turns; audio
// is transcribed before provider messages and has the separate Whisper limit.
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
  const mid = data.length >> 1;
  return `${String(file?.name || '')}\u0000${data.length}\u0000${data.slice(0, 256)}\u0000` +
    `${data.slice(mid, mid + 256)}\u0000${data.slice(-256)}`;
}

/**
 * Remove a file repeated by the current turn/history replay. A cheap sampled
 * fingerprint selects a small candidate bucket; exact full-string equality is
 * the deduplication contract. Mesh files are already base64 in memory, so this
 * avoids hashing every multi-megabyte body and allocates no second body copy.
 */
export function deduplicateRequestFiles(files = [], history = []) {
  // The sampled key is only a cheap bucket selector. It must never be treated as
  // proof that two attachments are identical: same-name/same-length files can
  // differ outside all three samples. Keep references to the full strings in
  // each (normally one-entry) bucket and use exact string equality before
  // suppressing a replay. This adds no second base64 allocation and only scans a
  // multi-megabyte body in the rare case where its cheap fingerprint collides.
  const seen = new Map();
  const keep = (list) => (Array.isArray(list) ? list : []).filter((file) => {
    const key = fileReplayKey(file);
    const data = typeof file?.dataBase64 === 'string' ? file.dataBase64 : '';
    const bucket = seen.get(key);
    if (bucket?.some((prior) => prior === data)) return false;
    if (bucket) bucket.push(data);
    else seen.set(key, [data]);
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
 * Enforce separate decoded budgets over the exact set entering a solve,
 * including replayed history. Non-audio stays under 6 MiB because it can reach
 * the proxy as base64. Audio is transcribed to text by Groq Whisper first and
 * never reaches provider messages as base64 (failure adds only a short note),
 * so its aggregate follows Groq's own 25 MiB file limit instead. Returns a
 * user-ready result so UI and service-worker boundaries surface one message.
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
  let totalBytes = 0;
  let audioBytes = 0;
  let nonAudioBytes = 0;
  for (const file of files) {
    const bytes = decodedBase64Bytes(file?.dataBase64);
    totalBytes += bytes;
    if (isAudioFile(file)) audioBytes += bytes;
    else nonAudioBytes += bytes;
  }
  if (nonAudioBytes > MAX_REQUEST_FILE_BYTES) {
    return {
      ok: false,
      error: `Общий размер вложений — ${formatMegabytes(nonAudioBytes)} МБ. ` +
        `Максимум — ${formatMegabytes(MAX_REQUEST_FILE_BYTES)} МБ, включая файлы из истории.`
    };
  }
  if (audioBytes > MAX_AUDIO_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `Общий размер аудиофайлов — ${formatMegabytes(audioBytes)} МБ. ` +
        `Максимум — ${formatMegabytes(MAX_AUDIO_UPLOAD_BYTES)} МБ, включая файлы из истории.`
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
