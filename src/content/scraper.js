/**
 * СМЭШ AI content scraper
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
 * Flip SMESH_DEBUG below to trace scraping against the real DOM.
 */

// Diagnostic logging. OFF in shipped builds — flip to true to trace homework
// scraping, attachment auto-fetch and test auto-fill in the page console
// (filter on "СМЭШ AI"). Kept out of production so a student's console stays clean.
const SMESH_DEBUG = false;
const dbg = (...a) => { if (SMESH_DEBUG) { try { console.log(...a); } catch { /* no console */ } } };

// `let`, not `const`: the remote runtime config (lib/remote-config.js, passed in
// on the MESH_SCAN message) can override this to add a subject Mesh renamed,
// without a store re-publish. The built-in list below is always the fallback.
let SUBJECT_VOCABULARY = [
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

// `let` for the same reason as SUBJECT_VOCABULARY: if Mesh changes the homework
// URL shape, the remote config can ship a new selector same-day. Built-in is the
// fallback, and any override is validated before it reaches this script.
let HOMEWORK_ANCHOR_SEL = 'a[href*="/diary/homeworks/homeworks/"]';
const APPROVED_HOMEWORK_SELECTORS = Object.freeze([
  'a[href*="/diary/homeworks/homeworks/"]',
  'a[href*="/diary/homeworks/"]',
  'a[href*="/diary/homework/"]'
]);

// A row token exists only for one scan of this live DOM. It lets later
// attachment discovery return to the exact card/anchor the popup rendered,
// instead of re-identifying a row by subject text or scanning the whole page.
// Roots are held via WeakRef: while connected, the document itself keeps the
// element alive, so deref() can only miss AFTER Mesh detached the row — which
// callers already treat as "context changed". Without this, every detached
// React row subtree from the last scan stayed pinned for the page's lifetime
// on the diary SPA, where client-side navigation never re-runs MESH_SCAN.
const homeworkRowContexts = new Map();
function mintRowToken(root = null) {
  const token = crypto.randomUUID();
  // Store even a null root. Presence proves that this opaque row token belongs
  // to the current scan; the null value merely means DOM fallback must stay
  // candidate-only rather than claiming an exact row subtree.
  homeworkRowContexts.set(token, root ? new WeakRef(root) : null);
  return token;
}

function normalize(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

// Apply remote runtime-config overrides (subject vocabulary, homework anchor
// selector) sent by the popup on MESH_SCAN. Best-effort and defensive: a junk
// value is ignored and the built-in default stays in force. The selector is
// only ever used in querySelector, never executed.
function applyScanConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  if (Array.isArray(cfg.subjectVocabulary) && cfg.subjectVocabulary.length) {
    const list = cfg.subjectVocabulary.filter((s) => typeof s === 'string' && s.trim());
    if (list.length) SUBJECT_VOCABULARY = list;
  }
  if (typeof cfg.homeworkAnchorSelector === 'string' && cfg.homeworkAnchorSelector.trim()) {
    const selector = cfg.homeworkAnchorSelector.trim();
    // Mirrors remote-config.js. Keep the check here too because content-script
    // messages cross a less-trusted boundary than extension storage.
    if (!APPROVED_HOMEWORK_SELECTORS.includes(selector)) return;
    try {
      document.querySelector(selector); // throws on an invalid selector
      HOMEWORK_ANCHOR_SEL = selector;
    } catch { /* invalid selector — keep the built-in */ }
  }
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
 * For each visible <h6> (Mesh's subject header), build cards for EVERY
 * homework row inside that lesson card:
 *   subject = h6 text
 *   task    = <p> text inside each homework anchor
 * A single lesson can contain several homework rows (Mesh shows "Домашнее
 * задание 2" and the detail drawer URL gets `sidebar=homeworks_<id>`). Older
 * code took only `querySelector(...)`, so the popup collapsed two tasks into
 * one and could attach the wrong file.
 */
function collectCardsFromDom() {
  const headings = Array.from(document.querySelectorAll('h6')).filter(isVisible);
  if (!headings.length) return null;

  const cards = [];
  const seen = new Set();
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

    const addCard = (task, href, rowRoot = null) => {
      const cleanTask = task || '(текст задания не виден — откройте задание или загрузите фото)';
      const key = `${subject}||${href || ''}||${cleanTask.slice(0, 120)}`;
      if (seen.has(key)) return;
      seen.add(key);
      cards.push({
        h6,
        subject,
        task: cleanTask,
        href,
        homeworkId: homeworkIdFromHref(href),
        homeworkItemId: homeworkItemIdFromHref(href),
        rowToken: mintRowToken(rowRoot)
      });
    };

    let cardHasTaskRow = false;
    let fallbackHref = '';
    if (cardRoot) {
      const links = Array.from(cardRoot.querySelectorAll(HOMEWORK_ANCHOR_SEL)).filter(isVisible);
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        if (href && !fallbackHref) fallbackHref = href;
        let task = '';
        // Prefer the first <p> inside this anchor (the visible row text).
        // Skip empty <p> wrappers Mesh sometimes emits around the text.
        const ps = link.querySelectorAll('p');
        for (const p of ps) {
          const t = normalize(p.textContent);
          if (t && !TIME_RE.test(t)) { task = t; break; }
        }
        if (!task) {
          const t = normalize(link.textContent);
          if (t && !TIME_RE.test(t) && !isNoise(t)) task = t;
        }
        if (task) {
          // With exactly one homework row, the lesson card is an unambiguous
          // ownership subtree. With several, only the row anchor itself is safe;
          // sibling material links become explicit candidates later.
          addCard(task, href, links.length === 1 ? cardRoot : link);
          cardHasTaskRow = true;
        }
      }
    }

    // Last-resort fallback: walk forward siblings of the h6 looking for the
    // next non-time <p> text. Helps if Mesh ships a card without the anchor.
    if (!cardHasTaskRow && !cards.some((c) => c.h6 === h6)) {
      let sib = h6.nextElementSibling;
      let task = '';
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
      addCard(task, fallbackHref, null);
    }
  }
  return cards;
}

/** Pull the numeric homework id out of a Mesh anchor href (".../homeworks/123_normal"). */
function homeworkIdFromHref(href) {
  const m = (href || '').match(/\/homeworks\/(\d+)/);
  return m ? m[1] : null;
}

/** Pull the row-specific homework id from Mesh's detail-drawer query param. */
function homeworkItemIdFromHref(href) {
  const raw = href || '';
  let m = raw.match(/[?&]sidebar=homeworks_(\d+)/);
  if (m) return m[1];
  try {
    const u = new URL(raw, location.href);
    m = (u.searchParams.get('sidebar') || '').match(/^homeworks_(\d+)$/);
    return m ? m[1] : null;
  } catch { return null; }
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
    byDay.get(key).subjects.push({
      subject: c.subject,
      task: c.task,
      href: c.href,
      homeworkId: c.homeworkId,
      homeworkItemId: c.homeworkItemId,
      rowToken: c.rowToken
    });
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

/* ---------- Attachment discovery (logged-in Mesh session) ---------- */
/**
 * The most painful manual step is: read "сделать из прикреплённого файла",
 * leave Mesh, download it, come back, upload it. We run INSIDE the user's
 * authenticated school.mos.ru session, so we can find those materials.
 *
 * Division of labour (this matters for MV3):
 *  - The content script only DISCOVERS the file URLs. Mesh is an SPA, so the
 *    materials live behind its family API; we hit that API here because it is
 *    SAME-ORIGIN (school.mos.ru) and so carries the page's auth cookies, plus
 *    we can read the auth token from the page's localStorage for the header.
 *  - The actual file DOWNLOADS happen in the service worker (see
 *    DOWNLOAD_FILES), NOT here. In MV3 a content-script fetch is bound by the
 *    page's CORS and does NOT get the extension's host_permissions, so a
 *    cross-origin file (e.g. uchebnik.mos.ru) would be blocked here. The
 *    service worker DOES get host_permissions and can fetch it.
 * Everything is best-effort: any failure returns no URLs and the popup falls
 * back to manual upload (unchanged behaviour).
 *
 * Endpoint verified against the real Mesh Network tab (2026): the homeworks
 * list URL `/diary/homeworks/homeworks/<id>_normal` carries a LESSON-schedule
 * item id, and its detail (incl. attachment file URLs) comes from
 * `/api/family/web/v1/lesson_schedule_items/<id>`. The call needs the Bearer
 * token plus Mesh's `X-mes-*` headers; `person_id` is the JWT `msh` claim and
 * `student_id` lives in localStorage. The attachment files themselves are
 * served from the SAME origin (school.mos.ru/ej/attachments/...).
 */
const FILE_URL_RE = /https?:\/\/[^\s"'<>]+\.(?:pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|webp|txt|rtf|mp3|mpga|m4a|wav|ogg|oga|opus|flac|aac)(?:\?[^\s"'<>]*)?/i;
const MESH_FILE_HINT_RE = /(uchebnik\.mos\.ru|\/ej\/attachments?\/|\/files?\/|\/storage\/|file_id=)/i;

const LESSON_API = (id, studentId, personId) => {
  const u = new URL(`https://school.mos.ru/api/family/web/v1/lesson_schedule_items/${id}`);
  if (studentId) u.searchParams.set('student_id', studentId);
  u.searchParams.set('type', 'OO');
  if (personId) u.searchParams.set('person_id', personId);
  return u.toString();
};

const MESH_JSON_TIMEOUT_MS = 15 * 1000;
const MESH_PROFILE_JSON_MAX_BYTES = 1024 * 1024;
const MESH_LESSON_JSON_MAX_BYTES = 4 * 1024 * 1024;

// Mesh JSON includes teacher-controlled homework text and attachment metadata.
// Read it under both time and decompressed-byte limits so an accidental or
// adversarially inflated school response cannot exhaust the content script.
// A non-OK body is drained but never returned: the only former reader was the
// support diagnostic, and a Mesh error body can echo account identifiers.
async function fetchMeshJson(url, init, maxBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MESH_JSON_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: ctrl.signal });
    const bytes = await readBoundedBody(res, res.ok ? maxBytes : 4096, ctrl);
    if (!res.ok) return { res, json: null };
    const text = bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '';
    if (!text) throw new Error('Mesh JSON response empty or too large');
    return { res, json: JSON.parse(text) };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** Try to find Mesh's auth token (raw JWT) in localStorage / cookies. */
function findAuthToken() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || '';
      if (!/token|aupd|auth/i.test(k)) continue;
      let v = (localStorage.getItem(k) || '').trim();
      if (!v) continue;
      // Some Mesh builds wrap the token in JSON ({"token":"…"} or {"value":…}).
      if (v[0] === '{') {
        try {
          const o = JSON.parse(v);
          v = o.token || o.value || o.access_token || o.accessToken || '';
        } catch { /* not JSON, fall through */ }
      }
      v = v.replace(/^"|"$/g, '');
      if (v.length > 20 && !/\s/.test(v)) return v;
    }
  } catch { /* storage blocked */ }
  const m = document.cookie.match(/(?:aupd_token|auth_token)=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Decode a JWT payload (no verification — we just want its claims). */
function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

const STUDENT_ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,})$/i;
const ACTIVE_STUDENT_KEYS = [
  'student_id', 'studentId', 'profile_id', 'profileId',
  'selected_student_id', 'selectedStudentId', 'selected_profile_id', 'selectedProfileId',
  'current_student_id', 'currentStudentId', 'current_profile_id', 'currentProfileId',
  'aupd_current_profile_id'
];

function cleanStudentId(value) {
  const id = String(value ?? '').replace(/^"|"$/g, '').trim();
  return STUDENT_ID_RE.test(id) ? id : null;
}

function oneActiveSignal(values, source) {
  const ids = [...new Set(values.map(cleanStudentId).filter(Boolean))];
  if (ids.length === 1) return { id: ids[0], source };
  if (ids.length > 1) {
    return {
      id: null,
      source,
      error: 'Не удалось однозначно определить активного ученика. Переключитесь на нужный профиль в электронном дневнике и обновите страницу.'
    };
  }
  return null;
}

function storageSignal(storage, source) {
  const values = [];
  try {
    for (const key of ACTIVE_STUDENT_KEYS) {
      const raw = storage.getItem(key);
      if (raw != null) values.push(raw);
    }
    // Mesh builds occasionally wrap the selection in one JSON record. Only
    // inspect records whose STORAGE KEY itself says current/selected/active;
    // scanning every cached profile record is what previously picked child #1.
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i) || '';
      if (!/(?:current|selected|active).*(?:student|profile)|aupd_current_profile/i.test(key)) continue;
      const raw = storage.getItem(key) || '';
      try {
        const parsed = JSON.parse(raw);
        for (const field of ACTIVE_STUDENT_KEYS) if (parsed?.[field] != null) values.push(parsed[field]);
        if (parsed?.id != null) values.push(parsed.id);
      } catch { values.push(raw); }
    }
  } catch { return null; }
  return oneActiveSignal(values, source);
}

/** Resolve only CURRENT-selection signals; never scan arbitrary profile lists. */
function findStudentId() {
  try {
    const url = new URL(location.href);
    const fromUrl = oneActiveSignal(ACTIVE_STUDENT_KEYS.map((key) => url.searchParams.get(key)), 'diary_url');
    if (fromUrl) return fromUrl;
  } catch { /* malformed/location unavailable */ }

  // `aupd_current_profile_id` is Mesh's explicit selected-profile cookie. It is
  // authoritative for the diary currently open, unlike /students[0].
  const cookieValues = [];
  let currentProfileCookie = null;
  try {
    for (const part of document.cookie.split(';')) {
      const [rawKey, ...rest] = part.trim().split('=');
      const value = decodeURIComponent(rest.join('='));
      if (rawKey === 'aupd_current_profile_id') currentProfileCookie = value;
      else if (ACTIVE_STUDENT_KEYS.includes(rawKey)) cookieValues.push(value);
    }
  } catch { /* cookies blocked */ }
  const cookie = oneActiveSignal(
    currentProfileCookie != null ? [currentProfileCookie] : cookieValues,
    'aupd_current_profile_cookie'
  );
  if (cookie) return cookie;

  const session = storageSignal(sessionStorage, 'session_selected_profile');
  if (session) return session;

  const local = storageSignal(localStorage, 'local_selected_profile');
  if (local) return local;
  return { id: null, source: 'none' };
}

const MAX_CAPTURE_PRINCIPAL_PART = 128;

function cleanCapturePrincipalPart(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const part = String(value).trim();
  return part && part.length <= MAX_CAPTURE_PRINCIPAL_PART && /^[\p{L}\p{N}._:@/-]+$/u.test(part)
    ? part : '';
}

// Uchebnik test players do not always expose the family-web student selector or
// a Mesh JWT in their origin. XAPI launches do, however, carry a per-attempt
// registration/actor identity. Hash only those identity-bearing values (never
// put the raw actor or URL token in a capture message) and let the top wrapper
// inherit the iframe's binding through the capture-wide validation below.
const CAPTURE_SESSION_PARAM_RE = /^(?:registration|actor|attempt_?id|session_?id|student_?id|profile_?id|user_?id)$/i;

function hashCaptureIdentity(value) {
  const text = String(value || '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}`;
}

function currentTestSessionIdentity() {
  const signals = [];
  const addUrl = (raw) => {
    try {
      const url = new URL(raw, location.href);
      for (const [key, value] of url.searchParams) {
        if (!CAPTURE_SESSION_PARAM_RE.test(key) || !value) continue;
        // Bound work even when a hostile page supplies an enormous actor JSON.
        signals.push(`${key.toLowerCase()}:${String(value).slice(0, 2048)}`);
      }
    } catch { /* malformed/opaque URL */ }
  };
  try { addUrl(location.href); } catch { /* location unavailable */ }
  try {
    for (const frame of Array.from(document.querySelectorAll('iframe[src]')).slice(0, 32)) {
      addUrl(frame.getAttribute('src') || '');
    }
  } catch { /* iframe discovery unavailable in this document */ }
  try {
    const selector = '[data-registration], [data-attempt-id], [data-session-id], [data-student-id], [data-profile-id]';
    for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 32)) {
      for (const name of ['data-registration', 'data-attempt-id', 'data-session-id', 'data-student-id', 'data-profile-id']) {
        const value = element.getAttribute?.(name);
        if (value) signals.push(`${name}:${String(value).slice(0, 2048)}`);
      }
    }
  } catch { /* no explicit player identity in the DOM */ }
  if (!signals.length) return '';
  return hashCaptureIdentity([...new Set(signals)].sort().join('|'));
}

// Hosts whose pages go through the МЭШ flow. Everything else that the user has
// granted is a generic web page (see lib/web-solve.js) and is identified by its
// ORIGIN instead of by a signed-in child.
const MESH_ORIGIN_HOSTS = ['school.mos.ru', 'uchebnik.mos.ru'];
const SMESH_SERVICE_ORIGIN_HOSTS = ['smeshai.xyz', 'smeshapi.site', 'ai.smeshapi.site'];

function isMeshOrigin() {
  try {
    const url = new URL(location.href);
    return url.protocol === 'https:' && MESH_ORIGIN_HOSTS.includes(url.hostname);
  } catch {
    // An opaque location (sandboxed/about:blank frame) is never a generic page
    // we may read on its own account — fail closed onto the Mesh predicate,
    // which then finds no Mesh signals either.
    return true;
  }
}

/**
 * ⚠️ Mirrors lib/web-solve.js isWebSolvableUrl(). The worker enforces the same
 * rule on the tab URL before it ever injects here; this is the in-document half
 * of that check, so a capture can never be built from a document that is not
 * itself an eligible generic page.
 */
function isWebSolvableDocument() {
  try {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return !MESH_ORIGIN_HOSTS.includes(url.hostname) &&
      !SMESH_SERVICE_ORIGIN_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Identity of a captured GENERIC page.
 *
 * ⚠️ Mirrors lib/web-solve.js webCapturePrincipal() verbatim — a classic content
 * script cannot import it. tests/web-solve-regression.mjs fails on any drift.
 *
 * There is no "which child" question on an arbitrary site, so the origin is the
 * isolation unit: it keeps the answer-reuse cache scoped per site and gives the
 * capture validator a principal that carries real identity, without inventing a
 * Mesh account that does not exist.
 */
function webCapturePrincipalIdentity() {
  let origin = '';
  try { origin = String(new URL(location.href).origin || ''); } catch { origin = ''; }
  return JSON.stringify(['v2', origin.slice(0, 128), '', '', 'web', '']);
}

/**
 * Stable, bounded identity for the account/child whose page is being captured.
 * Never include the bearer token itself: only its stable local account claim
 * and Mesh's explicit current-student selection participate. The explicit
 * `none`/`ambiguous` state also makes a later selection change observable.
 *
 * Off Mesh there is no such account, so the origin-scoped web identity above is
 * returned instead. Mesh captures cannot reach that branch: the worker's Mesh
 * frame filter already drops every non-Mesh document before it is captured.
 */
function currentPrincipalIdentity() {
  if (!isMeshOrigin()) return webCapturePrincipalIdentity();
  let student = null;
  let account = '';
  let subject = '';
  try { student = findStudentId(); } catch { student = null; }
  try {
    const claims = jwtPayload(findAuthToken()) || {};
    account = [claims.msh, claims.person_id, claims.personId]
      .map(cleanCapturePrincipalPart)
      .find(Boolean) || '';
    subject = [claims.sub, claims.user_id, claims.userId]
      .map(cleanCapturePrincipalPart)
      .find(Boolean) || '';
  } catch { /* auth storage/cookies unavailable in this frame */ }
  const studentId = cleanCapturePrincipalPart(student?.id);
  const session = currentTestSessionIdentity();
  const state = studentId ? 'selected'
    : (student?.error ? 'ambiguous' : (account || subject ? 'account' : (session ? 'session' : 'unbound')));
  return JSON.stringify(['v2', account, subject, studentId, state, session]);
}

const HOMEWORK_CONTEXT_CHANGED = 'HOMEWORK_CONTEXT_CHANGED';

function currentHomeworkPrincipal() {
  const principal = currentPrincipalIdentity();
  try {
    const parts = JSON.parse(principal);
    const state = parts?.[4];
    // Homework belongs to a child, not merely to the signed-in adult account or
    // an arbitrary URL session. Require Mesh's explicit selected-student signal;
    // otherwise a same-account child switch would be indistinguishable.
    if (state !== 'selected') {
      return {
        principal: null,
        error: state === 'ambiguous'
          ? 'Не удалось однозначно определить активного ученика.'
          : 'Не удалось подтвердить выбранного ученика в электронном дневнике.'
      };
    }
  } catch {
    return { principal: null, error: 'Не удалось проверить аккаунт дневника.' };
  }
  return { principal, error: null };
}

function homeworkContextMatches(expectedPrincipal, expectedError, rowToken) {
  if (typeof expectedPrincipal !== 'string' || !expectedPrincipal ||
      expectedPrincipal.length > 512 || expectedError ||
      typeof rowToken !== 'string' || !homeworkRowContexts.has(rowToken)) {
    return false;
  }
  const entry = homeworkRowContexts.get(rowToken);
  if (entry) {
    // A minted root that the WeakRef can no longer produce was detached (and
    // collected) after minting — the same verdict as a detached-but-alive
    // root: the row list changed, so this token no longer authorizes.
    const rowRoot = entry.deref();
    try {
      if (!rowRoot || !document.documentElement.contains(rowRoot)) return false;
    } catch {
      return false;
    }
  }
  const current = currentHomeworkPrincipal();
  return !current.error && current.principal === expectedPrincipal;
}

function assertHomeworkContext(expectedPrincipal, expectedError, rowToken) {
  if (!homeworkContextMatches(expectedPrincipal, expectedError, rowToken)) {
    const error = new Error(
      'Аккаунт, ученик или список домашних заданий изменился. Обновите список и повторите.'
    );
    error.code = HOMEWORK_CONTEXT_CHANGED;
    throw error;
  }
}

/**
 * Resolve the numeric student_id the family API requires (it 400s without it).
 * Current diary selection first; if absent, ask the family profile APIs. A
 * single returned student is safe, but a multi-child list without a selection
 * is an error — never an invitation to take index zero.
 * @returns {Promise<{id:string|null, source:string, debug?:object}>}
 */
async function resolveStudentId(headers) {
  const active = findStudentId();
  if (active.id || active.error) return active;
  const tried = [];
  const listed = new Set();
  const direct = new Set();
  for (const url of [
    'https://school.mos.ru/api/family/web/v1/profile',
    'https://school.mos.ru/api/family/web/v1/students',
    'https://school.mos.ru/api/family/mobile/v1/profile'
  ]) {
    try {
      const { res, json: j } = await fetchMeshJson(
        url, { credentials: 'include', headers }, MESH_PROFILE_JSON_MAX_BYTES
      );
      tried.push({ url, status: res.status });
      if (!res.ok) continue;
      const addIds = (items, target) => {
        for (const item of (Array.isArray(items) ? items : [])) {
          const id = cleanStudentId(item?.id ?? item?.student_id ?? item?.studentId ?? item?.contingent_guid);
          if (id) target.add(id);
        }
      };
      if (Array.isArray(j)) addIds(j, listed);
      addIds(j?.children, listed);
      addIds(j?.students, listed);
      const own = cleanStudentId(j?.profile?.id ?? j?.id ?? j?.contingent_guid);
      if (own) direct.add(own);
      tried[tried.length - 1].keys = j && typeof j === 'object' ? Object.keys(j) : typeof j;
    } catch (e) { tried.push({ url, error: String(e) }); }
  }
  const candidates = listed.size ? [...listed] : [...direct];
  if (candidates.length === 1) return { id: candidates[0], source: listed.size ? 'single_student_from_api' : 'single_profile_from_api', debug: tried };
  if (candidates.length > 1) {
    return {
      id: null,
      source: 'ambiguous_profiles',
      error: 'В аккаунте несколько учеников, а активный профиль дневника не определён. Выберите нужного ученика в дневнике, обновите страницу и повторите.',
      debug: tried
    };
  }
  return { id: null, source: 'none', debug: tried };
}

/** Mesh family-web headers required by both the API and the file download. */
function meshHeaders(token) {
  const h = {
    Accept: 'application/json, text/plain, */*',
    'X-mes-subsystem': 'familyweb',
    'X-Mes-Role': 'student',
    'X-Mes-RoleId': '1'
  };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}

/**
 * `new URL(raw, base).href` is ALREADY a single correct percent-encoding, so
 * this is the whole normalisation — every caller passes an href from
 * allowedAttachmentUrl.
 *
 * The previous `encodeURI(decodeURI(s))` was not idempotent: decodeURI
 * deliberately preserves escapes for RESERVED characters, so encodeURI then
 * re-encoded their `%`. `%2F` became `%252F`, and a signed query's `%2F`/`%3D`/
 * `%26` became `%252F`/`%253D`/`%2526` — which the server answers with 403/404
 * or a signature failure.
 */
function normalizeUrl(s) {
  return String(s);
}

// Bounds ONE diagnostic probe end to end (headers plus every stream read).
const DIAGNOSTIC_PROBE_TIMEOUT_MS = 20000;

const ATTACHMENT_HOSTS = new Set(['school.mos.ru', 'uchebnik.mos.ru']);
function isIpLiteralHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (host.includes(':')) return true;
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function allowedAttachmentUrl(raw, base = location.href) {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (isIpLiteralHost(host) || !ATTACHMENT_HOSTS.has(host)) return null;
    return url;
  } catch { return null; }
}

/** Recursively collect file-looking URLs from an arbitrary JSON value. */
function collectFileUrls(node, out = new Set(), depth = 0) {
  if (depth > 8 || out.size >= 8) return out;
  if (typeof node === 'string') {
    let s = node;
    // Mesh often stores attachment paths relative ("/ej/attachments/…"); absolutise.
    if (s[0] === '/' && MESH_FILE_HINT_RE.test(s)) s = 'https://school.mos.ru' + s;
    if (FILE_URL_RE.test(s) || (/^https?:\/\//.test(s) && MESH_FILE_HINT_RE.test(s))) {
      const safe = allowedAttachmentUrl(s);
      if (safe) out.add(normalizeUrl(safe.href));
    }
  } else if (Array.isArray(node)) {
    for (const v of node) collectFileUrls(v, out, depth + 1);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectFileUrls(v, out, depth + 1);
  }
  return out;
}

/**
 * Pull file URLs for the SPECIFIC homework the user is solving. One lesson can
 * bundle several homeworks (e.g. a retelling «Charles Dickens.docx» AND an OGE
 * «Вариант 10 … .pdf»); attaching the unrelated file confuses the solver and
 * made results flaky. Match the homework whose text matches the card task and
 * take ONLY its files; whole-lesson fallback is allowed only for one row.
 */
function idLooksLike(value, targetId) {
  if (!targetId || value == null) return false;
  const s = String(value);
  return s === String(targetId) || s.includes(`homeworks_${targetId}`);
}

function homeworkHasItemId(node, targetId, depth = 0) {
  if (!targetId || !node || depth > 5) return false;
  if (Array.isArray(node)) return node.some((v) => homeworkHasItemId(v, targetId, depth + 1));
  if (typeof node !== 'object') return idLooksLike(node, targetId);
  for (const [key, value] of Object.entries(node)) {
    if (/id|guid|url|href|link|sidebar/i.test(key) && idLooksLike(value, targetId)) return true;
    if (value && typeof value === 'object' && homeworkHasItemId(value, targetId, depth + 1)) return true;
  }
  return false;
}

function normMatchText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textMatchScore(a, b) {
  const left = normMatchText(a);
  const right = normMatchText(b);
  if (!left || !right) return 0;
  if (left.includes(right.slice(0, 40)) || right.includes(left.slice(0, 40))) return 100;
  const aTokens = new Set(left.split(' ').filter((w) => w.length > 2));
  const bTokens = right.split(' ').filter((w) => w.length > 2);
  if (!aTokens.size || !bTokens.length) return 0;
  let hits = 0;
  for (const token of bTokens) if (aTokens.has(token)) hits++;
  return hits / Math.max(aTokens.size, bTokens.length);
}

function homeworkText(h) {
  return normalize(h?.homework || h?.description || h?.text || h?.name || h?.title || '');
}

function urlsRelevantToTask(urls, taskText) {
  const task = normMatchText(taskText);
  if (!task) return [];
  const taskTokens = new Set(task.split(' ').filter((w) => w.length > 2));
  const taskNums = new Set((task.match(/\d+/g) || []));
  return urls.filter((url) => {
    const name = normMatchText(fileNameFromUrl(url));
    if (!name) return false;
    const nameTokens = name.split(' ').filter((w) => w.length > 2);
    const tokenHit = nameTokens.some((w) => taskTokens.has(w));
    const nums = name.match(/\d+/g) || [];
    const numberHit = nums.length && nums.some((n) => taskNums.has(n));
    return tokenHit || numberHit;
  });
}

function urlsForHomework(json, taskText, homeworkItemId) {
  const homeworks = Array.isArray(json?.lesson_homeworks) ? json.lesson_homeworks : [];
  const allLessonUrls = [...collectFileUrls(json)];
  // Multiple rows are not a safe default scope. Start empty unless the lesson
  // has exactly one homework; id/text matching below may narrow it to one.
  let scope = homeworks.length === 1 ? homeworks : [];
  let matchedSpecificHomework = false;

  if (homeworkItemId && homeworks.length) {
    const byId = homeworks.filter((h) => homeworkHasItemId(h, homeworkItemId));
    if (byId.length === 1) {
      scope = byId;
      matchedSpecificHomework = true;
    }
  }

  if (!matchedSpecificHomework && taskText && homeworks.length > 1) {
    let bestScore = 0;
    let best = [];
    for (const h of homeworks) {
      const score = textMatchScore(homeworkText(h), taskText);
      if (score > bestScore) { bestScore = score; best = [h]; }
      else if (score && score === bestScore) best.push(h);
    }
    // textMatchScore returns a token-overlap ratio in [0,1] (or exactly 100
    // for containment), so a single 0.35 threshold covers both regimes.
    if (bestScore >= 0.35 && best.length === 1) {
      scope = best;
      matchedSpecificHomework = true;
    }
  }

  const out = new Set();
  for (const h of scope) collectFileUrls(h, out);
  // If the row matched but Mesh put the attachment at lesson level
  // (kr_attachments / shared materials), only borrow URLs whose filename
  // clearly points at this task. That keeps "Задание 1" from stealing the PDF
  // belonging to "Задание 2".
  if (!out.size && matchedSpecificHomework) {
    for (const url of urlsRelevantToTask(allLessonUrls, taskText)) out.add(url);
  }
  // Whole-lesson fallback is ownership-safe only when the response contains
  // exactly one homework. With zero/several rows the URLs are candidates for an
  // explicit popup choice, never automatic attachments.
  if (!out.size && !matchedSpecificHomework && homeworks.length === 1) {
    for (const url of allLessonUrls) out.add(url);
  }
  const candidates = !out.size && !matchedSpecificHomework && homeworks.length !== 1
    ? allLessonUrls.map((url) => ({ name: fileNameFromUrl(url), url }))
    : [];
  return { urls: [...out], candidates };
}

// STRICT matcher for DOM links: only a real attachment, never an auth/SSO link.
// The diagnostic proved a bare "uchebnik.mos.ru/" rule grabbed
// ".../authenticate?aupd_url=..." (a login redirect, content-type text/html).
// So: require a true file extension OR a path under Mesh's /ej/attachments
// store, and explicitly reject auth links.
const DOM_FILE_RE = /\/ej\/attachments?\//i;
const AUTH_LINK_RE = /(authenticate|aupd_url|\/sso\b|\/oauth\b|\/login\b)/i;
function looksLikeFileLink(s) {
  if (AUTH_LINK_RE.test(s)) return false;
  return FILE_URL_RE.test(s) || DOM_FILE_RE.test(s);
}

/**
 * Scan the CURRENT page DOM for attachment-looking links. This is the reliable
 * path: when the user is on the homework page, the attachment is a real <a> (or
 * a download button) we can read directly — no private-API guessing. Also used
 * as a fallback when the family API doesn't surface the file URL.
 */
function collectDomFileLinks(root) {
  const out = new Map();
  const push = (el, raw) => {
    if (!raw) return;
    let s = String(raw).trim();
    if (s[0] === '/') s = location.origin + s; // absolutise relative paths
    const safe = allowedAttachmentUrl(s);
    if (safe && looksLikeFileLink(safe.href)) {
      const url = normalizeUrl(safe.href);
      if (!out.has(url)) out.set(url, { el, url, name: fileNameFromUrl(url) });
    }
  };
  for (const a of root.querySelectorAll('a[href]')) push(a, a.getAttribute('href'));
  // Mesh sometimes renders downloads as buttons carrying the URL in a data-attr.
  for (const el of root.querySelectorAll('[download],[data-href],[data-url],[data-file-url],[data-link]')) {
    push(el, el.getAttribute('href') || el.getAttribute('data-href') ||
         el.getAttribute('data-url') || el.getAttribute('data-file-url') || el.getAttribute('data-link'));
  }
  return [...out.values()].slice(0, 8);
}

/**
 * Auto-attach only links inside the exact row subtree registered by MESH_SCAN.
 * When that subtree is missing or has no owned link, whole-page discoveries are
 * returned as explicit candidates; none is silently assigned to this homework.
 */
function scanPageForFileLinks({ rowToken } = {}) {
  const all = collectDomFileLinks(document);
  const entry = rowToken ? homeworkRowContexts.get(rowToken) : null;
  const root = entry ? entry.deref() : null;
  if (root?.isConnected) {
    const owned = all.filter((item) => item.el === root || root.contains(item.el));
    if (owned.length) return { urls: owned.map((item) => item.url), candidates: [] };
  }
  return {
    urls: [],
    candidates: all.map(({ name, url }) => ({ name, url }))
  };
}

/** Last path segment of a URL, decoded — used as the attachment filename. */
function fileNameFromUrl(url) {
  try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()) || 'attachment'; }
  catch { return 'attachment'; }
}

const isSameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};

const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', md: 'text/markdown',
  mp3: 'audio/mpeg', mpga: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', aac: 'audio/aac',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function inferMime(name, contentType) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  return 'application/octet-stream';
}

function isAudioAttachment(name, mimeType) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return (mimeType || '').startsWith('audio/') ||
    ['mp3', 'mpga', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac'].includes(ext);
}

const MAX_STANDARD_UPLOAD_BYTES = 6 * 1024 * 1024; // mirrors lib/upload-limits.js
const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;   // content scripts cannot import ESM
const ATTACHMENT_FETCH_TIMEOUT_MS = 30 * 1000;

function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function readBoundedBody(response, maxBytes, controller) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length.trim()) && Number(length) > maxBytes) {
    controller.abort();
    return null;
  }
  if (!response.body?.getReader) { controller.abort(); return null; }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('attachment too large'); } catch { /* already closed */ }
        controller.abort();
        return null;
      }
      chunks.push(value);
    }
  } catch (e) {
    if (!controller.signal.aborted) throw e;
    return null;
  }
  // `null` means "refused" (over the cap, unreadable, aborted). A zero-length
  // body is a legitimate read of an empty file and comes back as empty bytes so
  // callers can report the two apart. Mirrors the service worker's copy.
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Download a SAME-ORIGIN attachment from inside the page. The content script
 * carries the user's real session cookies, so school.mos.ru/ej/attachments
 * downloads succeed here without bouncing to the auth page — which is exactly
 * what happened when the service worker fetched them. An HTML response means we
 * still got an auth/login redirect, so we reject it instead of attaching junk.
 */
async function fetchInlineFile(url) {
  const safe = allowedAttachmentUrl(url);
  if (!safe || safe.origin !== location.origin) return null;
  const ctrl = new AbortController();
  // Covers response headers and every reader.read(), not only fetch().
  const timer = setTimeout(() => ctrl.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    // Same-origin inline downloads do not need redirects. Rejecting one avoids
    // forwarding diary cookies to a target selected by an attachment response.
    const res = await fetch(safe.href, { credentials: 'include', redirect: 'error', signal: ctrl.signal });
    if (!res.ok) { dbg('[СМЭШ AI] cs-download http', res.status, url); return null; }
    const ct = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/xml')) {
      dbg('[СМЭШ AI] cs-download got HTML (auth redirect?)', url);
      return { __auth: true };
    }
    const name = fileNameFromUrl(safe.href);
    const mimeType = inferMime(name, ct);
    // Keep the same normal-file ceiling as manual/background uploads: after
    // base64 expansion the licensed proxy has only 9 MB for its messages blob.
    const maxBytes = isAudioAttachment(name, mimeType) ? MAX_AUDIO_UPLOAD_BYTES : MAX_STANDARD_UPLOAD_BYTES;
    const bytes = await readBoundedBody(res, maxBytes, ctrl);
    if (!bytes) { dbg('[СМЭШ AI] cs-download size limit skip', url); return null; }
    if (!bytes.byteLength) { dbg('[СМЭШ AI] cs-download empty file skip', url); return null; }
    return {
      mimeType,
      dataBase64: bytesToBase64(bytes),
      name
    };
  } catch (e) { dbg('[СМЭШ AI] cs-download exception', String(e), url); return null; }
  finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/**
 * Discover a homework's attachment(s) and download the SAME-ORIGIN ones right
 * here (the content script carries the page's real session, so the download
 * doesn't bounce to the auth page). Cross-origin URLs (e.g. uchebnik.mos.ru) are
 * returned for the service worker to fetch with host_permissions.
 *
 * Returns a `stage` so failures are VISIBLE instead of silently falling back to
 * manual upload. `files` are already-inlined same-origin attachments; `urls` are
 * leftover cross-origin ones for the service worker.
 * @returns {Promise<{ok:boolean, files:object[], urls:string[], candidates:object[], token:string|null, headers:object, stage:string, status?:number}>}
 */
async function listMaterialUrls(
  lessonId,
  taskText,
  homeworkItemId,
  rowToken,
  expectedPrincipal,
  expectedPrincipalError,
) {
  // Check before even reading the bearer token. The popup card is a snapshot;
  // a same-document account/child switch must make it powerless.
  assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
  const token = findAuthToken();
  const headers = meshHeaders(token);
  const log = (stage, extra) => dbg('[СМЭШ AI] auto-fetch:', stage, extra ?? '');

  // The API path is the precise one (it knows which homework owns which file), so
  // prefer it whenever we have a lesson id. The DOM scan is only a fallback for
  // when there's no id (it can't tell which of several files belongs to the task).
  let urls = [];
  let candidates = [];
  let stage = '';
  if (lessonId && token) {
    try {
      const personId = jwtPayload(token)?.msh || null;
      const student = await resolveStudentId(headers);
      assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
      if (!student.id) {
        const ambiguous = !!student.error;
        const studentStage = ambiguous ? 'ambiguous_student' : 'no_student_id';
        log(studentStage, student.error);
        return { ok: false, files: [], urls: [], candidates: [], token, headers, stage: studentStage, error: student.error };
      }
      const studentId = student.id;
      const apiUrl = LESSON_API(lessonId, studentId, personId);
      log('request', { lessonId, studentId, personId, apiUrl });
      const { res, json } = await fetchMeshJson(
        apiUrl, { credentials: 'include', headers }, MESH_LESSON_JSON_MAX_BYTES
      );
      assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
      if (!res.ok) {
        log('api_error', res.status);
        return { ok: false, files: [], urls: [], candidates: [], token, headers, stage: 'api_error', status: res.status };
      }
      const matched = urlsForHomework(json, taskText, homeworkItemId);
      urls = matched.urls.slice(0, 5);
      candidates = matched.candidates.slice(0, 8);
      stage = urls.length ? 'found_api' : 'no_urls';
    } catch (e) {
      if (e?.code === HOMEWORK_CONTEXT_CHANGED) throw e;
      log('exception', String(e));
      return { ok: false, files: [], urls: [], candidates: [], token, headers, stage: 'exception' };
    }
  }

  // Fallback: scan the page DOM (works on the homework detail page even without
  // a lesson id). It can't tell which homework a file belongs to, so it's the
  // second choice — used only when the API surfaced nothing.
  if (!urls.length) {
    assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
    const dom = scanPageForFileLinks({ rowToken });
    if (dom.urls.length) { urls = dom.urls; stage = 'found_dom'; }
    else if (dom.candidates.length) {
      const seen = new Set(candidates.map((candidate) => candidate.url));
      for (const candidate of dom.candidates) {
        if (!seen.has(candidate.url)) { candidates.push(candidate); seen.add(candidate.url); }
      }
      candidates = candidates.slice(0, 8);
    }
  }
  if (!urls.length) {
    assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
    const why = !lessonId ? 'no_lesson_id' : !token ? 'no_token' : 'no_urls';
    log(why);
    return { ok: false, files: [], urls: [], candidates, token, headers, stage: why };
  }

  // Download same-origin attachments inline (real cookies); leave cross-origin
  // for the service worker. If a same-origin fetch comes back as HTML, it was an
  // auth redirect — report that distinctly so we don't attach a login page.
  const files = [];
  const crossOrigin = [];
  let sawAuth = false;
  for (const u of urls) {
    if (!isSameOrigin(u)) { crossOrigin.push(u); continue; }
    const f = await fetchInlineFile(u);
    assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
    if (f?.__auth) sawAuth = true;
    else if (f) files.push(f);
  }
  if (!files.length && !crossOrigin.length) {
    assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
    log(sawAuth ? 'auth_redirect' : 'download_failed', urls);
    return { ok: false, files: [], urls: [], candidates, token, headers, stage: sawAuth ? 'auth_redirect' : 'download_failed' };
  }
  assertHomeworkContext(expectedPrincipal, expectedPrincipalError, rowToken);
  log('ok', { files: files.map((f) => f.name), crossOrigin });
  return { ok: true, files, urls: crossOrigin, candidates, token, headers, stage };
}

/**
 * Diagnostic for the file auto-fetch: WHICH LAYER failed — is there a token, was
 * a student resolved and from where, what did the family API answer, which
 * attachment links does the page expose, and what comes back when each is
 * probed. One copy-paste of this tells us where the chain breaks.
 *
 * PRIVACY: this output is shown to a schoolchild in a textarea captioned
 * «Скопировать результат» and is meant to be pasted into a support chat, so it
 * must not carry account identifiers. The person/student ids, the raw
 * localStorage scrape and the API error body they can appear in were removed;
 * their PRESENCE and their SOURCE are what actually diagnose the failure, and
 * that is all this reports. Keep it that way when extending it.
 */
/**
 * An attachment link is a CAPABILITY, not just an address: a real one looks
 * like `…/attachments/<uuid>.pdf?student_id=123&sig=…`, so pasting it verbatim
 * into a support chat hands over both the child's id and access to the file.
 * Report only what actually diagnoses the failure — origin, path SHAPE, and
 * file extension — with every opaque id and the whole query/fragment removed.
 */
function diagnosticSegment(segment) {
  const dot = segment.lastIndexOf('.');
  const hasExtension = dot > 0 && segment.length - dot <= 6;
  const extension = hasExtension ? segment.slice(dot).toLowerCase() : '';
  const stem = hasExtension ? segment.slice(0, dot) : segment;
  const opaque = stem.length > 24 ||
    /^\d{3,}$/.test(stem) ||
    /^[0-9a-f]{8,}$/i.test(stem) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(stem);
  return (opaque ? '<id>' : stem) + extension;
}

function diagnosticUrl(raw) {
  try {
    const url = new URL(String(raw), location.href);
    const path = url.pathname.split('/').filter(Boolean).map(diagnosticSegment).join('/');
    return `${url.origin}/${path}${url.search ? '?<redacted>' : ''}`;
  } catch {
    return '<unparseable url>';
  }
}

// Strict scalar allowlist. Raw API structures (attachments, additional
// materials, kr_attachments, details.content) carried ids, titles and signed
// URLs straight into the copy-paste box; their SHAPE is what diagnoses the
// failure, so only counts and redacted links survive.
function diagnosticUrlList(value) {
  const urls = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
  return urls.slice(0, 6).map(diagnosticUrl);
}

function diagnosticCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value == null) return 0;
  return typeof value === 'object' ? Object.keys(value).length : 1;
}

async function debugFetch(lessonId) {
  const token = findAuthToken();
  const headers = meshHeaders(token);
  const sid = await resolveStudentId(headers);
  const personId = token ? (jwtPayload(token)?.msh || null) : null;
  // RAW links, kept local. The probes below must fetch the real signed URLs —
  // feeding them the redacted output turned every probe into a request for
  // `.../<id>.pdf?<redacted>`, so the diagnostic reported invented 403/404s for
  // links that were actually fine. Only `out` is ever shown or copied.
  const domLinks = (() => {
    const found = scanPageForFileLinks();
    return [...found.urls, ...found.candidates.map((candidate) => candidate.url)];
  })();
  const out = {
    pagePath: (() => {
      try { return diagnosticUrl(location.href).replace(/^https?:\/\/[^/]+/i, ''); } catch { return null; }
    })(),
    // The lesson id identifies the child's specific lesson. Its PRESENCE is
    // what tells us whether the row was resolved at all.
    lessonIdFound: !!lessonId,
    tokenFound: !!token,
    personIdFound: !!personId,
    studentIdFound: !!sid.id,
    studentIdSource: sid.source,
    studentIdError: sid.error || null,
    // Which endpoints were tried and what they answered — no ids, no bodies.
    studentIdProbe: (sid.debug || []).map((entry) => ({
      url: diagnosticUrl(entry.url),
      status: entry.status ?? null,
      keys: Array.isArray(entry.keys) ? entry.keys : (entry.keys ?? null),
      error: entry.error ? String(entry.error).slice(0, 120) : null
    })),
    domFileLinks: domLinks.map(diagnosticUrl),
    domAnchorCount: document.querySelectorAll('a[href]').length
  };
  let apiUrls = [];
  if (lessonId && token) {
    const apiUrl = LESSON_API(lessonId, sid.id, personId);
    // The query string carries student_id and person_id, AND the path itself
    // ends in the lesson id — reporting the bare pathname exported exactly the
    // identifier the contract above promises to withhold. Redact it the same
    // way as every other URL so only the endpoint SHAPE survives.
    out.apiPath = diagnosticUrl(apiUrl).replace(/^https?:\/\/[^/]+/, '');
    try {
      const { res, json } = await fetchMeshJson(
        apiUrl, { credentials: 'include', headers }, MESH_LESSON_JSON_MAX_BYTES
      );
      out.httpStatus = res.status;
      if (res.ok) {
        out.subjectName = json?.subject_name;
        apiUrls = [...collectFileUrls(json)];
        out.foundUrls = apiUrls.map(diagnosticUrl);
        // Where a real uploaded file lives (vs a digital-library binding) is
        // the diagnostic value here — the counts and link shapes, never the
        // raw objects, their ids or their titles.
        out.homeworks = (json?.lesson_homeworks || []).map((h) => ({
          attachmentCount: diagnosticCount(h.attachments),
          attachmentUrls: diagnosticUrlList(h.attachments),
          additionalMaterials: (h.additional_materials || []).map((m) => ({
            type: m.type,
            urlCount: diagnosticCount(m.urls),
            urls: diagnosticUrlList(m.urls)
          }))
        }));
        out.krAttachmentCount = diagnosticCount(json?.kr_attachments);
        out.krAttachmentUrls = diagnosticUrlList(json?.kr_attachments);
        out.detailsContentPresent = json?.details?.content != null;
      }
      // No body sample on failure: a Mesh error body can echo the student and
      // person ids back at us, and the status alone identifies the layer.
    } catch (e) { out.exception = String(e); }
  }

  // Actually try to download each candidate so the diagnostic shows what comes
  // back — a real file (PDF, size) vs an HTML auth redirect vs a 403. This one
  // field usually reveals the fix without further round-trips.
  const candidates = [...new Set([...domLinks, ...apiUrls])].slice(0, 6);
  out.probes = [];
  for (const url of candidates) {
    const p = { url: diagnosticUrl(url), sameOrigin: isSameOrigin(url) };
    let probeDeadline = null;
    try {
      const safe = allowedAttachmentUrl(url);
      if (!safe) { p.error = 'URL rejected'; out.probes.push(p); continue; }
      const ctrl = new AbortController();
      // A complete-operation deadline, not just an abort handle. Without it a
      // stalling server left «Запускаю диагностику…» on screen forever — the
      // wait covers BOTH the headers and every stream read below, and closing
      // the popup did not cancel any of it.
      probeDeadline = setTimeout(() => ctrl.abort(), DIAGNOSTIC_PROBE_TIMEOUT_MS);
      const res = await fetch(safe.href, { credentials: 'include', redirect: 'error', signal: ctrl.signal });
      p.status = res.status;
      p.contentType = (res.headers.get('content-type') || '').split(';')[0];
      // Diagnostics must not become a bypass around the production streaming
      // cap. Count bytes without retaining chunks, and stop at the largest
      // per-file ceiling used by automatic downloads.
      let total = 0;
      const declared = res.headers.get('content-length');
      if (declared && /^\d+$/.test(declared.trim()) && Number(declared) > MAX_AUDIO_UPLOAD_BYTES) {
        p.tooLarge = true;
        ctrl.abort();
      } else {
        const reader = res.body?.getReader();
        if (!reader) { p.error = 'response body unavailable'; out.probes.push(p); continue; }
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value?.byteLength || 0;
          if (total > MAX_AUDIO_UPLOAD_BYTES) {
            p.tooLarge = true;
            try { await reader.cancel('diagnostic size cap'); } catch { /* already closed */ }
            ctrl.abort();
            break;
          }
        }
      }
      p.sizeKB = Math.round(total / 102.4) / 10;
      p.looksHtml = (p.contentType || '').includes('html');
    } catch (e) {
      p.error = ctrlAbortedByDeadline(e) ? 'timeout' : String(e);
    } finally {
      clearTimeout(probeDeadline);
    }
    out.probes.push(p);
  }
  return out;
}

const ctrlAbortedByDeadline = (error) => error?.name === 'AbortError';

/* ---------- Entry point ---------- */

function scanHomeworks() {
  homeworkRowContexts.clear();
  const dom = scanFromDom();
  const result = dom || scanFromText() || { day: null, subjects: [], days: [] };
  // Older text-only layouts have no safe DOM ownership subtree, but still need
  // a unique row identity for popup → dashboard matching. Their attachment DOM
  // fallback therefore yields candidates only.
  for (const group of result.days || []) {
    for (const item of group.subjects || []) if (!item.rowToken) item.rowToken = mintRowToken();
  }
  // Scope the popup's week cache to the exact account + selected child whose
  // diary produced it. A bare student id is not enough: two accounts can expose
  // the same local selection shape, and an account-only switch must invalidate
  // every pending attachment operation too.
  try {
    const binding = currentHomeworkPrincipal();
    result.principal = binding.principal;
    result.principalError = binding.error ? String(binding.error).slice(0, 1024) : null;
  } catch {
    result.principal = null;
    result.principalError = 'Не удалось проверить аккаунт дневника.';
  }
  return result;
}

/* =================================================================
 * TEST AUTO-FILL
 * -----------------------------------------------------------------
 * Given the model's answers ([{ index, answer, choice? }]), discover the
 * test's form controls by DOM traversal — NO hardcoded class names, same as
 * the homework scanner — and fill them in. The Mesh test page is a React/MUI
 * app, so every write goes through the native value setter + bubbling input/
 * change events (text), or a real click() (radio/checkbox), so React's
 * controlled state actually updates.
 *
 * Conservative by design: a control is filled only when the match clears a
 * confidence threshold AND beats the runner-up; anything ambiguous, detached,
 * or unmatched is reported as "skipped" so the copy-paste panel stays the
 * reliable fallback. The form is NEVER submitted.
 * ================================================================= */

// MUI hides the real <input> (opacity:0) behind a styled control, so we can't
// judge a form control by opacity the way isVisible() does. Decide by the
// rendered box of the input OR its label, plus a display/visibility walk.
function isFillable(el) {
  if (!el || el.disabled || el.readOnly) return false;
  let n = el;
  while (n && n.nodeType === 1) {
    const st = window.getComputedStyle(n);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    n = n.parentElement;
  }
  const box = el.getBoundingClientRect();
  // Reject ONLY inputs parked far off-screen to the side (e.g. a math editor's
  // hidden capture <textarea> at left:-9999px). Do NOT reject by top/bottom — a
  // perfectly valid box scrolled above the viewport has a negative bottom, and
  // rejecting it dropped real answer boxes (the bug where a question got no unit
  // and its neighbour absorbed the answer).
  if (box.right < -2000 || box.left > (window.innerWidth || 0) + 2000) return false;
  if (box.width > 0 && box.height > 0) return true;
  // A zero-sized control can still be a real answer box when a NEAR ancestor —
  // the styled math-input widget (МЭШ renders «x₁ =» boxes this way) — carries
  // the visible rectangle. Climb a few levels before giving up, so these boxes
  // get collected as units instead of being dropped.
  let ref = el.closest('label') || el.parentElement;
  for (let i = 0; i < 4 && ref; i++, ref = ref.parentElement) {
    const rb = ref.getBoundingClientRect();
    if (rb.width > 0 && rb.height > 0) return true;
  }
  return false;
}

function pickControls(sel) {
  return Array.from(document.querySelectorAll(sel)).filter(isFillable);
}

// Stable per-element key so we can group controls in a Map without classes.
let __smeshUid = 0;
const __smeshUidMap = new WeakMap();
function elUid(el) {
  if (!el) return 'null';
  let v = __smeshUidMap.get(el);
  if (!v) { v = 'e' + (++__smeshUid); __smeshUidMap.set(el, v); }
  return v;
}

function nearestCommonAncestor(a, b) {
  const seen = new Set();
  for (let n = a; n; n = n.parentElement) seen.add(n);
  for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
  return null;
}

function commonAncestor(els) {
  if (!els.length) return null;
  let a = els[0];
  for (let i = 1; i < els.length; i++) {
    a = nearestCommonAncestor(a, els[i]);
    if (!a) return null;
  }
  return a;
}

function domOrderCompare(a, b) {
  if (a === b) return 0;
  const pos = a.compareDocumentPosition(b);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}

// Extract a question number from the prompt text that PRECEDES the first form
// control inside `node`. Anchored at the start so option text ("4 года") can't
// masquerade as a question number. Returns null when no leading number is seen.
function leadingQuestionNumber(node) {
  const ctrl = node.querySelector('input, textarea, select');
  let text = '';
  if (ctrl) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    let t;
    while ((t = walker.nextNode())) {
      if (ctrl.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_PRECEDING) {
        text += ' ' + t.nodeValue;
      } else break;
    }
  } else {
    text = node.textContent;
  }
  const norm = normalize(text);
  // FIRST «Вопрос/Задание №N» ANYWHERE in the heading text — robust to a task-id
  // badge, icon alt-text, or stray whitespace rendered before the heading (which
  // otherwise defeated an anchored ^ match and left the box unnumbered → the
  // positional fallback then shifted answers onto the wrong question's boxes).
  let m = norm.match(QNUM_TEXT_RE);
  if (m && isAuthoritativeQuestionMarker(norm, m, node)) return parseInt(m[1], 10);
  // Otherwise require a number at the very start («№3», «3.» / «3)»).
  m = norm.match(/^\s*[№#]\s*(\d{1,3})\b/) || norm.match(/^\s*(\d{1,3})\s*[.)]/);
  return m ? parseInt(m[1], 10) : null;
}

// Collect every «ЗАДАНИЕ №N» / «Вопрос N» heading on the page as {number, node}
// in document order. This is the RELIABLE way to number a question's answer
// boxes: instead of climbing the DOM tree from each box (which the МЭШ layout
// defeats — the heading can sit far above the inputs), we read the headings once
// and, for each box, take the nearest heading that precedes it (numberForNode).
// Mirrors the homework scanner's day-header pairing.
const QNUM_TEXT_RE = /(?:вопрос|задани[ея])\s*[№#]?\s*(\d{1,3})/i;
const QNUM_TEXT_ALL_RE = /(?:вопрос|задани[ея])\s*[№#]?\s*\d{1,3}/gi;
// Accept question numbers only from heading-shaped text. A denylist of prose
// lead-ins can never be complete ("После задания 3…" was one bypass), so the
// prefix is deliberately allowlisted: either no prose precedes the marker, a
// common instruction verb does, or a compact technical task-id badge does.
const QNUM_INSTRUCTION_PREFIX_RE = /^(?:выполните|решите|ответьте(?:\s+на)?|выберите|укажите|заполните|сопоставьте|прочитайте|рассмотрите|определите|найдите|вычислите)$/iu;
const QNUM_TECH_PREFIX_RE = /^(?:id|task)\s*[#№-]?\s*\d+$/iu;
// These tails make «задание N» an external prose reference, not the boundary
// of the current on-page question. Check after an optional heading delimiter so
// «Прочитайте задание 3. В учебнике…» cannot bypass the same rule.
const QNUM_REFERENCE_SUFFIX_RE = /^(?:(?:в|по)\s+(?:учебник\p{L}*|тетрад\p{L}*|параграф\p{L}*|глав\p{L}*|раздел\p{L}*)|из\s+(?:учебник\p{L}*|параграф\p{L}*|глав\p{L}*|раздел\p{L}*|упражнен\p{L}*|задани\p{L}*)|на\s+(?:страниц\p{L}*|стр(?:аниц\p{L}*|\.)?|сайт\p{L}*|портал\p{L}*))(?=\s|[.,;:!?…)}\]»"'—–-]|$)/iu;
const QNUM_HEADING_SEPARATOR_RE = /^[.:—–-]/u;
const QNUM_SCOPE_TAG_RE = /^(?:H[1-6]|P|LI|LEGEND|DT|DD|DIV)$/;

function isQuestionHeadingNode(node) {
  let element = node?.nodeType === 1 ? node : node?.parentElement;
  for (let depth = 0; depth < 4 && element; depth++, element = element.parentElement) {
    const tag = String(element.tagName || '').toUpperCase();
    let role = '';
    try { role = String(element.getAttribute?.('role') || '').toLowerCase(); } catch { /* malformed DOM */ }
    if (/^H[1-6]$/.test(tag) || tag === 'LEGEND' || role.split(/\s+/).includes('heading')) return true;
  }
  return false;
}

function questionMarkerTextScope(textNode) {
  let element = textNode?.parentElement || null;
  let fallback = element;
  for (let depth = 0; depth < 4 && element; depth++, element = element.parentElement) {
    fallback = element;
    const tag = String(element.tagName || '').toUpperCase();
    let role = '';
    try { role = String(element.getAttribute?.('role') || '').toLowerCase(); } catch { /* malformed DOM */ }
    if (QNUM_SCOPE_TAG_RE.test(tag) || role.split(/\s+/).includes('heading')) return element;
  }
  return fallback;
}

function boundedQuestionMarkerText(scope, maxChars = 160) {
  let walker;
  try { walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null); }
  catch { return ''; }
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    const part = String(node.nodeValue || '');
    if (text.length + part.length + 1 > maxChars) return '';
    text += ` ${part}`;
  }
  return normalize(text);
}

function isAuthoritativeQuestionMarker(s, m, node = null) {
  const prefix = s.slice(0, m.index).trim().replace(/[.:—–-]+$/u, '').trim();
  const instructionPrefix = QNUM_INSTRUCTION_PREFIX_RE.test(prefix);
  const technicalPrefix = QNUM_TECH_PREFIX_RE.test(prefix);
  if (prefix && !instructionPrefix && !technicalPrefix) return false;
  const suffix = s.slice(m.index + m[0].length).trim();
  const semanticSuffix = suffix.replace(/^[.,;:—–-]+\s*/u, '');
  if (QNUM_REFERENCE_SUFFIX_RE.test(semanticSuffix)) return false;
  if (!suffix || m.index === 0 || technicalPrefix) return true;
  // A semantic heading or explicit separator is authoritative; otherwise the
  // remaining words are prose about a numbered task, not a question boundary.
  return isQuestionHeadingNode(node) || QNUM_HEADING_SEPARATOR_RE.test(suffix);
}
function collectQuestionMarkers() {
  const out = [];
  const root = document.body || document.documentElement;
  if (!root) return out;
  let walker;
  // Walk TEXT NODES once (O(total text)) — fast even on Mesh's huge React DOM,
  // unlike reading textContent on every element (which is O(n²) and was bloating
  // the fill). A cheap word pre-filter skips the ~99.9% of nodes that can't be a
  // heading before any regex/normalize work.
  try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null); }
  catch { return out; }
  const checkedScopes = new Set();
  let t;
  while ((t = walker.nextNode())) {
    const raw = t.nodeValue;
    if (!raw || !/задани|вопрос/i.test(raw)) continue;
    let s = normalize(raw);
    let m = s.match(QNUM_TEXT_RE);
    let markerNode = t.parentElement || t;
    // A marker or its disqualifying tail may be split across sibling spans.
    // Evaluate the nearest short block/heading as one semantic unit, not the
    // individual text node («Прочитайте» | «задание 3» | «в учебнике»).
    const scope = questionMarkerTextScope(t);
    if (scope) {
      const scopedText = boundedQuestionMarkerText(scope);
      const scopedMarkers = scopedText ? scopedText.match(QNUM_TEXT_ALL_RE) : null;
      const scopedMatch = scopedMarkers?.length === 1 ? scopedText.match(QNUM_TEXT_RE) : null;
      if (scopedMatch) {
        if (checkedScopes.has(scope)) continue;
        checkedScopes.add(scope);
        s = scopedText;
        m = scopedMatch;
        markerNode = scope;
      }
    }
    // A real «ЗАДАНИЕ №N» heading is short OR leads its text (a task-id badge may
    // sit just before it); a deep mention inside prose is not a heading.
    if (m && isAuthoritativeQuestionMarker(s, m, markerNode) &&
        (s.length <= 60 || m.index <= 20 || isQuestionHeadingNode(markerNode))) {
      out.push({ number: parseInt(m[1], 10), node: markerNode });
    }
  }
  return out;
}

// The question number for a node = the nearest «ЗАДАНИЕ №N» heading that PRECEDES
// it in document order. Markers are already in document order.
function numberForNode(node, markers) {
  if (!node || !markers || !markers.length) return null;
  let num = null;
  for (const m of markers) {
    if (m.node === node) { num = m.number; continue; }
    const pos = m.node.compareDocumentPosition(node);
    // node comes after (or is inside) the marker → marker is a candidate.
    if (pos & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY)) num = m.number;
    // node comes before the marker → all later markers are also after it; stop.
    else if (pos & Node.DOCUMENT_POSITION_PRECEDING) break;
  }
  return num;
}

// Climb from a control's container looking for the enclosing question block and
// its number. Falls back to (base, null) — positional matching takes over then.
function questionInfo(base) {
  let node = base;
  for (let i = 0; i < 6 && node && node !== document.body; i++, node = node.parentElement) {
    const num = leadingQuestionNumber(node);
    if (num != null) return { container: node, number: num };
  }
  return { container: base, number: null };
}

// Smallest ancestor that groups this checkbox with its siblings but no controls
// of another question. MUI checkboxes in a FormGroup rarely share a name, so we
// group by container instead. Stops as soon as climbing would pull in a radio /
// text control (a different question type) or a numbered question boundary.
function checkboxGroupContainer(cb) {
  let best = cb.parentElement || cb;
  let node = cb.parentElement;
  while (node && node !== document.body) {
    const mixers = node.querySelectorAll('input[type=radio], input[type=text], input[type=number], input:not([type]), textarea');
    if (mixers.length) break;
    best = node;
    if (leadingQuestionNumber(node) != null) break;
    node = node.parentElement;
  }
  return best;
}

function makeUnit(type, inputs, providedContainer, number) {
  // Prefer the document-order question number (number, passed in by collectUnits);
  // fall back to climbing the container tree when the page has no headings.
  let num = number;
  if (num == null) {
    const base = providedContainer || commonAncestor(inputs) || inputs[0].parentElement || inputs[0];
    num = questionInfo(base).number;
  }
  return { type, inputs, anchor: inputs[0], number: num != null ? num : null };
}

// Discover every fillable question on the page as a list of units, in document
// order. Radios group by their shared `name` (MUI RadioGroup) or RadioGroup
// container; checkboxes by container; text/number/textarea group by question
// card so one task's several answer boxes (x & y, x₁ & x₂) form a single unit.
function collectUnits() {
  const units = [];
  const consumed = new Set();

  // Read the «ЗАДАНИЕ №N» headings once; every control is numbered by the nearest
  // heading that precedes it (numberForNode). This is the reliable association on
  // Mesh's layout, where the heading sits far above the answer boxes.
  const markers = collectQuestionMarkers();
  const numFor = (el) => numberForNode(el, markers);

  // --- radio groups ---
  const radioByKey = new Map();
  for (const r of pickControls('input[type=radio]')) {
    const key = r.name ? 'name:' + r.name : 'grp:' + elUid(r.closest('[role=radiogroup]') || r.parentElement);
    if (!radioByKey.has(key)) radioByKey.set(key, []);
    radioByKey.get(key).push(r);
    consumed.add(r);
  }
  for (const inputs of radioByKey.values()) units.push(makeUnit('radio', inputs, null, numFor(inputs[0])));

  // --- checkbox groups ---
  const cbByKey = new Map();
  for (const c of pickControls('input[type=checkbox]')) {
    if (consumed.has(c)) continue;
    const container = checkboxGroupContainer(c);
    const key = 'cb:' + elUid(container);
    if (!cbByKey.has(key)) cbByKey.set(key, { container, inputs: [] });
    cbByKey.get(key).inputs.push(c);
  }
  for (const { container, inputs } of cbByKey.values()) units.push(makeUnit('checkbox', inputs, container, numFor(inputs[0])));

  // --- selects (native dropdowns) ---
  // A «выберите из списка» question (e.g. «система … имеет …») is one <select>.
  // One select = one unit; filled by matching the answer to an <option> text.
  for (const s of pickControls('select')) {
    if (consumed.has(s)) continue;
    consumed.add(s);
    units.push(makeUnit('select', [s], null, numFor(s)));
  }

  // --- free text / number / textarea ---
  // Group the boxes that belong to the SAME question (a system's x & y, a
  // quadratic's x₁ & x₂, several blanks) into ONE multi-field unit, so a single
  // answer carrying several values fills every box instead of dumping the whole
  // string into the first box or shifting onto the next question. When the page
  // has «ЗАДАНИЕ №N» headings, boxes are grouped by their associated number —
  // robust regardless of how deeply the boxes are nested. With no headings we
  // can't tell questions apart, so each box stays its own unit (legacy behavior,
  // safe for ordinary single-box tests).
  // Exclude MathQuill's internal capture <textarea> (inside .mq-editable-field):
  // it ignores a value-set — those formula boxes are filled separately via the
  // MathQuill API in the page's main world (see service-worker fillMathQuillMain).
  // Touching it here only created phantom units.
  const textCtrls = pickControls('input[type=text], input[type=number], input:not([type]), textarea')
    .filter((t) => !consumed.has(t) && !(t.closest && t.closest('.mq-editable-field, .mathquill-input')));
  if (markers.length) {
    const byNum = new Map();
    const order = [];
    const unnumbered = [];
    for (const t of textCtrls) {
      const n = numFor(t);
      if (n == null) { unnumbered.push(t); continue; }
      const key = 'n:' + n;
      if (!byNum.has(key)) { byNum.set(key, { num: n, inputs: [] }); order.push(key); }
      byNum.get(key).inputs.push(t);
    }
    for (const key of order) {
      const g = byNum.get(key);
      units.push(makeUnit('text', g.inputs, null, g.num));
    }
    // Boxes that sit before any heading → fall back to the container heuristic.
    for (const t of unnumbered) units.push(makeUnit('text', [t], null, null));
  } else {
    for (const t of textCtrls) units.push(makeUnit('text', [t], null, null));
  }

  units.sort((a, b) => domOrderCompare(a.anchor, b.anchor));
  return units;
}

// Resolve the visible label text for an option control. Tries, in order:
// associated <label>, wrapping <label> (MUI FormControlLabel), aria-label /
// aria-labelledby, then a text-bearing sibling that holds no nested input.
function controlLabelText(input) {
  try {
    if (input.labels && input.labels.length) {
      const t = normalize(Array.from(input.labels).map((l) => l.textContent).join(' '));
      if (t) return t;
    }
  } catch { /* .labels can throw on detached nodes */ }
  const lab = input.closest('label');
  if (lab) { const t = normalize(lab.textContent); if (t) return t; }
  const al = input.getAttribute('aria-label');
  if (al && normalize(al)) return normalize(al);
  const lb = input.getAttribute('aria-labelledby');
  if (lb) {
    const t = normalize(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
    if (t) return t;
  }
  let node = input.parentElement;
  for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
    const siblings = node.parentElement ? node.parentElement.children : [];
    for (const sib of siblings) {
      if (sib === node || (sib.querySelector && sib.querySelector('input'))) continue;
      const t = normalize(sib.textContent);
      if (t) return t;
    }
    const own = normalize(node.textContent);
    if (own) return own;
  }
  return '';
}

// Normalize an answer / option label for fuzzy comparison: lowercase, ё→е,
// strip a leading enumerator ("Б)", "2."), drop punctuation, collapse spaces.
function normalizeForMatch(s) {
  return normalize(s)
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/^[a-zа-я0-9]{1,2}\s*[).:\-–—]\s*/i, '')
    .replace(/[«»"'’.,;:!?()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cyrillic option lettering as Mesh uses it (а, б, в, …; ё and й skipped).
const OPTION_LETTERS = 'абвгдежзиклмнопрстуф';

// Interpret a bare letter ("Б"), latin letter, or number ("2") as a 0-based
// option index. Returns -1 when the string isn't a pure positional reference.
function asOptionIndex(s) {
  const t = normalize(s).toLowerCase().replace(/ё/g, 'е').replace(/[).:\-–—]/g, '').trim();
  if (/^[а-я]$/.test(t)) { const i = OPTION_LETTERS.indexOf(t); return i >= 0 ? i : -1; }
  if (/^[a-z]$/.test(t)) return t.charCodeAt(0) - 97;
  if (/^\d{1,2}$/.test(t)) return parseInt(t, 10) - 1;
  return -1;
}

// Parse the model's positional hint (the `choice`/`c` field) into a list of
// 0-based option indices. Accepts a single token ("б", "2") or several
// separated by comma / semicolon / "и" / slash ("1, 3", "а и в"). Out-of-range
// or unparseable tokens are dropped. Used as a reliable fallback when fuzzy
// text matching of the option labels is ambiguous or fails.
function parseChoiceIndices(choice, optionCount) {
  if (choice == null) return [];
  const out = [];
  for (const tok of String(choice).split(/\s*[,;/|]\s*|\s+и\s+/i)) {
    const idx = asOptionIndex(tok);
    if (idx >= 0 && idx < optionCount && !out.includes(idx)) out.push(idx);
  }
  return out;
}

// Similarity in [0,1]: exact normalized match → 1, containment → high, else a
// token Jaccard capped below containment so a partial word overlap can't pose
// as a strong match.
function similarity(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  if (bNorm.includes(aNorm) || aNorm.includes(bNorm)) {
    const lo = Math.min(aNorm.length, bNorm.length);
    const hi = Math.max(aNorm.length, bNorm.length);
    return 0.6 + 0.39 * (lo / hi);
  }
  const A = new Set(aNorm.split(' ').filter(Boolean));
  const B = new Set(bNorm.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (inter / (A.size + B.size - inter)) * 0.8;
}

const MATCH_MIN = 0.5;   // floor: below this we never select
const MATCH_MARGIN = 0.08; // best must beat runner-up by this much

// Pick the single best option for one answer string. Text similarity is the
// primary signal; a bare letter/number in the answer (or an explicit `choice`
// hint from the model) is used only as a fallback when text doesn't decide.
function bestOption(answerStr, options, choice) {
  const aNorm = normalizeForMatch(answerStr);
  let best = null;
  let second = null;
  for (const o of options) {
    const s = similarity(aNorm, o.labelNorm);
    if (!best || s > best.s) { second = best; best = { opt: o, s }; }
    else if (!second || s > second.s) second = { opt: o, s };
  }
  if (best && best.s >= MATCH_MIN && (!second || best.s - second.s >= MATCH_MARGIN)) return best.opt;
  let idx = asOptionIndex(answerStr);
  if (idx < 0 && choice != null) idx = asOptionIndex(String(choice));
  if (idx >= 0 && idx < options.length) return options[idx];
  return null;
}

/* ---- Multi-field answers (one question, several answer boxes) ---- */
// Some Mesh tasks need SEVERAL values typed into SEPARATE boxes: a system of
// equations (x and y), a quadratic's two roots (x₁, x₂), several blanks. The
// model returns those as `parts` ([{label,value}]) alongside the combined `a`
// string; we map each part to the right box by its variable label, falling back
// to screen order. That is what makes «x=4; y=-6» land as 4 in x and -6 in y
// instead of the whole string in one box (or, worse, shifted into the next
// question).

const SUBSCRIPT_DIGITS = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9' };
function asciiSubscripts(s) { return String(s ?? '').replace(/[₀-₉]/g, (c) => SUBSCRIPT_DIGITS[c] || c); }

// Short key for a field's variable name: lowercase, subscripts→digits, ё→е, drop
// a trailing «=»/«:», strip punctuation/spaces. «x ₁ =» → «x1», «Y:» → «y».
// Returns '' for anything longer than a short label (e.g. a prompt sentence), so
// a messy capture never poses as a variable name.
function normalizeFieldLabel(s) {
  let t = asciiSubscripts(normalize(s)).toLowerCase().replace(/ё/g, 'е');
  t = t.replace(/\s*[=:]\s*$/, '').trim();
  t = t.replace(/[«»"'’`().,;]/g, '').replace(/\s+/g, '');
  return t.length && t.length <= 6 ? t : '';
}

// Closest short text just before a text input — its on-screen variable name
// («x =», «y =»). Walks previous siblings then climbs a few levels; stops at any
// control so it never reads across into another field's label.
function precedingFieldText(input) {
  let node = input;
  for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
    let sib = node.previousSibling;
    while (sib) {
      if (sib.nodeType === 1) {
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(sib.tagName)) return '';
        if (sib.querySelector && sib.querySelector('input, textarea, select')) return '';
      }
      const tx = normalize(sib.nodeType === 3 ? sib.nodeValue : sib.textContent);
      if (tx) return tx.slice(-24);
      sib = sib.previousSibling;
    }
    node = node.parentElement;
  }
  return '';
}

// Resolve a text input's variable label — explicit associations first, then the
// visible text right before it.
function fieldLabel(input) {
  let t = '';
  try { if (input.labels && input.labels.length) t = normalize(Array.from(input.labels).map((l) => l.textContent).join(' ')); }
  catch { /* .labels can throw on detached nodes */ }
  if (!t) t = normalize(input.getAttribute('aria-label') || '');
  if (!t) t = normalize(input.getAttribute('placeholder') || '');
  if (!t) t = normalize(input.getAttribute('name') || '');
  if (!t) t = precedingFieldText(input);
  return normalizeFieldLabel(t);
}

// The list of {label,value} a question must spread across its boxes. Prefers the
// model's structured `parts`; otherwise splits the combined answer into
// «var = value» pieces — but only when EVERY piece is clearly labelled, so a
// single value like «(2; 3)» is never shredded by its inner punctuation.
function questionParts(question) {
  if (Array.isArray(question.parts) && question.parts.length) {
    return question.parts
      .map((p) => ({ label: String(p.label ?? '').trim(), value: String(p.value ?? '').trim() }))
      .filter((p) => p.value !== '' || p.label !== '');
  }
  const ans = String(question.answer ?? '').trim();
  if (!ans) return [];
  const trySplit = (sep) => {
    const pieces = ans.split(sep).map((s) => s.trim()).filter(Boolean);
    if (pieces.length < 2) return null;
    const parsed = pieces.map((piece) => {
      const m = piece.match(/^([a-zа-я][a-zа-я0-9₀-₉]{0,3})\s*[=:]\s*(.+)$/i);
      return m ? { label: m[1], value: m[2].trim() } : { label: '', value: piece };
    });
    return parsed.every((p) => p.label) ? parsed : null;
  };
  return trySplit(/[;\n]+/) || trySplit(/,/) || [{ label: '', value: ans }];
}

// Align a question's values to its input boxes: match by variable label, then
// fill any leftover boxes in screen order. Returns an array parallel to `inputs`.
function distributeFieldValues(question, inputs) {
  const values = new Array(inputs.length).fill('');
  const parts = questionParts(question);
  if (!parts.length) return values;
  const labels = inputs.map(fieldLabel);
  const usedPart = new Set();
  // 1) label match — only when both sides have a real short variable name.
  inputs.forEach((_, k) => {
    const lbl = labels[k];
    if (!lbl) return;
    for (let p = 0; p < parts.length; p++) {
      if (usedPart.has(p)) continue;
      if (normalizeFieldLabel(parts[p].label) === lbl) { values[k] = parts[p].value; usedPart.add(p); break; }
    }
  });
  // 2) fill remaining boxes positionally from remaining parts (screen order).
  let pp = 0;
  for (let k = 0; k < inputs.length; k++) {
    if (values[k] !== '') continue;
    while (pp < parts.length && usedPart.has(pp)) pp++;
    if (pp < parts.length) { values[k] = parts[pp].value; usedPart.add(pp); pp++; }
  }
  return values;
}

// --- React-aware writers ---

// Write a value into a standard answer box: native value setter (so React's value
// tracker picks it up) + bubbling input/change. Deliberately MINIMAL and fast —
// no focus(), no InputEvent/beforeinput. Those were added to try to drive Mesh's
// MyScript formula widgets, but they triggered heavy SYNCHRONOUS recognition work
// inside the page on every box, which hung the whole fill (and so the solve) to
// the timeout. The formula boxes need a different, non-blocking approach (TODO:
// see __smeshDumpBoxes diagnostics); plain inputs fill reliably with just this.
function mutationGuardCurrent(guard, element) {
  if (!element || !document.documentElement.contains(element)) {
    if (guard) guard.stale = true;
    return false;
  }
  return interactiveGuardCurrent(guard);
}

function setNativeValue(el, value, guard = null) {
  if (!mutationGuardCurrent(guard, el)) return false;
  const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (!mutationGuardCurrent(guard, el)) return false;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return mutationGuardCurrent(guard, el);
}

// React-aware <select> writer: set the value through the native setter (so a
// controlled React select picks it up), mark the option selected, then fire
// input/change. Mirrors setNativeValue for text inputs.
function setSelectValue(sel, option, guard = null) {
  if (!mutationGuardCurrent(guard, sel)) return false;
  try {
    const proto = HTMLSelectElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(sel, option.value);
    else sel.value = option.value;
  } catch { sel.value = option.value; }
  try { option.selected = true; } catch { /* */ }
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  if (!mutationGuardCurrent(guard, sel)) return false;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return mutationGuardCurrent(guard, sel);
}

function selectRadio(input, guard = null) {
  if (!mutationGuardCurrent(guard, input)) return false;
  if (!input.checked) input.click(); // real click → React's onChange fires
  if (!mutationGuardCurrent(guard, input)) return false;
  if (!input.checked) { // belt-and-braces for non-standard handlers
    input.checked = true;
    input.dispatchEvent(new Event('click', { bubbles: true }));
    if (!mutationGuardCurrent(guard, input)) return false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return mutationGuardCurrent(guard, input);
}

function setCheckbox(input, desired, guard = null) {
  if (!mutationGuardCurrent(guard, input)) return false;
  if (input.checked !== desired) input.click();
  if (!mutationGuardCurrent(guard, input)) return false;
  if (input.checked !== desired) {
    input.checked = desired;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return mutationGuardCurrent(guard, input);
}

// Compact element description for the fill diagnostics — enough to identify a
// box's real widget type (plain <input> vs formula/contenteditable/math-field)
// from the console without guessing.
function boxInfo(el) {
  if (!el || !el.tagName) return null;
  let cls = '';
  try { cls = (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '').slice(0, 60); } catch { /* */ }
  let kids = '';
  try { kids = Array.from(el.children || []).slice(0, 5).map((c) => c.tagName.toLowerCase()).join(','); } catch { /* */ }
  return {
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute && el.getAttribute('type')) || '',
    role: (el.getAttribute && el.getAttribute('role')) || '',
    ce: !!el.isContentEditable,
    ro: !!(el.readOnly || (el.getAttribute && el.getAttribute('readonly') != null)),
    val: (() => { try { return String(el.value ?? '').slice(0, 16); } catch { return ''; } })(),
    cls,
    kids
  };
}

// This is the explicitly allowed set of reformatted equivalents for an answer:
// normalised case/ё/dashes/decimal separator, whitespace-free equality, or the
// same finite number. Anything looser (the old any-non-empty check) lets a
// controlled widget revert to a stale wrong value and still report a false ✓.
function answerValueMatches(got, want) {
  const comparable = (value) => normalize(String(value ?? ''))
    .toLowerCase().replace(/ё/g, 'е').replace(/[−–—]/g, '-');
  const gotNorm = comparable(got);
  const wantNorm = comparable(want);
  if (gotNorm === wantNorm) return true;
  const gotCompact = gotNorm.replace(/\s/g, '');
  const wantCompact = wantNorm.replace(/\s/g, '');
  if (gotCompact === wantCompact) return true;
  if (!gotCompact || !wantCompact) return false;
  // Decimal comma is an allowed equivalent for numeric answers only. Applying
  // it to arbitrary text would incorrectly equate punctuation ("да, нет" and
  // "да. нет"). Invalid/multi-separator forms remain NaN and fail closed.
  const gotNumber = Number(gotCompact.replace(',', '.'));
  const wantNumber = Number(wantCompact.replace(',', '.'));
  return Number.isFinite(gotNumber) && Number.isFinite(wantNumber) && gotNumber === wantNumber;
}

function answerBoxValue(el) {
  let got = '';
  try { got = String(el.value ?? '').trim(); } catch { /* not a value element */ }
  if (!got) { try { got = normalize(el.textContent || ''); } catch { /* */ } }
  return got;
}

// Read-back honesty check after the framework's settle window. Success means
// the intended answer (or one of answerValueMatches' explicit equivalents) is
// actually present. A merely changed non-empty value is not evidence of that.
function valueTook(el, want) {
  return answerValueMatches(answerBoxValue(el), want);
}

function nativeElementStillCurrent(element) {
  try {
    return !!element && document.documentElement.contains(element);
  } catch {
    return false;
  }
}

function nativeSelectTook(select, option) {
  if (!nativeElementStillCurrent(select) || !option) return false;
  try {
    const selected = Array.from(select.options || []).filter((candidate) => candidate.selected);
    return String(select.value) === String(option.value) &&
      selected.length === 1 &&
      selected[0] === option;
  } catch {
    return false;
  }
}

function nativeCheckedSetTook(expected) {
  if (!Array.isArray(expected) || !expected.length) return false;
  return expected.every(({ input, checked }) =>
    nativeElementStillCurrent(input) && input.checked === checked
  );
}

function pendingWriteTook(write) {
  if (!write) return false;
  if (typeof write.verify === 'function') {
    try { return write.verify() === true; } catch { return false; }
  }
  return nativeElementStillCurrent(write.el) && valueTook(write.el, write.want);
}

// Don't act on a "not visible, scroll" sentinel or an empty answer.
function isUnfillableAnswer(ans) {
  return !ans || /не\s*видно|прокрут/i.test(ans);
}

// Fill one discovered unit from one question. Returns true only on a real edit.
function fillUnit(unit, question, pendingVerify, guard = null) {
  const ans = String(question.answer ?? '').trim();
  if (isUnfillableAnswer(ans)) return false;

  if (unit.type === 'text') {
    const inputs = unit.inputs.filter((i) => i && document.documentElement.contains(i));
    if (!inputs.length) return false;
    // One box — the whole answer goes in. Verification is deliberately deferred
    // until React/MyScript has had one settle window in which to accept or revert.
    if (inputs.length === 1) {
      if (!setNativeValue(inputs[0], ans, guard)) return false;
      pendingVerify.push({ el: inputs[0], want: ans });
      return true;
    }
    // Several boxes for ONE question (system, multiple roots, several blanks):
    // spread the per-field values across them by label, then screen order.
    const values = distributeFieldValues(question, inputs);
    let wrote = false;
    for (let k = 0; k < inputs.length; k++) {
      const inp = inputs[k];
      if (values[k] != null && values[k] !== '') {
        if (!setNativeValue(inp, values[k], guard)) return false;
        pendingVerify.push({ el: inp, want: values[k] });
        wrote = true;
      }
    }
    // Couldn't split (no parts, unparseable) → put the full answer in the first
    // box so something still lands, matching the legacy single-box fallback.
    if (!wrote) {
      if (!setNativeValue(inputs[0], ans, guard)) return false;
      pendingVerify.push({ el: inputs[0], want: ans });
      wrote = true;
    }
    // Optimistic only for unit ownership; the delayed every-box check below
    // decides whether this question remains ✓ or is honestly demoted to ⚠.
    return wrote;
  }

  if (unit.type === 'select') {
    const sel = unit.inputs[0];
    if (!sel || !document.documentElement.contains(sel) || !sel.options || !sel.options.length) return false;
    const aNorm = normalizeForMatch(ans);
    let best = null;
    let second = null;
    const isPlaceholder = (option, index) => index === 0 &&
      (option.value === '' || !normalizeForMatch(option.textContent));
    for (const [index, o] of [...sel.options].entries()) {
      if (isPlaceholder(o, index)) continue;
      const norm = normalizeForMatch(o.textContent);
      if (!norm) continue;
      const s = similarity(aNorm, norm);
      if (!best || s > best.s) { second = best; best = { o, s }; }
      else if (!second || s > second.s) second = { o, s };
    }
    // The model's `choice` hint (1-based option number) may resolve a missing,
    // weak, or ambiguous text match. Without a usable hint, every entry into
    // this block must skip the select rather than commit its best guess.
    if (!best || best.s < MATCH_MIN || (second && best.s - second.s < MATCH_MARGIN)) {
      const idxs = parseChoiceIndices(question.choice, sel.options.length);
      // Choice indices count VISIBLE options; the placeholder shifts them by one.
      const offset = (sel.options[0] && isPlaceholder(sel.options[0], 0)) ? 1 : 0;
      if (idxs.length && sel.options[idxs[0] + offset]) best = { o: sel.options[idxs[0] + offset], s: 1 };
      else return false;
    }
    if (!setSelectValue(sel, best.o, guard)) return false;
    if (!nativeSelectTook(sel, best.o)) return false;
    pendingVerify.push({ verify: () => nativeSelectTook(sel, best.o) });
    return true;
  }

  const options = unit.inputs
    .filter((input) => document.documentElement.contains(input))
    .map((input) => ({ input, labelNorm: normalizeForMatch(controlLabelText(input)) }));
  if (!options.length) return false;

  if (unit.type === 'checkbox') {
    const parts = ans.split(/\s*[,;/]\s*|\s+и\s+|\n\s*/i).map((p) => p.trim()).filter(Boolean);
    const targets = new Set();
    for (const part of (parts.length ? parts : [ans])) {
      const m = bestOption(part, options);
      if (m) targets.add(m.input);
    }
    // Positional fallback/augment: the model's `choice` hint ("1,3" / "а,в")
    // points straight at the right boxes when the label text is hard to match.
    for (const idx of parseChoiceIndices(question.choice, options.length)) {
      if (options[idx]) targets.add(options[idx].input);
    }
    if (!targets.size) return false;
    // Re-solving must also turn stale earlier choices OFF; otherwise МЭШ grades
    // the old wrong checks alongside new targets despite our better answer.
    const expected = options.map((o) => ({ input: o.input, checked: targets.has(o.input) }));
    for (const o of options) {
      if (!setCheckbox(o.input, targets.has(o.input), guard)) return false;
    }
    if (!nativeCheckedSetTook(expected)) return false;
    pendingVerify.push({ verify: () => nativeCheckedSetTook(expected) });
    return true;
  }

  // radio (single choice)
  const m = bestOption(ans, options, question.choice);
  if (!m) return false;
  if (!selectRadio(m.input, guard)) return false;
  const expected = options.map((o) => ({ input: o.input, checked: o.input === m.input }));
  if (!nativeCheckedSetTook(expected)) return false;
  pendingVerify.push({ verify: () => nativeCheckedSetTook(expected) });
  return true;
}

/**
 * Fill the Mesh test form from the model's answers. Matches each question to a
 * discovered unit by its number first, then by position. Never guesses past the
 * confidence threshold and never submits. Returns a Promise resolving to
 * { filled, skipped, diag }, with identifiers from `index` or 1-based position.
 */
async function fillTestAnswers(questions, expectedSignature = '', expectedPrincipal = '') {
  const summary = { filled: [], skipped: [] };
  if (!Array.isArray(questions) || !questions.length) return summary;
  const guard = {
    signature: expectedSignature,
    principal: expectedPrincipal,
    stale: false
  };
  if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };

  const idFor = (q, i) =>
    (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;

  let units = [];
  try { units = collectUnits(); } catch { units = []; }
  // One-line picture of what the page exposed, so a mis-fill can be diagnosed
  // from the test tab's console (filter on «СМЭШ AI fill») without guesswork.
  if (SMESH_DEBUG) try {
    console.log('[СМЭШ AI fill] units:', units.map((u) => ({
      type: u.type, number: u.number, boxes: u.inputs.length,
      els: u.type === 'text' ? u.inputs.slice(0, 6).map(boxInfo) : undefined
    })), 'questions:', questions.map((q, i) => ({ id: idFor(q, i), parts: q.parts ? q.parts.length : 0 })));
  } catch { /* console unavailable */ }
  if (!units.length) {
    questions.forEach((q, i) => summary.skipped.push(idFor(q, i)));
    return summary;
  }

  const byNumber = new Map();
  units.forEach((u) => { if (u.number != null && !byNumber.has(String(u.number))) byNumber.set(String(u.number), u); });

  // Does the page label its questions «ЗАДАНИЕ №N» at all? If so, we trust those
  // on-screen numbers ABSOLUTELY: a NUMBERED unit may only be filled by the
  // question carrying its own number — never positionally by another question.
  // That cross-assignment is exactly what shifted every answer down by one when
  // a question's boxes weren't detected (its neighbour's boxes absorbed the
  // answer). UNNUMBERED units stay positionally fillable either way; only when
  // the page numbers NOTHING do we fall back to pure positional for everything.
  // Keyed on the page (not on this call's question set) so a single-question
  // re-fill can't slip a question onto the wrong numbered boxes either.
  const pageHasNumbers = units.some((u) => u.number != null);

  const used = new Set();
  // A positional candidate is acceptable only if free AND (the page numbers
  // nothing, OR the unit is unnumbered, OR its number equals this question's id).
  const acceptable = (u, id) =>
    u && !used.has(u) && (!pageHasNumbers || u.number == null || String(u.number) === String(id));

  const pendingVerify = [];
  for (let qi = 0; qi < questions.length; qi++) {
    if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };
    const q = questions[qi];
    const id = idFor(q, qi);
    let unit = byNumber.get(String(id));
    if (!unit || used.has(unit)) {
      // Positional fallback: numeric ids map to 1-based order, else array order —
      // but guarded so we never overwrite a differently-numbered question's boxes.
      const posIdx = /^\d+$/.test(String(id)) ? parseInt(id, 10) - 1 : qi;
      unit = acceptable(units[posIdx], id) ? units[posIdx]
        : acceptable(units[qi], id) ? units[qi] : null;
    }
    if (!unit || used.has(unit)) { summary.skipped.push(id); continue; }

    let ok = false;
    const writes = [];
    try { ok = fillUnit(unit, q, writes, guard); } catch { ok = false; }
    if (guard.stale) return { ...summary, stale: true };
    if (ok) {
      used.add(unit);
      summary.filled.push(id);
      if (writes.length) pendingVerify.push({ id, writes });
    }
    else summary.skipped.push(id);
  }

  if (pendingVerify.length) {
    // One shared window is enough: controlled components revert on the next
    // tick/frame, and per-box sleeps would make large forms needlessly slow.
    await __smeshSleep(80);
    if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };
    const demoted = pendingVerify
      .filter((group) => !group.writes.every(pendingWriteTook))
      .map((group) => group.id);
    for (const id of demoted) {
      const at = summary.filled.indexOf(id);
      if (at !== -1) summary.filled.splice(at, 1);
      if (!summary.skipped.includes(id)) summary.skipped.push(id);
    }
    if (demoted.length && SMESH_DEBUG) try {
      console.log('[СМЭШ AI fill] verification demoted:', demoted);
    } catch { /* console unavailable */ }
  }

  dbg('[СМЭШ AI fill] result:', summary);
  // Attach a per-unit diagnostic so the worker can log it from ITS console
  // (the test runs in an iframe, so page-console logs are easy to miss). Cheap;
  // ignored by every existing caller (they read .filled/.skipped only).
  try {
    summary.diag = units.map((u) => ({
      number: u.number, type: u.type, boxes: u.inputs.length,
      els: u.type === 'text' ? u.inputs.slice(0, 6).map(boxInfo) : undefined
    }));
  } catch { /* */ }
  return summary;
}

// Broad, detection-independent scan of every input-like / editable element in
// THIS frame — including MyScript / math-field / contenteditable widgets that the
// normal unit detection might miss. Surfaced for diagnostics so the real shape of
// the formula boxes («x₁ =», coordinate fields) can be seen without DevTools
// frame-hunting (the worker logs it; see fillAllFrames).
function dumpBoxes() {
  const sel = [
    'input', 'textarea', 'select',
    '[contenteditable=""]', '[contenteditable="true"]', '[role="textbox"]',
    'canvas', 'math-field',
    '[class*="myscript" i]', '[class*="mathfield" i]', '[class*="mathquill" i]',
    '[class*="mq-" i]', '[class*="equation" i]', '[class*="formula" i]'
  ].join(',');
  let els = [];
  try { els = Array.from(document.querySelectorAll(sel)); } catch { return []; }
  return els.slice(0, 50).map((el) => {
    const info = boxInfo(el) || {};
    let size = '?';
    try { const b = el.getBoundingClientRect(); size = Math.round(b.width) + 'x' + Math.round(b.height); } catch { /* */ }
    return { ...info, id: (el.id || '').slice(0, 30), size };
  });
}
window.__smeshDumpBoxes = dumpBoxes;

// Shared isolated-world entry point: answer-panel.js (same content-script world,
// so it sees this global) calls it directly — chrome.runtime messaging can't
// reach a sibling content script in the same tab.
window.__smeshFill = fillTestAnswers;

// Diagnostic: what units does THIS page yield? Run `__smeshDebugUnits()` in the
// test tab's console to verify every «ЗАДАНИЕ №N» got a unit with the right box
// count and number — the fastest way to spot a question whose boxes weren't
// detected (which is what lets a neighbour absorb its answer).
function debugUnits() {
  let units = [];
  try { units = collectUnits(); } catch (e) { return { error: String(e) }; }
  return units.map((u, i) => ({
    pos: i,
    type: u.type,
    number: u.number,
    boxes: u.inputs.length,
    labels: u.inputs.slice(0, 8).map((inp) =>
      u.type === 'text' ? fieldLabel(inp) : normalizeForMatch(controlLabelText(inp)).slice(0, 24)),
    elems: u.inputs.slice(0, 8).map(boxInfo)
  }));
}
window.__smeshDebugUnits = debugUnits;

/* =====================================================================
 * INTERACTIVE / CUSTOM CONTROLS (dropdowns, ARIA choices, matching)
 * ---------------------------------------------------------------------
 * fillTestAnswers() above covers native <input>/<select>/<textarea>, and the
 * worker's MathQuill pass covers formula boxes. Mesh ALSO renders questions as
 * custom widgets that carry NO native form control, so the sync fill silently
 * leaves them blank:
 *   • custom dropdowns — MUI Select etc.: a <div>/<button> with
 *     role=combobox / aria-haspopup=listbox / .MuiSelect-select that opens a
 *     portaled listbox of role=option items. «Соответствие» (matching) is often
 *     ONE such dropdown per left-hand item, so it falls out of the same path;
 *   • ARIA radio groups — role=radiogroup → role=radio rendered from <div>s;
 *   • MUI toggle groups — role=group → <button aria-pressed> (single/multi choice).
 *
 * These need a multi-step ASYNC interaction (open the popper, wait a frame,
 * click the option), so they stay out of the native write/settle pass. They run
 * as a SEPARATE pass AFTER it (worker: fillInteractiveAllFrames), and are told which
 * question ids an earlier pass already filled so we never re-open / toggle one
 * back off. Best-effort throughout: anything not confidently matched is left for
 * the copy-paste panel, and the form is NEVER submitted.
 * ===================================================================== */

const __smeshSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isDisabledControl(el) {
  return !!(el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'));
}

// Candidate dropdown TRIGGERS: a custom control that opens a listbox. Strictly
// custom widgets only — a native <select> is handled by the sync fill, and an
// <input role=combobox> (autocomplete) is a text box, so both are excluded here.
function findDropdownTriggers() {
  const out = [];
  const seen = new Set();
  const add = (el) => {
    if (!el || seen.has(el)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;     // native fill owns it
    if (el.closest && el.closest('select')) return;
    if (!isVisible(el)) return;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return;
    seen.add(el);
    out.push(el);
  };
  let els = [];
  try { els = Array.from(document.querySelectorAll('[aria-haspopup="listbox"], [role="combobox"], .MuiSelect-select')); }
  catch { return []; }
  for (const e of els) add(e);
  return out;
}

// Discover interactive units in document order, numbered by the same «ЗАДАНИЕ
// №N» markers the native fill uses. A matching question with several dropdowns
// becomes ONE multi-field 'dropdown' unit (els = every dropdown in that question).
function collectInteractiveUnits() {
  const markers = collectQuestionMarkers();
  const numFor = (el) => numberForNode(el, markers);
  const units = [];
  const consumed = new WeakSet();

  // --- custom dropdowns (grouped by question number for matching) ---
  const byNum = new Map();
  const order = [];
  const loose = [];
  for (const t of findDropdownTriggers()) {
    consumed.add(t);
    const n = numFor(t);
    if (n == null) { loose.push(t); continue; }
    const key = 'n:' + n;
    if (!byNum.has(key)) { byNum.set(key, { num: n, els: [] }); order.push(key); }
    byNum.get(key).els.push(t);
  }
  for (const key of order) { const g = byNum.get(key); units.push({ type: 'dropdown', els: g.els, anchor: g.els[0], number: g.num }); }
  for (const t of loose) units.push({ type: 'dropdown', els: [t], anchor: t, number: null });

  // --- ARIA radio groups (role=radiogroup → role=radio) ---
  let rgs = [];
  try { rgs = Array.from(document.querySelectorAll('[role="radiogroup"]')).filter(isVisible); } catch { /* */ }
  for (const grp of rgs) {
    const radios = Array.from(grp.querySelectorAll('[role="radio"]')).filter((r) => isVisible(r) && !consumed.has(r) && !isDisabledControl(r));
    if (!radios.length) continue;
    radios.forEach((r) => consumed.add(r));
    units.push({ type: 'aria-radio', els: radios, anchor: radios[0], number: numFor(grp) });
  }

  // --- MUI toggle-button groups (role=group → button[aria-pressed]) ---
  let tgs = [];
  try { tgs = Array.from(document.querySelectorAll('[role="group"]')).filter(isVisible); } catch { /* */ }
  for (const grp of tgs) {
    const btns = Array.from(grp.querySelectorAll('button[aria-pressed]')).filter((b) => isVisible(b) && !consumed.has(b) && !isDisabledControl(b));
    if (btns.length < 2) continue; // a lone toggle isn't an answer group
    btns.forEach((b) => consumed.add(b));
    units.push({ type: 'toggle', els: btns, anchor: btns[0], number: numFor(grp) });
  }

  units.sort((a, b) => domOrderCompare(a.anchor, b.anchor));
  return units;
}

// Close any open MUI/ARIA menu so the NEXT dropdown can open cleanly (only
// needed when we DON'T pick an option — choosing one closes the menu itself).
function closeOpenMenu() {
  try { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch { /* */ }
  try {
    const bd = document.querySelector('.MuiBackdrop-root, .MuiModal-backdrop');
    if (bd) bd.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  } catch { /* */ }
}

// Read the OPEN listbox's options for a trigger. Prefers the listbox the trigger
// points at (aria-controls/owns); else the last visible listbox in the DOM (MUI
// portals its menu to <body>, and only one is open at a time).
function readOpenOptions(trigger) {
  let lb = null;
  const id = (trigger.getAttribute && (trigger.getAttribute('aria-controls') || trigger.getAttribute('aria-owns'))) || '';
  if (id) lb = document.getElementById(id);
  if (!lb) {
    let all = [];
    try { all = Array.from(document.querySelectorAll('[role="listbox"], ul.MuiMenu-list, .MuiMenu-list')).filter(isVisible); } catch { /* */ }
    lb = all[all.length - 1] || null;
  }
  if (!lb) return [];
  let opts = [];
  try { opts = Array.from(lb.querySelectorAll('[role="option"], li')).filter(isVisible); } catch { /* */ }
  return opts.map((el) => ({ el, norm: normalizeForMatch(el.textContent || '') }));
}

function interactiveGuardCurrent(guard) {
  if (!guard || (!guard.signature && !guard.principal)) return true;
  const matches = (!guard.signature || pageSignature() === guard.signature) &&
    (!guard.principal || currentPrincipalIdentity() === guard.principal);
  if (!matches) guard.stale = true;
  return matches;
}

// Accept DOM changes caused by a click we just made, but only while the
// original question control is still attached. This lets MUI animate/update
// labels without weakening the guard against a React page replacement.
function interactiveGuardAccept(guard, anchor) {
  if (anchor && !document.documentElement.contains(anchor)) {
    if (guard) guard.stale = true;
    return false;
  }
  return interactiveGuardCurrent(guard);
}

// A custom answer widget can still be backed by a native form control. In
// particular, <button> defaults to type=submit and a descendant/label can
// activate that button indirectly. Do not dispatch page-controlled clicks for
// any control coupled to a form, or for an implicit/native submitter. Leaving a
// question unfilled is recoverable; submitting the assessment is not.
function isUnsafeInteractiveActivator(el) {
  if (!el) return true;
  let owner = null;
  let labelControl = null;
  try {
    owner = el.closest?.('button, input') || null;
    labelControl = el.closest?.('label')?.control || null;
  } catch { return true; }
  for (const control of [owner, labelControl]) {
    if (!control) continue;
    const tag = String(control.localName || control.tagName || '').toLowerCase();
    let type = '';
    try { type = String(control.type || control.getAttribute?.('type') || '').trim().toLowerCase(); }
    catch { return true; }
    if (tag === 'button' && type !== 'button') return true;
    if (tag === 'input' && type !== 'button') return true;
  }
  try {
    if (el.form || el.getAttribute?.('form') || el.closest?.('form')) return true;
    if (owner && (owner.form || owner.getAttribute?.('form') || owner.closest?.('form'))) return true;
    if (labelControl && (labelControl.form || labelControl.getAttribute?.('form') || labelControl.closest?.('form'))) return true;
  } catch { return true; }
  return false;
}

function safeInteractiveClick(el) {
  if (isUnsafeInteractiveActivator(el)) return false;
  try { el.click(); return true; } catch { return false; }
}

// Open a dropdown and return its options (waits a few frames for the portaled
// menu to render). Returns [] if it never appeared.
async function openDropdownOptions(trigger, guard) {
  if (!document.documentElement.contains(trigger) || !interactiveGuardCurrent(guard)) return [];
  try { trigger.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* */ }
  if (!safeInteractiveClick(trigger)) return [];
  if (!interactiveGuardAccept(guard, trigger)) return [];
  for (let i = 0; i < 8; i++) {
    await __smeshSleep(60);
    // A same-document SPA transition can happen while the popper animates. The
    // original trigger becoming detached is a hard stop: never click an option
    // that may now belong to the replacement question.
    if (!interactiveGuardAccept(guard, trigger)) return [];
    const o = readOpenOptions(trigger);
    if (o.length) return o;
  }
  return readOpenOptions(trigger);
}

// Pick the option whose text best matches the answer (same thresholds as the
// native fill), falling back to a positional letter/number or the model's
// `choice` hint. Returns the element to click, or null.
function chooseOption(valueStr, opts, choice) {
  const aNorm = normalizeForMatch(valueStr);
  let best = null;
  let second = null;
  for (const o of opts) {
    const s = similarity(aNorm, o.norm);
    if (!best || s > best.s) { second = best; best = { o, s }; }
    else if (!second || s > second.s) second = { o, s };
  }
  if (best && best.s >= MATCH_MIN && (!second || best.s - second.s >= MATCH_MARGIN)) return best.o.el;
  let idx = asOptionIndex(valueStr);
  if (idx < 0 && choice != null) { const idxs = parseChoiceIndices(choice, opts.length); if (idxs.length) idx = idxs[0]; }
  if (idx >= 0 && idx < opts.length) return opts[idx].el;
  return null;
}

function stableControlValues(element, attributeNames = [], includePropertyValue = true) {
  const values = [];
  const add = (value) => {
    const normalized = normalizeForMatch(value);
    if (normalized && !values.includes(normalized)) values.push(normalized);
  };
  if (includePropertyValue) {
    try { add(element?.value); } catch { /* custom element getter */ }
  }
  try { add(element?.textContent); } catch { /* detached element */ }
  for (const name of attributeNames) {
    try { add(element?.getAttribute?.(name)); } catch { /* malformed host element */ }
  }
  return values;
}

function dropdownSelectionMatches(trigger, target) {
  const expected = stableControlValues(target, ['aria-label', 'data-value']);
  if (!expected.length) return false;
  // aria-label/title name the widget itself and are usually static, so they
  // cannot prove which option is selected. Only submitted/visible value state
  // is admissible on the trigger side.
  let tag = '';
  try { tag = String(trigger?.tagName || '').toUpperCase(); } catch { /* malformed host element */ }
  const actual = stableControlValues(
    trigger,
    ['aria-valuetext', 'data-value'],
    tag !== 'BUTTON'
  );
  return actual.some((value) => expected.includes(value));
}

// Fill ONE custom dropdown. Honest read-back: count it only if the trigger's
// submitted/visible value exactly identifies the chosen option. A merely
// changed non-empty label is not evidence that the intended option won.
async function fillOneDropdown(trigger, valueStr, choice, guard) {
  if (isUnfillableAnswer(valueStr)) return false;
  if (!document.documentElement.contains(trigger) || !interactiveGuardCurrent(guard)) return false;
  const opts = await openDropdownOptions(trigger, guard);
  if (!document.documentElement.contains(trigger)) return false;
  if (!opts.length) { closeOpenMenu(); return false; }
  const target = chooseOption(valueStr, opts, choice);
  if (!target) { closeOpenMenu(); return false; }
  if (!document.documentElement.contains(target) || !interactiveGuardCurrent(guard)) return false;
  const want = normalizeForMatch(target.textContent || '');
  if (!safeInteractiveClick(target)) { closeOpenMenu(); return false; }
  if (!interactiveGuardAccept(guard, trigger)) return false;
  await __smeshSleep(120);
  if (!interactiveGuardAccept(guard, trigger)) return false;
  return !!want && dropdownSelectionMatches(trigger, target);
}

// The left-hand label for a matching dropdown (the item it pairs an option to).
function interactiveRowLabel(el) {
  let t = '';
  try { t = controlLabelText(el); } catch { /* */ }
  if (!t) t = precedingFieldText(el);
  return normalizeForMatch(t);
}

// Spread a matching question's {label,value} parts across its dropdowns: match
// each dropdown to a part by its row label, then fill leftovers in screen order.
// Mirrors distributeFieldValues for text boxes.
function distributeInteractiveValues(question, els) {
  const values = new Array(els.length).fill('');
  const parts = questionParts(question);
  if (!parts.length) return values;
  const labels = els.map(interactiveRowLabel);
  const usedPart = new Set();
  // 1) label match — best part per dropdown, above the match floor.
  els.forEach((_, k) => {
    const lbl = labels[k];
    if (!lbl) return;
    let best = -1;
    let bestS = 0;
    for (let p = 0; p < parts.length; p++) {
      if (usedPart.has(p)) continue;
      const s = similarity(lbl, normalizeForMatch(parts[p].label));
      if (s > bestS) { bestS = s; best = p; }
    }
    if (best >= 0 && bestS >= MATCH_MIN) { values[k] = parts[best].value; usedPart.add(best); }
  });
  // 2) leftovers in screen order.
  let pp = 0;
  for (let k = 0; k < els.length; k++) {
    if (values[k] !== '') continue;
    while (pp < parts.length && usedPart.has(pp)) pp++;
    if (pp < parts.length) { values[k] = parts[pp].value; usedPart.add(pp); pp++; }
  }
  return values;
}

function interactiveRadioIsSelected(element) {
  try {
    const aria = element.getAttribute?.('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
  } catch { /* malformed custom control */ }
  try { return element.checked === true; } catch { return false; }
}

function exactInteractiveRadioSelection(options, target) {
  let selected = 0;
  let targetSelected = false;
  for (const option of options) {
    if (!interactiveRadioIsSelected(option.el)) continue;
    selected++;
    if (option.el === target) targetSelected = true;
  }
  return selected === 1 && targetSelected;
}

// Fill one interactive unit from one question. Returns true only on a real edit.
async function fillInteractiveUnit(unit, question, guard) {
  const ans = String(question.answer ?? '').trim();

  if (unit.type === 'dropdown') {
    const els = unit.els.filter((e) => document.documentElement.contains(e));
    if (!els.length) return false;
    if (els.length === 1) return await fillOneDropdown(els[0], ans, question.choice, guard);
    // Matching: attempt every dropdown so partial progress is still useful, but
    // report success only when the whole question is complete. An incomplete
    // match then lands in `skipped`, telling the user to check it.
    const values = distributeInteractiveValues(question, els);
    let all = values.every((v) => !!v);
    for (let k = 0; k < els.length; k++) {
      const v = values[k];
      if (!v) continue;
      try { if (!(await fillOneDropdown(els[k], v, null, guard))) all = false; }
      catch { all = false; /* this row failed; others try */ }
    }
    return all;
  }

  if (unit.type === 'aria-radio') {
    const opts = unit.els
      .filter((e) => document.documentElement.contains(e))
      .map((el) => ({ el, norm: normalizeForMatch(controlLabelText(el) || el.textContent || '') }));
    const target = chooseOption(ans, opts, question.choice);
    if (!target) return false;
    if (isDisabledControl(target)) return false;
    if (exactInteractiveRadioSelection(opts, target)) return true;
    if (!interactiveGuardCurrent(guard)) return false;
    if (!safeInteractiveClick(target)) return false;
    if (!interactiveGuardAccept(guard, target)) return false;
    await __smeshSleep(120);
    if (!interactiveGuardAccept(guard, target)) return false;
    // A stale option left selected alongside the target is not a valid radio
    // answer. Prove group exclusivity as well as the target's checked state.
    return exactInteractiveRadioSelection(opts, target);
  }

  if (unit.type === 'toggle') {
    const opts = unit.els
      .filter((e) => document.documentElement.contains(e) && !isDisabledControl(e))
      .map((el) => ({ el, norm: normalizeForMatch(controlLabelText(el) || el.textContent || '') }));
    const parts = ans.split(/\s*[,;/]\s*|\s+и\s+|\n\s*/i).map((p) => p.trim()).filter(Boolean);
    const targets = new Set();
    for (const part of (parts.length ? parts : [ans])) { const t = chooseOption(part, opts, null); if (t) targets.add(t); }
    for (const idx of parseChoiceIndices(question.choice, opts.length)) if (opts[idx]) targets.add(opts[idx].el);
    if (!targets.size) return false;
    for (const o of opts) {
      const want = targets.has(o.el);
      const isOn = o.el.getAttribute('aria-pressed') === 'true';
      // Re-solving must clear stale buttons from our earlier attempt as well as
      // enable new targets, or МЭШ grades both the old wrong and new choices.
      if (want !== isOn) {
        if (!interactiveGuardCurrent(guard)) return false;
        if (!safeInteractiveClick(o.el)) return false;
        if (!interactiveGuardAccept(guard, o.el)) return false;
      }
    }
    await __smeshSleep(120);
    if (!interactiveGuardAccept(guard, opts[0]?.el)) return false;
    return opts.every((o) => {
      const pressed = o.el.getAttribute('aria-pressed');
      return pressed != null && (pressed === 'true') === targets.has(o.el);
    });
  }

  return false;
}

/**
 * Async fill pass for custom/ARIA controls. Returns { filled:[ids] }. Mirrors
 * fillTestAnswers' number-first/position-fallback matching and its absolute
 * trust in on-screen «ЗАДАНИЕ №N» numbers, so it never cross-assigns a question
 * onto another's controls. `alreadyFilled` are ids an earlier pass handled —
 * skipped here so we never re-open or toggle them. Never throws, never submits.
 */
async function fillInteractiveAnswers(questions, alreadyFilled, expectedSignature = '', expectedPrincipal = '') {
  const out = { filled: [] };
  try {
    if (!Array.isArray(questions) || !questions.length) return out;
    // Re-check inside the injected document, immediately before discovery. The
    // worker also targets the browser documentId, while this closes the
    // same-document SPA gap between its last read and this async pass.
    const guard = { signature: expectedSignature, principal: expectedPrincipal, stale: false };
    if (!interactiveGuardCurrent(guard)) return { ...out, stale: true };
    const done = new Set((alreadyFilled || []).map(String));
    let units = [];
    try { units = collectInteractiveUnits(); } catch { units = []; }
    if (!units.length) return out;

    const idFor = (q, i) => (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;
    const byNumber = new Map();
    units.forEach((u) => { if (u.number != null && !byNumber.has(String(u.number))) byNumber.set(String(u.number), u); });
    const pageHasNumbers = units.some((u) => u.number != null);
    const used = new Set();
    const acceptable = (u, id) =>
      u && !used.has(u) && (!pageHasNumbers || u.number == null || String(u.number) === String(id));

    for (let qi = 0; qi < questions.length; qi++) {
      if (!interactiveGuardCurrent(guard)) break;
      const q = questions[qi];
      const id = idFor(q, qi);
      if (done.has(String(id))) continue; // an earlier pass already filled this question
      let unit = byNumber.get(String(id));
      if (!unit || used.has(unit)) {
        const posIdx = /^\d+$/.test(String(id)) ? parseInt(id, 10) - 1 : qi;
        unit = acceptable(units[posIdx], id) ? units[posIdx]
          : acceptable(units[qi], id) ? units[qi] : null;
      }
      if (!unit || used.has(unit)) continue;
      let ok = false;
      try { ok = await fillInteractiveUnit(unit, q, guard); } catch { ok = false; }
      if (ok) { used.add(unit); out.filled.push(String(id)); }
      if (guard.stale) break;
    }
    if (guard.stale) out.stale = true;
    if (SMESH_DEBUG) try { console.log('[СМЭШ AI fill] interactive:', out.filled, 'units:', units.map((u) => ({ type: u.type, number: u.number, n: u.els.length }))); } catch { /* */ }
  } catch { /* whole pass is best-effort */ }
  return out;
}
window.__smeshFillInteractive = fillInteractiveAnswers;

/**
 * Read-only inventory used by multi-page autopilot before it mutates a page.
 * Each entry is one fillable QUESTION unit, not one raw input: collectUnits()
 * already groups native multi-box questions, collectInteractiveUnits() groups
 * matching dropdown rows, and MathQuill fields sharing a visible question
 * number are grouped here. The worker adds the captured document id, so units
 * in different frames cannot accidentally prove one another complete.
 *
 * Numbered units can be matched exactly to model answer ids. Unnumbered units
 * deliberately retain a local ordinal; the worker/classifier accepts them only
 * when one document + one fill mechanism provides an unambiguous positional
 * inventory. Any discovery failure is explicit and therefore fail-closed.
 */
function testQuestionUnitInventory() {
  const units = [];
  try {
    const nativeUnits = collectUnits();
    nativeUnits.forEach((unit, ordinal) => units.push({
      source: 'native',
      type: unit.type,
      id: unit.number == null ? null : String(unit.number),
      ordinal,
    }));

    const interactiveUnits = collectInteractiveUnits();
    interactiveUnits.forEach((unit, ordinal) => units.push({
      source: 'interactive',
      type: unit.type,
      id: unit.number == null ? null : String(unit.number),
      ordinal,
    }));

    // MathQuill's internal textarea is excluded from collectUnits(). Inventory
    // the visible editor shells themselves, using the same question markers.
    // Several fields under one number are one multi-field question unit.
    const markers = collectQuestionMarkers();
    const seenMathNumbers = new Set();
    const mathUnits = [];
    let mathFields = [];
    try {
      mathFields = Array.from(document.querySelectorAll('.mq-editable-field')).filter(isVisible);
    } catch { mathFields = []; }
    for (const field of mathFields) {
      const number = numberForNode(field, markers);
      if (number == null) {
        mathUnits.push(null);
        continue;
      }
      const id = String(number);
      if (seenMathNumbers.has(id)) continue;
      seenMathNumbers.add(id);
      mathUnits.push(id);
    }
    // ONE ordinal counter across numbered and loose fields. Numbering them
    // separately let a loose field and a numbered question both claim
    // mathquill ordinal 0, which collides in the worker's unit identity.
    mathUnits.forEach((id, ordinal) => units.push({
      source: 'mathquill', type: 'mathquill', id, ordinal,
    }));
    return { ok: true, units };
  } catch {
    return { ok: false, units: [] };
  }
}
window.__smeshQuestionInventory = testQuestionUnitInventory;

// True only for a positively identified Mesh assessment document. The top
// school/uchebnik wrapper is captured separately by the worker; this predicate
// decides which child frames may contribute text or receive answers. Keeping
// it here makes the same decision available during capture and immediately
// before every document-targeted read.
function isMeshTestDocument() {
  try {
    const url = new URL(location.href);
    if (url.protocol !== 'https:' ||
        (url.hostname !== 'school.mos.ru' && url.hostname !== 'uchebnik.mos.ru')) return false;
    const strongQuery = /[?&](activityId|cwork_id|registration|scorm_id)=/i.test(url.search) ||
      /[?&]endpoint=[^&]*lrs/i.test(url.search);
    const dtTaskRoute = /^\/dt(?:\/|$)/i.test(url.pathname) &&
      (/\/go(?:\/|$)/i.test(url.pathname) || /[?&]subcategory_id=/i.test(url.search));
    const strongPath = /\/(exam|challenge|cwork|control[-_]?work)(\/|$)/i.test(url.pathname) ||
      /^\/01math\/maths\/test(?:\/|$)/i.test(url.pathname) || dtTaskRoute;
    if (strongQuery || strongPath) return true;
    const inventory = testQuestionUnitInventory();
    const weakRoute = /\/(test|testing|training|diagnostic|quiz|player)(\/|$)/i.test(url.pathname);
    return weakRoute && inventory?.ok === true && Array.isArray(inventory.units) && inventory.units.length > 0;
  } catch {
    return false;
  }
}
window.__smeshIsTestDocument = isMeshTestDocument;

/* =====================================================================
 * MULTI-PAGE TEST PAGINATION (per-frame)
 * ---------------------------------------------------------------------
 * Some Mesh tests show one question per page: answer, press «Далее», repeat.
 * The orchestrator (popup) drives that loop and reaches every frame the same
 * way the auto-fill does (the test player is often inside an iframe), running
 * these two globals in each frame:
 *   __smeshPageSig — a signature of THIS frame's current question, so the loop
 *                    can tell whether a click actually advanced the page;
 *   __smeshNextDiscovery — reports forward controls without mutating the page;
 *   __smeshNextClick     — re-validates and clicks one enabled control only.
 * ===================================================================== */

// Forward ("next") vs finish ("submit the whole test"). Matched against text
// that's already lowercased with ё→е, so the patterns stay ё-agnostic.
const NEXT_CTRL_RE = /дал(ее|ьше)|следующ|вперед|next/i;
const FINISH_CTRL_RE = /заверш|готов|отправ|сдат|finish|submit|результат/i;
const FINISH_ROUTE_RE =
  /(?:^|[/?&_.=-])(?:submit|finish|complete|done|end|close|pass|over|summary|review|final(?:ize)?|result|grade|send|turn.?in|заверш|отправ|сдат)(?=$|[/?&_.=-])/i;
const NAV_CONTROL_SELECTOR = [
  'button', 'a[href]', '[role="button"]', 'input[type="button"]',
  'input[type="submit"]', 'input[type="image"]', '[tabindex]'
].join(', ');

function navTagName(el) {
  return String(el?.localName || el?.tagName || '').toLowerCase();
}

// Pagination is allowed to activate only controls whose native activation
// cannot submit or reset a form. In HTML a missing/invalid <button type> is
// "submit", including when `form="…"` associates it with a non-ancestor form.
// A role/tabindex on a submitter (or one of its descendants) must not smuggle
// that submitter back into the candidate set.
function isUnsafePaginationActivator(el) {
  if (!el) return true;
  const controls = [];
  try {
    const owner = el.closest && el.closest('button, input');
    if (owner) controls.push(owner);
    const label = el.closest && el.closest('label');
    if (label?.control && !controls.includes(label.control)) controls.push(label.control);
  } catch { return true; }
  const directTag = navTagName(el);
  if ((directTag === 'button' || directTag === 'input') && !controls.includes(el)) controls.push(el);

  for (const control of controls) {
    const tag = navTagName(control);
    let type;
    try { type = String(control.type || control.getAttribute?.('type') || '').trim().toLowerCase(); }
    catch { return true; }
    // Only an explicit button state is inert. Reset, submit, image and any
    // other input state are not pagination controls, even if labelled Next.
    if (tag === 'button' || tag === 'input') {
      if (type !== 'button') return true;
    }
  }

  // Never execute javascript:/data: navigation through a page-controlled
  // programmatic click. Real Next links remain relative/http(s) links.
  if (directTag === 'a') {
    try {
      const href = new URL(el.getAttribute('href') || '', location.href);
      if (href.protocol !== 'http:' && href.protocol !== 'https:') return true;
    } catch { return true; }
  }
  return false;
}

// Automatic pagination must not dispatch a page-controlled click at all. Even
// an explicit type=button can have a React handler that queues requestSubmit()
// or calls the event-less form.submit() after our listener returns. The only
// activation primitive with a provable non-submission contract is direct
// navigation to a validated same-origin HTTP(S) link.
function safePaginationDestination(el) {
  if (navTagName(el) !== 'a' || isUnsafePaginationActivator(el)) return null;
  try {
    if (el.hasAttribute?.('download')) return null;
    const target = String(el.getAttribute?.('target') || '').trim().toLowerCase();
    if (target && target !== '_self') return null;
    const raw = String(el.getAttribute?.('href') || '').trim();
    if (!raw) return null;
    const destination = new URL(raw, location.href);
    const current = new URL(location.href);
    if ((destination.protocol !== 'http:' && destination.protocol !== 'https:') ||
        destination.origin !== current.origin ||
        destination.username || destination.password) return null;
    // Hash-only/self links are normally JS controls, not a new test page.
    const withoutHash = (url) => `${url.origin}${url.pathname}${url.search}`;
    if (withoutHash(destination) === withoutHash(current)) return null;
    // A misleading “Next” label must not make a submit/result endpoint safe.
    // Test pathname and query separately so an inserted separator cannot break
    // an otherwise end-anchored route match.
    let pathname = destination.pathname;
    let search = destination.search;
    try { pathname = decodeURIComponent(pathname); } catch { /* raw spelling remains checked */ }
    try { search = decodeURIComponent(search); } catch { /* raw spelling remains checked */ }
    if (FINISH_CTRL_RE.test(pathname) || FINISH_CTRL_RE.test(search) ||
        FINISH_ROUTE_RE.test(pathname) || FINISH_ROUTE_RE.test(search)) return null;
    if (!structuredPaginationAdvance(current, destination)) return null;
    return destination.href;
  } catch {
    return null;
  }
}

// Direct navigation cannot inspect a server redirect's final URL before it is
// followed. Restrict automatic navigation to URLs that visibly advance one
// numeric page-like coordinate while preserving the rest of the route. Generic
// endpoints such as /next are deliberately unsupported.
function structuredPaginationAdvance(current, destination) {
  const pageKeys = /^(?:page|step|question|task|item|slide|screen)$/i;
  if (destination.pathname === current.pathname) {
    for (const [key, value] of destination.searchParams) {
      if (!pageKeys.test(key) || !/^\d+$/.test(value)) continue;
      const before = current.searchParams.get(key);
      if (before != null && /^\d+$/.test(before) && Number(value) === Number(before) + 1) return true;
    }
  }

  const beforeSegments = current.pathname.split('/').filter(Boolean);
  const afterSegments = destination.pathname.split('/').filter(Boolean);
  if (beforeSegments.length !== afterSegments.length) return false;
  let changed = -1;
  for (let i = 0; i < beforeSegments.length; i++) {
    if (beforeSegments[i] === afterSegments[i]) continue;
    if (changed !== -1) return false;
    changed = i;
  }
  if (changed < 0 || !/^\d+$/.test(beforeSegments[changed]) || !/^\d+$/.test(afterSegments[changed])) return false;
  if (Number(afterSegments[changed]) !== Number(beforeSegments[changed]) + 1) return false;
  const coordinate = beforeSegments[changed - 1] || '';
  return /^(?:page|step|question|task|item|slide|screen)$/i.test(coordinate);
}

// Visible, actionable text of a control: its label plus aria-label/title/value,
// normalised for matching (lowercase, ё→е). `alt` is included because an
// <input type="image"> carries its entire label there — without it an image
// submit button reading «Завершить» matched no finish word at all.
function navControlText(el) {
  const attr = (name) => (el.getAttribute ? el.getAttribute(name) : null);
  const parts = [el.textContent, attr('aria-label'), attr('title'), attr('alt'), el.value];
  return normalize(parts.filter(Boolean).join(' ')).toLowerCase().replace(/ё/g, 'е');
}

// Attribute "metadata" for icon-only buttons that carry no readable text.
function navControlMeta(el) {
  if (!el.getAttribute) return '';
  return [el.getAttribute('aria-label'), el.getAttribute('title'),
    el.getAttribute('class'), el.getAttribute('data-action'),
    el.getAttribute('data-testid'), el.getAttribute('name'), el.id]
    .filter(Boolean).join(' ').toLowerCase();
}

function isNavClickable(el) {
  if (!el || el.disabled) return false;
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
  return isVisible(el);
}

// Classify a candidate as 'finish' | 'blocked' | 'next' | null.
//   finish  — a submit/finish control. Never activated.
//   blocked — a genuine FORWARD control we refuse to activate, because we
//             cannot prove its activation is non-submitting.
//   next    — a forward control with a provably safe activation primitive.
// The finish LABEL is checked first, so a control carrying both a forward word
// and a submit word is treated as a finish — fail safe: we'd rather stop than
// submit the test. 'blocked' exists because collapsing it into 'finish' made
// the autopilot report «дошёл до конца теста» for a test it never advanced
// past: Mesh renders «Далее» as a <button>, whose implicit type is submit.
function classifyNavControl(el) {
  const t = navControlText(el);
  const meta = navControlMeta(el);
  if (FINISH_CTRL_RE.test(t) || FINISH_CTRL_RE.test(meta)) return 'finish';
  const looksNext = NEXT_CTRL_RE.test(t) ||
    /next|forward|arrow.?right|chevron.?right|вперед|вправо/.test(meta) ||
    (!/[a-zа-я]/i.test(t) && /[→▶›»]/.test(el.textContent || ''));
  // An unsafe activator can never become 'next'. A forward-looking one is not
  // a finish control either, so it reports the honest third state instead.
  if (isUnsafePaginationActivator(el)) return looksNext ? 'blocked' : 'finish';
  // A safe control still needs an activation primitive with a provable
  // non-submission contract (a validated same-origin link — see
  // safePaginationDestination). Without one the page HAS a next control; we
  // simply will not press it.
  if (looksNext) return safePaginationDestination(el) ? 'next' : 'blocked';
  return null;
}

// Navigate directly in the isolated world. No click event crosses into page
// JavaScript, so neither synchronous nor deferred submit handlers can run.
function activatePaginationControl(el) {
  // Re-run the complete classifier at the final activation boundary. A page
  // can synchronously mutate not only the control type but also its label or
  // action metadata while scrollIntoView runs (for example Next -> Submit).
  if (!isNavClickable(el) || classifyNavControl(el) !== 'next') return false;
  const destination = safePaginationDestination(el);
  if (!destination) return false;
  try {
    window.location.assign(destination);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signature of THIS frame's visible question + controls. Built from the prompt
 * text and the kind/count/labels of the form controls — deliberately NOT their
 * values, so filling the answers doesn't change it. Clock literals are masked
 * on EVERY line because a countdown can share a mixed line with question text;
 * broader duration masking stays timer-context-only so «5 минут» and «7 минут»
 * in two genuine question variants remain distinct. Enough to differ between
 * distinct questions while staying stable across a re-render of one.
 * @returns {string}
 */
function stableSignatureText(raw) {
  const timerHint = /(?:осталось|времени\s+осталось|оставш\w*\s+врем|до\s+конца|таймер|remaining|time\s*left|countdown)/i;
  const clock = /\b\d{1,3}\s*:\s*\d{2}(?:\s*:\s*\d{2})?\b/g;
  // JavaScript's \b is ASCII-word based, so a trailing \b after Cyrillic never
  // matched «минут»/«часов». Use a punctuation/space lookahead instead.
  const duration = /\b\d+\s*(?:сек(?:унд(?:а|ы|у)?|\.)?|мин(?:ут(?:а|ы|у)?|\.)?|час(?:а|ов)?)(?=\s|[.,;:!?…)}\]»"'—–-]|$)/gi;
  let previousWasTimerLabel = false;
  const stableLines = String(raw || '').split(/[\r\n]+/).map((line) => {
    const hinted = timerHint.test(line);
    const clockOnly = /^\s*\d{1,3}\s*:\s*\d{2}(?:\s*:\s*\d{2})?\s*$/.test(line);
    const dynamic = hinted || clockOnly || previousWasTimerLabel;
    previousWasTimerLabel = hinted && !clock.test(line);
    clock.lastIndex = 0;
    // A clock literal is part of many real questions (train schedules, time
    // arithmetic). Mask it only on a line already proven to be timer context;
    // masking every HH:MM value lets two different questions share a capture
    // signature and defeats the final stale-answer guard.
    if (!dynamic) return line;
    return line.replace(clock, '<timer>').replace(duration, '<timer>');
  });
  return normalize(stableLines.join('\n'));
}

const SIGNATURE_BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'DIV', 'DL', 'DT', 'DD',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'
]);
const SIGNATURE_IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
const SIGNATURE_VOLATILE_NAME_RE = /(?:^|[\s_-])(?:countdown|timer|status|elapsed(?:[\s_-]?time)?|live[\s_-]?status)(?=$|[\s_-])/i;
const SIGNATURE_RESOURCE_SELECTOR = [
  'img', 'svg', 'canvas', 'video[poster]', 'object[data]', 'embed[src]',
  'iframe[src]', '[role="img"]'
].join(', ');
const SIGNATURE_RESOURCE_LIMIT = 512;
const SIGNATURE_ELEMENT_SCAN_LIMIT = 4096;
const SIGNATURE_TRANSIENT_OVERLAY_SELECTOR = [
  '[role="listbox"]', '[role="option"]', '[role="menu"]', '[role="menuitem"]',
  '.MuiPopover-root', '.MuiModal-root', '.MuiMenu-root', '.MuiBackdrop-root',
  '[data-popper-placement]'
].join(', ');
const SIGNATURE_MUTABLE_ANSWER_SELECTOR = [
  '[role="combobox"]', '[aria-haspopup="listbox"]', '.MuiSelect-select',
  '.mq-editable-field', '.mathquill-input', '[contenteditable="true"]',
  '[contenteditable=""]', '[role="textbox"]'
].join(', ');

function signatureTextLooksLikeQuestion(raw) {
  const text = stableSignatureText(raw);
  if (!text) return false;
  const semanticText = text.replace(/<timer>/g, '');
  return /[?？=≤≥±×÷√]|\b(?:what|which|where|when|who|how|solve|choose|find|calculate)\b/i.test(semanticText) ||
    /(?:кто|что|где|когда|как|какой|какая|какие|сколько|решите|реши|найдите|найди|выберите|выбери|укажите|укажи|определите|определи|вычислите|вычисли|сопоставьте|введите|ответьте)(?![\p{L}\p{N}_])/iu.test(semanticText);
}

function signatureTextLooksTransient(raw) {
  const text = stableSignatureText(raw);
  if (!text || text.length > 240 || signatureTextLooksLikeQuestion(text)) return false;
  return /<timer>|(?:таймер|осталось|remaining|countdown|loading|загруз|решаю|думаю|проверяю|анализирую|готовлю|обрабатываю|статус|status|progress)/i.test(text);
}

function signatureRegionCarriesQuestion(element) {
  try {
    if (element.querySelector?.(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], ' +
      '[role="radio"], [role="checkbox"], [role="combobox"]'
    )) return true;
  } catch { /* malformed/test DOM */ }
  try {
    const text = String(element.innerText || element.textContent || '');
    return /(?:вопрос|задани[ея])\s*[№#]?\s*\d{1,3}/i.test(text) ||
      signatureTextLooksLikeQuestion(text);
  } catch { return false; }
}

function signatureElementIsVisuallyHidden(element, style = null) {
  const inlineStyle = (() => {
    try { return String(element.getAttribute?.('style') || ''); } catch { return ''; }
  })();
  if (/(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?(?:\s*!important)?\s*(?:;|$)/i.test(inlineStyle) ||
      /(?:^|;)\s*clip(?:-path)?\s*:\s*(?:rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)|inset\(\s*(?:50|100)%)/i.test(inlineStyle)) return true;
  const computed = style || (() => {
    try { return getComputedStyle(element); } catch { return null; }
  })();
  if (!computed) return false;
  const opacity = Number.parseFloat(computed.opacity);
  if (Number.isFinite(opacity) && opacity <= 0.001) return true;
  const clip = String(computed.clip || '').replace(/\s+/g, '').toLowerCase();
  const clipPath = String(computed.clipPath || computed.webkitClipPath || '').replace(/\s+/g, '').toLowerCase();
  if ((clip && clip !== 'auto' && /rect\((?:0(?:px)?[,]?){4}\)/.test(clip)) ||
      /inset\((?:50|100)%/.test(clipPath)) return true;
  const transform = String(computed.transform || '').replace(/\s+/g, '').toLowerCase();
  if (transform === 'scale(0)' || transform === 'scale(0,0)' ||
      /^matrix\(0,0,0,0,/.test(transform)) return true;

  let rect = null;
  try { rect = element.getBoundingClientRect?.(); } catch { /* detached element */ }
  if (!rect) return false;
  const position = String(computed.position || '').toLowerCase();
  const overflow = `${computed.overflow || ''} ${computed.overflowX || ''} ${computed.overflowY || ''}`.toLowerCase();
  const constrained = /hidden|clip/.test(overflow) || position === 'absolute' || position === 'fixed';
  if (computed.display !== 'contents' && constrained && (rect.width <= 0 || rect.height <= 0)) return true;
  // Do not drop ordinary below-the-fold question content. Only positioned
  // elements moved wholly off-canvas are treated as the classic visually-hidden
  // accessibility/status pattern.
  if ((position === 'absolute' || position === 'fixed') &&
      (rect.right <= -1 || rect.bottom <= -1 || rect.left <= -1000 || rect.top <= -1000)) return true;
  return false;
}

function signatureNodeIsVolatile(element) {
  const tag = String(element?.tagName || '').toUpperCase();
  if (!tag || SIGNATURE_IGNORED_TAGS.has(tag) || element.hidden) return true;
  const attr = (name) => {
    try { return String(element.getAttribute?.(name) ?? ''); } catch { return ''; }
  };
  let inert = false;
  try { inert = Boolean(element.hasAttribute?.('inert')); } catch { /* malformed host element */ }
  const inlineStyle = attr('style');
  if (attr('aria-hidden').toLowerCase() === 'true' || inert ||
      /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|content-visibility\s*:\s*hidden)/i.test(inlineStyle)) return true;
  let style = null;
  try {
    style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' ||
        style.visibility === 'collapse' || style.contentVisibility === 'hidden') return true;
  } catch { /* detached/test DOM, or style access blocked */ }
  if (signatureElementIsVisuallyHidden(element, style)) return true;
  const live = attr('aria-live').trim().toLowerCase();
  const roles = attr('role').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const className = typeof element.className === 'string' ? element.className : '';
  const nameHints = [element.id, className, attr('data-testid'), attr('data-test'), attr('data-qa')].join(' ');
  const explicitVolatile = roles.some((role) =>
    ['status', 'timer', 'progressbar', 'log', 'alert'].includes(role)) ||
    SIGNATURE_VOLATILE_NAME_RE.test(nameHints);
  // aria-live is also routinely placed on the actual unnumbered question
  // prompt. Preserve ambiguous live regions; exclude one only when its own text
  // is recognizably transient or it has an explicit status/timer role/name.
  const semanticVolatile = explicitVolatile ||
    (live && live !== 'off' && signatureTextLooksTransient(element.innerText || element.textContent || ''));
  // The question-content probe walks this subtree, so run it only for the tiny
  // number of regions that are actually marked volatile. Doing it for every
  // ancestor turns a large React document into an O(n²) signature pass.
  return semanticVolatile && !signatureRegionCarriesQuestion(element);
}

function signatureNodeIsTransientInteraction(element) {
  try {
    if (element.matches?.(SIGNATURE_TRANSIENT_OVERLAY_SELECTOR)) return true;
  } catch { /* malformed selector host */ }
  const role = (() => {
    try { return String(element.getAttribute?.('role') || '').toLowerCase(); }
    catch { return ''; }
  })();
  const className = typeof element.className === 'string' ? element.className : '';
  return ['listbox', 'option', 'menu', 'menuitem'].includes(role) ||
    /(?:^|\s)Mui(?:Popover|Modal|Menu|Backdrop)-root(?:\s|$)/.test(className);
}

function signatureNodeCarriesMutableAnswerText(element) {
  const attr = (name) => {
    try { return String(element.getAttribute?.(name) || '').toLowerCase(); }
    catch { return ''; }
  };
  const className = typeof element.className === 'string' ? element.className : '';
  return attr('role') === 'combobox' || attr('aria-haspopup') === 'listbox' ||
    attr('role') === 'textbox' || attr('contenteditable') === 'true' ||
    attr('contenteditable') === '' && element.hasAttribute?.('contenteditable') ||
    /(?:^|\s)(?:MuiSelect-select|mq-editable-field|mathquill-input)(?:\s|$)/.test(className);
}

/**
 * DOM-order text for the page signature, excluding semantic live/status/timer
 * subtrees. Unlike deleting status strings from body.innerText, structural
 * exclusion cannot accidentally delete identical wording from the question.
 */
function stableSignatureDomText(root) {
  const chunks = [];
  const visit = (node) => {
    if (!node) return;
    if (node.nodeType === 3) {
      chunks.push(String(node.nodeValue || ''));
      return;
    }
    if (![1, 9, 11].includes(node.nodeType)) return;
    const isElement = node.nodeType === 1;
    if (isElement && (
      signatureNodeIsVolatile(node) ||
      signatureNodeIsTransientInteraction(node) ||
      signatureNodeCarriesMutableAnswerText(node)
    )) return;
    const tag = isElement ? String(node.tagName || '').toUpperCase() : '';
    const block = SIGNATURE_BLOCK_TAGS.has(tag);
    if (block || tag === 'BR') chunks.push('\n');
    for (const child of Array.from(node.childNodes || [])) visit(child);
    if (block) chunks.push('\n');
  };
  visit(root);
  return chunks.join('');
}

function stableSignatureHash(value) {
  const text = String(value || '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}:${text.length}`;
}

function stableSignatureResourceUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value, location.href);
    url.hash = '';
    // Common cache-busters are not question identity. Preserve every other
    // parameter because resource ids are often carried in the query string.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:_|cb|cachebust|cache_bust|timestamp|ts)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return value;
  }
}

function stableSignatureCanvasSample(canvas) {
  try {
    const width = Math.max(0, Number(canvas.width) || 0);
    const height = Math.max(0, Number(canvas.height) || 0);
    if (!width || !height) return '';

    // Canvas has no src/markup identity: same-sized image-only questions would
    // otherwise collide. Downsample into a detached 16×16 canvas so both CPU
    // and memory stay fixed regardless of the source dimensions. A tainted
    // cross-origin canvas throws on readback and safely falls back to its
    // structural attributes below.
    const sample = document.createElement('canvas');
    sample.width = 16;
    sample.height = 16;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    if (!ctx) return '';
    ctx.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = ctx.getImageData(0, 0, sample.width, sample.height).data;
    let fingerprint = `${width}x${height}:`;
    for (let i = 0; i < pixels.length; i += 4) {
      fingerprint += String.fromCharCode(
        pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]
      );
    }
    return stableSignatureHash(fingerprint);
  } catch {
    return '';
  }
}

function stableSignatureBackground(raw) {
  const value = String(raw || '').trim();
  if (!value || value === 'none') return '';
  const canonical = value.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi,
    (_match, _quote, quoted, unquoted) =>
      `url(${stableSignatureResourceUrl(quoted ?? unquoted ?? '')})`
  ).replace(/\s+/g, ' ').trim();
  return canonical ? stableSignatureHash(canonical) : '';
}

function signatureCanvasCarriesQuestion(canvas) {
  const attr = (name) => {
    try { return String(canvas.getAttribute?.(name) || ''); } catch { return ''; }
  };
  try {
    if (canvas.closest?.(SIGNATURE_MUTABLE_ANSWER_SELECTOR) ||
        /(?:myscript|mathquill|mathfield|answer|input)/i.test(
          `${attr('class')} ${attr('id')} ${attr('role')}`
        )) return false;
  } catch { /* detached/test canvas */ }
  if (attr('aria-label') || attr('title') || attr('data-question-id')) return true;
  let node = canvas.parentElement;
  for (let depth = 0; depth < 4 && node && node !== document.body; depth++, node = node.parentElement) {
    if (signatureRegionCarriesQuestion(node)) return true;
  }
  return false;
}

function stableSignatureResourceSemantics(root) {
  let resourceElements;
  let allElements;
  try {
    const resourceNodes = root?.querySelectorAll?.(SIGNATURE_RESOURCE_SELECTOR) || [];
    const allNodes = root?.querySelectorAll?.('*') || [];
    // Background images can carry the whole question. If the DOM is too large
    // to inspect within the fixed budget, an unseen element could distinguish
    // the page, so make the capture unusable instead of hashing a prefix.
    if (Number(allNodes.length) > SIGNATURE_ELEMENT_SCAN_LIMIT) {
      return { value: '', safe: false };
    }
    resourceElements = Array.from(resourceNodes);
    allElements = [
      ...(root?.nodeType === 1 ? [root] : []),
      ...Array.from(allNodes)
    ];
  } catch { return { value: '', safe: false }; }
  const elements = [];
  const seen = new Set();
  const add = (element) => {
    if (!element || seen.has(element)) return;
    seen.add(element);
    elements.push(element);
  };
  resourceElements.forEach(add);
  allElements.forEach((element) => {
    let background = '';
    try { background = getComputedStyle(element).backgroundImage || ''; } catch { /* detached */ }
    if (background && background !== 'none') add(element);
  });
  const tokens = [];
  let safe = true;
  for (const element of elements) {
    let style = null;
    try { style = getComputedStyle(element); } catch { /* tests/detached resource */ }
    if (signatureElementIsVisuallyHidden(element, style)) continue;
    try {
      if (element.closest?.(SIGNATURE_TRANSIENT_OVERLAY_SELECTOR)) continue;
      if (element.closest?.(SIGNATURE_MUTABLE_ANSWER_SELECTOR)) continue;
    } catch { /* detached/test element */ }
    const attr = (name) => {
      try { return String(element.getAttribute?.(name) || ''); } catch { return ''; }
    };
    const tag = String(element.tagName || '').toLowerCase();
    const parts = [tag];
    for (const value of [
      element.currentSrc, attr('src'), attr('srcset'), attr('poster'), attr('data'),
      attr('href'), attr('xlink:href')
    ]) {
      const stable = stableSignatureResourceUrl(value);
      if (stable) parts.push(stable);
    }
    for (const name of ['alt', 'title', 'aria-label', 'width', 'height', 'viewBox', 'data-testid', 'data-question-id']) {
      const value = attr(name);
      if (value) parts.push(`${name}=${normalize(value)}`);
    }
    const background = stableSignatureBackground(style?.backgroundImage || '');
    if (background) parts.push(`background=${background}`);
    // Inline SVG carries the visual question in path/use attributes rather than
    // text or a src URL. Hash the whole stable markup locally; only the digest
    // enters the capture context.
    if (tag === 'svg') {
      try { parts.push(`svg=${stableSignatureHash(element.outerHTML || '')}`); } catch { /* no serialization */ }
    }
    if (tag === 'canvas') {
      parts.push(`size=${Number(element.width) || 0}x${Number(element.height) || 0}`);
      if (signatureCanvasCarriesQuestion(element)) {
        const sample = stableSignatureCanvasSample(element);
        if (sample) parts.push(`pixels=${sample}`);
        else safe = false;
      }
    }
    tokens.push(parts.join('|'));
    // The remaining visible resource/background elements are identity-bearing
    // but would be omitted from a bounded signature. Fail closed on overflow.
    if (tokens.length > SIGNATURE_RESOURCE_LIMIT) {
      return { value: '', safe: false };
    }
  }
  return { value: tokens.join(';'), safe };
}

// Provider routing signal for test pages. This is deliberately visual rather
// than tag-only: Mesh uses many tiny SVG icons in its shell, and treating any
// <svg> as a graph would send every text-only test to Qwen. A visible,
// substantial raster/vector/canvas/media surface (or an explicitly labelled
// graph/diagram) is enough. Large answer-input canvases are excluded because
// they contain handwriting controls, not question material.
const TEST_VISUAL_MEDIA_SELECTOR = [
  'img', 'picture', 'svg', 'canvas', 'video', 'audio', 'object[data]',
  'embed[src]', '[role="img"]'
].join(', ');
const TEST_VISUAL_LABEL_RE = /(?:график|диаграмм|схем|рисунок|изображени|иллюстрац|карт[ауы]|черт[её]ж|graph|chart|diagram|image|illustration|map)/iu;

function testVisualMediaRect(element) {
  let rect;
  try { rect = element.getBoundingClientRect(); } catch { return null; }
  const width = Math.max(0, Number(rect?.width) || 0);
  const height = Math.max(0, Number(rect?.height) || 0);
  if (!width || !height) return null;
  const viewportWidth = Math.max(0,
    Number(typeof innerWidth === 'number' ? innerWidth : 0) ||
    Number(document.documentElement?.clientWidth) || 0);
  const viewportHeight = Math.max(0,
    Number(typeof innerHeight === 'number' ? innerHeight : 0) ||
    Number(document.documentElement?.clientHeight) || 0);
  if (viewportWidth && viewportHeight &&
      (rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewportWidth || rect.top >= viewportHeight)) {
    return null;
  }
  return { width, height };
}

function isTestAnswerMediaWidget(element) {
  const attr = (name) => {
    try { return String(element.getAttribute?.(name) || ''); } catch { return ''; }
  };
  try {
    if (element.closest?.(SIGNATURE_MUTABLE_ANSWER_SELECTOR)) return true;
  } catch { /* detached/test element */ }
  return /(?:myscript|mathquill|mathfield|answer|input|signature)/i.test(
    `${attr('class')} ${attr('id')} ${attr('data-testid')} ${attr('data-test')}`
  );
}

function isSubstantialTestVisual(element, style = null) {
  if (signatureElementIsVisuallyHidden(element, style) || isTestAnswerMediaWidget(element)) return false;
  const rect = testVisualMediaRect(element);
  if (!rect) return false;
  const attr = (name) => {
    try { return String(element.getAttribute?.(name) || ''); } catch { return ''; }
  };
  const label = [attr('alt'), attr('title'), attr('aria-label')].join(' ');
  if (TEST_VISUAL_LABEL_RE.test(label) && rect.width >= 24 && rect.height >= 24) return true;
  const tag = String(element.tagName || '').toLowerCase();
  if (tag === 'audio') return true;
  return Math.min(rect.width, rect.height) >= 36 && rect.width * rect.height >= 3000;
}

function testPageHasVisualMedia() {
  let media = [];
  let all = [];
  try {
    media = Array.from(document.querySelectorAll(TEST_VISUAL_MEDIA_SELECTOR));
    all = Array.from(document.querySelectorAll('*')).slice(0, SIGNATURE_ELEMENT_SCAN_LIMIT);
  } catch { return false; }
  for (const element of media) {
    let style = null;
    try { style = getComputedStyle(element); } catch { /* detached/test element */ }
    if (isSubstantialTestVisual(element, style)) return true;
  }
  // Some Mesh questions are drawn as CSS background images rather than media
  // elements. Scan within the same fixed element budget used by page identity.
  for (const element of all) {
    let style = null;
    try { style = getComputedStyle(element); } catch { continue; }
    // Gradients and other decorative CSS paint are not question media. Only a
    // real referenced image is useful input for the vision model.
    if (!/url\s*\(/i.test(style?.backgroundImage || '')) continue;
    if (isSubstantialTestVisual(element, style)) return true;
  }
  return false;
}

function stableSignatureControlSemantics(unit) {
  const labels = (unit.inputs || []).map((input) => {
    const label = unit.type === 'text' ? fieldLabel(input) : controlLabelText(input);
    const attr = (name) => {
      try { return String(input.getAttribute?.(name) || ''); } catch { return ''; }
    };
    // Do not include value/checked/selected state: filling must not invalidate
    // the capture. Labels and stable structural ids distinguish same-shaped
    // unnumbered questions without depending on the user's answer.
    return [label, attr('type'), attr('name'), attr('id'), attr('aria-label'), attr('placeholder')]
      .map((value) => normalizeForMatch(value)).filter(Boolean).join('|');
  });
  let options = '';
  if (unit.type === 'select') {
    try {
      options = Array.from(unit.inputs?.[0]?.options || [])
        .map((option) => normalizeForMatch(option.textContent || ''))
        .filter(Boolean)
        .join('~');
    } catch { /* malformed select */ }
  }
  return `${unit.type}:${unit.number ?? ''}:${labels.length}:${labels.join('~')}:${options}`;
}

function stableSignatureInteractiveSemantics(unit) {
  const controls = (unit.els || []).map((element) => {
    const attr = (name) => {
      try { return String(element.getAttribute?.(name) || ''); } catch { return ''; }
    };
    const stableLabel = unit.type === 'dropdown'
      ? [attr('aria-label'), attr('title'), attr('name'), attr('id'), precedingFieldText(element)]
      : [controlLabelText(element), attr('aria-label'), attr('title'), attr('name'), attr('id')];
    return stableLabel.map((value) => normalizeForMatch(value)).filter(Boolean).join('|');
  });
  return `${unit.type}:${unit.number ?? ''}:${controls.length}:${controls.join('~')}`;
}

function pageSignature() {
  let text = '';
  // Hash the complete stable text. Cutting the first 4,000 characters allowed a
  // long static shell to erase the actual question near the end of the body.
  try { text = stableSignatureText(stableSignatureDomText(document.body)); } catch { /* */ }
  let ctrlSig = '';
  try {
    const native = collectUnits().map(stableSignatureControlSemantics);
    const interactive = collectInteractiveUnits().map(stableSignatureInteractiveSemantics);
    ctrlSig = [...native, ...interactive].join(';');
  } catch { /* controls unreadable in this frame */ }
  let resources = { value: '', safe: true };
  try { resources = stableSignatureResourceSemantics(document.body); }
  catch { resources = { value: '', safe: false }; }
  // A question-bearing tainted canvas cannot be read in an extension isolated
  // world. Size/markup alone would let two different visual questions collide,
  // so make the document uncapturable instead of pretending it is bound.
  if (!resources.safe) return '';
  return stableSignatureHash(`${text}##${ctrlSig}##${resources.value}`);
}

/**
 * Read-only discovery for THIS frame. The worker compares these counts across
 * frames before it targets the separate clickDiscoveredPagination phase.
 */
function discoverPagination() {
  let candidates = [];
  try { candidates = Array.from(document.querySelectorAll(NAV_CONTROL_SELECTOR)); }
  catch { return { candidateCount: 0, enabledCount: 0, disabledState: [], finishCount: 0, blockedCount: 0, signature: '' }; }
  const next = [];
  let finishCount = 0;
  let blockedCount = 0;
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const c = classifyNavControl(el);
    if (c === 'finish') finishCount++;
    // Only an ENABLED blocked control means "this page can go forward and we
    // won't press it". A disabled «Далее» is the page saying there is nowhere
    // to go, which is the ordinary end-of-test state, not our refusal.
    else if (c === 'blocked') { if (isNavClickable(el)) blockedCount++; }
    else if (c === 'next') next.push(el);
  }
  const enabled = next.filter(isNavClickable);
  let hasTestSignature = false;
  try {
    hasTestSignature = collectQuestionMarkers().length > 0 || collectUnits().length > 0 ||
      /(?:вопрос|задани[ея])\s*[№#]?\s*\d{1,3}/i.test(document.body?.innerText || '');
  } catch { /* a frame without readable test state gets no preference */ }
  return {
    candidateCount: next.length,
    enabledCount: enabled.length,
    disabledState: next.map((el) => !isNavClickable(el)),
    finishCount,
    blockedCount,
    signature: hasTestSignature ? pageSignature() : ''
  };
}

function clickDiscoveredPagination(expectedSignature = '', expectedPrincipal = '') {
  const captureMatches = () =>
    (!expectedSignature || pageSignature() === expectedSignature) &&
    (!expectedPrincipal || currentPrincipalIdentity() === expectedPrincipal);
  if (!captureMatches()) return { status: 'stale' };
  let candidates = [];
  try { candidates = Array.from(document.querySelectorAll(NAV_CONTROL_SELECTOR)); } catch { return { status: 'none' }; }
  const enabled = candidates.filter((el) => isNavClickable(el) && classifyNavControl(el) === 'next');
  // DOM may have changed between discovery and click. Requiring exactly one
  // candidate again makes that race fail closed instead of clicking a guess.
  if (enabled.length !== 1) return { status: 'none' };
  const nextEl = enabled[0];
  try { nextEl.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* */ }
  // scrollIntoView can synchronously trigger page-owned handlers that replace
  // the SPA question/control tree. Never carry discovery authority across it.
  if (!captureMatches()) return { status: 'stale' };
  return { status: activatePaginationControl(nextEl) ? 'clicked' : 'none' };
}

/* =====================================================================
 * GENERIC WEB PAGES (everything that is NOT МЭШ)
 * ---------------------------------------------------------------------
 * The extension can also answer an ordinary web page with a question or an
 * exercise on it, on origins the user explicitly granted (see lib/web-solve.js
 * for the permission model). МЭШ keeps its own path untouched; this section is
 * purely additive and is never reached from a Mesh document.
 *
 * Two jobs, both read-only until the worker asks for a fill (the "is there a
 * question here?" detection that decides whether the pill appears lives in
 * test-pill.js — it must run on every page of every granted site, and this
 * 180 KB file is only injected once a solve actually starts):
 *   __smeshWebContent  — the scrape. Picks the region that actually holds the
 *                        question, strips site furniture (nav/footer/cookie
 *                        bars/comments) and emits a compact transcript plus an
 *                        explicit inventory of the answer controls. Bounded on
 *                        purpose: these pages are answered on the cheap model
 *                        chain and every character is paid for.
 *   __smeshWebFill     — one fill pass over native AND custom controls merged
 *                        into a single numbered list, so the numbers the model
 *                        was shown are exactly the numbers the fill resolves.
 *                        (The Mesh flow runs two independent passes, each with
 *                        its own numbering — safe there because both see the
 *                        same «ЗАДАНИЕ №N» headings, ambiguous on a random
 *                        site that numbers nothing.)
 * ===================================================================== */

const MAX_WEB_UNITS = 60;              // answer controls we will describe/fill
const MAX_WEB_OPTIONS = 24;            // options listed per control
const MAX_WEB_TEXT_CHARS = 7000;       // page transcript budget (≈2k tokens)
const MAX_WEB_INVENTORY_CHARS = 3000;
const MAX_WEB_NODES = 20000;           // hard bound on the extraction walk
const MAX_WEB_STYLE_READS = 800;       // bound on getComputedStyle during it
const MAX_WEB_DEPTH = 40;

/* ---------- shared unit list (native + custom, one numbering) ---------- */

const MAX_WEB_FURNITURE_DEPTH = 12;

/**
 * Is this control part of the SITE rather than part of a question?
 *
 * Found on a real page: ru.wikipedia.org ships eight visible `input[type=
 * checkbox]` elements — the dropdown toggles for the main menu, appearance,
 * language list and table of contents. collectUnits() cannot tell them from a
 * multiple-choice question, so without this an encyclopedia article looked like
 * a four-question quiz and an autofill could have flipped the site's own menus.
 * Every one of them sits inside a <nav> or <header> within a few levels, which
 * is what this checks.
 */
function webInFurniture(element) {
  let node = element;
  for (let depth = 0; node && node.nodeType === 1 && depth < MAX_WEB_FURNITURE_DEPTH; depth++) {
    if (webLooksLikeFurniture(node)) return true;
    node = node.parentElement;
  }
  return false;
}

function webQuestionUnits() {
  let native = [];
  let interactive = [];
  try { native = collectUnits(); } catch { native = []; }
  try { interactive = collectInteractiveUnits(); } catch { interactive = []; }
  const units = [];
  const usable = (unit) => {
    try { return !!unit.anchor && !webInFurniture(unit.anchor); } catch { return false; }
  };
  for (const unit of native) if (usable(unit)) units.push({ kind: 'native', unit, anchor: unit.anchor });
  for (const unit of interactive) if (usable(unit)) units.push({ kind: 'interactive', unit, anchor: unit.anchor });
  try { units.sort((a, b) => domOrderCompare(a.anchor, b.anchor)); } catch { /* detached anchor */ }
  return units.slice(0, MAX_WEB_UNITS);
}

/**
 * Identifiers for the merged unit list.
 *
 * Either the page numbers EVERY control unambiguously («Вопрос 1…5») and we use
 * those on-screen numbers, or we number 1..N positionally. A mixed or repeated
 * set is deliberately discarded: the fill matches an answer to a control by this
 * id, and a half-numbered page is exactly how an answer lands on the wrong box.
 */
function webUnitIds(units) {
  const numbers = units.map((entry) => (entry.unit.number == null ? '' : String(entry.unit.number)));
  const named = numbers.filter(Boolean);
  const unique = new Set(named).size === named.length;
  if (named.length === units.length && unique && units.length) {
    return { ids: numbers, numbered: true };
  }
  return { ids: units.map((_, index) => String(index + 1)), numbered: false };
}

const WEB_UNIT_KIND_TEXT = {
  radio: 'один вариант из списка',
  checkbox: 'несколько вариантов (галочки)',
  select: 'выпадающий список',
  text: 'ввод текста',
  dropdown: 'выпадающий список',
  'aria-radio': 'один вариант из списка',
  toggle: 'кнопки-варианты'
};

function webUnitOptions(entry) {
  const unit = entry.unit;
  const out = [];
  try {
    if (entry.kind === 'native') {
      if (unit.type === 'select') {
        const options = Array.from(unit.inputs[0]?.options || []).slice(0, MAX_WEB_OPTIONS);
        for (const option of options) out.push(normalize(option.textContent));
      } else if (unit.type === 'radio' || unit.type === 'checkbox') {
        for (const input of unit.inputs.slice(0, MAX_WEB_OPTIONS)) out.push(normalize(controlLabelText(input)));
      }
    } else if (unit.type === 'dropdown') {
      // A custom dropdown keeps its options in a popper that only opens on
      // click. Showing the trigger's current text is honest; the fill matches
      // the model's answer against the real options once the menu is open.
      for (const element of unit.els.slice(0, MAX_WEB_OPTIONS)) {
        out.push(normalize(element.getAttribute?.('aria-label') || precedingFieldText(element) || element.textContent));
      }
    } else {
      for (const element of unit.els.slice(0, MAX_WEB_OPTIONS)) {
        out.push(normalize(controlLabelText(element) || element.textContent));
      }
    }
  } catch { /* unreadable control — describe it without options */ }
  return out.map((text) => text.slice(0, 160)).filter(Boolean);
}

function webUnitFields(entry) {
  if (entry.kind !== 'native' || entry.unit.type !== 'text') return [];
  try {
    return entry.unit.inputs
      .slice(0, 12)
      .map((input) => normalize(fieldLabel(input)).slice(0, 80))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The answer-control inventory handed to the model. This is what makes generic
 * autofill work at all: the model is told the exact number, kind and options of
 * every box, and answers against those numbers.
 */
function webInventoryText(units, ids) {
  const lines = [];
  let used = 0;
  units.forEach((entry, index) => {
    if (used >= MAX_WEB_INVENTORY_CHARS) return;
    const kind = WEB_UNIT_KIND_TEXT[entry.unit.type] || 'поле ответа';
    const options = webUnitOptions(entry);
    const fields = webUnitFields(entry);
    let line = `№${ids[index]} · ${kind}`;
    if (options.length) {
      line += ' · варианты: ' + options.map((text, i) => `${i + 1}) ${text}`).join('  ');
    } else if (fields.length > 1) {
      line += ` · ${fields.length} поля: ` + fields.join(', ');
    } else if (fields.length === 1) {
      line += ` · подпись: ${fields[0]}`;
    }
    line = line.slice(0, 600);
    used += line.length + 1;
    lines.push(line);
  });
  return lines.join('\n');
}

/* ---------- readable content extraction ---------- */

const WEB_SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'LINK', 'META', 'TITLE',
  'SVG', 'CANVAS', 'IFRAME', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED', 'MAP', 'AREA',
  'PICTURE', 'SOURCE', 'TRACK', 'PARAM'
]);
const WEB_BOILERPLATE_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'DIALOG']);
const WEB_BOILERPLATE_ROLES = new Set([
  'navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu',
  'menubar', 'toolbar', 'tablist', 'dialog', 'alertdialog', 'tooltip', 'log',
  'status', 'marquee', 'presentation'
]);
// Matched against TOKENS of class/id, never against the raw string: `subheader`
// is one token and stays, `page-header` splits and goes. Anything that holds a
// question control or a «Вопрос N» heading is protected from this list anyway
// (see webProtectedAncestors) — the words below are only allowed to remove
// furniture that carries no answerable material.
const WEB_BOILERPLATE_WORDS = new Set([
  'nav', 'navbar', 'navigation', 'menu', 'submenu', 'megamenu', 'header',
  'masthead', 'footer', 'sidebar', 'breadcrumb', 'breadcrumbs', 'comment',
  'comments', 'disqus', 'banner', 'advert', 'advertisement', 'ads',
  'adsbygoogle', 'cookie', 'cookies', 'consent', 'gdpr', 'promo', 'social',
  'share', 'sharing', 'related', 'recommended', 'recommendations', 'newsletter',
  'subscribe', 'popup', 'modal', 'overlay', 'pagination', 'pager', 'copyright',
  'sponsor', 'sponsored', 'paywall', 'skiplink', 'offcanvas', 'hamburger',
  'topbar', 'bottombar', 'toolbar', 'searchform', 'searchbox', 'sitemap'
]);
const WEB_INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DFN', 'EM', 'FONT',
  'I', 'KBD', 'MARK', 'Q', 'RUBY', 'RT', 'RP', 'S', 'SAMP', 'SMALL', 'SPAN',
  'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR', 'BR', 'IMG'
]);

function webTokens(value) {
  return String(value || '').toLowerCase().split(/[^a-z0-9а-яё]+/i);
}

function webLooksLikeFurniture(element) {
  if (WEB_BOILERPLATE_TAGS.has(element.tagName)) return true;
  let role = '';
  try { role = String(element.getAttribute('role') || '').toLowerCase(); } catch { role = ''; }
  if (role && WEB_BOILERPLATE_ROLES.has(role)) return true;
  let names = '';
  try { names = `${element.getAttribute('class') || ''} ${element.getAttribute('id') || ''}`; } catch { names = ''; }
  if (!names.trim()) return false;
  for (const token of webTokens(names)) if (WEB_BOILERPLATE_WORDS.has(token)) return true;
  return false;
}

/**
 * Every ancestor of every question anchor. A subtree on this list is never
 * pruned as furniture — a real quiz inside `<div class="widget">` outranks a
 * class-name heuristic, always.
 */
function webProtectedAncestors(units, markers) {
  const protectedNodes = new Set();
  const add = (node) => {
    let current = node;
    for (let depth = 0; current && depth < 60; depth++, current = current.parentElement) {
      if (protectedNodes.has(current)) break;
      protectedNodes.add(current);
    }
  };
  for (const entry of units) add(entry.anchor);
  for (const marker of markers.slice(0, 60)) if (marker.node) add(marker.node);
  return protectedNodes;
}

/**
 * The region that actually holds the question.
 *
 * Anchored on the answer controls and the «Вопрос N» headings when there are
 * any — far more reliable on a quiz page than article heuristics — then climbed
 * a few levels so the prompt text ABOVE the first control comes along. Falls
 * back to the page's main/article landmark, then to <body> (which the furniture
 * pruning below already handles).
 */
function webContentRoot(units, markers) {
  const anchors = units.map((entry) => entry.anchor).filter(Boolean).slice(0, 40);
  for (const marker of markers.slice(0, 40)) if (marker.node) anchors.push(marker.node);
  const body = document.body || document.documentElement;
  if (anchors.length) {
    let root = null;
    try { root = commonAncestor(anchors); } catch { root = null; }
    if (root && root.nodeType === 1) {
      for (let step = 0; step < 6; step++) {
        const parent = root.parentElement;
        if (!parent || parent === body || parent === document.documentElement) break;
        const grown = (parent.textContent || '').length;
        const current = (root.textContent || '').length;
        // A lone input has no text of its own, so its immediate parent may be a
        // long reading-comprehension passage rather than the page shell. Let
        // that first meaningful context in, within a strict bound; after that,
        // retain the tighter same-order-of-magnitude rule.
        if (current < 200) {
          if (grown > MAX_WEB_TEXT_CHARS * 2) break;
        } else if (grown > Math.max(1500, current * 3)) break;
        root = parent;
      }
      return root;
    }
  }
  let best = null;
  let bestLength = 0;
  try {
    for (const candidate of Array.from(document.querySelectorAll('main, [role="main"], article')).slice(0, 20)) {
      const length = (candidate.textContent || '').length;
      if (length > bestLength) { best = candidate; bestLength = length; }
    }
  } catch { /* landmarks unreadable */ }
  return bestLength >= 200 ? best : body;
}

/**
 * Depth-first transcript of `root`: one line per block, site furniture pruned,
 * hard-bounded in nodes, style reads and characters. Deliberately NOT innerText
 * on the whole page — that is what makes a generic scrape expensive and noisy.
 */
function webBlockText(root, budget, protectedNodes) {
  const lines = [];
  let used = 0;
  let nodes = 0;
  let styleReads = 0;

  const hidden = (element) => {
    try {
      if (element.hidden) return true;
      if (element.getAttribute('aria-hidden') === 'true') return true;
    } catch { return false; }
    if (styleReads >= MAX_WEB_STYLE_READS) return false;
    styleReads++;
    try {
      const style = window.getComputedStyle(element);
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    } catch {
      return false;
    }
  };

  const push = (text) => {
    const line = normalize(text);
    if (!line) return;
    const room = budget - used;
    if (room <= 0) return;
    const clipped = line.length > room ? line.slice(0, room) : line;
    lines.push(clipped);
    used += clipped.length + 1;
  };

  const inlineText = (element) => {
    if (element.tagName === 'IMG') {
      let alt = '';
      try { alt = element.getAttribute('alt') || ''; } catch { alt = ''; }
      return alt ? ` ${alt} ` : '';
    }
    if (element.tagName === 'BR') return ' ';
    return element.textContent || '';
  };

  const controlMarker = (element) => {
    const tag = element.tagName;
    if (tag === 'TEXTAREA') return ' [поле для ответа] ';
    if (tag === 'SELECT') return ' [выпадающий список] ';
    if (tag !== 'INPUT') return '';
    let type = '';
    try { type = String(element.getAttribute('type') || 'text').toLowerCase(); } catch { type = 'text'; }
    if (type === 'radio') return ' ( ) ';
    if (type === 'checkbox') return ' [ ] ';
    if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) return '';
    return ' [___] ';
  };

  const walk = (element, depth) => {
    if (used >= budget || nodes >= MAX_WEB_NODES || depth > MAX_WEB_DEPTH) return;
    nodes++;
    let buffer = '';
    let children = [];
    try { children = Array.from(element.childNodes); } catch { children = []; }
    for (const node of children) {
      if (used >= budget || nodes >= MAX_WEB_NODES) break;
      if (node.nodeType === 3) { buffer += node.nodeValue || ''; continue; }
      if (node.nodeType !== 1) continue;
      nodes++;
      const tag = node.tagName;
      if (WEB_SKIP_TAGS.has(tag)) continue;
      const isProtected = protectedNodes.has(node);
      if (!isProtected && webLooksLikeFurniture(node)) continue;
      if (hidden(node)) continue;
      if (WEB_INLINE_TAGS.has(tag)) { buffer += inlineText(node); continue; }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'OPTION') {
        // OPTION text is inventoried separately; inline it would duplicate the
        // whole dropdown into the transcript.
        if (tag !== 'OPTION') buffer += controlMarker(node);
        continue;
      }
      push(buffer);
      buffer = '';
      walk(node, depth + 1);
    }
    push(buffer);
  };

  try { walk(root, 0); } catch { /* torn-down DOM — return what we have */ }

  // NOTE: repeated lines are deliberately NOT collapsed. An earlier version
  // deduplicated short ones to squeeze out echoed navigation, which also ate a
  // true/false quiz's fifth «Да» and shifted every option after it. Dropping
  // page content on a repetition heuristic buys a few tokens and risks a wrong
  // answer; the furniture pruning above is the real defence, and the budget
  // already caps the cost.
  return lines.join('\n').slice(0, budget);
}

/**
 * Everything the worker sends to the model for a generic page.
 *
 * `bodyChars` counts ONLY the page transcript, not the title/URL header the
 * worker's "is this page readable at all?" check would otherwise always clear.
 *
 * @returns {{text:string, unitCount:number, chars:number, bodyChars:number}}
 */
function readWebPageContent(maxChars = MAX_WEB_TEXT_CHARS) {
  const budget = Math.max(500, Math.min(MAX_WEB_TEXT_CHARS, Number(maxChars) || MAX_WEB_TEXT_CHARS));
  const units = webQuestionUnits();
  const { ids } = webUnitIds(units);
  // One marker sweep for the whole read. collectQuestionMarkers walks every
  // text node in the document, and this function used to trigger it four times
  // on pages that can be megabytes.
  let markers = [];
  try { markers = collectQuestionMarkers(); } catch { markers = []; }
  const protectedNodes = webProtectedAncestors(units, markers);
  const root = webContentRoot(units, markers);
  const body = webBlockText(root, budget, protectedNodes);
  const parts = [];
  const title = normalize(document.title).slice(0, 200);
  if (title) parts.push(`Заголовок страницы: ${title}`);
  // Origin + path only. The query string can carry session material and adds
  // nothing a model needs; the path usually names the topic and does.
  try {
    const url = new URL(location.href);
    parts.push(`Адрес: ${url.origin}${url.pathname}`.slice(0, 300));
  } catch { /* opaque location */ }
  parts.push('\n=== Содержимое страницы ===\n' + (body || '(не удалось прочитать текст страницы)'));
  if (units.length) {
    parts.push('\n=== Поля для ответа на странице ===\n' + webInventoryText(units, ids));
  }
  const text = parts.join('\n');
  return {
    text,
    unitCount: units.length,
    chars: text.length,
    bodyChars: body.trim().length,
  };
}

/* ---------- single-pass fill for generic pages ---------- */

/**
 * Fill a generic page from the model's answers.
 *
 * One list, one numbering, one match — see the section header for why the Mesh
 * two-pass design is not reused here. Native units are written synchronously and
 * verified after a settle window (identical to fillTestAnswers); custom widgets
 * go through the async interactive filler, which verifies itself. Never submits.
 */
async function fillWebAnswers(questions, expectedSignature = '', expectedPrincipal = '') {
  const summary = { filled: [], skipped: [] };
  if (!Array.isArray(questions) || !questions.length) return summary;
  const guard = { signature: expectedSignature, principal: expectedPrincipal, stale: false };
  if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };

  const idFor = (question, index) =>
    (question && question.index != null && String(question.index).trim() !== '') ? question.index : index + 1;

  const units = webQuestionUnits();
  const { ids, numbered } = webUnitIds(units);
  if (!units.length) {
    questions.forEach((question, index) => summary.skipped.push(idFor(question, index)));
    return summary;
  }
  const byId = new Map();
  ids.forEach((id, index) => { if (!byId.has(id)) byId.set(id, index); });
  const used = new Set();
  // When the page numbers its questions we trust those numbers absolutely: a
  // numbered control may only receive the answer carrying its own number. This
  // is the same rule the Mesh fill applies, and for the same reason — a missed
  // control must not shift every later answer onto its neighbour.
  const acceptable = (index, id) =>
    index >= 0 && index < units.length && !used.has(index) && (!numbered || ids[index] === String(id));

  const pendingVerify = [];
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex++) {
    if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };
    const question = questions[questionIndex];
    const id = idFor(question, questionIndex);
    let index = byId.has(String(id)) ? byId.get(String(id)) : -1;
    if (!acceptable(index, id)) {
      const positional = /^\d+$/.test(String(id)) ? parseInt(id, 10) - 1 : questionIndex;
      index = acceptable(positional, id) ? positional
        : (acceptable(questionIndex, id) ? questionIndex : -1);
    }
    if (index < 0) { summary.skipped.push(id); continue; }

    const entry = units[index];
    let ok = false;
    if (entry.kind === 'native') {
      const writes = [];
      try { ok = fillUnit(entry.unit, question, writes, guard); } catch { ok = false; }
      if (ok && writes.length) pendingVerify.push({ id, writes });
    } else {
      try { ok = await fillInteractiveUnit(entry.unit, question, guard); } catch { ok = false; }
    }
    if (guard.stale) return { ...summary, stale: true };
    if (ok) { used.add(index); summary.filled.push(id); }
    else summary.skipped.push(id);
  }

  if (pendingVerify.length) {
    await __smeshSleep(80);
    if (!interactiveGuardCurrent(guard)) return { ...summary, stale: true };
    const demoted = pendingVerify
      .filter((group) => !group.writes.every(pendingWriteTook))
      .map((group) => group.id);
    for (const id of demoted) {
      const at = summary.filled.indexOf(id);
      if (at !== -1) summary.filled.splice(at, 1);
      if (!summary.skipped.includes(id)) summary.skipped.push(id);
    }
  }
  return summary;
}

window.__smeshHasVisualMedia = testPageHasVisualMedia;
window.__smeshPageSig = pageSignature;
window.__smeshCurrentPrincipal = currentPrincipalIdentity;
window.__smeshNextDiscovery = discoverPagination;
window.__smeshNextClick = clickDiscoveredPagination;
window.__smeshWebContent = readWebPageContent;
window.__smeshWebFill = fillWebAnswers;
window.__smeshIsWebDocument = isWebSolvableDocument;

// A SHOW_ANSWERS message is itself the worker's privileged replacement action.
// If its capture is already stale before panel.show() can mint the new local
// generation, remove the previous panel unconditionally: its worker capability
// was revoked when the replacement began. Keep standalone HIDE_ANSWERS nonce-
// scoped below so a delayed/unrelated hide can never remove a newer panel.
function discardPanelForRejectedShow() {
  try { window.__smeshPanel?.hide(); } catch { /* no prior panel to discard */ }
}

// Guard against duplicate listeners: the manifest auto-injects this script,
// and popup.js falls back to chrome.scripting.executeScript on a race. Without
// this guard both copies would respond to every MESH_SCAN.
if (!window.__smeshListenerAdded) {
  window.__smeshListenerAdded = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Handlers are synchronous — only return true (keep the channel open)
    // when we actually own this message type, otherwise the sender hangs on
    // "channel closed before response".
    try {
      if (msg && msg.type === 'MESH_SCAN') {
        applyScanConfig(msg.config); // remote hot-fix overrides (best-effort)
        sendResponse({ ok: true, data: scanHomeworks() });
        return false;
      }
      if (msg && msg.type === 'MESH_DEBUG_FETCH') {
        debugFetch(msg.homeworkId)
          .then((info) => sendResponse({ ok: true, info }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
      }
      if (msg && msg.type === 'MESH_LIST_MATERIALS') {
        // Async: keep the channel open until the API call resolves. Only
        // discovers URLs — the service worker downloads them (see comment above
        // listMaterialUrls for the MV3 CORS reason).
        listMaterialUrls(
          msg.homeworkId,
          msg.task,
          msg.homeworkItemId,
          msg.rowToken,
          msg.principal,
          msg.principalError,
        )
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({
            ok: false,
            error: String(e),
            urls: [],
            files: [],
            candidates: [],
            token: null,
            headers: null,
            stage: e?.code === HOMEWORK_CONTEXT_CHANGED ? 'binding_changed' : 'exception',
          }));
        return true;
      }
      if (msg && msg.type === 'MESH_VERIFY_HOMEWORK_CONTEXT') {
        sendResponse({
          ok: true,
          matches: homeworkContextMatches(msg.principal, msg.principalError, msg.rowToken),
        });
        return false;
      }
      if (msg && msg.type === 'SHOW_ANSWERS') {
        // The floating panel lives in answer-panel.js (same isolated world).
        // The service worker injects it before sending this message, so the
        // entry point should already exist; guard anyway in case order slips.
        const expected = msg.payload?.capture;
        const captureMatches = expected &&
          window.location.href === expected.url &&
          window.__smeshCaptureDocumentId === expected.pageId &&
          pageSignature() === expected.signature &&
          currentPrincipalIdentity() === expected.principal;
        if (!captureMatches) {
          discardPanelForRejectedShow();
          sendResponse({ ok: false, error: 'captured test page changed' });
          return false;
        }
        if (window.__smeshPanel?.show) {
          Promise.resolve(window.__smeshPanel.show(msg.payload))
            .then(() => sendResponse({ ok: true }))
            .catch((error) => {
              // show() may have claimed the replacement generation before an
              // async state read/capture check failed. Tear down only that exact
              // nonce; a newer SHOW remains protected from this late failure.
              try { window.__smeshPanel?.hide(msg.payload?.panelNonce); } catch { /* already gone */ }
              sendResponse({ ok: false, error: String(error) });
            });
          // Keep the channel open until the panel has finished its async state
          // and theme reads. The worker revalidates the capture after this
          // response and removes a panel raced by SPA navigation.
          return true;
        } else {
          sendResponse({ ok: false, error: 'answer-panel not loaded' });
        }
        return false;
      }
      if (msg && msg.type === 'HIDE_ANSWERS') {
        try { window.__smeshPanel?.hide(msg.payload?.panelNonce); } catch { /* nothing to clean up */ }
        sendResponse({ ok: true });
        return false;
      }
      // NOTE: there is deliberately no message that fills the form. Every fill
      // is injected by the worker through __smeshFill/__smeshFillInteractive
      // WITH the captured signature and principal, so it fails closed when the
      // page changed. A message-triggered fill carried no such guard — it was
      // the one write path with no capture, principal, panel-nonce or action
      // token — and had no caller. Do not reintroduce one.
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return false;
    }
    return false;
  });
}
