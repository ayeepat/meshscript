/**
 * meshscript content scraper
 * -------------------------------------------------------------
 * Mesh (school.mos.ru) is a React/MUI app with OBFUSCATED, randomly
 * generated class names. We never rely on class names. Two strategies:
 *
 *  PRIMARY (DOM): every homework card is shaped
 *    <h6>SUBJECT</h6>
 *    <p>HH:MM - HH:MM</p>
 *    <a href=".../diary/homeworks/homeworks/{id}_normal">
 *      <p>TASK</p>
 *    </a>
 *  Day headers are <p>Weekday, DD month</p> in document order.
 *  We pair every visible <h6> with the <p> inside its homework anchor,
 *  then group cards by the most recent preceding day header.
 *
 *  FALLBACK (text walk): older Mesh layouts, or any page where <h6> isn't
 *  used, fall back to a vocabulary-based text walk that pairs each subject
 *  with the following task-looking fragment.
 *
 * A MESH_DEBUG message returns diagnostics for tuning against the real DOM.
 */

const SUBJECT_VOCABULARY = [
  'Алгебра', 'Геометрия', 'Математика', 'Физика', 'Химия',
  'Биология', 'История', 'Обществознание', 'География',
  'Русский язык', 'Литература', 'Английский язык', 'Иностранный язык',
  'Информатика', 'ОБЖ', 'Физическая культура', 'Физкультура', 'Астрономия',
  'Технология', 'ИЗО', 'Музыка', 'Вероятность и статистика'
];

const WEEKDAY_RE = /(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)/i;
const MONTH = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
// Day-header pattern Mesh actually uses: "Понедельник, 04 мая".
const DAY_HEADER_RE = new RegExp(
  '^(?:понедельник|вторник|среда|четверг|пятница|суббота|воскресенье),?\\s+\\d{1,2}\\s+(?:' + MONTH + ')',
  'i'
);
// Looser date pattern only used by the fallback text-walker.
const DATE_RE = new RegExp('\\b\\d{1,2}\\s+(?:' + MONTH + ')\\b|\\b\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?\\b', 'i');

const TASK_MARKER_RE = /(№|§|п\.|стр\.|упр|задани|параграф|читать|выучить|реш|номер|подготов|характерист|пересказ|сочинени|конспект|ex\.?\s*\d|p\.\s*\d|страниц)/i;

const TIME_RE = /^\d{1,2}:\d{2}(\s*[-–—]\s*\d{1,2}:\d{2})?$/;
const NOISE_RE = new RegExp(
  '^(?:' +
  [
    'урок\\s*№?\\s*\\d*',
    'каб(?:инет)?\\.?\\s*\\S*',
    'домашн(?:ее|ие)\\s+задани[ея]',
    'оценок нет', 'нет оценок', 'оценки', 'оценка',
    'показать (?:ещё|еще|все)', 'свернуть', 'развернуть', 'подробнее',
    'перейти к уроку', 'комментарий учителя', 'прикреплённые материалы',
    'учитель[:\\s].*', 'тема урока'
  ].join('|') +
  ')$', 'i'
);

const HOMEWORK_ANCHOR_SEL = 'a[href*="/diary/homeworks/homeworks/"]';

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function isNoise(text) {
  const t = normalize(text);
  if (!t) return true;
  if (TIME_RE.test(t)) return true;
  if (NOISE_RE.test(t)) return true;
  if (/^[\d\s:№.,;\-–—()/]+$/.test(t)) return true;
  return false;
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

/* ---------- PRIMARY: DOM-based scan ---------- */

/**
 * Collect day-header <p> elements in document order. Mesh emits exactly one
 * per day in the shape "Weekday, DD month", which is rare enough to avoid
 * false positives elsewhere on the page.
 */
function collectDayHeaders() {
  const out = [];
  const ps = document.querySelectorAll('p');
  for (const el of ps) {
    if (!isVisible(el)) continue;
    const text = normalize(el.textContent);
    if (DAY_HEADER_RE.test(text)) out.push({ el, text });
  }
  return out;
}

/** Find the nearest preceding day header in document order. */
function dayForNode(node, dayHeaders) {
  let last = null;
  for (const h of dayHeaders) {
    const pos = h.el.compareDocumentPosition(node);
    // FOLLOWING = node comes after h.el → h.el is a candidate
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) last = h.text;
    else break;
  }
  return last;
}

/**
 * For each visible <h6> (Mesh's subject header), build a card:
 *   subject = h6 text
 *   task    = <p> text inside the nearest homework anchor in the same card
 * Falls back to the next non-time <p> if the anchor isn't present.
 */
function collectCardsFromDom() {
  const headings = Array.from(document.querySelectorAll('h6')).filter(isVisible);
  if (!headings.length) return null;

  const cards = [];
  for (const h6 of headings) {
    const subject = normalize(h6.textContent);
    if (!subject) continue;
    if (isNoise(subject)) continue;

    // Climb until an ancestor contains a homework anchor — that ancestor is
    // the card root. Cap the climb so we never escape into the page chrome.
    let cardRoot = h6.parentElement;
    let hops = 0;
    while (cardRoot && cardRoot !== document.body && hops < 8) {
      if (cardRoot.querySelector(HOMEWORK_ANCHOR_SEL)) break;
      cardRoot = cardRoot.parentElement;
      hops++;
    }
    if (cardRoot === document.body) cardRoot = null;

    let task = '';
    if (cardRoot) {
      const link = cardRoot.querySelector(HOMEWORK_ANCHOR_SEL);
      if (link) {
        // Prefer the FIRST <p> inside the anchor (the visible task text).
        // Skip empty <p> wrappers Mesh sometimes emits around the text.
        const ps = link.querySelectorAll('p');
        for (const p of ps) {
          const t = normalize(p.textContent);
          if (t && !TIME_RE.test(t)) { task = t; break; }
        }
      }
    }

    // Last-resort fallback: walk forward siblings of the h6 looking for the
    // next non-time <p> text. Helps if Mesh ships a card without the anchor.
    if (!task) {
      let sib = h6.nextElementSibling;
      let scanned = 0;
      while (sib && !task && scanned < 8) {
        if (sib.tagName === 'P') {
          const t = normalize(sib.textContent);
          if (t && !TIME_RE.test(t) && !isNoise(t)) task = t;
        } else {
          const inner = sib.querySelector && sib.querySelector('p');
          if (inner) {
            const t = normalize(inner.textContent);
            if (t && !TIME_RE.test(t) && !isNoise(t)) task = t;
          }
        }
        sib = sib.nextElementSibling;
        scanned++;
      }
    }

    cards.push({
      h6,
      subject,
      task: task || '(текст задания не виден — откройте задание или загрузите фото)'
    });
  }
  return cards;
}

function scanFromDom() {
  const cards = collectCardsFromDom();
  if (!cards || !cards.length) return null;

  const dayHeaders = collectDayHeaders();
  const byDay = new Map();
  for (const c of cards) {
    const day = dayForNode(c.h6, dayHeaders) || null;
    const key = day || '__nodate__';
    if (!byDay.has(key)) byDay.set(key, { day, subjects: [] });
    byDay.get(key).subjects.push({ subject: c.subject, task: c.task });
  }

  // Preserve document order of day headers.
  const days = [];
  const seen = new Set();
  for (const h of dayHeaders) {
    if (byDay.has(h.text) && !seen.has(h.text)) {
      days.push(byDay.get(h.text));
      seen.add(h.text);
    }
  }
  // Surface cards that didn't match any day header last.
  if (byDay.has('__nodate__')) days.push(byDay.get('__nodate__'));

  if (!days.length) return null;
  const first = days[0];
  return { day: first.day, subjects: first.subjects, days };
}

/* ---------- FALLBACK: vocabulary text walk (older layouts) ---------- */

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
  if (TIME_RE.test(text)) return 'NOISE';
  if ((DATE_RE.test(text) || WEEKDAY_RE.test(text)) && text.length <= 60) return 'DATE';
  if (matchSubject(text)) return 'SUBJECT';
  return 'TEXT';
}

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

function pairSubjects(groupFrags) {
  const results = [];
  const seen = new Set();
  for (let i = 0; i < groupFrags.length; i++) {
    const subject = matchSubject(groupFrags[i].text);
    if (!subject) continue;
    const pieces = [];
    for (let j = i + 1; j < Math.min(i + 20, groupFrags.length); j++) {
      const cand = groupFrags[j].text;
      if (matchSubject(cand)) break;
      if (classify(cand) === 'DATE') break;
      if (isNoise(cand)) continue;
      if (TASK_MARKER_RE.test(cand) || cand.length >= 12) {
        pieces.push(cand);
        if (pieces.join(' ').length >= 500) break;
      }
    }
    const task = normalize(pieces.join(' '));
    const key = subject + '||' + task.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ subject, task: task || '(текст задания не виден — откройте задание или загрузите фото)' });
  }
  return results;
}

function scanFromText() {
  const { groups } = buildGroups();
  const days = [];
  for (const g of groups) {
    const subjects = pairSubjects(g.frags);
    if (subjects.length) days.push({ day: g.day, subjects });
  }
  if (!days.length) return null;
  const first = days[0];
  return { day: first.day, subjects: first.subjects, days };
}

/* ---------- Entry point ---------- */

function scanHomeworks() {
  const dom = scanFromDom();
  if (dom) return dom;
  return scanFromText() || { day: null, subjects: [], days: [] };
}

function debugScan() {
  const cards = collectCardsFromDom() || [];
  const dayHeaders = collectDayHeaders();
  const { frags } = buildGroups();
  return {
    domH6Count: document.querySelectorAll('h6').length,
    domHomeworkAnchors: document.querySelectorAll(HOMEWORK_ANCHOR_SEL).length,
    domCardsExtracted: cards.length,
    domSampleCards: cards.slice(0, 12).map((c) => ({
      subject: c.subject,
      task: c.task.slice(0, 120)
    })),
    dayHeaders: dayHeaders.map((d) => d.text),
    textFragments: frags.length,
    textSample: frags.slice(0, 40).map((f) => ({ kind: classify(f.text), text: f.text.slice(0, 80) }))
  };
}

// Guard against duplicate listeners: the manifest auto-injects this script,
// and popup.js falls back to chrome.scripting.executeScript on a race. Without
// this guard both copies would respond to every MESH_SCAN.
if (!window.__meshscriptListenerAdded) {
  window.__meshscriptListenerAdded = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Handlers are synchronous — only return true (keep the channel open)
    // when we actually own this message type, otherwise the sender hangs on
    // "channel closed before response".
    try {
      if (msg && msg.type === 'MESH_SCAN') {
        sendResponse({ ok: true, data: scanHomeworks() });
        return false;
      }
      if (msg && msg.type === 'MESH_DEBUG') {
        sendResponse({ ok: true, debug: debugScan() });
        return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return false;
    }
    return false;
  });
}
