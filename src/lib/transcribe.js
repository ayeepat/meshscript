/**
 * Turn attached audio (listening / аудирование clips) into text the solver can
 * read, using Groq Whisper. Mirrors extract.prepareFiles(): each audio file is
 * replaced with a text/plain file carrying its transcript; everything else
 * passes through untouched.
 *
 * Best-effort and never throws: if a clip can't be transcribed (no Groq key,
 * over the daily cap, network error, unsupported codec) the original audio file
 * is kept as-is, so the solver's missing-input gate / context guard still refuse
 * cleanly instead of inventing listening answers.
 *
 * Runs in the background service worker only (needs the Groq key + network).
 */

import { isAudioFile } from './file-kinds.js';
import { transcribeAudio } from './groq.js';
import { utf8ToBase64 } from './extract.js';

// Wrap the raw transcript so the model treats it as the listening material AND
// knows it was auto-recognised (so it doesn't over-trust a mis-heard word). The
// «Расшифровка аудиозаписи …» marker is what the CONTEXT_GUARD in
// subject-router.js keys on to allow solving the listening task.
function asTranscriptFile(file, text) {
  const label = file.name || 'аудио';
  const body =
    `[Расшифровка аудиозаписи «${label}» — сделана автоматически (Whisper), ` +
    `возможны ошибки распознавания]:\n\n${text}`;
  return { mimeType: 'text/plain', dataBase64: utf8ToBase64(body), name: `[Расшифровка] ${label}` };
}

/**
 * Replace every audio file in the list with its transcript (as text/plain).
 * @param {Array<{mimeType?:string, dataBase64:string, name?:string}>} files
 * @returns {Promise<Array>}
 */
export async function transcribeAudioFiles(files = []) {
  const out = [];
  for (const f of files) {
    if (isAudioFile(f)) {
      let text = null;
      try { text = await transcribeAudio(f); } catch { /* keep original on failure */ }
      if (text) { out.push(asTranscriptFile(f, text)); continue; }
    }
    out.push(f);
  }
  return out;
}
