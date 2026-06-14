/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and Supabase persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI } from '../lib/ai.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { createSession, addMessage, listSessions, listMessages } from '../lib/supabase.js';
import { isBareTextbookRef } from '../lib/task-classifier.js';
import { classifyTasksAI } from '../lib/classify-ai.js';

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
 * Solve a task with the AI provider + chat history. Persist to Supabase.
 * @param {object} p
 * @param {string} [p.mode] answer mode (brief/explain) — see subject-router
 * @param {(chunk:string)=>void} [onDelta] stream callback (token-by-token)
 */
async function solve({ subject, task, files = [], sessionId = null, history = [], mode }, onDelta) {
  const category = categoryForSubject(subject);

  // Russian-full guard: bare "Упр 25" with no image -> ask for a photo
  // WITHOUT spending a (possibly paid) API call on a guess. Only on the
  // first turn — once a photo arrived earlier in the chat, follow-ups pass.
  if (category === PROMPT_CATEGORIES.RUSSIAN_FULL && history.length === 0) {
    if (isBareTextbookRef(task) && files.length === 0) {
      const ask = 'Чтобы выписать упражнение без ошибок, загрузите, пожалуйста, фото страницы учебника с этим упражнением.';
      return { answer: ask, needsUpload: true, sessionId };
    }
  }

  const systemPrompt = await buildSystemPrompt(subject, mode);
  const answer = await askAI(
    systemPrompt, task || '(см. вложение)', files,
    history.slice(-MAX_HISTORY_TURNS), { onDelta }
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

async function downloadFile(url, token) {
  try {
    const headers = {};
    if (token) { headers['Auth-Token'] = token; headers['Authorization'] = 'Bearer ' + token; }
    const res = await fetch(url, { credentials: 'include', headers });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 12 * 1024 * 1024) return null; // skip empty / >12MB
    const mimeType = (res.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream';
    return { mimeType, dataBase64: abToBase64(buf), name: nameFromUrl(url) };
  } catch { return null; }
}

async function downloadFiles({ urls = [], token = null }) {
  const files = [];
  for (const url of urls.slice(0, 5)) {
    const f = await downloadFile(url, token);
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
