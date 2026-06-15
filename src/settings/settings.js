/** Settings: theme, API keys, provider, editable base prompts, 7-day history. */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { initTheme, getThemePref, setThemePref } from '../common/theme.js';
import { iconSvg } from '../common/icons.js';

initTheme();

const KEY_FIELDS = ['openrouterApiKey', 'groqApiKey', 'supabaseUrl', 'supabaseAnonKey'];
const CATS = Object.values(PROMPT_CATEGORIES);

// Display metadata for each prompt category: an icon, a title and the subjects
// it covers. Keeps the markup DRY — the editors are generated, not hand-written.
const PROMPT_META = {
  [PROMPT_CATEGORIES.WORKED_SOLUTION]: { icon: 'flask', title: 'Точные науки', sub: 'Алгебра · Геометрия · Физика · Химия' },
  [PROMPT_CATEGORIES.DIRECT_ANSWER]: { icon: 'globe', title: 'Языки', sub: 'Английский — только ответы' },
  [PROMPT_CATEGORIES.PARAGRAPH_SUMMARY]: { icon: 'map', title: 'Гуманитарные параграфы', sub: 'История · Обществознание · География' },
  [PROMPT_CATEGORIES.RUSSIAN_FULL]: { icon: 'pen', title: 'Русский язык', sub: 'Полное упражнение со вставками' },
  [PROMPT_CATEGORIES.LITERATURE]: { icon: 'book', title: 'Литература', sub: 'Анализ произведений' },
  [PROMPT_CATEGORIES.TEST_ANSWER]: { icon: 'listChecks', title: 'Тесты МЭШ', sub: 'Только номер и ответ' }
};

/* ---------- Theme segmented control ---------- */

const segButtons = [...document.querySelectorAll('#themeSeg button')];
function markActivePref(pref) {
  for (const b of segButtons) b.classList.toggle('active', b.dataset.pref === pref);
}
for (const b of segButtons) {
  b.onclick = async () => { await setThemePref(b.dataset.pref); markActivePref(b.dataset.pref); };
}
getThemePref().then(markActivePref);
document.addEventListener('themechange', async () => markActivePref(await getThemePref()));

/* ---------- Build the prompt editors ---------- */

function buildPromptEditors() {
  const list = document.getElementById('promptList');
  for (const cat of CATS) {
    const meta = PROMPT_META[cat] || { icon: 'fileText', title: cat, sub: '' };
    const field = document.createElement('div');
    field.className = 'field promptfield';
    field.innerHTML = `
      <div class="field-head">
        <span class="subj-ic">${iconSvg(meta.icon, 16)}</span>
        <label for="p_${cat}">${meta.title}<span class="sub">${meta.sub}</span></label>
        <button class="resetbtn" type="button" data-reset="${cat}">${iconSvg('reset', 12)}Сброс</button>
      </div>
      <textarea id="p_${cat}"></textarea>
      <div class="charcount" data-count="${cat}"></div>`;
    list.appendChild(field);

    const ta = field.querySelector(`#p_${cat}`);
    const counter = field.querySelector(`[data-count="${cat}"]`);
    const resetBtn = field.querySelector(`[data-reset="${cat}"]`);
    const refresh = () => {
      counter.textContent = `${ta.value.length} символов`;
      resetBtn.disabled = ta.value.trim() === DEFAULT_PROMPTS[cat].trim();
    };
    ta.addEventListener('input', refresh);
    resetBtn.onclick = () => { ta.value = DEFAULT_PROMPTS[cat]; refresh(); };
    ta._refresh = refresh;
  }
}

/* ---------- Reveal (show/hide) toggles for secret fields ---------- */

function wireReveals() {
  for (const btn of document.querySelectorAll('.reveal')) {
    const input = document.getElementById(btn.dataset.reveal);
    const sync = () => { btn.innerHTML = iconSvg(input.type === 'password' ? 'eye' : 'eyeOff', 16); };
    sync();
    btn.onclick = () => { input.type = input.type === 'password' ? 'text' : 'password'; sync(); };
  }
}

/* ---------- Load / save ---------- */

async function load() {
  const stored = await chrome.storage.local.get([...KEY_FIELDS, 'promptOverrides', 'aiProvider']);
  for (const f of KEY_FIELDS) document.getElementById(f).value = stored[f] || '';
  document.getElementById('aiProvider').value = stored.aiProvider || 'openrouter';
  const overrides = stored.promptOverrides || {};
  for (const cat of CATS) {
    const ta = document.getElementById('p_' + cat);
    ta.value = overrides[cat] || DEFAULT_PROMPTS[cat];
    ta._refresh?.();
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
  s.innerHTML = `${iconSvg('check', 14)}Сохранено`;
  s.classList.add('show');
  setTimeout(() => s.classList.remove('show'), 2200);
}

/* ---------- History ---------- */

function loadHistory() {
  const box = document.getElementById('history');
  box.innerHTML = `<div class="loading"><span class="spinner"></span><span>Загрузка…</span></div>`;
  chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (resp) => {
    if (chrome.runtime.lastError || !resp?.ok) {
      box.innerHTML = `<div class="empty">${iconSvg('alert', 15)}<span>Не удалось загрузить: ${resp?.error || 'нет данных'}</span></div>`;
      return;
    }
    if (!resp.sessions?.length) {
      box.innerHTML = `<div class="empty">${iconSvg('clock', 15)}<span>Пока пусто — решённые задания появятся здесь.</span></div>`;
      return;
    }
    box.innerHTML = '';
    for (const s of resp.sessions) {
      const d = document.createElement('div');
      d.className = 'session';
      const top = document.createElement('div');
      top.className = 'session-top';
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = s.subject || 'Задание';
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = new Date(s.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      top.append(pill, date);
      const task = document.createElement('div');
      task.className = 'task';
      task.textContent = s.task_text || '(без описания)';
      d.append(top, task);
      box.appendChild(d);
    }
  });
}

/* ---------- Init ---------- */

buildPromptEditors();
wireReveals();
document.getElementById('save').onclick = save;
document.getElementById('reload').onclick = loadHistory;
load();
