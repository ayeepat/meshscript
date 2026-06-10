/** Full-window dashboard: sidebar history + chat solve view. */
import { buildFirstUserMessage } from '../lib/subject-router.js';

const params = new URLSearchParams(location.search);
const subject = params.get('subject') || '';
const initialTask = params.get('task') || '';
let sessionId = null;
const history = []; // [{role:'user'|'assistant', content:string}] — sent to the AI for memory

const chatEl = document.getElementById('chat');
const titleEl = document.getElementById('title');
titleEl.textContent = subject ? `${subject} — решение` : 'Решение';

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
  const lines = escapeHtml(md).split(/\r?\n/);
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
  return html;
}

/* ---------- Typewriter: starts slow, accelerates, finishes fast ---------- */

function typewriter(el, fullText) {
  let i = 0;
  let chunk = 1; // chars per frame; grows each frame -> accelerating reveal
  function step() {
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

function fileToInline(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mimeType: file.type || 'application/octet-stream', dataBase64: String(r.result).split(',')[1], name: file.name });
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function send(task, files) {
  const prior = history.slice(); // turns BEFORE this message
  history.push({ role: 'user', content: task });
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'SOLVE', payload: { subject, task, files, sessionId, history: prior } },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          bubble('assistant', 'Ошибка: ' + (resp?.error || chrome.runtime.lastError?.message));
          return resolve();
        }
        sessionId = resp.result.sessionId || sessionId;
        history.push({ role: 'assistant', content: resp.result.answer });
        bubble('assistant', resp.result.answer, { animate: true });
        resolve();
      }
    );
  });
}

async function loadSessions() {
  chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (resp) => {
    if (!resp?.ok) return;
    const box = document.getElementById('sessions');
    box.innerHTML = '';
    for (const s of resp.sessions || []) {
      const el = document.createElement('div');
      el.className = 's';
      el.textContent = `${s.subject || '?'}: ${(s.task_text || '').slice(0, 40)}`;
      el.onclick = () => openSession(s);
      box.appendChild(el);
    }
  });
}

function openSession(s) {
  sessionId = s.id;
  titleEl.textContent = `${s.subject} — решение`;
  chatEl.innerHTML = '';
  history.length = 0;
  chrome.runtime.sendMessage({ type: 'LIST_MESSAGES', sessionId: s.id }, (resp) => {
    if (!resp?.ok) return;
    for (const m of resp.messages || []) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      history.push({ role, content: m.content });
      bubble(role, m.content); // no animation for restored history
    }
  });
}

document.getElementById('send').onclick = async () => {
  const input = document.getElementById('input');
  const fileInput = document.getElementById('file');
  const task = input.value.trim();
  const files = fileInput.files[0] ? [await fileToInline(fileInput.files[0])] : [];
  if (!task && !files.length) return;
  bubble('user', task || ('📎 ' + files[0].name));
  input.value = '';
  fileInput.value = '';
  const thinking = bubble('assistant', 'Думаю…');
  await send(task, files);
  thinking.remove();
  loadSessions();
};

// Auto-run the initial task from the popup:
// first message = full subject prompt from Settings + the task itself.
(async function init() {
  await loadSessions();
  if (initialTask) {
    const firstMessage = await buildFirstUserMessage(subject, initialTask);
    bubble('user', firstMessage);
    const thinking = bubble('assistant', 'Думаю…');
    await send(firstMessage, []);
    thinking.remove();
    loadSessions();
  }
})();
