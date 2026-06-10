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

function bubble(role, text) {
  const d = document.createElement('div');
  d.className = `msg ${role}`;
  d.textContent = text;
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
        bubble('assistant', resp.result.answer);
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
      bubble(role, m.content);
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
