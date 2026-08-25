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

// Dashboard follow-ups replay the original audio bytes, not the transcript file
// produced for the preceding request. Cache a handful of successful Whisper
// results briefly so replaying the same clip does not spend a second Groq
// request. This content lives in trusted-only storage.local, never the
// content-script-readable storage.session area. Timestamp pruning preserves
// the old session-like lifetime without weakening the storage trust split.
const TRANSCRIPT_CACHE_KEY = 'smeshTranscriptCache';
const TRANSCRIPT_CACHE_MAX = 8;
const TRANSCRIPT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TRANSCRIPT_CACHE_TEXT_MAX = 200_000;
let transcriptCacheMutation = Promise.resolve();

async function transcriptHash(file) {
  try {
    const bytes = new TextEncoder().encode(file?.dataBase64 || '');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

async function cachedTranscript(hash) {
  if (!hash) return null;
  try {
    const { [TRANSCRIPT_CACHE_KEY]: cache = {} } =
      await chrome.storage.local.get(TRANSCRIPT_CACHE_KEY);
    const entry = cache?.[hash];
    const text = entry?.text;
    return typeof text === 'string' && text &&
      Number.isFinite(entry?.at) && entry.at >= Date.now() - TRANSCRIPT_CACHE_TTL_MS
      ? text
      : null;
  } catch { return null; }
}

function rememberTranscript(hash, text) {
  if (!hash || !text || text.length > TRANSCRIPT_CACHE_TEXT_MAX) return Promise.resolve();
  // History messages are prepared with Promise.all, so serialize this one-key
  // read-modify-write; otherwise two completed clips can each read the same old
  // object and the later set silently discards the other transcript.
  const write = transcriptCacheMutation.then(async () => {
    try {
      const { [TRANSCRIPT_CACHE_KEY]: stored = {} } =
        await chrome.storage.local.get(TRANSCRIPT_CACHE_KEY);
      const cache = stored && typeof stored === 'object' && !Array.isArray(stored)
        ? { ...stored }
        : {};
      const cutoff = Date.now() - TRANSCRIPT_CACHE_TTL_MS;
      for (const [storedHash, entry] of Object.entries(cache)) {
        if (!entry || !Number.isFinite(entry.at) || entry.at < cutoff) delete cache[storedHash];
      }
      cache[hash] = { text, at: Date.now() };
      const oldestFirst = Object.entries(cache)
        .sort(([, a], [, b]) => (Number(a?.at) || 0) - (Number(b?.at) || 0));
      while (oldestFirst.length > TRANSCRIPT_CACHE_MAX) {
        const [oldestHash] = oldestFirst.shift();
        delete cache[oldestHash];
      }
      // storage.local.set() can throw synchronously when the area is missing
      // or reject asynchronously during SW teardown/quota pressure. Guard both;
      // cache persistence must never change the transcription result.
      try {
        await chrome.storage.local.set({ [TRANSCRIPT_CACHE_KEY]: cache })?.catch(() => {});
      } catch { /* trusted storage unavailable */ }
    } catch { /* cache read unavailable */ }
  });
  transcriptCacheMutation = write.catch(() => {});
  return write;
}

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
      const hash = await transcriptHash(f);
      const cached = await cachedTranscript(hash);
      if (cached) { out.push(asTranscriptFile(f, cached)); continue; }
      let text = null;
      try { text = await transcribeAudio(f); } catch { /* keep original on failure */ }
      if (text) {
        await rememberTranscript(hash, text);
        out.push(asTranscriptFile(f, text));
        continue;
      }
    }
    out.push(f);
  }
  return out;
}
