/**
 * Shared guard for files selected manually in extension pages.
 *
 * Automatic Mesh downloads enforce the same limits in the content script and
 * service worker. Keeping the manual path bounded too prevents an oversized
 * FileReader/base64 conversion from exhausting extension memory or storage
 * before the proxy gets a chance to reject the request.
 */

import { isAudioFile } from './file-kinds.js';

// The proxy stores the base64-encoded messages JSON under a 9 MiB ceiling.
// Six raw MiB leaves room for base64 inflation plus prompts/history; anything
// larger can never be reliable on the licensed proxy path.
export const MAX_STANDARD_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;

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
