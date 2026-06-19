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
    let href = '';
    if (cardRoot) {
      const link = cardRoot.querySelector(HOMEWORK_ANCHOR_SEL);
      if (link) {
        href = link.getAttribute('href') || '';
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
      task: task || '(текст задания не виден — откройте задание или загрузите фото)',
      href,
      homeworkId: homeworkIdFromHref(href)
    });
  }
  return cards;
}

/** Pull the numeric homework id out of a Mesh anchor href (".../homeworks/123_normal"). */
function homeworkIdFromHref(href) {
  const m = (href || '').match(/\/homeworks\/(\d+)/);
  return m ? m[1] : null;
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
      subject: c.subject, task: c.task, href: c.href, homeworkId: c.homeworkId
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
const FILE_URL_RE = /https?:\/\/[^\s"'<>]+\.(?:pdf|docx?|pptx?|xlsx?|png|jpe?g|gif|webp|txt|rtf)(?:\?[^\s"'<>]*)?/i;
const MESH_FILE_HINT_RE = /(uchebnik\.mos\.ru|\/ej\/attachments?\/|\/files?\/|\/storage\/|file_id=)/i;

const LESSON_API = (id, studentId, personId) => {
  const u = new URL(`https://school.mos.ru/api/family/web/v1/lesson_schedule_items/${id}`);
  if (studentId) u.searchParams.set('student_id', studentId);
  u.searchParams.set('type', 'OO');
  if (personId) u.searchParams.set('person_id', personId);
  return u.toString();
};

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

/** student_id isn't in the token — scan localStorage/cookies values for it. */
function findStudentId() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const v = localStorage.getItem(localStorage.key(i)) || '';
      // Match a numeric id OR a GUID — `contingent_guid` is a GUID, so a digits-
      // only pattern would silently skip it despite being listed here.
      const m = v.match(/"(?:student_id|studentId|profile_id|profileId|contingent_guid)"\s*:\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,})"?/i);
      if (m) return m[1];
    }
  } catch { /* storage blocked */ }
  const c = document.cookie.match(/(?:student_id|profile_id|aupd_current_profile_id)=(\d{4,})/);
  return c ? c[1] : null;
}

/**
 * Resolve the numeric student_id the family API requires (it 400s without it).
 * Local storage first; if absent, ask the family profile API — for a student
 * login the profile's own `id` IS the student_id; for a parent it's a child id.
 * @returns {Promise<{id:string|null, source:string, debug?:object}>}
 */
async function resolveStudentId(headers) {
  const local = findStudentId();
  if (local) return { id: local, source: 'storage' };
  const tried = [];
  for (const url of [
    'https://school.mos.ru/api/family/web/v1/profile',
    'https://school.mos.ru/api/family/web/v1/students',
    'https://school.mos.ru/api/family/mobile/v1/profile'
  ]) {
    try {
      const res = await fetch(url, { credentials: 'include', headers });
      tried.push({ url, status: res.status });
      if (!res.ok) continue;
      const j = await res.json();
      const id = j?.profile?.id ?? j?.children?.[0]?.id ?? (Array.isArray(j) ? j[0]?.id : j?.id) ??
                 j?.students?.[0]?.id ?? j?.contingent_guid;
      if (id != null) return { id: String(id), source: url };
      tried[tried.length - 1].keys = j && typeof j === 'object' ? Object.keys(j) : typeof j;
    } catch (e) { tried.push({ url, error: String(e) }); }
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
 * Normalise a URL to a SINGLE correct percent-encoding. Mesh's API already
 * percent-encodes its file URLs (spaces -> %20, Cyrillic -> %D0…). A blind
 * encodeURI re-encodes the % itself (%D0 -> %25D0), producing a URL the server
 * 404s on. decode-then-encode is idempotent for both raw and pre-encoded input.
 */
function normalizeUrl(s) {
  try { return encodeURI(decodeURI(s)); } catch { return s; }
}

/** Recursively collect file-looking URLs from an arbitrary JSON value. */
function collectFileUrls(node, out = new Set(), depth = 0) {
  if (depth > 8 || out.size >= 8) return out;
  if (typeof node === 'string') {
    let s = node;
    // Mesh often stores attachment paths relative ("/ej/attachments/…"); absolutise.
    if (s[0] === '/' && MESH_FILE_HINT_RE.test(s)) s = 'https://school.mos.ru' + s;
    if (FILE_URL_RE.test(s) || (/^https?:\/\//.test(s) && MESH_FILE_HINT_RE.test(s))) {
      out.add(normalizeUrl(s));
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
 * take ONLY its files; fall back to the whole lesson if nothing matches.
 */
function urlsForHomework(json, taskText) {
  const homeworks = Array.isArray(json?.lesson_homeworks) ? json.lesson_homeworks : [];
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(taskText);
  let scope = homeworks;
  if (t && homeworks.length > 1) {
    const match = homeworks.filter((h) => {
      const hw = norm(h.homework);
      return hw && (hw.includes(t.slice(0, 25)) || t.includes(hw.slice(0, 25)));
    });
    if (match.length) scope = match;
  }
  const out = new Set();
  for (const h of scope) collectFileUrls(h, out);
  // Matched homework had no file? Widen to the whole lesson (kr_attachments etc.).
  if (!out.size) collectFileUrls(json, out);
  return [...out];
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
function scanPageForFileLinks() {
  const out = new Set();
  const push = (raw) => {
    if (!raw) return;
    let s = String(raw).trim();
    if (s[0] === '/') s = location.origin + s; // absolutise relative paths
    if (/^https?:\/\//.test(s) && looksLikeFileLink(s)) out.add(normalizeUrl(s));
  };
  for (const a of document.querySelectorAll('a[href]')) push(a.getAttribute('href'));
  // Mesh sometimes renders downloads as buttons carrying the URL in a data-attr.
  for (const el of document.querySelectorAll('[download],[data-href],[data-url],[data-file-url],[data-link]')) {
    push(el.getAttribute('href') || el.getAttribute('data-href') ||
         el.getAttribute('data-url') || el.getAttribute('data-file-url') || el.getAttribute('data-link'));
  }
  return [...out].slice(0, 8);
}

/** Last path segment of a URL, decoded — used as the attachment filename. */
function fileNameFromUrl(url) {
  try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').pop()) || 'attachment'; }
  catch { return 'attachment'; }
}

const isSameOrigin = (url) => {
  try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};

/**
 * Download a SAME-ORIGIN attachment from inside the page. The content script
 * carries the user's real session cookies, so school.mos.ru/ej/attachments
 * downloads succeed here without bouncing to the auth page — which is exactly
 * what happened when the service worker fetched them. An HTML response means we
 * still got an auth/login redirect, so we reject it instead of attaching junk.
 */
async function fetchInlineFile(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) { console.log('[СМЭШ AI] cs-download http', res.status, url); return null; }
    const ct = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/xml')) {
      console.log('[СМЭШ AI] cs-download got HTML (auth redirect?)', url);
      return { __auth: true };
    }
    const blob = await res.blob();
    if (!blob.size || blob.size > 12 * 1024 * 1024) return null;
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    return {
      mimeType: ct || blob.type || 'application/octet-stream',
      dataBase64: String(dataUrl).split(',')[1],
      name: fileNameFromUrl(url)
    };
  } catch (e) { console.log('[СМЭШ AI] cs-download exception', String(e), url); return null; }
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
 * @returns {Promise<{ok:boolean, files:object[], urls:string[], token:string|null, headers:object, stage:string, status?:number}>}
 */
async function listMaterialUrls(lessonId, taskText) {
  const token = findAuthToken();
  const headers = meshHeaders(token);
  const log = (stage, extra) => console.log('[СМЭШ AI] auto-fetch:', stage, extra ?? '');

  // The API path is the precise one (it knows which homework owns which file), so
  // prefer it whenever we have a lesson id. The DOM scan is only a fallback for
  // when there's no id (it can't tell which of several files belongs to the task).
  let urls = [];
  let stage = '';
  if (lessonId && token) {
    try {
      const personId = jwtPayload(token)?.msh || null;
      const studentId = (await resolveStudentId(headers)).id;
      if (!studentId) { log('no_student_id'); return { ok: false, files: [], urls: [], token, headers, stage: 'no_student_id' }; }
      const apiUrl = LESSON_API(lessonId, studentId, personId);
      log('request', { lessonId, studentId, personId, apiUrl });
      const res = await fetch(apiUrl, { credentials: 'include', headers });
      if (!res.ok) {
        log('api_error', res.status);
        return { ok: false, files: [], urls: [], token, headers, stage: 'api_error', status: res.status };
      }
      urls = urlsForHomework(await res.json(), taskText).slice(0, 5);
      stage = urls.length ? 'found_api' : 'no_urls';
    } catch (e) {
      log('exception', String(e));
      return { ok: false, files: [], urls: [], token, headers, stage: 'exception' };
    }
  }

  // Fallback: scan the page DOM (works on the homework detail page even without
  // a lesson id). It can't tell which homework a file belongs to, so it's the
  // second choice — used only when the API surfaced nothing.
  if (!urls.length) {
    const domUrls = scanPageForFileLinks();
    if (domUrls.length) { urls = domUrls; stage = 'found_dom'; }
  }
  if (!urls.length) {
    const why = !lessonId ? 'no_lesson_id' : !token ? 'no_token' : 'no_urls';
    log(why);
    return { ok: false, files: [], urls: [], token, headers, stage: why };
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
    if (f?.__auth) sawAuth = true;
    else if (f) files.push(f);
  }
  if (!files.length && !crossOrigin.length) {
    log(sawAuth ? 'auth_redirect' : 'download_failed', urls);
    return { ok: false, files: [], urls: [], token, headers, stage: sawAuth ? 'auth_redirect' : 'download_failed' };
  }
  log('ok', { files: files.map((f) => f.name), crossOrigin });
  return { ok: true, files, urls: crossOrigin, token, headers, stage };
}

/**
 * Full diagnostic for the file auto-fetch: token presence, ids, the exact API
 * URL + HTTP status, the response's top-level keys and a JSON sample, plus any
 * attachment links found in the page DOM. One copy-paste of this tells us
 * exactly which layer is broken so the fetch can be fixed for real.
 */
async function debugFetch(lessonId) {
  const token = findAuthToken();
  const headers = meshHeaders(token);
  const sid = await resolveStudentId(headers);
  const out = {
    pageUrl: location.href,
    lessonId: lessonId || null,
    tokenFound: !!token,
    personId: token ? (jwtPayload(token)?.msh || null) : null,
    studentId: sid.id,
    studentIdSource: sid.source,
    studentIdProbe: sid.debug || null,
    // Numeric id-like fields in localStorage (no tokens) — a backstop for
    // locating student_id if the profile API can't supply it.
    storageHints: (() => {
      const hints = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i) || '';
          const v = localStorage.getItem(k) || '';
          const m = v.match(/"(student_id|studentId|profile_id|profileId|contingent_guid|id)"\s*:\s*"?(\d{4,})"?/);
          if (m) hints.push({ key: k.slice(0, 40), field: m[1], val: m[2] });
        }
      } catch { /* blocked */ }
      return hints.slice(0, 12);
    })(),
    domFileLinks: scanPageForFileLinks(),
    domAnchorCount: document.querySelectorAll('a[href]').length
  };
  let apiUrls = [];
  if (lessonId && token) {
    const apiUrl = LESSON_API(lessonId, out.studentId, out.personId);
    out.apiUrl = apiUrl;
    try {
      const res = await fetch(apiUrl, { credentials: 'include', headers });
      out.httpStatus = res.status;
      if (res.ok) {
        const json = await res.json();
        out.subjectName = json?.subject_name;
        apiUrls = [...collectFileUrls(json)];
        out.foundUrls = apiUrls;
        // The attachment-bearing structures, pulled out explicitly so we can see
        // exactly where a real uploaded file lives (vs digital-library bindings).
        out.homeworks = (json?.lesson_homeworks || []).map((h) => ({
          homework: (h.homework || '').slice(0, 80),
          attachments: h.attachments,
          additional_materials: (h.additional_materials || []).map((m) => ({
            type: m.type, title: (m.title || '').slice(0, 40), urls: m.urls, id: m.id
          }))
        }));
        out.kr_attachments = json?.kr_attachments;
        out.details_content = json?.details?.content;
      } else {
        out.bodySample = (await res.text().catch(() => '')).slice(0, 600);
      }
    } catch (e) { out.exception = String(e); }
  }

  // Actually try to download each candidate so the diagnostic shows what comes
  // back — a real file (PDF, size) vs an HTML auth redirect vs a 403. This one
  // field usually reveals the fix without further round-trips.
  const candidates = [...new Set([...out.domFileLinks, ...apiUrls])].slice(0, 6);
  out.probes = [];
  for (const url of candidates) {
    const p = { url, sameOrigin: isSameOrigin(url) };
    try {
      const res = await fetch(url, { credentials: 'include' });
      p.status = res.status;
      p.contentType = (res.headers.get('content-type') || '').split(';')[0];
      const blob = await res.blob();
      p.sizeKB = Math.round(blob.size / 102.4) / 10;
      p.looksHtml = (p.contentType || '').includes('html');
    } catch (e) { p.error = String(e); }
    out.probes.push(p);
  }
  return out;
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
  if (box.width > 0 && box.height > 0) return true;
  const ref = el.closest('label') || el.parentElement;
  if (ref) {
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
  const m = norm.match(/^\s*(?:вопрос|задание)\s*[№#]?\s*(\d{1,3})\b/i)
    || norm.match(/^\s*[№#]\s*(\d{1,3})\b/)
    || norm.match(/^\s*(\d{1,3})\s*[.)]/);
  return m ? parseInt(m[1], 10) : null;
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

function makeUnit(type, inputs, providedContainer) {
  const base = providedContainer || commonAncestor(inputs) || inputs[0].parentElement || inputs[0];
  const info = questionInfo(base);
  return { type, inputs, anchor: inputs[0], number: info.number };
}

// Discover every fillable question on the page as a list of units, in document
// order. Radios group by their shared `name` (MUI RadioGroup) or RadioGroup
// container; checkboxes by container; text/number/textarea are one-per-unit.
function collectUnits() {
  const units = [];
  const consumed = new Set();

  // --- radio groups ---
  const radioByKey = new Map();
  for (const r of pickControls('input[type=radio]')) {
    const key = r.name ? 'name:' + r.name : 'grp:' + elUid(r.closest('[role=radiogroup]') || r.parentElement);
    if (!radioByKey.has(key)) radioByKey.set(key, []);
    radioByKey.get(key).push(r);
    consumed.add(r);
  }
  for (const inputs of radioByKey.values()) units.push(makeUnit('radio', inputs));

  // --- checkbox groups ---
  const cbByKey = new Map();
  for (const c of pickControls('input[type=checkbox]')) {
    if (consumed.has(c)) continue;
    const container = checkboxGroupContainer(c);
    const key = 'cb:' + elUid(container);
    if (!cbByKey.has(key)) cbByKey.set(key, { container, inputs: [] });
    cbByKey.get(key).inputs.push(c);
  }
  for (const { container, inputs } of cbByKey.values()) units.push(makeUnit('checkbox', inputs, container));

  // --- free text ---
  for (const t of pickControls('input[type=text], input[type=number], input:not([type]), textarea')) {
    if (consumed.has(t)) continue;
    units.push(makeUnit('text', [t]));
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
  for (const tok of String(choice).split(/\s*(?:,|;|\bи\b|\/|\|)\s*/i)) {
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

// --- React-aware writers ---

function setNativeValue(el, value) {
  const proto = (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement)
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function selectRadio(input) {
  if (!input.checked) input.click(); // real click → React's onChange fires
  if (!input.checked) { // belt-and-braces for non-standard handlers
    input.checked = true;
    input.dispatchEvent(new Event('click', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function setCheckbox(input, desired) {
  if (input.checked !== desired) input.click();
  if (input.checked !== desired) {
    input.checked = desired;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Don't act on a "not visible, scroll" sentinel or an empty answer.
function isUnfillableAnswer(ans) {
  return !ans || /не\s*видно|прокрут/i.test(ans);
}

// Fill one discovered unit from one question. Returns true only on a real edit.
function fillUnit(unit, question) {
  const ans = String(question.answer ?? '').trim();
  if (isUnfillableAnswer(ans)) return false;

  if (unit.type === 'text') {
    const input = unit.inputs[0];
    if (!input || !document.documentElement.contains(input)) return false;
    setNativeValue(input, ans);
    return true;
  }

  const options = unit.inputs
    .filter((input) => document.documentElement.contains(input))
    .map((input) => ({ input, labelNorm: normalizeForMatch(controlLabelText(input)) }));
  if (!options.length) return false;

  if (unit.type === 'checkbox') {
    const parts = ans.split(/\s*(?:,|;|\bи\b|\/|\n)\s*/i).map((p) => p.trim()).filter(Boolean);
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
    for (const o of options) if (targets.has(o.input)) setCheckbox(o.input, true);
    return true;
  }

  // radio (single choice)
  const m = bestOption(ans, options, question.choice);
  if (!m) return false;
  selectRadio(m.input);
  return true;
}

/**
 * Fill the Mesh test form from the model's answers. Matches each question to a
 * discovered unit by its number first, then by position. Never guesses past the
 * confidence threshold and never submits. Returns { filled, skipped } as lists
 * of question identifiers (the `index` field, or 1-based position when absent).
 */
function fillTestAnswers(questions) {
  const summary = { filled: [], skipped: [] };
  if (!Array.isArray(questions) || !questions.length) return summary;

  const idFor = (q, i) =>
    (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;

  let units = [];
  try { units = collectUnits(); } catch { units = []; }
  if (!units.length) {
    questions.forEach((q, i) => summary.skipped.push(idFor(q, i)));
    return summary;
  }

  const byNumber = new Map();
  units.forEach((u) => { if (u.number != null && !byNumber.has(String(u.number))) byNumber.set(String(u.number), u); });
  const used = new Set();

  questions.forEach((q, qi) => {
    const id = idFor(q, qi);
    let unit = byNumber.get(String(id));
    if (!unit || used.has(unit)) {
      // Positional fallback: numeric ids map to 1-based order, else array order.
      const posIdx = /^\d+$/.test(String(id)) ? parseInt(id, 10) - 1 : qi;
      unit = (units[posIdx] && !used.has(units[posIdx])) ? units[posIdx]
        : (units[qi] && !used.has(units[qi])) ? units[qi] : null;
    }
    if (!unit || used.has(unit)) { summary.skipped.push(id); return; }

    let ok = false;
    try { ok = fillUnit(unit, q); } catch { ok = false; }
    if (ok) { used.add(unit); summary.filled.push(id); }
    else summary.skipped.push(id);
  });

  return summary;
}

// Shared isolated-world entry point: answer-panel.js (same content-script world,
// so it sees this global) calls it directly — chrome.runtime messaging can't
// reach a sibling content script in the same tab.
window.__smeshFill = fillTestAnswers;

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
        sendResponse({ ok: true, data: scanHomeworks() });
        return false;
      }
      if (msg && msg.type === 'MESH_DEBUG') {
        sendResponse({ ok: true, debug: debugScan() });
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
        listMaterialUrls(msg.homeworkId, msg.task)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: String(e), urls: [], token: null }));
        return true;
      }
      if (msg && msg.type === 'SHOW_ANSWERS') {
        // The floating panel lives in answer-panel.js (same isolated world).
        // The service worker injects it before sending this message, so the
        // entry point should already exist; guard anyway in case order slips.
        if (window.__smeshPanel?.show) {
          Promise.resolve(window.__smeshPanel.show(msg.payload)).catch(() => { /* show is best-effort */ });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'answer-panel not loaded' });
        }
        return false;
      }
      if (msg && msg.type === 'HIDE_ANSWERS') {
        try { window.__smeshPanel?.hide(); } catch { /* nothing to clean up */ }
        sendResponse({ ok: true });
        return false;
      }
      if (msg && msg.type === 'FILL_ANSWERS') {
        // Auto-fill the test form. The in-page panel button calls fillTestAnswers
        // directly (same world); this message is for any external trigger
        // (service worker / popup). Always degrades to a skipped summary.
        let summary = { filled: [], skipped: [] };
        try {
          summary = fillTestAnswers(msg.payload?.questions || []);
          sendResponse({ ok: true, summary });
        } catch (e) {
          sendResponse({ ok: false, error: String(e), summary });
        }
        return false;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return false;
    }
    return false;
  });
}
