/** Settings: API keys, editable base prompts, 7-day history viewer. */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';

const KEY_FIELDS = ['geminiApiKey', 'supabaseUrl', 'supabaseAnonKey'];
const CATS = Object.values(PROMPT_CATEGORIES);

async function load() {
  const stored = await chrome.storage.local.get([...KEY_FIELDS, 'promptOverrides']);
  for (const f of KEY_FIELDS) document.getElementById(f).value = stored[f] || '';
  const overrides = stored.promptOverrides || {};
  for (const cat of CATS) {
    document.getElementById('p_' + cat).value = overrides[cat] || DEFAULT_PROMPTS[cat];
  }
}

async function save() {
  const data = {};
  for (const f of KEY_FIELDS) data[f] = document.getElementById(f).value.trim();
  const promptOverrides = {};
  for (const cat of CATS) {
    const v = document.getElementById('p_' + cat).value.trim();
    if (v && v !== DEFAULT_PROMPTS[cat]) promptOverrides[cat] = v;
  }
  data.promptOverrides = promptOverrides;
  await chrome.storage.local.set(data);
  const s = document.getElementById('status');
  s.textContent = '✓ Сохранено';
  setTimeout(() => (s.textContent = ''), 2000);
}

function loadHistory() {
  const box = document.getElementById('history');
  box.innerHTML = 'Загрузка…';
  chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (resp) => {
    if (!resp?.ok) { box.textContent = 'Ошибка: ' + (resp?.error || 'нет данных'); return; }
    box.innerHTML = '';
    if (!resp.sessions?.length) { box.textContent = 'Пусто.'; return; }
    for (const s of resp.sessions) {
      const d = document.createElement('div');
      d.className = 'session';
      d.textContent = `[${new Date(s.created_at).toLocaleString()}] ${s.subject}: ${s.task_text || ''}`;
      box.appendChild(d);
    }
  });
}

document.getElementById('save').onclick = save;
document.getElementById('reload').onclick = loadHistory;
load();
