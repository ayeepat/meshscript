/** Full-window dashboard: sidebar history + chat solve view. */

const params = new URLSearchParams(location.search);
const subject = params.get('subject') || '';
const initialTask = params.get('task') || '';
let sessionId = null;

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
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'SOLVE', payload: { subject, task, files, sessionId } },
      (resp) => {
        if (chrome.runtime.lastError || !resp?.ok) {
          bubble('assistant', 'Ошибка: ' + (resp?.error || chrome.runtime.lastError?.message));
          return resolve();
        }
        sessionId = resp.result.sessionId || sessionId;
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
  chrome.runtime.sendMessage({ type: 'LIST_MESSAGES', sessionId: s.id }, (resp) => {
    if (!resp?.ok) return;
    for (const m of resp.messages || []) bubble(m.role === 'assistant' ? 'assistant' : 'user', m.content);
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

// Auto-run the initial task from the popup.
(async function init() {
  await loadSessions();
  if (initialTask) {
    bubble('user', initialTask);
    const thinking = bubble('assistant', 'Думаю…');
    await send(initialTask, []);
    thinking.remove();
    loadSessions();
  }
})();
