/**
 * Lightweight task classifier — pure regex heuristics, no network.
 *
 * Decides what a homework card needs from the user BEFORE solving:
 *  - 'attachment': the teacher references a file/worksheet distributed via
 *    Mesh (PDF, Word, презентация, карточки, раздатка…). The AI can't see
 *    it — the user must download it from Mesh and attach it here.
 *  - 'textbook': the task is only a reference («Упр. 25», «№ 354, 358»,
 *    «стр. 102 з. 4») with no actual task text. A photo of the textbook
 *    page turns a guessed answer into an exact one.
 *
 * Deliberately NOT an LLM call: a per-card Groq round-trip would add latency
 * to every popup open and a hard dependency on a configured key. The solver
 * model already performs the deep "what is actually needed" check at solve
 * time (see CONTEXT_GUARD in subject-router.js); these heuristics only
 * decide how to present the upload button in the popup.
 */

// The many ways teachers say "the task is in an attached file".
const ATTACHMENT_RE = new RegExp(
  [
    'файл', 'пдф', '\\bpdf\\b', 'ворд', '\\bword\\b', '\\bdocx?\\b',
    'презентаци', '\\bpptx?\\b', '\\bxlsx?\\b', '\\btxt\\b', 'таблиц',
    'документ', 'приложен', 'прикреп', 'вложен',
    'скан', 'распечат', 'раздат', 'карточк', 'бланк',
    // [а-яё]* not \w*: \w is ASCII-only in JS and never matches Cyrillic.
    'рабоч[а-яё]*\\s+лист', 'лист[а-яё]*\\s+с\\s+задани',
    'тест\\s+мэш', 'мэш[\\s-]*тест', 'по\\s+ссылке', 'доделать\\s+упр',
    // OGE/EGE/VPR variants are distributed as an attached file; listening
    // (аудирование) and audio links also imply external material.
    'вариант\\s*\\d', '\\bогэ\\b', '\\bегэ\\b', '\\bвпр\\b',
    'аудир', 'аудиозап', 'drive\\.google', 'disk\\.yandex'
  ].join('|'),
  'i'
);

// Detects whether a task needs AUDIO — listening sections or audio links.
// This tool can never solve those, so callers can warn the user up front.
const AUDIO_RE = /(аудир|аудиозап|на\s+слух|listening|\.mp3|\.m4a|\.wav|drive\.google|disk\.yandex)/i;
export function needsAudio(task) {
  return AUDIO_RE.test(task || '');
}

// Reference to a numbered item in a textbook: упр./№/стр./задание/§ + digit.
const REF_RE = /(№|упр[а-яё]*|стр[а-яё]*|задани[а-яё]*|задач[а-яё]*|номер[а-яё]*|параграф[а-яё]*|§|пункт[а-яё]*|п\.|зад\.|ex\.?\s*|p\.|page\s*)\s*\.?\s*\d/i;

/**
 * True when the task is essentially just textbook references — the actual
 * exercise text lives on a page the AI can't see.
 */
export function isBareTextbookRef(task) {
  const t = (task || '').trim();
  if (!t || !REF_RE.test(t)) return false;
  // Strip the references themselves plus digits/punctuation. If almost no
  // descriptive text remains («Упр. 25», «№ 354, 358 стр. 80»), it's bare.
  // Short imperatives like «вставьте буквы» also count as bare: the
  // sentences to work on are still in the book.
  const residual = t
    .replace(new RegExp(REF_RE.source, 'gi'), ' ')
    .replace(/[\d\s.,;:№§()\-–—/+«»"']+/g, ' ')
    .trim();
  return residual.length < 40;
}

/**
 * @param {string} task homework text as scraped from Mesh
 * @returns {{needsFile: boolean, kind: 'attachment'|'textbook'|null}}
 */
export function classifyTask(task) {
  if (ATTACHMENT_RE.test(task || '')) return { needsFile: true, kind: 'attachment' };
  if (isBareTextbookRef(task)) return { needsFile: true, kind: 'textbook' };
  return { needsFile: false, kind: null };
}
