/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and Supabase persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI } from '../lib/ai.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { createSession, addMessage, listSessions, listMessages } from '../lib/supabase.js';
import { isBareTextbookRef, classifyTask, needsAudio } from '../lib/task-classifier.js';
import { classifyTasksAI } from '../lib/classify-ai.js';
import { isReadableFile, hasPdf } from '../lib/file-kinds.js';

// Follow-ups re-send prior turns as context. Cap how many: full worked
// solutions are long, and on a paid provider every re-sent turn is money.
// The last few turns carry all the context that matters.
const MAX_HISTORY_TURNS = 8;

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
      msg += '\n\n🎧 Аудирование я прослушать не могу в принципе — для него пришлите ' +
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
 * Solve a task with the AI provider + chat history. Persist to Supabase.
 * @param {object} p
 * @param {string} [p.mode] answer mode (brief/explain) — see subject-router
 * @param {(chunk:string)=>void} [onDelta] stream callback (token-by-token)
 */
async function solve({ subject, task, files = [], sessionId = null, history = [], mode }, onDelta) {
  const category = categoryForSubject(subject);

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
  const answer = await askAI(
    systemPrompt, task || '(см. вложение)', files,
    history.slice(-MAX_HISTORY_TURNS), { onDelta, provider }
  );

  // Persist (non-fatal if Supabase not configured).
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
  const { promptOverrides = {} } = await chrome.storage.local.get('promptOverrides');
  const systemPrompt =
    promptOverrides[PROMPT_CATEGORIES.TEST_ANSWER] || DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];
  const userText = 'Текст страницы теста (может содержать навигационный мусор — игнорируй его):\n\n' +
    (text || '(текст не извлечён, смотри скриншот)');
  // JSON mode: the model returns {reasoning, answers:[{n,a}]} — no fragile
  // marker parsing. The popup formats/displays it.
  return askAI(systemPrompt, userText, screenshot ? [screenshot] : [], [], { responseFormat: 'json_object' });
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
  if (ct && ct !== 'application/octet-stream' && ct !== 'binary/octet-stream') return ct;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return EXT_MIME[ext] || ct || 'application/octet-stream';
}

async function downloadFile(url, headers) {
  try {
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) { console.log('[meshscript] download http', res.status, url); return null; }
    // An HTML response is an auth/login redirect, not the attachment — reject it
    // so we never hand the model (or the chat chip) a fake "file".
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html') || ct.includes('text/xml')) {
      console.log('[meshscript] download got HTML (auth redirect?)', url);
      return null;
    }
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 12 * 1024 * 1024) {
      console.log('[meshscript] download size skip', buf.byteLength, url);
      return null;
    }
    const name = nameFromUrl(url);
    const mimeType = inferMime(name, res.headers.get('content-type'));
    console.log('[meshscript] downloaded', name, mimeType, buf.byteLength + 'b');
    return { mimeType, dataBase64: abToBase64(buf), name };
  } catch (e) { console.log('[meshscript] download exception', String(e), url); return null; }
}

// `headers` come straight from the content script's discovery (Bearer token +
// Mesh's X-mes-* set). A bare `token` is still accepted for backward-compat.
async function downloadFiles({ urls = [], headers = null, token = null }) {
  const hdrs = headers || (token ? { Authorization: 'Bearer ' + token } : {});
  const files = [];
  for (const url of urls.slice(0, 5)) {
    const f = await downloadFile(url, hdrs);
    if (f) files.push(f);
  }
  return files;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
        case 'SOLVE_TEST':
          sendResponse({ ok: true, answer: await solveTest(msg.payload) });
          break;
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
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'SOLVE') return;
    try {
      const result = await solve(msg.payload, (text) => {
        try { port.postMessage({ type: 'delta', text }); } catch { /* port closed */ }
      });
      port.postMessage({ type: 'done', result });
    } catch (e) {
      port.postMessage({ type: 'error', error: String(e?.message || e) });
    }
  });
});
