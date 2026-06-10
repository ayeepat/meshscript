/** Settings: theme, API keys, provider, editable base prompts, 7-day history viewer. */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { initTheme, getThemePref, setThemePref } from '../common/theme.js';

initTheme();

const segButtons = [...document.querySelectorAll('#themeSeg button')];

function markActivePref(pref) {
  for (const b of segButtons) b.classList.toggle('active', b.dataset.pref === pref);
}

for (const b of segButtons) {
  b.onclick = async () => {
    await setThemePref(b.dataset.pref);
    markActivePref(b.dataset.pref);
  };
}
getThemePref().then(markActivePref);
// Follow theme changes made elsewhere (e.g. the dashboard toggle).
document.addEventListener('themechange', async () => markActivePref(await getThemePref()));

const KEY_FIELDS = ['openrouterApiKey', 'geminiApiKey', 'groqApiKey', 'supabaseUrl', 'supabaseAnonKey'];
const CATS = Object.values(PROMPT_CATEGORIES);

async function load() {
  const stored = await chrome.storage.local.get([...KEY_FIELDS, 'promptOverrides', 'aiProvider']);
  for (const f of KEY_FIELDS) document.getElementById(f).value = stored[f] || '';
  document.getElementById('aiProvider').value = stored.aiProvider || 'openrouter';
  const overrides = stored.promptOverrides || {};
  for (const cat of CATS) {
    document.getElementById('p_' + cat).value = overrides[cat] || DEFAULT_PROMPTS[cat];
  }
}

async function save() {
  const data = {};
  for (const f of KEY_FIELDS) data[f] = document.getElementById(f).value.trim();
  data.aiProvider = document.getElementById('aiProvider').value;
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
