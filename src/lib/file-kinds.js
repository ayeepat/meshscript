/**
 * Shared file-kind detection.
 *
 * Mesh attachments very often arrive as application/octet-stream, so EVERY
 * check also looks at the filename extension — otherwise a real PDF/image is
 * misrouted to a "can't read" branch and silently dropped, and the model then
 * fabricates an answer to material it never received.
 */

const SAFE_RASTER_MIME = /^image\/(?:png|jpe?g|gif|webp)$/i;
const GENERIC_MIME = /^(?:application\/(?:octet-stream|download)|binary\/octet-stream)?$/i;

export const isImageFile = (f) => {
  const mime = String(f?.mimeType || '').trim();
  return SAFE_RASTER_MIME.test(mime) ||
    (GENERIC_MIME.test(mime) && /\.(png|jpe?g|gif|webp)$/i.test(f?.name || ''));
};

export const isPdfFile = (f) =>
  (f?.mimeType || '') === 'application/pdf' || /\.pdf$/i.test(f?.name || '');

export const isTextFile = (f) =>
  /^text\//.test(f?.mimeType || '') ||
  /application\/(json|xml|rtf|csv|x-tex)/.test(f?.mimeType || '') ||
  /\.(txt|md|markdown|csv|tsv|rtf|log|json|xml|html?|tex)$/i.test(f?.name || '');

/**
 * Audio files (listening / аудирование material). The solver model can't hear
 * sound, so these are deliberately NOT "readable" below — they must be
 * transcribed to text first (Groq Whisper, see lib/transcribe.js) before the
 * solve path can use them. Mesh serves attachments as octet-stream a lot, so
 * the extension check matters as much as the mime.
 */
export const isAudioFile = (f) =>
  /^audio\//.test(f?.mimeType || '') ||
  /\.(mp3|mpga|mpeg|m4a|wav|flac|ogg|oga|opus|aac|weba|webm)$/i.test(f?.name || '');

/**
 * Office Open XML / legacy office docs. We can't hand these to a model, but the
 * modern (zip-based) ones can be text-extracted locally first — see extract.js.
 * The regex also matches legacy binaries (.doc/.ppt/.xls); extraction returns
 * null for those and the caller falls back to asking for a PDF/photo.
 */
export const isOfficeFile = (f) =>
  /(officedocument|msword|ms-powerpoint|ms-excel)/.test(f?.mimeType || '') ||
  /\.(docx?|pptx?|xlsx?)$/i.test(f?.name || '');

/**
 * Can the SOLVER model actually read this file's CONTENT? Images (vision),
 * PDFs (Gemini native) and plain text (inlined) — yes. Office files only after
 * extract.js has converted them to text/plain (so a raw .docx is still false
 * here, which is what the missing-input gate wants).
 */
export const isReadableFile = (f) => isImageFile(f) || isPdfFile(f) || isTextFile(f);

/** True if any file needs a PDF-capable provider (Groq cannot read PDFs). */
export const hasPdf = (files = []) => files.some(isPdfFile);
