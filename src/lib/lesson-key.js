/**
 * Stable identity for ONE homework row, so a lesson that was already solved is
 * answered from local history instead of paying for the same completion twice.
 *
 * This is deliberately NOT the dashboard's in-tab `keyFor`. That one keys on
 * the per-scan rowToken, which is a fresh UUID every scan — perfect for keeping
 * two same-subject rows apart inside one tab, useless for recognising the same
 * lesson in a later tab. This key uses only what МЭШ itself repeats: the
 * student, the day, the subject, the homework row ids and the task text.
 *
 * Consequences that are intentional:
 *  - a re-worded assignment changes the key, so it is solved again rather than
 *    answered from the text the teacher replaced;
 *  - a different student (principal) never reads another one's session;
 *  - the stored key is an opaque digest, so history holds no second copy of the
 *    task text beyond the one `task_text` field it already had.
 */

const FIELD_SEPARATOR = String.fromCharCode(31); // ASCII unit separator

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Small deterministic digest. Two independent FNV-style accumulators plus the
 * input length; the same construction scraper.js uses for page signatures, and
 * for the same reason — every extension context must derive the identical
 * string with no crypto round trip on the UI path.
 */
export function lessonDigest(value) {
  const text = String(value ?? '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${text.length.toString(36)}`;
}

/**
 * @returns {string} the lesson's reuse key, or '' when the row carries too
 *   little identity to be recognised again. An empty key is never stored and
 *   never matches, so an unidentifiable lesson simply behaves as it did before.
 */
export function lessonKeyFor({
  principal = null,
  day = '',
  subject = '',
  task = '',
  homeworkId = '',
  homeworkItemId = '',
} = {}) {
  const normalizedSubject = normalizeText(subject);
  const normalizedTask = normalizeText(task);
  const row = String(homeworkItemId ?? '') || String(homeworkId ?? '');
  if (!normalizedSubject) return '';
  // Either a Mesh row id or the task text has to be present. Subject + day
  // alone would merge every assignment of one lesson into a single answer.
  if (!row && !normalizedTask) return '';
  const parts = [
    typeof principal === 'string' ? principal : '',
    normalizeText(day),
    normalizedSubject,
    row,
    normalizedTask,
  ];
  // Fixed field count joined on the ASCII unit separator: normalizeText
  // collapses every real whitespace run, so no field can grow a separator of
  // its own and shift the boundaries into a neighbouring field.
  return `l1.${lessonDigest(parts.join(FIELD_SEPARATOR))}`;
}
