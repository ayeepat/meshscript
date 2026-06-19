/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and local solve-history persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI } from '../lib/ai.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { createSession, addMessage, listSessions, listMessages } from '../lib/history.js';
import { ensureLicensed } from '../lib/license.js';
import { isBareTextbookRef, classifyTask, needsAudio } from '../lib/task-classifier.js';
import { classifyTasksAI } from '../lib/classify-ai.js';
import { isReadableFile, hasPdf } from '../lib/file-kinds.js';
import { getCatalog, searchBooks, resolveTask, resolveForTask, fetchTaskImage } from '../lib/gdz-api.js';
import { mapSubjectToId } from '../lib/gdz-match.js';
import { prepareFiles } from '../lib/extract.js';

// Follow-ups re-send prior context. Cap how many MESSAGES we replay: full
// worked solutions are long, and on a paid provider every re-sent message is
// money. 8 messages ≈ 4 back-and-forth turns — enough recent context to follow
// up without re-sending the whole chat. (Bump to 16 for ~8 full turns.)
const MAX_HISTORY_MESSAGES = 8;

// chrome.storage.session defaults to extension-only access; the floating
// answer panel (content-script context) needs to remember its position and
// minimized state across page interactions. Opening the access level is reset
// on every SW restart, so we re-apply it at module top — cheap and idempotent.
try {
  chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
} catch { /* old Chrome — content script falls back to defaults each time */ }

// Open the full-window dashboard when the popup asks to "Solve".
async function openDashboard(payload) {
  const url = chrome.runtime.getURL(
    `src/dashboard/dashboard.html?subject=${encodeURIComponent(payload.subject)}` +
    `&task=${encodeURIComponent(payload.task || '')}` +
    `&day=${encodeURIComponent(payload.day || '')}`
  );
  await chrome.tabs.create({ url });
}

// NOTE: an earlier version attempted a GDZ (reshebnik) lookup before the AI
// call. GDZ sits behind Cloudflare's JS challenge, the fetch always failed,
// and its result was discarded — it only added latency to every solve. The
// AI provider is the solver.

/**
 * Decide whether we MUST refuse before calling the model, returning the
 * Russian message to show, or null to proceed. This is the structural backstop
 * for the fabrication problem: a model handed only a task reference (and no
 * actual file/page) will otherwise invent plausible-but-wrong answers and even
 * claim it "read" material it never got.
 *
 *  - audio: this tool can NEVER process sound. If the task needs listening and
 *    no readable text/file is attached (a transcript can't arrive as audio),
 *    refuse the audio outright.
 *  - attachment: task points at a file/variant/worksheet but nothing readable
 *    is attached -> ask for it (Office files like .docx don't count: unreadable).
 *  - textbook ref: bare «Упр. 25 / §3» with no page photo -> ask for the photo.
 *
 * "Readable" = image, PDF or plain text (see file-kinds). An attached .docx or
 * an empty file does not satisfy the requirement.
 */
function missingInputGate(category, task, files) {
  const hasReadable = files.some(isReadableFile);
  const cls = classifyTask(task);
  const audio = needsAudio(task);

  if (cls.kind === 'attachment' && !hasReadable) {
    let msg = 'Не могу решить это задание без самого материала. ' +
      'Пришлите файл варианта/задания (PDF, фото или скриншот страницы), и я всё решу.';
    if (audio) {
      msg += '\n\nАудирование я прослушать не могу в принципе — для него пришлите ' +
        'расшифровку (текст) записи, тогда решу и эту часть.';
    }
    return msg;
  }

  if (audio && !hasReadable) {
    return 'В этом задании нужно аудирование, а звук я прослушать не могу. ' +
      'Пришлите расшифровку (текст) записи или фото/скан заданий — тогда решу.';
  }

  if ((category === PROMPT_CATEGORIES.RUSSIAN_FULL || cls.kind === 'textbook') &&
      isBareTextbookRef(task) && !hasReadable) {
    return 'Чтобы решить это упражнение без ошибок, загрузите, пожалуйста, ' +
      'фото страницы учебника с этим заданием.';
  }

  return null;
}

/**
 * Solve a task with the AI provider + chat history. Persist to local history.
 * @param {object} p
 * @param {string} [p.mode] answer mode (brief/explain) — see subject-router
 * @param {(chunk:string)=>void} [onDelta] stream callback (token-by-token)
 */
async function solve({ subject, task, files = [], sessionId = null, history = [], mode }, onDelta, signal) {
  // License gate. No-op while LICENSE_ENFORCED is off (preorder window).
  // Throws a Russian-language error the catch path surfaces verbatim.
  await ensureLicensed();
  const category = categoryForSubject(subject);

  // Extract Office files (.docx/.pptx/.xlsx) to inline text RIGHT HERE, locally
  // and for free — no API call. This both lets the model actually solve from
  // them and lets the gate below see them as readable material.
  files = await prepareFiles(files);

  // Hard refusal gate — runs in CODE, before any model call, only on the first
  // turn (later turns may carry a clarification or a just-attached file). A soft
  // prompt guard alone doesn't reliably stop a model inventing answers to
  // material it never received, so when a required input is genuinely missing we
  // refuse deterministically instead of guessing. See missingInputGate.
  if (history.length === 0) {
    const gate = missingInputGate(category, task, files);
    if (gate) return { answer: gate, needsUpload: true, sessionId };
  }

  const systemPrompt = await buildSystemPrompt(subject, mode);
  // PDFs require a PDF-capable backend; force OpenRouter (Gemini reads PDFs
  // natively) even if the user picked Groq, which cannot read them at all.
  const provider = hasPdf(files) ? 'openrouter' : undefined;
  // If a PDF forced OpenRouter but no OpenRouter key is set, explain WHY a key
  // is suddenly needed (the user may have deliberately picked free Groq, which
  // can't read PDFs) instead of surfacing a bare "key not set" error.
  if (provider === 'openrouter') {
    const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
    if (!openrouterApiKey) {
      return {
        answer: 'В задании есть PDF, а его умеет читать только OpenRouter (модель Gemini). ' +
          'Groq не читает PDF-файлы. Добавьте ключ OpenRouter в настройках расширения — ' +
          'или пришлите это задание фотографиями страниц / текстом, и я решу через Groq.',
        sessionId
      };
    }
  }
  const answer = await askAI(
    systemPrompt, task || '(см. вложение)', files,
    history.slice(-MAX_HISTORY_MESSAGES), { onDelta, provider, signal }
  );

  // Persist to local history (non-fatal if storage write fails).
  try {
    let sid = sessionId;
    if (!sid) {
      const session = await createSession(subject, task);
      sid = session.id;
    }
    await addMessage(sid, 'user', task || '(файл)');
    await addMessage(sid, 'assistant', answer);
    return { answer, sessionId: sid };
  } catch (e) {
    return { answer, sessionId, storageError: String(e) };
  }
}

/**
 * Solve an in-app Mesh test from a screenshot + extracted page text.
 * Answers are concise («№N: ответ») and intentionally NOT persisted.
 */
async function solveTest({ text, screenshot }) {
  await ensureLicensed();
  const { promptOverrides = {} } = await chrome.storage.local.get('promptOverrides');
  const systemPrompt =
    promptOverrides[PROMPT_CATEGORIES.TEST_ANSWER] || DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];
  const userText = 'Текст страницы теста (может содержать навигационный мусор — игнорируй его):\n\n' +
    (text || '(текст не извлечён, смотри скриншот)');
  // JSON mode: the model returns {answers:[{n,a}]} — no fragile marker parsing.
  // `reasoning` turns on Gemini's NATIVE thinking channel: it reasons through
  // every question fully (privately), but the visible content stays a tiny
  // answers-only JSON. That reasoning streams on delta.reasoning, which
  // postStream drops — so the user only ever sees the answers, never the steps,
  // and the answers array can no longer be truncated by a long reasoning blob.
  return askAI(systemPrompt, userText, screenshot ? [screenshot] : [], [], {
    responseFormat: 'json_object',
    reasoning: { effort: 'high' }
  });
}

/**
 * Map the model's {answers:[{n,a}]} reply to the panel's {index, text, answer}
 * shape. Tiered like the popup's formatter so a truncated reply still surfaces
 * what arrived: whole JSON → embedded JSON → loose "n"/"a" pair regex.
 * The TEST_ANSWER prompt doesn't return per-question text, so `text` is "".
 */
function parseTestAnswers(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const make = (n, a, c) => {
    const q = {
      index: typeof n === 'number' ? n : (String(n).trim() || ''),
      text: '',
      answer: String(a ?? '').trim()
    };
    // Optional option letter/number for choice questions — a fill-only hint the
    // matcher (scraper.js) uses to break ties when option text is ambiguous.
    // Absent in the legacy {n,a} shape; panel/copy never read it.
    if (c != null && String(c).trim() !== '') q.choice = String(c).trim();
    return q;
  };
  const fromObj = (obj) => {
    if (!obj || !Array.isArray(obj.answers)) return null;
    const out = obj.answers
      .filter((x) => x && x.a != null && x.n != null)
      .map((x) => make(x.n, x.a, x.c));
    return out.length ? out : null;
  };
  try { const r = fromObj(JSON.parse(raw)); if (r) return r; } catch { /* not pure JSON */ }
  const embedded = raw.match(/\{[\s\S]*\}/);
  if (embedded) {
    try { const r = fromObj(JSON.parse(embedded[0])); if (r) return r; } catch { /* embedded failed */ }
  }
  const out = [];
  const re = /"n"\s*:\s*(?:"([^"]*)"|([^\s,}]+))\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const n = (m[1] ?? m[2] ?? '').trim();
    let a = m[3];
    try { a = JSON.parse('"' + a + '"'); } catch { /* keep raw escapes */ }
    out.push(make(n, a));
  }
  return out;
}

/**
 * Render the parsed answers as a floating panel on the test tab. The popup
 * still shows them too — the panel just outlives the popup so the user can
 * keep reading while they fill the form. Best-effort: a restricted page or
 * an in-flight navigation just means no panel; the popup is the fallback.
 */
async function showAnswersInTab(tabId, questions) {
  if (!tabId || !questions.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['src/content/answer-panel.js', 'src/content/scraper.js']
    });
  } catch { /* manifest may already have injected, or the page disallows scripting */ }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'SHOW_ANSWERS', payload: { questions } });
  } catch { /* no receiver — content script blocked on this page */ }
}

/* ---------- Attachment downloads (cross-origin, host_permissions) ---------- */
// The content script discovers the file URLs (same-origin API call), but the
// download must run HERE: only the service worker gets the extension's
// host_permissions for cross-origin hosts like uchebnik.mos.ru. There is no
// FileReader in a service worker, so base64 is encoded from an ArrayBuffer.

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // chunk so String.fromCharCode args don't overflow the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function nameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'attachment'; }
  catch { return 'attachment'; }
}

// Mesh frequently serves attachments as application/octet-stream. Downstream
// (openrouter/groq) routes PDFs and images by mime, so recover the real type
// from the filename extension whenever the server's content-type is generic.
const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', md: 'text/markdown',
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
  // A known extension is the most reliable signal for Mesh attachments: the
  // store serves a generic content-type often, and a mislabeled one sometimes
  // (e.g. text/plain or application/download for a real .pdf). Downstream
  // routing keys on the exact mime, so trust the extension whenever we know it
  // and only fall back to a specific content-type for unrecognized extensions.
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  return 'application/octet-stream';
}

async function downloadFile(url, headers) {
  try {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) { console.log('[СМЭШ AI] download http', res.status, url); return null; }
    // An HTML response is an auth/login redirect, not the attachment — reject it
    // so we never hand the model (or the chat chip) a fake "file".
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/xml')) {
      console.log('[СМЭШ AI] download got HTML (auth redirect?)', url);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 12 * 1024 * 1024) {
      console.log('[СМЭШ AI] download size skip', buf.byteLength, url);
      return null;
    }
    const name = nameFromUrl(url);
    const mimeType = inferMime(name, res.headers.get('content-type'));
    console.log('[СМЭШ AI] downloaded', name, mimeType, buf.byteLength + 'b');
    return { mimeType, dataBase64: abToBase64(buf), name };
  } catch (e) { console.log('[СМЭШ AI] download exception', String(e), url); return null; }
}

// Reconstruct Mesh's required family-web headers from a bare token. Mirrors the
// content script's meshHeaders() so the backward-compat (token-only) download
// path still carries the X-mes-* set the API and file store expect — Authorization
// alone gets bounced to the auth page on some endpoints.
function meshHeadersFromToken(token) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-mes-subsystem': 'familyweb',
    'X-Mes-Role': 'student',
    'X-Mes-RoleId': '1',
    Authorization: 'Bearer ' + token
  };
}

// The Mesh auth set (Bearer token + X-mes-*) is sensitive — it's the user's
// live session credential. It may ride along ONLY to a *.mos.ru host. A
// homework page is Mesh-controlled, but a stray non-Mesh link in its DOM (a
// teacher's comment, an embed) would otherwise have the user's Mesh token
// fetched straight to a third-party server. Gate the header set on the host.
function isMeshHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'mos.ru' || h.endsWith('.mos.ru');
  } catch { return false; }
}

// `headers` come straight from the content script's discovery (Bearer token +
// Mesh's X-mes-* set). A bare `token` is still accepted for backward-compat.
async function downloadFiles({ urls = [], headers = null, token = null }) {
  const hdrs = headers || (token ? meshHeadersFromToken(token) : {});
  const files = [];
  for (const url of urls.slice(0, 5)) {
    // Never hand the Mesh credential to a non-Mesh host (see isMeshHost).
    const f = await downloadFile(url, isMeshHost(url) ? hdrs : {});
    if (f) files.push(f);
  }
  return files;
}

/**
 * Fill the test form across EVERY frame of the tab. The Mesh test player is
 * sometimes embedded in an iframe (a different *.mos.ru origin), so a fill that
 * only touches the top frame finds no controls and skips everything. We inject
 * the fill logic into all accessible frames, run it in each, then merge: a
 * question counts as filled if ANY frame filled it. Frames the extension can't
 * script (foreign-origin embeds) are skipped silently. Never submits the form.
 */
async function fillAllFrames(tabId, questions) {
  if (!tabId || !Array.isArray(questions) || !questions.length) {
    return { filled: [], skipped: [] };
  }
  const idFor = (q, i) =>
    (q && q.index != null && String(q.index).trim() !== '') ? q.index : i + 1;

  // Make sure the fill logic (window.__smeshFill) exists in every frame.
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/scraper.js']
    });
  } catch { /* some frames disallow injection; the ones that allow it still run */ }

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (qs) => {
        try { return (typeof window.__smeshFill === 'function') ? window.__smeshFill(qs) : null; }
        catch { return null; }
      },
      args: [questions]
    });
  } catch (e) {
    return { filled: [], skipped: questions.map(idFor), error: String(e) };
  }

  const filled = new Set();
  for (const r of (results || [])) {
    const s = r && r.result;
    if (s && Array.isArray(s.filled)) s.filled.forEach((id) => filled.add(String(id)));
  }
  const filledIds = [];
  const skipped = [];
  questions.forEach((q, i) => {
    const id = idFor(q, i);
    (filled.has(String(id)) ? filledIds : skipped).push(id);
  });
  return { filled: filledIds, skipped };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'OPEN_DASHBOARD':
          await openDashboard(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'SOLVE':
          // Non-streaming fallback (popup / callers that don't open a port).
          sendResponse({ ok: true, result: await solve(msg.payload) });
          break;
        case 'SOLVE_TEST': {
          const answer = await solveTest(msg.payload);
          // Fire-and-forget: surfacing the panel must NOT delay the popup reply.
          // The popup is also where errors get rendered, so a panel failure has
          // no user-visible impact beyond "no on-page panel this time".
          const tabId = msg.payload?.tabId;
          if (tabId) {
            const questions = parseTestAnswers(answer);
            if (questions.length) showAnswersInTab(tabId, questions);
          }
          sendResponse({ ok: true, answer });
          break;
        }
        case 'FILL_ANSWERS_ALL': {
          // The in-page panel's «Заполнить» button routes here so the fill can
          // reach forms inside iframes (the panel's own frame can't). sender.tab
          // is the tab the panel lives in.
          const tabId = sender?.tab?.id;
          const questions = msg.payload?.questions || [];
          if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); break; }
          sendResponse({ ok: true, summary: await fillAllFrames(tabId, questions) });
          break;
        }
        case 'CLASSIFY_TASKS':
          sendResponse({ ok: true, kinds: await classifyTasksAI(msg.payload?.tasks || []) });
          break;
        case 'DOWNLOAD_FILES':
          sendResponse({ ok: true, files: await downloadFiles(msg.payload || {}) });
          break;
        case 'LIST_SESSIONS':
          sendResponse({ ok: true, sessions: await listSessions() });
          break;
        case 'LIST_MESSAGES':
          sendResponse({ ok: true, messages: await listMessages(msg.sessionId) });
          break;
        // ---------- GDZ ----------
        case 'GDZ_CATALOG': {
          const catalog = await getCatalog({ force: !!msg.payload?.force });
          // Return only what the picker needs in one shot; books are already trimmed.
          sendResponse({ ok: true, catalog });
          break;
        }
        case 'GDZ_SEARCH': {
          const catalog = await getCatalog();
          sendResponse({ ok: true, books: searchBooks(catalog, msg.payload || {}) });
          break;
        }
        case 'GDZ_RESOLVE': {
          // payload: { bookUrl, number }
          const { bookUrl, number } = msg.payload || {};
          if (!bookUrl || number == null) { sendResponse({ ok: false, error: 'bookUrl + number required' }); break; }
          const result = await resolveTask(bookUrl, number);
          if (!result) { sendResponse({ ok: false, error: 'not found' }); break; }
          // Inline EVERY answer image as base64 — multi-page answers have more
          // than one — so the chat can render them directly. Fetch them in
          // parallel (independent network calls) and drop any that fail, keeping
          // source order.
          const settled = await Promise.all(
            result.images.map((url) => fetchTaskImage(url).catch(() => null))
          );
          const inlined = settled.filter(Boolean);
          if (!inlined.length) { sendResponse({ ok: false, error: 'images unavailable' }); break; }
          sendResponse({ ok: true, result: { ...result, inlined } });
          break;
        }
        case 'GDZ_FOR_TASK': {
          // payload: { subject, task } — the dashboard's per-lesson lookup.
          const { subject, task } = msg.payload || {};
          const sid = mapSubjectToId(subject);
          const { gdzBooks = {} } = await chrome.storage.local.get('gdzBooks');
          // A subject may hold several books (textbook + workbook). Normalise the
          // legacy single-object shape to an array so both resolve.
          const raw = sid != null ? gdzBooks[sid] : null;
          const books = Array.isArray(raw) ? raw : (raw ? [raw] : []);
          if (!books.length) { sendResponse({ ok: true, configured: false }); break; }

          // Resolve every configured book and merge. Each answer carries its own
          // book + mode so a page-structured workbook and an exercise-structured
          // textbook are labelled correctly side by side in the same card.
          const answers = [];
          let primaryMode = null, primaryBook = null;
          for (const book of books) {
            const res = await resolveForTask(book, task || '');
            const bookMeta = { title: book.title, breadcrumb: book.breadcrumb, year: book.year, study_level: book.study_level };
            if (!primaryBook && res.answers.some((a) => a.found)) { primaryMode = res.mode; primaryBook = bookMeta; }
            for (const a of res.answers) {
              a.mode = res.mode;
              a.book = bookMeta;
              if (!a.found) continue;
              // Parallel image fetches (independent network calls), source order kept.
              const settled = await Promise.all(
                (a.images || []).map((u) => fetchTaskImage(u).catch(() => null))
              );
              a.inlined = settled.filter(Boolean);
            }
            answers.push(...res.answers);
          }
          const fallback = { title: books[0].title, breadcrumb: books[0].breadcrumb, year: books[0].year, study_level: books[0].study_level };
          sendResponse({
            ok: true, configured: true,
            mode: primaryMode || 'exercise',
            book: primaryBook || fallback,
            answers
          });
          break;
        }
        case 'GDZ_SELFTEST': {
          // End-to-end smoke test from the popup/devtools: search → resolve →
          // image. If this returns ok:true, the DNR UA rule is firing and the
          // whole chain works from inside the extension.
          const catalog = await getCatalog();
          const hits = searchBooks(catalog, { grade: 9, subjectId: 4, query: 'макарычев углубл' });
          if (!hits.length) { sendResponse({ ok: false, error: 'catalog: book not found' }); break; }
          const r = await resolveTask(hits[0].url, '25');
          if (!r) { sendResponse({ ok: false, error: 'resolve: task not found' }); break; }
          const img = await fetchTaskImage(r.images[0]);
          sendResponse({
            ok: true,
            book: hits[0].title,
            taskLink: r.link,
            imageBytes: Math.round((img.dataBase64.length * 3) / 4),
            mimeType: img.mimeType
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});

// Streaming solve over a long-lived port. The dashboard connects with
// name 'solve', sends one { type:'SOLVE', payload }, and receives a series of
// { type:'delta', text } messages followed by { type:'done', result } or
// { type:'error', error }. An open port also keeps the service worker alive
// for the duration of the (possibly long) streamed answer.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'solve') return;
  // Abort the in-flight provider call if the dashboard tab is closed/reloaded
  // mid-stream. Without this the upstream fetch keeps streaming (and getting
  // charged) until the 60-s idle timeout, even though no UI is listening.
  let activeCtrl = null;
  port.onDisconnect.addListener(() => {
    try { activeCtrl?.abort(); } catch { /* already aborted */ }
    activeCtrl = null;
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'SOLVE') return;
    const ctrl = new AbortController();
    activeCtrl = ctrl;
    const safePost = (m) => { try { port.postMessage(m); } catch { /* port closed */ } };
    try {
      const result = await solve(msg.payload, (text) => safePost({ type: 'delta', text }), ctrl.signal);
      safePost({ type: 'done', result });
    } catch (e) {
      // Caller-initiated abort: the port is already gone, no point posting.
      if (e?.name !== 'AbortError' && !ctrl.signal.aborted) {
        safePost({ type: 'error', error: String(e?.message || e) });
      }
    } finally {
      if (activeCtrl === ctrl) activeCtrl = null;
    }
  });
});
