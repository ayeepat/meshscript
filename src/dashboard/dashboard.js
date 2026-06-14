/**
 * Full-window dashboard: week-of-homework sidebar + chat solve view.
 * Each sidebar lesson keeps its own chat in this tab. The AI is only called
 * when a lesson is opened for the first time (or you send a follow-up).
 * Chat history (7-day TTL) lives in Settings, not here.
 */
import { initTheme, toggleTheme } from '../common/theme.js';
import { extractMath, restoreMath } from '../common/tex.js';
import { iconSvg } from '../common/icons.js';

// Keep the theme button icon in sync with the resolved theme.
document.addEventListener('themechange', (e) => {
  document.getElementById('themeBtn').innerHTML = iconSvg(e.detail === 'dark' ? 'sun' : 'moon', 16);
});
initTheme();

const params = new URLSearchParams(location.search);
const initialSubject = params.get('subject') || '';
const initialTask = params.get('task') || '';
const initialDay = params.get('day') || '';

const chatEl = document.getElementById('chat');
const titleEl = document.getElementById('title');
const weekEl = document.getElementById('week');

// key -> { key, day, subject, task, sessionId, history: [{role, content}], started, pending }
const chats = new Map();
let activeKey = null;
let answerMode = 'brief'; // 'brief' (concise, keeps steps) | 'explain' (tutor)

// Task is part of the key: one subject can have two homeworks in a day.
const keyFor = (day, subject, task) => `${day || '?'}||${subject}||${(task || '').slice(0, 40)}`;
const activeChat = () => chats.get(activeKey);

/* ---------- Minimal safe markdown renderer (no external libs) ---------- */

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function mdToHtml(md) {
  // Pull LaTeX out first so markdown processing can't mangle *, _ inside it.
  const { text, chunks } = extractMath(md);
  const lines = escapeHtml(text).split(/\r?\n/);
  let html = '';
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) { closeList(); html += `<h4>${inlineMd(h[1])}</h4>`; continue; }
    const ul = line.match(/^[*\-•]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inlineMd(ul[1])}</li>`; continue;
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inlineMd(ol[1])}</li>`; continue;
    }
    closeList();
    html += `<p>${inlineMd(line)}</p>`;
  }
  closeList();
  return restoreMath(html, chunks);
}

/* ---------- Typewriter: starts slow, accelerates, finishes fast ---------- */

// Re-parsing the full markdown every frame is O(n²); for long answers that
// janks badly and the reveal drags on. Above this length we render once.
const TYPEWRITER_MAX = 1500;

function typewriter(el, fullText) {
  if (fullText.length > TYPEWRITER_MAX) { el.innerHTML = mdToHtml(fullText); return; }
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

function bubble(role, text, { animate = false } = {}) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  if (role === 'assistant') {
    const body = document.createElement('div');
    body.className = 'mdbody';
    if (animate) typewriter(body, text);
    else body.innerHTML = mdToHtml(text);
    d.appendChild(body);
    d.appendChild(copyButton(() => text));
  } else {
    d.textContent = text; // user text stays plain
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
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return { wrap: d, body };
}

/** Transient status bubble shown while the answer is being generated. */
function thinkingBubble() {
  const d = document.createElement('div');
  d.className = 'msg assistant thinking';
  d.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
  d.append('Думаю…');
  chatEl.appendChild(d);
  chatEl.scrollTop = chatEl.scrollHeight;
  return d;
}

/** Re-render the whole chat from a lesson's stored history (no animation). */
function renderChat(chat) {
  chatEl.innerHTML = '';
  if (!chat) {
    chatEl.innerHTML = '<p class="hintmsg">Выберите урок слева, чтобы получить решение.</p>';
    return;
  }
  for (const m of chat.history) bubble(m.role, m.content);
  if (chat.pending) chat.thinkingEl = thinkingBubble();
}

function fileToInline(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mimeType: file.type || 'application/octet-stream', dataBase64: String(r.result).split(',')[1], name: file.name });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/**
 * Send a message within a lesson's chat over a streaming port. Tokens are
 * revealed live; the answer is appended to that lesson's history even if the
 * user switched lessons meanwhile — the DOM is only touched when the lesson is
 * the active one. The active lesson can change mid-stream, so every render
 * guards on `activeKey === chat.key`.
 */
function sendToChat(chat, text, files) {
  const prior = chat.history.slice(); // turns BEFORE this message
  chat.history.push({ role: 'user', content: text });
  chat.pending = true;
  if (activeKey === chat.key) {
    bubble('user', text);
    chat.thinkingEl = thinkingBubble();
  }
  renderSidebar();

  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'solve' });
    let acc = '';        // accumulated streamed text
    let shell = null;    // live assistant bubble, created on first delta
    let settled = false;

    // (Re)create the live bubble. Switching lessons wipes the chat DOM via
    // renderChat, detaching our shell — so rebuild it (with text so far) if the
    // user comes back mid-stream.
    const ensureShell = () => {
      if (activeKey !== chat.key) return;
      if (shell && shell.wrap.isConnected) return;
      chat.thinkingEl?.remove();
      chat.thinkingEl = null;
      shell = assistantShell();
      shell.body.innerHTML = mdToHtml(acc);
    };

    // Re-parsing the full markdown on every token is O(n²) and janks on long
    // answers. Coalesce: deltas just append to `acc`; the DOM re-renders at
    // most once per animation frame.
    let renderPending = false;
    const flush = () => {
      renderPending = false;
      if (settled || activeKey !== chat.key) return;
      ensureShell();
      shell.body.innerHTML = mdToHtml(acc);
      chatEl.scrollTop = chatEl.scrollHeight;
    };
    const scheduleRender = () => {
      if (renderPending || activeKey !== chat.key) return;
      renderPending = true;
      requestAnimationFrame(flush);
    };

    const finish = (answer, { animate = false } = {}) => {
      if (settled) return;
      settled = true;
      chat.pending = false;
      chat.history.push({ role: 'assistant', content: answer });
      if (activeKey === chat.key) {
        chat.thinkingEl?.remove();
        chat.thinkingEl = null;
        if (shell && shell.wrap.isConnected) {
          shell.body.innerHTML = mdToHtml(answer); // clean final render
          shell.wrap.appendChild(copyButton(() => answer));
        } else {
          bubble('assistant', answer, { animate });
        }
      }
      renderSidebar();
      try { port.disconnect(); } catch { /* already gone */ }
      resolve();
    };

    port.onMessage.addListener((m) => {
      if (m?.type === 'delta') {
        acc += m.text;
        scheduleRender();
      } else if (m?.type === 'done') {
        chat.sessionId = m.result?.sessionId || chat.sessionId;
        // Prefer the authoritative full text; fall back to what we streamed.
        // animate only when nothing streamed (e.g. the photo-request guard).
        finish(m.result?.answer ?? acc, { animate: !acc });
      } else if (m?.type === 'error') {
        finish('Ошибка: ' + m.error);
      }
    });

    // The service worker can be torn down; surface that instead of hanging.
    port.onDisconnect.addListener(() => finish(acc || 'Ошибка: соединение прервано.'));

    port.postMessage({
      type: 'SOLVE',
      payload: { subject: chat.subject, task: text, files, sessionId: chat.sessionId, history: prior, mode: answerMode }
    });
  });
}

/**
 * First open of a lesson: send the task as-is. The subject prompt from
 * Settings is applied as the SYSTEM prompt by the service worker — sending
 * it here too would duplicate it and break the bare-"Упр. N" photo guard.
 * If the popup attached a file for this lesson, include it.
 */
async function startLesson(chat) {
  chat.started = true;
  let text = chat.task;
  let files = [];
  try {
    const { pendingUpload } = await chrome.storage.local.get('pendingUpload');
    // Files come from the popup: manually attached OR auto-fetched from Mesh.
    const pending = pendingUpload?.files || (pendingUpload?.file ? [pendingUpload.file] : []);
    if (pending.length && pendingUpload.subject === chat.subject &&
        (!pendingUpload.day || pendingUpload.day === chat.day)) {
      files = pending;
      text += '\n\nВложение: ' + pending.map((f) => f.name || 'файл').join(', ');
      await chrome.storage.local.remove('pendingUpload');
    }
  } catch (_e) { /* upload is best-effort */ }
  await sendToChat(chat, text, files);
}

async function activateLesson(key) {
  const chat = chats.get(key);
  if (!chat || key === activeKey) return;
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
    weekEl.innerHTML = '<p class="hintmsg">Нет данных о неделе. Откройте попап на странице дневника, чтобы просканировать домашние задания.</p>';
    return;
  }
  let lastDay = null;
  for (const chat of chats.values()) {
    if (chat.day !== lastDay) {
      lastDay = chat.day;
      const hdr = document.createElement('div');
      hdr.className = 'dayhdr';
      hdr.textContent = chat.day || 'Без даты';
      weekEl.appendChild(hdr);
    }
    const el = document.createElement('div');
    el.className = 'lesson' + (chat.key === activeKey ? ' active' : '');
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
    weekEl.appendChild(el);
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

function showAttachment(name) {
  fileNameEl.textContent = name;
  fileChip.hidden = false;
}
function clearAttachment() {
  pendingFile = null;
  fileInput.value = '';
  fileChip.hidden = true;
}

document.getElementById('attach').onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const f = fileInput.files[0];
  if (f) { pendingFile = await fileToInline(f); showAttachment(f.name); }
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
  pendingFile = await fileToInline(new File([blob], name, { type: blob.type || 'image/png' }));
  showAttachment(name);
});

async function sendFromComposer() {
  const chat = activeChat();
  if (!chat || chat.pending) return; // ignore until the current answer lands
  const text = inputEl.value.trim();
  const files = pendingFile ? [pendingFile] : [];
  if (!text && !files.length) return;
  const fname = pendingFile?.name;
  inputEl.value = '';
  clearAttachment();
  await sendToChat(chat, text || ('Вложение: ' + fname), files);
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
  markMode(b.dataset.mode);
  chrome.storage.local.set({ answerMode: b.dataset.mode });
});
chrome.storage.local.get('answerMode').then(({ answerMode: saved }) => {
  if (saved === 'brief' || saved === 'explain') markMode(saved);
});

/* ---------- Init: load week from the last popup scan ---------- */

(async function init() {
  const { weekHomework } = await chrome.storage.local.get('weekHomework');
  for (const group of weekHomework?.days || []) {
    for (const item of group.subjects || []) {
      const key = keyFor(group.day, item.subject, item.task);
      if (!chats.has(key)) {
        chats.set(key, {
          key, day: group.day, subject: item.subject, task: item.task,
          sessionId: null, history: [], started: false, pending: false
        });
      }
    }
  }

  // Lesson the user pressed "Solve" on. Match it against the saved week,
  // loosening the criteria step by step; if it's missing entirely (e.g.
  // opened from an old link), add it so it still works.
  let startKey = null;
  if (initialSubject) {
    const all = [...chats.values()];
    const match =
      all.find((c) => c.day === initialDay && c.subject === initialSubject && c.task === initialTask) ||
      all.find((c) => c.subject === initialSubject && c.task === initialTask) ||
      all.find((c) => c.subject === initialSubject);
    if (match) {
      startKey = match.key;
    } else {
      startKey = keyFor(initialDay, initialSubject, initialTask);
      chats.set(startKey, {
        key: startKey, day: initialDay, subject: initialSubject, task: initialTask,
        sessionId: null, history: [], started: false, pending: false
      });
    }
  }

  renderSidebar();
  if (startKey) await activateLesson(startKey);
  else renderChat(null);
})();
