/**
 * Full-window dashboard: week-of-homework sidebar + chat solve view.
 * Each sidebar lesson keeps its own chat in this tab. The AI is only called
 * when a lesson is opened for the first time (or you send a follow-up).
 * Chat history (7-day TTL) lives in Settings, not here.
 */
import { initTheme, toggleTheme } from '../common/theme.js';
import { mdToHtml } from '../common/markdown.js';
import { filesLabel } from '../common/plural.js';
import { iconSvg } from '../common/icons.js';
import { startThinking } from '../common/thinking.js';
import { PROVIDER_ABBR, PROVIDER_NAME } from '../common/provider-badge.js';
import { isPdfFile } from '../lib/file-kinds.js';
import { isGdzApiUrl, isGdzHumanUrl } from '../lib/gdz-hosts.js';
import {
  assertUploadAllowed,
  deduplicateRequestFiles,
  MAX_AUDIO_UPLOAD_BYTES,
  validateRequestFileBudget
} from '../lib/upload-limits.js';
import { awaitStablePendingRead } from '../lib/pending-read.js';
import { principalBindingMatches } from '../lib/principal-binding.js';

// Tiny "which AI model will answer" tag next to the theme switch. In the
// dashboard the Авто/Думать toggle — not the Settings provider — decides the
// model (see the SOLVE payload's `engine`), so the badge is painted from the
// engine instead of mountProviderBadge's aiProvider setting.
const ENGINE_PROVIDER = { auto: 'deepseek', think: 'qwen' };
function paintEngineBadge(engine) {
  const el = document.getElementById('provBadge');
  const p = ENGINE_PROVIDER[engine];
  el.textContent = PROVIDER_ABBR[p];
  el.title = `Сейчас отвечает: ${PROVIDER_NAME[p]}`;
  el.hidden = false;
}

// Keep the theme button icon in sync with the resolved theme.
document.addEventListener('themechange', (e) => {
  document.getElementById('themeBtn').innerHTML = iconSvg(e.detail === 'dark' ? 'sun' : 'moon', 16);
});
initTheme();

const params = new URLSearchParams(location.search);
const launchPayload = await (async () => {
  const launch = params.get('launch');
  if (!launch) return {};
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CONSUME_DASH_LAUNCH',
      payload: { id: launch }
    });
    return response?.ok && response.payload ? response.payload : {};
  } catch { return {}; }
})();
const initialSubject = launchPayload.subject || '';
const initialTask = launchPayload.task || '';
const initialDay = launchPayload.day || '';
const initialHomeworkId = launchPayload.homeworkId || '';
const initialHomeworkItemId = launchPayload.homeworkItemId || '';
const initialRowToken = launchPayload.rowToken || '';
const initialScanId = launchPayload.scanId || '';
let initialFiles = Array.isArray(launchPayload.files) ? launchPayload.files : [];

const chatEl = document.getElementById('chat');
const titleEl = document.getElementById('title');
const weekEl = document.getElementById('week');
const AI_NOTICE_URL = 'https://smeshai.xyz/ai';

// key -> { key, day, subject, task, homeworkId, homeworkItemId, rowToken,
//          sessionId, history, started, pending, pendingOwner, thinkingOwner }
const chats = new Map();
let activeKey = null;
let answerMode = 'brief'; // 'brief' (concise, keeps steps) | 'explain' (tutor)
let solveEngine = 'auto'; // 'auto' (DeepSeek, fast) | 'think' (Qwen, reasons longer)
let weekDataError = '';
// Must match service-worker.js MAX_HISTORY_MESSAGES. The dashboard retains the
// full conversation for local rendering, but only this completed tail is ever
// budgeted or serialized to the privileged SOLVE boundary.
const MAX_REPLAY_MESSAGES = 8;

function taskPrefix(task, len = 40) {
  return (task || '').replace(/\s+/g, ' ').trim().slice(0, len);
}

// Task plus Mesh row ids are part of the key: one subject/lesson can have
// several homework rows in a day, and their first 40 chars can be similar.
const keyFor = (day, subject, task, homeworkId = '', homeworkItemId = '', rowToken = '') => {
  const row = rowToken || homeworkItemId || `${homeworkId || 'noid'}:${taskPrefix(task, 80)}`;
  return `${day || '?'}||${subject}||${row}`;
};
const activeChat = () => chats.get(activeKey);

function replayableHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => !message?.needsUpload && message?.error !== true)
    .slice(-MAX_REPLAY_MESSAGES);
}

function sameMeshRow(upload, chat) {
  // A launch payload must never lend its files to another lesson/child. A
  // scan capability plus its row token are the accepted identity; subject/task
  // similarity is display data, not ownership evidence.
  return !!upload?.scanId && upload.scanId === chat.scanId &&
    !!upload.rowToken && !!chat.rowToken && upload.rowToken === chat.rowToken;
}

/* ---------- Typewriter: starts slow, accelerates, finishes fast ---------- */

// Re-parsing the full markdown every frame is O(n²); for long answers that
// janks badly and the reveal drags on. Above this length we render once.
const TYPEWRITER_MAX = 1500;

function typewriter(el, fullText) {
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (reduceMotion || fullText.length > TYPEWRITER_MAX) { el.innerHTML = mdToHtml(fullText); return; }
  let i = 0;
  let chunk = 1; // chars per frame; grows each frame -> accelerating reveal
  function step() {
    if (!el.isConnected) return; // user switched lessons mid-animation
    i += Math.round(chunk);
    chunk = Math.min(chunk * 1.08 + 0.3, 60);
    el.innerHTML = mdToHtml(fullText.slice(0, i));
    chatEl.scrollTop = chatEl.scrollHeight;
    if (i < fullText.length) requestAnimationFrame(step);
    else el.innerHTML = mdToHtml(fullText); // final clean render
  }
  requestAnimationFrame(step);
}

/* ---------- Chat UI ---------- */

/**
 * Blinking caret after the last character of a streaming answer. Inserted
 * after the last non-empty TEXT node rather than styled onto the last block
 * (a ::after on :last-child drops to its own line under lists), so it hugs
 * the tail wherever mdToHtml put it. The next innerHTML replacement discards
 * it, so every render re-appends; the final render simply doesn't.
 */
function appendStreamCaret(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent.trim()) last = n;
  }
  const caret = document.createElement('span');
  caret.className = 'type-caret';
  if (last?.parentNode) last.parentNode.insertBefore(caret, last.nextSibling);
  else root.appendChild(caret);
}

function retryButton(onClick) {
  const b = document.createElement('button');
  b.className = 'retrybtn';
  b.title = 'Повторить попытку';
  b.innerHTML = iconSvg('refresh', 13);
  b.onclick = onClick;
  return b;
}

function copyButton(getText) {
  const b = document.createElement('button');
  b.className = 'copybtn';
  b.title = 'Скопировать ответ';
  b.innerHTML = iconSvg('copy', 13);
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(getText());
      b.innerHTML = iconSvg('check', 13);
      setTimeout(() => (b.innerHTML = iconSvg('copy', 13)), 1200);
    } catch (_e) { /* clipboard blocked — ignore */ }
  };
  return b;
}

function aiNoticeEl() {
  const note = document.createElement('div');
  note.className = 'ai-notice';
  note.innerHTML =
    `${iconSvg('info', 13)}` +
    '<span>Это ИИ: ответы могут быть неточными. Проверяйте источники.</span>' +
    `<a href="${AI_NOTICE_URL}" target="_blank" rel="noopener noreferrer">Подробнее</a>`;
  return note;
}

/** Chip shown on a user message when files were attached: green check + icon. */
function attachChip(files) {
  const chip = document.createElement('div');
  chip.className = 'attachchip';
  const icon = (files.length === 1 && (files[0].mimeType || '').startsWith('image/')) ? 'image' : 'file';
  const label = files.length === 1
    ? (files[0].name || 'файл')
    : filesLabel(files.length);
  chip.innerHTML =
    `<span class="ac-check">${iconSvg('check', 13)}</span>` +
    `<span class="ac-ico">${iconSvg(icon, 13)}</span>` +
    `<span class="ac-name"></span>`;
  chip.querySelector('.ac-name').textContent = label;
  return chip;
}

function bubble(role, text, { animate = false, files = null, needsUpload = false, onRetry = null } = {}) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  if (role === 'assistant') {
    // Gate refusals (no readable file) read as a clear "attach a file" prompt.
    if (needsUpload) {
      d.classList.add('needupload');
      const head = document.createElement('div');
      head.className = 'nu-head';
      head.innerHTML = `${iconSvg('upload', 14)}<span>Нужен файл</span>`;
      d.appendChild(head);
    }
    const body = document.createElement('div');
    body.className = 'mdbody';
    if (animate) typewriter(body, text);
    else body.innerHTML = mdToHtml(text);
    d.appendChild(body);
    d.appendChild(aiNoticeEl());
    d.appendChild(copyButton(() => text));
    // onRetry is only ever passed for the CURRENT last error in the chat (see
    // renderChat / runSolveAttempt's finish) — an old, superseded error buried
    // earlier in history renders without one.
    if (onRetry) { d.classList.add('errored'); d.appendChild(retryButton(onRetry)); }
  } else {
    const span = document.createElement('div');
    span.className = 'usertext';
    span.textContent = text; // user text stays plain
    d.appendChild(span);
    if (files?.length) d.appendChild(attachChip(files));
  }
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}

/** Empty assistant bubble whose body is filled live as tokens stream in. */
function assistantShell() {
  const d = document.createElement('div');
  d.className = 'msg assistant';
  const body = document.createElement('div');
  body.className = 'mdbody';
  d.appendChild(body);
  d.appendChild(aiNoticeEl());
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { wrap: d, body };
}

/**
 * Transient status bubble shown while the answer is being generated. The verb
 * shifts and an elapsed-seconds counter ticks (see common/thinking.js), so a
 * long solve never looks frozen — same feedback as the test tab.
 */
function thinkingBubble(opts) {
  const d = document.createElement('div');
  d.className = 'msg assistant thinking';
  chatEl.appendChild(d); // append BEFORE animating so the ticker sees it connected
  d.__ticker = startThinking(d, opts);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}

/**
 * Brief heads-up toast, e.g. warning that a PDF may take longer to solve.
 * Reuses one element so repeated calls just reset the auto-hide timer.
 */
let toastEl = null;
let toastTimer = null;
function showToast(text) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 7000);
}

// Stop a chat's thinking ticker and remove its bubble. Always pair the two so a
// removed bubble never leaks its interval.
function stopThinking(chat, owner = null) {
  if (owner != null && chat.thinkingOwner !== owner) return;
  if (chat.thinkingEl) {
    chat.thinkingEl.__ticker?.stop();
    chat.thinkingEl.remove();
    chat.thinkingEl = null;
  }
  chat.thinkingOwner = null;
}

function beginChatOperation(chat, owner) {
  if (!chat || !owner || (chat.pendingOwner && chat.pendingOwner !== owner)) return false;
  chat.pendingOwner = owner;
  chat.pending = true;
  return true;
}

function ownsChatOperation(chat, owner) {
  return !!chat && !!owner && chat.pendingOwner === owner;
}

function releaseChatOperation(chat, owner) {
  if (!ownsChatOperation(chat, owner)) return false;
  chat.pendingOwner = null;
  chat.pending = false;
  return true;
}

/** Re-render the whole chat from a lesson's stored history (no animation). */
function renderChat(chat) {
  // A pending chat can have an older ticker whose element was detached by a
  // lesson switch. Stop it before rebuilding so assigning the replacement does
  // not orphan an interval behind an unreachable element.
  if (chat?.thinkingEl) stopThinking(chat);
  chatEl.innerHTML = '';
  if (!chat) {
    chatEl.innerHTML = '<p class="hintmsg">Выберите урок слева, чтобы получить решение.</p>';
    return;
  }
  const card = gdzCardEl(chat); // GDZ answers sit above the chat
  if (card) chatEl.appendChild(card);
  chat.history.forEach((m, i) => {
    // Retry is only offered on the trailing error — the one that actually
    // failed and can be resent. `m.error` is set by finish() at the point of
    // failure (never sniffed from the answer text, so a real answer that opens
    // with «Ошибка:» isn't mistaken for one). A user turn must precede it (it
    // always does; see runSolveAttempt) so retryLastTurn has something to resend.
    const isLastError = i === chat.history.length - 1 && m.role === 'assistant' &&
      m.error === true && chat.history[i - 1]?.role === 'user';
    bubble(m.role, m.content, {
      files: m.files, needsUpload: m.needsUpload,
      onRetry: isLastError ? () => retryLastTurn(chat) : null
    });
  });
  if (chat.pending) {
    chat.thinkingEl = thinkingBubble();
    chat.thinkingOwner = chat.pendingOwner || null;
  }
}

/* ---------- Image lightbox (click a GDZ answer to enlarge) ---------- */

// One overlay reused for every image. Built lazily so the dashboard pays for it
// only if the user actually opens an answer scan.
let lightboxEl = null;
let lastFocused = null;

function ensureLightbox() {
  if (lightboxEl) return lightboxEl;
  const ov = document.createElement('div');
  ov.className = 'lightbox';
  ov.hidden = true;
  ov.innerHTML =
    `<button class="lb-close" type="button" title="Закрыть (Esc)" aria-label="Закрыть">${iconSvg('close', 22)}</button>` +
    `<div class="lb-stage"><img class="lb-img" alt="" /></div>`;
  ov.querySelector('.lb-close').addEventListener('click', closeLightbox);
  // Click on the dark backdrop (anywhere but the image itself) closes.
  ov.addEventListener('click', (e) => { if (e.target !== ov.querySelector('.lb-img')) closeLightbox(); });
  // Click the image to toggle fit-to-screen ↔ actual size (pan by scrolling).
  const img = ov.querySelector('.lb-img');
  img.addEventListener('click', (e) => { e.stopPropagation(); img.classList.toggle('zoomed'); });
  document.body.appendChild(ov);
  lightboxEl = ov;
  return ov;
}

function openLightbox(src, alt) {
  const ov = ensureLightbox();
  const img = ov.querySelector('.lb-img');
  img.classList.remove('zoomed');
  img.src = src;
  img.alt = alt || '';
  ov.hidden = false;
  document.body.classList.add('lb-open');
  lastFocused = document.activeElement;
  ov.querySelector('.lb-close').focus();
}

function closeLightbox() {
  if (!lightboxEl || lightboxEl.hidden) return;
  lightboxEl.hidden = true;
  // Drop the (possibly multi-MB) data URL so it isn't pinned in memory.
  lightboxEl.querySelector('.lb-img').src = '';
  document.body.classList.remove('lb-open');
  if (lastFocused?.isConnected) lastFocused.focus();
  lastFocused = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && lightboxEl && !lightboxEl.hidden) { e.preventDefault(); closeLightbox(); }
});

/* ---------- GDZ answers (ready textbook solutions, no AI) ---------- */

/** Build the GDZ answer card from a lesson's resolved data, or null. */
function gdzCardEl(chat) {
  const g = chat.gdz;
  const found = (g?.answers || []).filter((a) => a.found && a.inlined?.length);
  if (!found.length) return null;

  const card = document.createElement('div');
  card.className = 'gdzcard';
  card.dataset.key = chat.key;

  const head = document.createElement('div');
  head.className = 'gh';
  head.innerHTML = `${iconSvg('book', 14)}<span>Готовые ответы · ГДЗ</span>`;
  card.appendChild(head);

  const bookLabel = (bk) => [bk?.breadcrumb || bk?.title, bk?.year].filter(Boolean).join(' · ');
  // When every answer comes from one book, show the source once in the header.
  // With a textbook + workbook mixed, label each answer with its own source.
  const sources = new Set(found.map((a) => bookLabel(a.book || g.book)).filter(Boolean));
  const singleSource = sources.size <= 1;
  if (singleSource) {
    const prov = bookLabel(g.book) || [...sources][0];
    if (prov) {
      const sub = document.createElement('div');
      sub.className = 'gsub';
      sub.textContent = prov;
      card.appendChild(sub);
    }
  }

  for (const a of found) {
    const block = document.createElement('div');
    block.className = 'gdzanswer';
    const label = document.createElement('div');
    label.className = 'gnum';
    const mode = a.mode || g.mode;
    label.textContent = mode === 'page' ? `Страница ${a.num}` : `№ ${a.num}`;
    if (!singleSource) {
      const src = bookLabel(a.book);
      if (src) {
        const s = document.createElement('span');
        s.className = 'gsrc';
        s.textContent = src;
        label.appendChild(s);
      }
    }
    block.appendChild(label);
    for (const img of a.inlined) {
      const im = document.createElement('img');
      im.src = `data:${img.mimeType};base64,${img.dataBase64}`;
      const alt = mode === 'page' ? `ГДЗ — страница ${a.num}` : `ГДЗ № ${a.num}`;
      im.alt = alt;
      im.loading = 'lazy';
      // Answer scans are small in the card but full of fine print — make them
      // openable in a fullscreen lightbox to actually read them.
      im.tabIndex = 0;
      im.setAttribute('role', 'button');
      im.title = 'Нажмите, чтобы увеличить';
      im.addEventListener('click', () => openLightbox(im.src, alt));
      im.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(im.src, alt); }
      });
      block.appendChild(im);
    }
    // Defense in depth: the background resolver already builds the GDZ link,
    // but chat history / storage are mutable. Never render an arbitrary href
    // from stored answer data into a prominent "Открыть на ГДЗ" action.
    if (a.link && (isGdzHumanUrl(a.link) || isGdzApiUrl(a.link))) {
      const link = document.createElement('a');
      link.href = a.link;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = 'Открыть на ГДЗ →';
      block.appendChild(link);
    }
    card.appendChild(block);
  }
  return card;
}

/** Resolve textbook references for this lesson and show the answer card BEFORE
 *  the AI solve — when ready GDZ answers exist they replace the AI call, so the
 *  lookup intentionally gates the solve. The card is prepended above the chat. */
/** @returns {Promise<boolean>} whether ready GDZ answers were found. */

// Hard ceiling on the GDZ lookup. The resolve hits gdz-ru.com (book structure +
// answer images) and the MV3 service worker can be recycled mid-request — either
// could otherwise leave the lesson awaiting a reply that never comes, stranding
// the user on a blank chat. On timeout we give up on GDZ and fall through to the
// AI solve. Generous enough that a normal resolve (now parallelised) finishes
// well within it, so we don't trigger a wasted AI call on the happy path.
const GDZ_LOOKUP_TIMEOUT_MS = 25000;

async function maybeShowGdz(chat) {
  let resp;
  try {
    resp = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), GDZ_LOOKUP_TIMEOUT_MS);
      chrome.runtime.sendMessage(
        { type: 'GDZ_FOR_TASK', payload: { subject: chat.subject, task: chat.task } },
        (r) => { clearTimeout(timer); finish(chrome.runtime.lastError ? null : r); }
      );
    });
  } catch { return false; }
  if (!resp?.ok || !resp.configured) return false;
  const found = (resp.answers || []).filter((a) => a.found && a.inlined?.length);
  if (!found.length) return false;

  chat.gdz = { book: resp.book, mode: resp.mode, answers: resp.answers };
  if (activeKey === chat.key && !chatEl.querySelector(`.gdzcard[data-key="${CSS.escape(chat.key)}"]`)) {
    chatEl.insertBefore(gdzCardEl(chat), chatEl.firstChild);
  }
  return true;
}

function fileToInline(file) {
  assertUploadAllowed(file);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mimeType: file.type || 'application/octet-stream', dataBase64: String(r.result).split(',')[1], name: file.name });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * Run one solve attempt over a streaming port: `task`/`files` are what to
 * solve, `history` is the prior-turn candidate set; this function filters and
 * caps it before any file budgeting or serialization. Tokens are revealed
 * live; the answer is appended to the lesson's
 * history even if the user switched lessons meanwhile — the DOM is only
 * touched when the lesson is the active one. Shared by the first send
 * (sendToChat) and a retry of a failed turn (retryLastTurn) — retry passes
 * the SAME task/files/history so the model sees an identical request, it just
 * runs again over a fresh port.
 */
function runSolveAttempt(chat, task, files, history, owner = Symbol('solve')) {
  // The first-open GDZ lookup may hand its existing ownership into the actual
  // solve. Any unrelated operation is rejected before it can mutate history or
  // share the chat's pending/session state.
  if (!beginChatOperation(chat, owner)) return Promise.resolve(false);
  history = replayableHistory(history);
  const deduped = deduplicateRequestFiles(files, history);
  files = deduped.files;
  history = deduped.history;
  const budget = validateRequestFileBudget(deduped.allFiles);
  if (!budget.ok) {
    chat.history.push({ role: 'assistant', content: budget.error, error: false });
    if (activeKey === chat.key) bubble('assistant', budget.error);
    releaseChatOperation(chat, owner);
    stopThinking(chat, owner);
    renderSidebar();
    return Promise.resolve(false);
  }
  if (activeKey === chat.key) {
    // Reuse of the startup owner intentionally replaces «Ищу готовые ответы»
    // with the normal solve ticker; it cannot touch another operation's ticker.
    stopThinking(chat, owner);
    chat.thinkingEl = thinkingBubble();
    chat.thinkingOwner = owner;
  }
  // PDFs are the slowest attachments to solve — a quick, kind heads-up so the
  // wait doesn't read as a stuck/broken UI.
  const replayHasPdf = history.some((m) => m?.files?.some(isPdfFile));
  if (activeKey === chat.key && ((files || []).some(isPdfFile) || replayHasPdf)) {
    showToast('Извините, PDF иногда решается дольше обычного — не закрывайте вкладку, я продолжаю решать в фоне.');
  }
  renderSidebar();

  let port;
  try {
    port = chrome.runtime.connect({ name: 'solve' });
  } catch (error) {
    const message = `Ошибка: ${error?.message || 'не удалось открыть соединение'}`;
    releaseChatOperation(chat, owner);
    stopThinking(chat, owner);
    chat.history.push({ role: 'assistant', content: message, error: true });
    if (activeKey === chat.key) bubble('assistant', message, {
      onRetry: () => retryLastTurn(chat),
    });
    renderSidebar();
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let acc = '';        // accumulated streamed text
    let shell = null;    // live assistant bubble, created on first delta
    let settled = false;

    // (Re)create the live bubble. Switching lessons wipes the chat DOM via
    // renderChat, detaching our shell — so rebuild it (with text so far) if the
    // user comes back mid-stream.
    const ensureShell = () => {
      if (activeKey !== chat.key) return;
      if (shell && shell.wrap.isConnected) return;
      stopThinking(chat, owner);
      shell = assistantShell();
      shell.body.innerHTML = mdToHtml(acc);
    };

    // The polling transport hands us text in ~0.6 s bursts, so rendering `acc`
    // as it arrives makes the answer blurt out a paragraph at a time. Instead,
    // reveal it at a smooth character rate: `shown` chases `acc.length` from a
    // rAF loop, at a speed proportional to the backlog (drains in ~1 s, so it
    // never falls behind the stream) with a floor that keeps short answers
    // lively. Re-parsing the full markdown per frame is O(n²) and janks on
    // long answers, so the DOM re-parses at most once per RENDER_THROTTLE_MS —
    // smoothness comes from small per-render increments, not per-frame parses.
    // `finish()` does the final clean render, so none of this affects the
    // result the user ends on.
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const RENDER_THROTTLE_MS = 50;
    const REVEAL_MIN_RATE = 90;    // chars/sec floor
    const REVEAL_CATCHUP_SEC = 1.1; // drain any backlog in about this long
    let shown = 0;                 // chars of `acc` currently revealed
    let revealRaf = 0;
    let lastStep = 0;
    let lastRender = 0;
    let finishPaint = null;        // set by finish(): reveal glides to the end, then this paints the clean final render
    const renderSlice = () => {
      lastRender = performance.now();
      ensureShell();
      if (!shell) return;
      shell.body.innerHTML = mdToHtml(acc.slice(0, shown));
      appendStreamCaret(shell.body);
      chatEl.scrollTop = chatEl.scrollHeight;
    };
    const revealStep = (now) => {
      revealRaf = 0;
      if (settled && !finishPaint) return;
      if (activeKey !== chat.key) {
        // Not visible: skip ahead. Mid-stream, ensureShell repaints on return;
        // post-finish, renderChat paints the answer from history — drop the
        // pending final paint so it can't append a duplicate bubble.
        shown = acc.length;
        lastStep = 0;
        finishPaint = null;
        return;
      }
      if (!lastStep) lastStep = now;
      const dt = Math.min((now - lastStep) / 1000, 0.1);
      lastStep = now;
      const backlog = acc.length - shown;
      const rate = Math.max(REVEAL_MIN_RATE, backlog / REVEAL_CATCHUP_SEC);
      shown = Math.min(acc.length, shown + Math.max(1, Math.round(rate * dt)));
      if (now - lastRender >= RENDER_THROTTLE_MS) renderSlice();
      if (shown < acc.length) revealRaf = requestAnimationFrame(revealStep);
      else {
        lastStep = 0;
        if (finishPaint) { const paint = finishPaint; finishPaint = null; paint(); }
        else renderSlice(); // caught up — paint the tail now, resume on next delta
      }
    };
    const scheduleReveal = () => {
      if (settled && !finishPaint) return;
      if (reduceMotion) { shown = acc.length; if (activeKey === chat.key) renderSlice(); return; }
      if (!revealRaf) revealRaf = requestAnimationFrame(revealStep);
    };

    const finish = (answer, { animate = false, needsUpload = false, isError = false } = {}) => {
      if (settled) return;
      settled = true;
      const ownedAtFinish = releaseChatOperation(chat, owner);
      // An operation that no longer owns this chat is obsolete. Its answer may
      // belong to an earlier startup/send and must not enter replay history or
      // repaint over the current operation.
      if (!ownedAtFinish) {
        stopThinking(chat, owner);
        try { port.disconnect(); } catch { /* already gone */ }
        resolve(false);
        return;
      }
      const onRetry = isError ? () => retryLastTurn(chat) : null;
      chat.history.push({ role: 'assistant', content: answer, needsUpload, error: isError });
      stopThinking(chat, owner);
      if (activeKey === chat.key) {
        const paintFinal = () => {
          if (shell && shell.wrap.isConnected) {
            shell.body.innerHTML = mdToHtml(answer); // clean final render (drops the caret)
            shell.wrap.appendChild(copyButton(() => answer));
            if (onRetry) { shell.wrap.classList.add('errored'); shell.wrap.appendChild(retryButton(onRetry)); }
          } else {
            bubble('assistant', answer, { animate, needsUpload, onRetry });
          }
        };
        // Don't snap the unrevealed tail in at once — that's the same blurt
        // the reveal exists to avoid. When the authoritative answer extends
        // what's on screen, glide the reveal to its end first; revealStep
        // calls paintFinal when it catches up.
        if (!isError && !reduceMotion && shell && shell.wrap.isConnected &&
            shown < answer.length && answer.startsWith(acc.slice(0, shown))) {
          acc = answer;
          finishPaint = paintFinal;
          scheduleReveal();
        } else {
          paintFinal();
        }
      }
      renderSidebar();
      try { port.disconnect(); } catch { /* already gone */ }
      resolve(true);
    };

    port.onMessage.addListener((m) => {
      if (m?.type === 'delta') {
        acc += m.text;
        scheduleReveal();
      } else if (m?.type === 'done') {
        if (ownsChatOperation(chat, owner)) {
          chat.sessionId = m.result?.sessionId || chat.sessionId;
        }
        // Prefer the authoritative full text; fall back to what we streamed.
        // animate only when nothing streamed (e.g. the photo-request guard).
        finish(m.result?.answer ?? acc, { animate: !acc, needsUpload: !!m.result?.needsUpload });
      } else if (m?.type === 'error') {
        finish('Ошибка: ' + m.error, { isError: true });
      }
    });

    // The service worker can be torn down; every disconnect before a done/error
    // message is abnormal. Preserve any streamed text for the student, but mark
    // the turn errored so retry is offered and the truncated answer is never
    // replayed as trustworthy follow-up context. finish() disconnects normally
    // only after setting `settled`, so that expected callback is a guarded no-op.
    port.onDisconnect.addListener(() => finish(
      acc
        ? acc + '\n\n_Ответ оборван — соединение прервано. Нажмите «Повторить», чтобы решить заново._'
        : 'Ошибка: соединение прервано.',
      { isError: true }));

    try {
      port.postMessage({
        type: 'SOLVE',
        payload: { subject: chat.subject, task, files, sessionId: chat.sessionId, history, mode: answerMode, engine: solveEngine }
      });
    } catch (error) {
      finish(`Ошибка: ${error?.message || 'не удалось отправить запрос'}`, { isError: true });
    }
  });
}

/**
 * Send a new message within a lesson's chat: records the user turn, shows its
 * bubble, then runs the attempt. See runSolveAttempt for the streaming part.
 */
function sendToChat(chat, text, files, owner = Symbol('solve')) {
  // Reserve the chat before recording the user turn. That makes startup and
  // composer sends mutually exclusive even when the GDZ lookup is awaiting.
  if (!beginChatOperation(chat, owner)) return Promise.resolve(false);
  // Context BEFORE this message. Drop gate refusals (the "пришлите фото / нужен
  // файл" prompts): they're UI nudges, not real conversation, and replaying
  // them as assistant turns biases the next answer's tone.
  const prior = replayableHistory(chat.history);
  // Keep the FULL files (incl. base64) on the user turn. The chip only reads
  // name/mime, but the service worker replays history attachments to the model
  // so a follow-up question still "sees" the photo/PDF from an earlier turn.
  // replayableHistory bounds that context before the worker boundary as well.
  const turnFiles = files || [];
  chat.history.push({ role: 'user', content: text, files: turnFiles });
  if (activeKey === chat.key) bubble('user', text, { files: turnFiles });
  return runSolveAttempt(chat, text, turnFiles, prior, owner);
}

/**
 * Retry the last turn after a failed solve (network drop, upstream hiccup —
 * see the "Повторить попытку" button on an error bubble). Drops the failed
 * assistant entry and re-runs the SAME user turn (same task text, same
 * files, same prior history) rather than re-sending a duplicate user message.
 * No-ops if the chat isn't actually sitting on a fresh, retryable error —
 * e.g. a stale click after a later turn already succeeded.
 */
function retryLastTurn(chat) {
  if (chat.pending) return;
  const h = chat.history;
  const last = h[h.length - 1];
  if (!last || last.role !== 'assistant' || last.error !== true) return;
  const prevUser = h[h.length - 2];
  if (!prevUser || prevUser.role !== 'user') return;
  h.pop(); // drop the failed assistant turn; prevUser is now the tail
  const priorHistory = replayableHistory(h.slice(0, h.length - 1));
  if (activeKey === chat.key) renderChat(chat);
  runSolveAttempt(chat, prevUser.content, prevUser.files || [], priorHistory);
}

/**
 * First open of a lesson: send the task as-is. The subject prompt from
 * Settings is applied as the SYSTEM prompt by the service worker — sending
 * it here too would duplicate it and break the bare-"Упр. N" photo guard.
 * If the popup attached a file for this lesson, include it.
 */
async function startLesson(chat) {
  chat.started = true;
  const owner = Symbol('startup');
  if (!beginChatOperation(chat, owner)) {
    chat.started = false;
    return false;
  }
  // The files were consumed together with this dashboard's one-time launch.
  // Keep the row-token check as a defense-in-depth ownership boundary.
  const files = sameMeshRow(launchPayload, chat) ? initialFiles : [];
  if (files.length) initialFiles = [];

  // Ready GDZ answers are free (no API), shown as a card above the chat. The
  // lookup hits gdz-ru.com and can take a few seconds, so show a transient
  // status instead of a blank chat while it resolves. If we have them and the
  // user didn't attach a file to solve, that's the whole answer: show ONLY the
  // card — no auto AI turn, so no task echo and no "Нужен файл" nudge. The user
  // can still ask follow-ups in the composer.
  if (activeKey === chat.key) {
    stopThinking(chat);
    chat.thinkingEl = thinkingBubble({ words: ['Ищу готовые ответы'] });
    chat.thinkingOwner = owner;
  }
  renderSidebar();
  try {
    const hasGdz = await maybeShowGdz(chat);
    if (!ownsChatOperation(chat, owner)) return false;
    stopThinking(chat, owner);
    if (hasGdz && !files.length) {
      // Ready GDZ answers replaced the AI turn, so no solve runs to repaint the
      // sidebar — mark this lesson done now (chat.started is already true) instead
      // of leaving it blank until the user opens another lesson.
      releaseChatOperation(chat, owner);
      renderSidebar();
      return true;
    }

    return await sendToChat(chat, chat.task, files, owner);
  } finally {
    // Normally the solve or GDZ-only branch released this owner. This is the
    // failure path for a rejected lookup/transport; identity checking prevents
    // an old finally block from clearing a newer operation.
    if (releaseChatOperation(chat, owner)) {
      stopThinking(chat, owner);
      renderSidebar();
    }
  }
}

async function activateLesson(key) {
  const chat = chats.get(key);
  if (!chat || key === activeKey) return;
  const previous = activeChat();
  if (previous?.thinkingEl) stopThinking(previous);
  activeKey = key;
  titleEl.textContent = `${chat.subject} — решение`;
  renderChat(chat);
  renderSidebar();
  if (!chat.started) await startLesson(chat); // the only place the API gets triggered automatically
}

/* ---------- Sidebar: whole week, grouped by day, scrollable ---------- */

function renderSidebar() {
  weekEl.innerHTML = '';
  if (!chats.size) {
    const hint = document.createElement('p');
    hint.className = 'hintmsg';
    hint.textContent = weekDataError || 'Нет данных о неделе. Откройте попап на странице дневника, чтобы просканировать домашние задания.';
    weekEl.appendChild(hint);
    return;
  }
  // Group lessons by day (first-seen order) so a lesson added out of insertion
  // order — e.g. an old Solve link appended at the end — still lands under its
  // day instead of producing a second, duplicate day header further down.
  const byDay = new Map();
  for (const chat of chats.values()) {
    const day = chat.day || null;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(chat);
  }
  for (const [day, dayChats] of byDay) {
    const hdr = document.createElement('div');
    hdr.className = 'dayhdr';
    hdr.textContent = day || 'Без даты';
    weekEl.appendChild(hdr);
    for (const chat of dayChats) {
      const el = document.createElement('div');
      el.className = 'lesson' + (chat.key === activeKey ? ' active' : '');
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-current', chat.key === activeKey ? 'true' : 'false');
      el.innerHTML = '<div class="subj"></div><div class="t"></div>';
      const subj = el.querySelector('.subj');
      if (chat.pending) {
        const dot = document.createElement('span');
        dot.className = 'spinner';
        subj.appendChild(dot);
      } else if (chat.started) {
        const done = document.createElement('span');
        done.className = 'donemark';
        done.innerHTML = iconSvg('check', 11);
        subj.appendChild(done);
      }
      subj.append(chat.subject);
      el.querySelector('.t').textContent = (chat.task || '').slice(0, 80);
      el.onclick = () => activateLesson(chat.key);
      el.onkeydown = (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.key === ' ') e.preventDefault();
        activateLesson(chat.key);
      };
      weekEl.appendChild(el);
    }
  }
}

/* ---------- Composer ---------- */

const inputEl = document.getElementById('input');
const fileInput = document.getElementById('file');
const fileChip = document.getElementById('filechip');
const fileNameEl = document.getElementById('filename');

// Held as an already-inlined file so a pasted screenshot and a picked file
// share one path (an <input type=file> can't be set programmatically).
let pendingFile = null;
let fileReadGen = 0;
let pendingFileRead = null;
// Only the short file-read/handoff phase needs a composer mutex. Once
// sendToChat synchronously owns `chat.pending`, another lesson must remain free
// to send even if this model stream is slow or never settles.
const composerPreparingChats = new WeakSet();

function showAttachment(name) {
  fileNameEl.textContent = name;
  fileChip.hidden = false;
}
function clearAttachmentPresentation() {
  pendingFile = null;
  fileInput.value = '';
  fileNameEl.textContent = '';
  fileChip.hidden = true;
  fileChip.classList.remove('recording');
}
function clearAttachment() {
  // The chip's × invalidates every file read and microphone phase — permission
  // prompt, recording, stop/final conversion, or a transient error notice. A
  // late callback from either path is then unable to resurrect the attachment.
  fileReadGen++;
  pendingFileRead = null;
  if (micSession) cancelMicSession(micSession);
  clearAttachmentPresentation();
}

document.getElementById('attach').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const f = fileInput.files[0];
  if (!f) return;
  const gen = ++fileReadGen;
  // A picked file is a newer attachment intent than every microphone phase,
  // including an async final conversion. Revoke that session before clearing
  // shared presentation so its late result cannot replace the selected file.
  if (micSession) cancelMicSession(micSession, { restoreAttachment: false });
  // The old chip and old payload are one state. Clear both before attempting a
  // replacement so a failed read cannot advertise a file that will not send.
  // The generation already made an older read ineligible; also detach its
  // promise now so a synchronously rejected replacement cannot leave composer
  // sends waiting on an obsolete FileReader forever.
  pendingFileRead = null;
  clearAttachmentPresentation();
  let read = null;
  try {
    read = fileToInline(f);
    pendingFileRead = read;
    const inline = await read;
    if (gen !== fileReadGen) return;
    pendingFile = inline;
    showAttachment(f.name);
  } catch (e) {
    if (gen !== fileReadGen) return;
    // A send click may already be awaiting this exact read. Invalidate that
    // click as well as the attachment UI so it cannot silently continue as a
    // text-only request after the selected file failed to decode.
    fileReadGen++;
    clearAttachmentPresentation();
    showToast(e?.message || 'Не удалось прочитать файл.');
  } finally {
    if (pendingFileRead === read) pendingFileRead = null;
  }
};
document.getElementById('clearfile').onclick = clearAttachment;

// Paste a screenshot / snipped image straight into the chat (Ctrl/⌘+V).
document.addEventListener('paste', async (e) => {
  const item = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
  if (!item) return;
  const blob = item.getAsFile();
  if (!blob) return;
  e.preventDefault();
  const name = blob.name || `screenshot-${Date.now()}.png`;
  const gen = ++fileReadGen;
  if (micSession) cancelMicSession(micSession, { restoreAttachment: false });
  pendingFileRead = null;
  clearAttachmentPresentation();
  let read = null;
  try {
    read = fileToInline(new File([blob], name, { type: blob.type || 'image/png' }));
    pendingFileRead = read;
    const inline = await read;
    if (gen !== fileReadGen) return;
    pendingFile = inline;
    showAttachment(name);
  } catch (e) {
    if (gen !== fileReadGen) return;
    fileReadGen++;
    clearAttachmentPresentation();
    showToast(e?.message || 'Не удалось прочитать изображение.');
  } finally {
    if (pendingFileRead === read) pendingFileRead = null;
  }
});

/* ---------- Microphone capture → Whisper transcription ---------- */
// For listening (аудирование) tasks whose audio isn't a downloadable file —
// play the track (browser player, phone speaker…) and record it here. The clip
// is attached like any file; the service worker runs Groq Whisper on it
// (transcribeAudioFiles) and the normal solve path answers from the transcript.
const micBtn = document.getElementById('mic');
const MAX_REC_MS = 10 * 60 * 1000;
const MAX_REC_BYTES = Math.floor(MAX_AUDIO_UPLOAD_BYTES * 0.95);
const MIC_IDLE_TITLE = 'Записать аудио с микрофона и расшифровать (для аудирования)';
let micSession = null;
let micStartPromise = null;
let micStartSession = null;
let micPageUnloading = false;

function createMicSession() {
  return {
    phase: 'starting',
    cancelled: false,
    stream: null,
    recorder: null,
    chunks: [],
    bytes: 0,
    timer: null,
    noticeTimer: null,
    startedAt: 0,
    limitMessage: ''
  };
}

function isCurrentMicSession(session) {
  return micSession === session && !session.cancelled;
}

function clearMicTimer(session) {
  if (session.timer) clearInterval(session.timer);
  session.timer = null;
}

function stopMicTracks(session) {
  const stream = session.stream;
  session.stream = null;
  if (!stream) return;
  try {
    for (const track of stream.getTracks?.() || []) {
      try { track.stop(); } catch { /* another cleanup path already stopped it */ }
    }
  } catch { /* malformed/closing stream: nothing else can release here */ }
}

function resetMicButton() {
  micBtn.classList.remove('recording');
  micBtn.title = MIC_IDLE_TITLE;
}

function restoreAttachmentAfterMic() {
  fileChip.classList.remove('recording');
  if (pendingFile) showAttachment(pendingFile.name || 'файл');
  else fileChip.hidden = true;
}

function detachAndStopRecorder(session) {
  const recorder = session.recorder;
  session.recorder = null;
  if (!recorder) return;
  recorder.ondataavailable = null;
  recorder.onstop = null;
  recorder.onerror = null;
  if (recorder.state === 'recording' || recorder.state === 'paused') {
    try { recorder.stop(); } catch { /* stream cleanup below is authoritative */ }
  }
}

function cancelMicSession(session, { restoreAttachment = true } = {}) {
  if (!session) return;
  const wasCurrent = micSession === session;
  session.cancelled = true;
  session.phase = 'cancelled';
  clearMicTimer(session);
  if (session.noticeTimer) clearTimeout(session.noticeTimer);
  session.noticeTimer = null;
  detachAndStopRecorder(session);
  stopMicTracks(session);
  session.chunks.length = 0;
  session.bytes = 0;
  if (micStartSession === session) {
    // getUserMedia permission promises are browser-owned and may never settle.
    // Release only this session's single-flight slot so a cancelled/page-restored
    // composer can start a fresh request. The old continuation still owns and
    // stops any stream that eventually arrives.
    micStartSession = null;
    micStartPromise = null;
  }
  if (!wasCurrent) return;
  micSession = null;
  resetMicButton();
  if (restoreAttachment) restoreAttachmentAfterMic();
}

// Prefer a codec Groq Whisper accepts; fall back to the browser default.
function pickRecMime() {
  const prefs = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of prefs) { if (window.MediaRecorder?.isTypeSupported?.(m)) return m; }
  return '';
}
const REC_EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tickRecording(session) {
  if (!isCurrentMicSession(session) || session.phase !== 'recording') return;
  const elapsed = Date.now() - session.startedAt;
  if (elapsed >= MAX_REC_MS) {
    stopRecordingForLimit(session, 'Запись остановлена: достигнут лимит 10 минут.');
    return;
  }
  fileChip.classList.add('recording');
  fileChip.hidden = false;
  fileNameEl.textContent = `● Запись… ${fmtTime(elapsed)} / ${fmtTime(MAX_REC_MS)}`;
}

function requestRecordingStop(session, limitMessage = '') {
  if (!isCurrentMicSession(session) || session.phase !== 'recording') return;
  if (limitMessage) session.limitMessage = limitMessage;
  session.phase = 'stopping';
  clearMicTimer(session);
  resetMicButton();
  try {
    session.recorder.stop();
  } catch {
    failMicSession(session, 'Не удалось завершить запись. Попробуйте ещё раз.');
    return;
  }
  // recorder.stop() queues the final data/stop events; the input track itself
  // is no longer needed and must not stay live if those events are delayed.
  stopMicTracks(session);
}

function stopRecordingForLimit(session, message) {
  requestRecordingStop(session, message);
}

// Briefly show an error in the chip, then clear it if nothing got attached.
function flashChipError(session, text) {
  if (!isCurrentMicSession(session)) return;
  session.phase = 'failed';
  fileChip.classList.remove('recording');
  showAttachment(text);
  session.noticeTimer = setTimeout(() => {
    session.noticeTimer = null;
    if (!isCurrentMicSession(session)) return;
    micSession = null;
    restoreAttachmentAfterMic();
  }, 2800);
}

function failMicSession(session, message) {
  clearMicTimer(session);
  detachAndStopRecorder(session);
  stopMicTracks(session);
  session.chunks.length = 0;
  session.bytes = 0;
  if (!isCurrentMicSession(session)) {
    session.cancelled = true;
    session.phase = 'cancelled';
    return;
  }
  if (micPageUnloading) {
    cancelMicSession(session, { restoreAttachment: false });
    return;
  }
  resetMicButton();
  flashChipError(session, message);
}

async function onRecordingStop(session, recorder) {
  clearMicTimer(session);
  stopMicTracks(session);
  recorder.ondataavailable = null;
  recorder.onstop = null;
  recorder.onerror = null;
  if (session.recorder === recorder) session.recorder = null;

  // A queued stop callback can still arrive after clear, unload, or a newer
  // start. It may clean only its own session-owned resources, never shared UI.
  if (!isCurrentMicSession(session) ||
      (session.phase !== 'recording' && session.phase !== 'stopping')) return;
  session.phase = 'processing';
  resetMicButton();
  fileChip.classList.remove('recording');

  const baseMime = (recorder.mimeType || 'audio/webm').split(';')[0];
  const limitMessage = session.limitMessage;
  session.limitMessage = '';
  const chunks = session.chunks;
  session.chunks = [];
  session.bytes = 0;
  if (limitMessage) showToast(limitMessage);
  if (!chunks.length) {
    micSession = null;
    pendingFile = null;
    fileInput.value = '';
    fileChip.hidden = true;
    return;
  }
  const blob = new Blob(chunks, { type: baseMime });
  const name = `Запись с микрофона.${REC_EXT[baseMime] || 'webm'}`;
  try {
    const inline = await fileToInline(new File([blob], name, { type: baseMime }));
    if (!isCurrentMicSession(session) || session.phase !== 'processing') return;
    pendingFile = inline;
    fileReadGen++; // a stale picker/paste read must not overwrite the fresh recording
    micSession = null;
    showAttachment(name);
  } catch (e) {
    if (!isCurrentMicSession(session) || session.phase !== 'processing') return;
    micSession = null;
    pendingFile = null;
    fileChip.hidden = true;
    showToast(e?.message || 'Запись слишком большая.');
  }
}

async function startMicSession(session) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    failMicSession(session, 'Запись с микрофона не поддерживается в этом браузере.');
    return;
  }
  let stream;
  try {
    // CRITICAL: turn OFF echo cancellation / noise suppression / auto-gain.
    // With the browser defaults (all ON), the mic stream actively REMOVES sound
    // coming from the device's own speakers — it treats it as echo — so audio
    // you play out loud to record (a listening track) comes back near-silent and
    // Whisper hallucinates filler ("Hush!", "Thank you."). We want the raw signal.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
  } catch (e) {
    if (!isCurrentMicSession(session) || micPageUnloading) {
      cancelMicSession(session, { restoreAttachment: false });
      return;
    }
    const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
    failMicSession(session, denied
      ? 'Нет доступа к микрофону — разрешите его для расширения.'
      : 'Микрофон недоступен.');
    return;
  }
  session.stream = stream;
  if (!isCurrentMicSession(session) || micPageUnloading) {
    cancelMicSession(session, { restoreAttachment: false });
    return;
  }

  try {
    const mimeType = pickRecMime();
    let recorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      recorder = new MediaRecorder(stream);
    }
    session.recorder = recorder;
    recorder.ondataavailable = (ev) => {
      if (!isCurrentMicSession(session) || !ev.data?.size || session.limitMessage) return;
      const nextBytes = session.bytes + ev.data.size;
      if (nextBytes <= MAX_AUDIO_UPLOAD_BYTES) {
        session.chunks.push(ev.data);
        session.bytes = nextBytes;
      }
      if (nextBytes >= MAX_REC_BYTES) {
        stopRecordingForLimit(session, 'Запись остановлена: достигнут лимит размера.');
      }
    };
    recorder.onstop = () => {
      onRecordingStop(session, recorder).catch(() => {
        failMicSession(session, 'Не удалось обработать запись. Попробуйте ещё раз.');
      });
    };
    recorder.onerror = () => {
      failMicSession(session, 'Не удалось записать звук. Попробуйте ещё раз.');
    };
    recorder.start(1000);
    session.phase = 'recording';
    session.startedAt = Date.now();
    micBtn.classList.add('recording');
    micBtn.title = 'Остановить запись';
    tickRecording(session);
    session.timer = setInterval(() => tickRecording(session), 1000);
  } catch {
    failMicSession(session, 'Микрофон недоступен.');
  }
}

function startRecording() {
  if (micStartPromise && micStartSession && isCurrentMicSession(micStartSession)) {
    return micStartPromise;
  }
  micStartPromise = null;
  micStartSession = null;
  if (micPageUnloading) return Promise.resolve();
  // A microphone start is a newer composer/attachment intent. Revoke any
  // picker/paste read (and any Send click waiting on its generation) before
  // asynchronous permission acquisition begins.
  fileReadGen++;
  pendingFileRead = null;
  if (micSession) cancelMicSession(micSession);
  const session = createMicSession();
  micSession = session;
  const startup = startMicSession(session);
  micStartPromise = startup;
  micStartSession = session;
  void startup.then(
    () => {
      if (micStartPromise === startup && micStartSession === session) {
        micStartPromise = null;
        micStartSession = null;
      }
    },
    () => {
      if (micStartPromise === startup && micStartSession === session) {
        micStartPromise = null;
        micStartSession = null;
      }
    }
  );
  return startup;
}

micBtn.onclick = () => {
  const session = micSession;
  if (session?.phase === 'starting') return cancelMicSession(session);
  if (session?.phase === 'recording') return requestRecordingStop(session);
  startRecording(); // failed/stopping/processing sessions are superseded safely
};

window.addEventListener('pagehide', () => {
  micPageUnloading = true;
  if (micSession) cancelMicSession(micSession, { restoreAttachment: false });
});
window.addEventListener('pageshow', () => {
  micPageUnloading = false;
  resetMicButton();
  restoreAttachmentAfterMic();
});

async function sendFromComposer() {
  const chat = activeChat();
  if (!chat || chat.pending || composerPreparingChats.has(chat)) return;
  if (micSession && ['starting', 'recording', 'stopping', 'processing'].includes(micSession.phase)) return;
  const draftAtClick = inputEl.value;
  const fileGenAtClick = fileReadGen;
  composerPreparingChats.add(chat);
  let solvePromise = null;
  try {
    await awaitStablePendingRead(() => pendingFileRead);
    // A file picker, paste, draft edit, or lesson switch while FileReader was
    // pending changes the meaning of this click. Preserve the new state and let
    // the user send it deliberately instead of crossing chats/attachments.
    if ((micSession && ['starting', 'recording', 'stopping', 'processing'].includes(micSession.phase)) ||
        activeChat() !== chat || chat.pending || fileReadGen !== fileGenAtClick ||
        inputEl.value !== draftAtClick) return;
    let text = draftAtClick.trim();
    const files = pendingFile ? [pendingFile] : [];
    if (!text && !files.length) return;
    // A recording sent with no note: tell the model explicitly to SOLVE the
    // listening task from the transcript, not just echo it back.
    if (!text && files.some((f) => (f.mimeType || '').startsWith('audio/'))) {
      text = 'Это аудиозапись к заданию по аудированию. Расшифруй её и выполни задание ' +
        '(ответь на вопросы / заполни пропуски по записи).';
    }
    inputEl.value = '';
    clearAttachment();
    // Text may be empty when only a file is sent — the chip shows the attachment.
    // sendToChat reserves chat.pending synchronously before returning its model
    // promise. Hand off ownership, then release this short preparation mutex;
    // awaiting the model here would globally strand other lesson composers.
    solvePromise = sendToChat(chat, text, files);
  } finally {
    composerPreparingChats.delete(chat);
  }
  return solvePromise;
}

document.getElementById('send').onclick = sendFromComposer;
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendFromComposer();
  }
});

document.getElementById('settingsBtn').onclick = () => chrome.runtime.openOptionsPage();
document.getElementById('themeBtn').onclick = toggleTheme;

/* ---------- Answer-mode toggle (Кратко / Объяснить) ---------- */

/**
 * Storage snapshots resolve asynchronously. A click that lands first must win:
 * repainting stale state would also revert the mode/engine sent in the next
 * SOLVE payload.
 */
let modeTouched = false;
let engineTouched = false;
let dashboardPreferenceWriteQueue = Promise.resolve();
function persistDashboardPreference(key, value) {
  const write = dashboardPreferenceWriteQueue.then(() =>
    chrome.storage.local.set({ [key]: value })
  );
  dashboardPreferenceWriteQueue = write.catch(() => {});
  return write;
}
const modeSeg = document.getElementById('modeSeg');
function markMode(mode) {
  answerMode = mode;
  for (const b of modeSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === mode);
  }
}
modeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  modeTouched = true;
  markMode(b.dataset.mode);
  void persistDashboardPreference('answerMode', b.dataset.mode);
});
chrome.storage.local.get('answerMode').then(({ answerMode: saved }) => {
  if (!modeTouched && (saved === 'brief' || saved === 'explain')) markMode(saved);
});

/* ---------- Engine toggle (Авто / Думать) ---------- */

// Which model solves: «Авто» answers fast (DeepSeek, low reasoning effort),
// «Думать» reasons at length (Qwen thinks by default). Applies to the NEXT
// send — an in-flight solve keeps the engine it started with.
const engineSeg = document.getElementById('engineSeg');
function markEngine(engine) {
  solveEngine = engine;
  for (const b of engineSeg.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.engine === engine);
  }
  paintEngineBadge(engine);
}
engineSeg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  engineTouched = true;
  markEngine(b.dataset.engine);
  void persistDashboardPreference('solveEngine', b.dataset.engine);
});
paintEngineBadge(solveEngine);
chrome.storage.local.get('solveEngine').then(({ solveEngine: saved }) => {
  if (!engineTouched && (saved === 'auto' || saved === 'think')) markEngine(saved);
});

/* ---------- Init: load week from the last popup scan ---------- */

const WEEK_SCAN_MAX_AGE_MS = 15 * 60 * 1000;

(async function init() {
  const { weekHomework } = await chrome.storage.local.get('weekHomework');
  const scannedAt = weekHomework?.scannedAt;
  const scanAge = Date.now() - scannedAt;
  let freshWeek = Number.isFinite(scannedAt) && scanAge >= 0 && scanAge <= WEEK_SCAN_MAX_AGE_MS;
  const cacheScanId = weekHomework?.scanId || null;
  const launchScanId = initialScanId || null;
  const cachePrincipal = weekHomework?.principal || null;
  const launchPrincipal = launchPayload.principal || null;
  const cachePrincipalError = weekHomework?.principalError || null;
  const launchPrincipalError = launchPayload.principalError || null;
  // The week cache is identity-sensitive even when this page was opened
  // directly. Its exact scan capability must arrive through the encrypted,
  // consume-once launch; freshness alone never authorizes browsing it.
  if (freshWeek && !principalBindingMatches({
    cacheScanId,
    launchScanId,
    cachePrincipal,
    launchPrincipal,
    cacheError: cachePrincipalError,
    launchError: launchPrincipalError,
  })) {
    freshWeek = false;
    if (!launchScanId) {
      weekDataError = 'Чтобы безопасно открыть сохранённую неделю, откройте попап СМЭШ AI в нужном дневнике и нажмите «Решить» у задания.';
    } else if (cachePrincipalError || launchPrincipalError) {
      weekDataError = 'Не удалось однозначно определить профиль ученика. Выберите нужный профиль в дневнике, обновите страницу и просканируйте задания заново.';
    } else if (cacheScanId !== launchScanId) {
      weekDataError = 'Скан недели изменился после открытия задания. Вернитесь в дневник, просканируйте задания заново и снова нажмите «Решить».';
    } else {
      weekDataError = 'Скан недели сделан для другого или неподтверждённого профиля. Откройте попап на нужном дневнике и просканируйте задания заново.';
    }
  }
  if (!freshWeek && weekHomework && !weekDataError) {
    weekDataError = 'Скан недели устарел. Откройте попап на текущей странице дневника и просканируйте задания заново.';
  }
  for (const group of freshWeek ? (weekHomework?.days || []) : []) {
    for (const item of group.subjects || []) {
      const key = keyFor(group.day, item.subject, item.task, item.homeworkId, item.homeworkItemId, item.rowToken);
      if (!chats.has(key)) {
        chats.set(key, {
          key,
          day: group.day,
          subject: item.subject,
          task: item.task,
          homeworkId: item.homeworkId || '',
          homeworkItemId: item.homeworkItemId || '',
          rowToken: item.rowToken || '',
          scanId: cacheScanId || '',
          sessionId: null, history: [], started: false, pending: false,
          pendingOwner: null, thinkingOwner: null
        });
      }
    }
  }

  // Lesson the user pressed "Solve" on. The row token was minted by this exact
  // week scan and is the only accepted match. If it is absent/stale/missing we
  // stop visibly instead of guessing by subject (which crossed rows/children).
  let startKey = null;
  let openError = '';
  if (initialSubject) {
    const all = [...chats.values()];
    const match = initialRowToken && freshWeek
      ? all.find((c) => c.rowToken === initialRowToken)
      : null;
    if (match) {
      startKey = match.key;
    } else if (!freshWeek) {
      openError = weekDataError || 'Скан домашних заданий устарел. Вернитесь в дневник, откройте попап СМЭШ AI и запустите свежий скан.';
    } else if (!initialRowToken) {
      openError = 'Не найден идентификатор строки задания. Откройте его заново из свежего списка в попапе СМЭШ AI.';
    } else {
      openError = 'Задание не найдено в свежем скане недели. Откройте попап на текущей странице дневника и просканируйте задания заново.';
    }
  }

  renderSidebar();
  if (startKey) await activateLesson(startKey);
  else if (openError) {
    titleEl.textContent = 'Задание не найдено';
    chatEl.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'hintmsg';
    hint.textContent = openError;
    chatEl.appendChild(hint);
  } else if (weekDataError) {
    titleEl.textContent = 'Неделя недоступна';
    chatEl.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'hintmsg';
    hint.textContent = weekDataError;
    chatEl.appendChild(hint);
  } else renderChat(null);
})();
