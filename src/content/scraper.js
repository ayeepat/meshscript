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
      const m = v.match(/"(?:student_id|studentId|profile_id|profileId|contingent_guid)"\s*:\s*"?(\d{4,})"?/);
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

/** Recursively collect file-looking URLs from an arbitrary JSON value. */
function collectFileUrls(node, out = new Set(), depth = 0) {
  if (depth > 8 || out.size >= 8) return out;
  if (typeof node === 'string') {
    let s = node;
    // Mesh often stores attachment paths relative ("/ej/attachments/…"); absolutise.
    if (s[0] === '/' && MESH_FILE_HINT_RE.test(s)) s = 'https://school.mos.ru' + s;
    if (FILE_URL_RE.test(s) || (/^https?:\/\//.test(s) && MESH_FILE_HINT_RE.test(s))) {
      // Mesh filenames contain spaces/Cyrillic; encodeURI makes the download
      // URL safe and is idempotent on already-encoded strings (% is untouched).
      out.add(encodeURI(s));
    }
  } else if (Array.isArray(node)) {
    for (const v of node) collectFileUrls(v, out, depth + 1);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) collectFileUrls(v, out, depth + 1);
  }
  return out;
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
    if (/^https?:\/\//.test(s) && looksLikeFileLink(s)) out.add(encodeURI(s));
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
    if (!res.ok) { console.log('[meshscript] cs-download http', res.status, url); return null; }
    const ct = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/xml')) {
      console.log('[meshscript] cs-download got HTML (auth redirect?)', url);
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
  } catch (e) { console.log('[meshscript] cs-download exception', String(e), url); return null; }
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
async function listMaterialUrls(lessonId) {
  const token = findAuthToken();
  const headers = meshHeaders(token);
  const log = (stage, extra) => console.log('[meshscript] auto-fetch:', stage, extra ?? '');

  // Resolve candidate URLs: first from the page DOM (reliable), then the API.
  let urls = scanPageForFileLinks();
  let stage = urls.length ? 'found_dom' : '';
  if (!urls.length) {
    if (!lessonId) { log('no_lesson_id'); return { ok: false, files: [], urls: [], token, headers, stage: 'no_lesson_id' }; }
    if (!token) { log('no_token'); return { ok: false, files: [], urls: [], token, headers, stage: 'no_token' }; }
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
      urls = [...collectFileUrls(await res.json())].slice(0, 5);
      stage = urls.length ? 'found_api' : 'no_urls';
    } catch (e) {
      log('exception', String(e));
      return { ok: false, files: [], urls: [], token, headers, stage: 'exception' };
    }
  }
  if (!urls.length) { log('no_urls'); return { ok: false, files: [], urls: [], token, headers, stage: 'no_urls' }; }

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
        listMaterialUrls(msg.homeworkId)
          .then((r) => sendResponse(r))
          .catch((e) => sendResponse({ ok: false, error: String(e), urls: [], token: null }));
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
      return false;
    }
    return false;
  });
}
