/**
 * Full-window dashboard: week-of-homework sidebar + chat solve view.
 * Each sidebar lesson keeps its own chat in this tab. The AI is only called
 * when a lesson is opened for the first time (or you send a follow-up).
 * Chat history (7-day TTL) lives in Settings, not here.
 */
import { initTheme, toggleTheme } from '../common/theme.js';
import { extractMath, restoreMath } from '../common/tex.js';

// Keep the theme button icon in sync with the resolved theme.
document.addEventListener('themechange', (e) => {
  document.getElementById('themeBtn').textContent = e.detail === 'dark' ? '☀️' : '🌙';
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

function typewriter(el, fullText) {
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

function bubble(role, text, { animate = false } = {}) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  if (role === 'assistant') {
    if (animate) typewriter(d, text);
    else d.innerHTML = mdToHtml(text);
  } else {
    d.textContent = text; // user text stays plain
  }
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
  if (chat.pending) chat.thinkingEl = bubble('assistant', 'Думаю…');
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
 * Send a message within a lesson's chat. The response is appended to that
 * lesson's history even if the user switched to another lesson meanwhile;
 * the DOM is only touched when the lesson is the active one.
 */
function sendToChat(chat, text, files) {
  const prior = chat.history.slice(); // turns BEFORE this message
  chat.history.push({ role: 'user', content: text });
  chat.pending = true;
  if (activeKey === chat.key) {
    bubble('user', text);
    chat.thinkingEl = bubble('assistant', 'Думаю…');
  }
  renderSidebar();
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'SOLVE', payload: { subject: chat.subject, task: text, files, sessionId: chat.sessionId, history: prior } },
      (resp) => {
        chat.pending = false;
        let answer;
        if (chrome.runtime.lastError || !resp?.ok) {
          answer = 'Ошибка: ' + (resp?.error || chrome.runtime.lastError?.message);
        } else {
          chat.sessionId = resp.result.sessionId || chat.sessionId;
          answer = resp.result.answer;
        }
        chat.history.push({ role: 'assistant', content: answer });
        if (activeKey === chat.key) {
          chat.thinkingEl?.remove();
          bubble('assistant', answer, { animate: true });
        }
        renderSidebar();
        resolve();
      }
    );
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
    if (pendingUpload?.file && pendingUpload.subject === chat.subject &&
        (!pendingUpload.day || pendingUpload.day === chat.day)) {
      files = [pendingUpload.file];
      text += '\n\n📎 ' + (pendingUpload.file.name || 'файл');
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
    const status = chat.pending ? '⏳ ' : chat.started ? '✓ ' : '';
    el.innerHTML = '<div class="subj"></div><div class="t"></div>';
    el.querySelector('.subj').textContent = status + chat.subject;
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

function clearAttachment() {
  fileInput.value = '';
  fileChip.hidden = true;
}

document.getElementById('attach').onclick = () => fileInput.click();
fileInput.onchange = () => {
  if (fileInput.files[0]) {
    fileNameEl.textContent = '📎 ' + fileInput.files[0].name;
    fileChip.hidden = false;
  }
};
document.getElementById('clearfile').onclick = clearAttachment;

async function sendFromComposer() {
  const chat = activeChat();
  if (!chat) return;
  const text = inputEl.value.trim();
  const files = fileInput.files[0] ? [await fileToInline(fileInput.files[0])] : [];
  if (!text && !files.length) return;
  inputEl.value = '';
  clearAttachment();
  await sendToChat(chat, text || ('📎 ' + files[0].name), files);
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
