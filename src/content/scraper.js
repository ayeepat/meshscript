/**
 * meshscript content scraper (hardened)
 * -------------------------------------------------------------
 * Mesh (school.mos.ru) is a React/MUI app with OBFUSCATED, randomly
 * generated class names. We never rely on class names.
 *
 * Real-world facts this version handles:
 *  - The homeworks page is usually ONE scrollable list, not per-day cards.
 *  - Subject name and task text are typically in SEPARATE sibling nodes,
 *    not nested, so we pair a subject node with the nearest following
 *    task-looking text rather than reading an ancestor's combined text.
 *  - Task text may be short on screen and fully present only after expand;
 *    we read whatever is in the DOM and let the user upload a file if needed.
 *
 * Strategy:
 *  1. Walk all visible text nodes in document order (TreeWalker).
 *  2. Tag each as: DATE header, SUBJECT, or other TEXT.
 *  3. Pair each SUBJECT with the nearest following task-looking TEXT,
 *     grouped under the most recent DATE header seen.
 *  4. Return the FIRST date group that has homework (next upcoming day).
 *
 * A MESH_DEBUG message returns diagnostics so the selectors can be tuned
 * against the real page without guessing.
 */

const SUBJECT_VOCABULARY = [
  'Алгебра', 'Геометрия', 'Математика', 'Физика', 'Химия',
  'Биология', 'История', 'Обществознание', 'География',
  'Русский язык', 'Литература', 'Английский язык', 'Иностранный язык',
  'Информатика', 'ОБЖ', 'Физическая культура', 'Физкультура', 'Астрономия',
  'Технология', 'ИЗО', 'Музыка'
];

const WEEKDAY_RE = /(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)/i;
const MONTH = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const DATE_RE = new RegExp('\\b\\d{1,2}\\s+(?:' + MONTH + ')\\b|\\b\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?\\b', 'i');

// A text looks like a task if it has numbering/markers or is reasonably long.
const TASK_MARKER_RE = /(№|§|п\.|стр\.|упр|задани|параграф|читать|выучить|реш|номер|ex\.?\s*\d|p\.\s*\d|страниц)/i;

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function matchSubject(text) {
  const t = normalize(text).toLowerCase();
  for (const subj of SUBJECT_VOCABULARY) {
    if (t === subj.toLowerCase() || t.startsWith(subj.toLowerCase())) return subj;
  }
  for (const subj of SUBJECT_VOCABULARY) {
    if (t.includes(subj.toLowerCase())) return subj;
  }
  return null;
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** Collect visible text fragments in document order. */
function collectTextFragments() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const txt = normalize(node.nodeValue);
      if (!txt) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const out = [];
  let n;
  while ((n = walker.nextNode())) {
    out.push({ text: normalize(n.nodeValue), el: n.parentElement });
  }
  return out;
}

function classify(text) {
  if ((DATE_RE.test(text) || WEEKDAY_RE.test(text)) && text.length <= 60) return 'DATE';
  if (matchSubject(text)) return 'SUBJECT';
  return 'TEXT';
}

/** Build day groups by walking fragments in order. */
function buildGroups() {
  const frags = collectTextFragments();
  const groups = [];
  let current = null;
  for (let i = 0; i < frags.length; i++) {
    const f = frags[i];
    if (classify(f.text) === 'DATE') {
      current = { day: f.text, frags: [], headerIndex: i };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { day: null, frags: [], headerIndex: -1 };
      groups.push(current);
    }
    current.frags.push(f);
  }
  return { frags, groups };
}

/** Pair subjects with the nearest following task text. */
function pairSubjects(groupFrags) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < groupFrags.length; i++) {
    const subject = matchSubject(groupFrags[i].text);
    if (!subject) continue;
    let task = '';
    for (let j = i + 1; j < Math.min(i + 7, groupFrags.length); j++) {
      const cand = groupFrags[j].text;
      if (matchSubject(cand)) break;
      if (TASK_MARKER_RE.test(cand) || cand.length >= 8) {
        task = task ? (task + ' ' + cand) : cand;
        if (task.length > 12) break;
      }
    }
    task = normalize(task);
    const key = subject + '||' + task.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ subject, task: task || '(текст задания не виден — откройте задание или загрузите фото)' });
  }
  return results;
}

/** Main scan: first day group that has homework = next upcoming day. */
function scanHomeworks() {
  const { groups } = buildGroups();
  for (const g of groups) {
    const subjects = pairSubjects(g.frags);
    if (subjects.length) return { day: g.day, subjects };
  }
  return { day: null, subjects: [] };
}

/** Diagnostics for tuning against the real DOM. */
function debugScan() {
  const { frags, groups } = buildGroups();
  return {
    totalFragments: frags.length,
    dateHeaders: groups.map((g) => g.day).filter(Boolean).slice(0, 20),
    subjectsSeen: frags.map((f) => matchSubject(f.text)).filter(Boolean).slice(0, 40),
    sample: frags.slice(0, 60).map((f) => ({ kind: classify(f.text), text: f.text.slice(0, 80) }))
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg && msg.type === 'MESH_SCAN') sendResponse({ ok: true, data: scanHomeworks() });
    else if (msg && msg.type === 'MESH_DEBUG') sendResponse({ ok: true, debug: debugScan() });
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return true;
});
