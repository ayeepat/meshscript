/** Settings: theme, API keys, provider, GDZ textbooks, prompts, 7-day history. */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { initTheme, getThemePref, setThemePref } from '../common/theme.js';
import { iconSvg } from '../common/icons.js';
import { EXERCISE_SUBJECTS } from '../lib/gdz-match.js';

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

/* ---------- Textbooks (GDZ) ---------- */

// gdzBooks: { [subjectId]: { url, title, breadcrumb, year, authors, study_level,
//            subtype, cover_url, subjectId } }. Keyed by catalog subject_id so the
// dashboard can look a book up from a Mesh subject via mapSubjectToId.
let gdzBooks = {};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const subjTitle = (id) => (EXERCISE_SUBJECTS.find((s) => String(s.id) === String(id))?.title) || `Предмет ${id}`;

// "10 класс", "7–9 класс" (contiguous range), or "5, 7 класс".
function classesLabel(classes) {
  const c = [...new Set((classes || []).map(Number))].sort((a, b) => a - b);
  if (!c.length) return '';
  const contiguous = c.every((v, i) => i === 0 || v === c[i - 1] + 1);
  return (c.length === 1 ? `${c[0]}` : contiguous ? `${c[0]}–${c[c.length - 1]}` : c.join(', ')) + ' класс';
}
// No inline onerror handler — MV3's page CSP blocks inline JS. A missing cover
// just shows the empty framed box, which is fine.
const coverHtml = (url, cls) => (url
  ? `<img class="cover ${cls}" src="${esc(url)}" alt="" loading="lazy">`
  : `<span class="cover ${cls} ph">${iconSvg('book', 16)}</span>`);

function gdzSend(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => resolve(chrome.runtime.lastError ? null : resp));
  });
}

function renderBooks() {
  const box = document.getElementById('gdzBooks');
  const ids = Object.keys(gdzBooks);
  if (!ids.length) {
    box.innerHTML = '<div class="empty">Учебники не выбраны. Нажмите «Добавить», чтобы получать готовые ответы из ГДЗ вместо запроса фото.</div>';
    return;
  }
  box.innerHTML = '';
  for (const id of ids) {
    const b = gdzBooks[id];
    const row = document.createElement('div');
    row.className = 'gdzrow';
    row.innerHTML =
      coverHtml(b.cover_url, '') +
      `<div class="meta">
         <div class="subj">${esc(subjTitle(id))}</div>
         <div class="ttl">${esc(b.breadcrumb || b.title || '')}</div>
         <div class="det">${esc([classesLabel(b.classes), b.subtype, b.year].filter(Boolean).join(' · '))}</div>
       </div>` +
      (b.is_paid ? '<span class="badge paid">платно</span>' : '') +
      (/углуб/i.test(b.study_level || '') ? '<span class="badge">Углубл.</span>' : '') +
      `<div class="row-actions">
         <button data-edit="${esc(id)}" type="button">Изменить</button>
         <button data-del="${esc(id)}" type="button">Убрать</button>
       </div>`;
    box.appendChild(row);
  }
  box.querySelectorAll('[data-edit]').forEach((btn) => { btn.onclick = () => openPicker(btn.dataset.edit); });
  box.querySelectorAll('[data-del]').forEach((btn) => {
    btn.onclick = async () => { delete gdzBooks[btn.dataset.del]; await chrome.storage.local.set({ gdzBooks }); renderBooks(); };
  });
}

let pickerTimer = null;

function openPicker(subjectId) {
  const sel = document.getElementById('gdzPickSubject');
  sel.innerHTML = EXERCISE_SUBJECTS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
  if (subjectId != null) sel.value = String(subjectId);
  document.getElementById('gdzPickSearch').value = '';
  // When editing, pre-select the saved book's type so a workbook doesn't reset
  // to the "Учебник" tab.
  const savedType = (subjectId != null && gdzBooks[subjectId]?.subtype === 'Рабочая тетрадь') ? 'Рабочая тетрадь' : 'Учебник';
  document.querySelectorAll('#gdzPickType button').forEach((b) => b.classList.toggle('active', b.dataset.st === savedType));
  document.getElementById('gdzPicker').hidden = false;
  runBookSearch();
}
const closePicker = () => { document.getElementById('gdzPicker').hidden = true; };

async function runBookSearch() {
  const results = document.getElementById('gdzPickResults');
  const grade = document.getElementById('studentGrade').value;
  const subjectId = document.getElementById('gdzPickSubject').value;
  const subtype = document.querySelector('#gdzPickType button.active')?.dataset.st || 'Учебник';
  const query = document.getElementById('gdzPickSearch').value.trim();
  // Grade is required: without it the list mixes every grade and the matcher
  // later can't trust the book either.
  if (!grade) {
    results.innerHTML = `<div class="empty">${iconSvg('info', 15)}<span>Сначала выберите класс выше.</span></div>`;
    return;
  }
  results.innerHTML = `<div class="loading"><span class="spinner"></span><span>Загрузка каталога…</span></div>`;

  const resp = await gdzSend('GDZ_SEARCH', { grade, subjectId, subtype, query });
  if (!resp?.ok) {
    results.innerHTML = `<div class="empty">${iconSvg('alert', 15)}<span>Не удалось загрузить каталог ГДЗ.</span></div>`;
    return;
  }
  const books = (resp.books || []).slice(0, 50);
  if (!books.length) {
    results.innerHTML = `<div class="empty">${iconSvg('search', 15)}<span>Ничего не найдено. Проверьте класс или измените запрос.</span></div>`;
    return;
  }
  results.innerHTML = '';
  for (const b of books) {
    const el = document.createElement('div');
    el.className = 'gdz-result';
    el.innerHTML =
      coverHtml(b.cover_url, '') +
      `<div class="info">
         <div class="ttl">${esc(b.breadcrumb || b.title)}</div>
         <div class="det">${esc([classesLabel(b.classes), b.study_level, b.year].filter(Boolean).join(' · '))}</div>
       </div>` +
      (b.is_paid ? '<span class="tag paid">платно · без картинок</span>' : '<span class="tag">выбрать</span>');
    el.onclick = () => saveBook(subjectId, b);
    results.appendChild(el);
  }
}

async function saveBook(subjectId, b) {
  gdzBooks[subjectId] = {
    url: b.url, title: b.title, breadcrumb: b.breadcrumb, year: b.year, authors: b.authors,
    study_level: b.study_level, subtype: b.subtype, cover_url: b.cover_url,
    classes: b.classes, is_paid: b.is_paid, subjectId: Number(subjectId)
  };
  await chrome.storage.local.set({ gdzBooks });
  closePicker();
  renderBooks();
}

async function loadGdz() {
  const { studentGrade = '', gdzBooks: stored = {} } = await chrome.storage.local.get(['studentGrade', 'gdzBooks']);
  gdzBooks = stored;
  document.getElementById('studentGrade').value = studentGrade || '';
  renderBooks();
}

function wireGdz() {
  document.getElementById('studentGrade').onchange = async (e) => {
    await chrome.storage.local.set({ studentGrade: e.target.value });
    if (!document.getElementById('gdzPicker').hidden) runBookSearch();
  };
  document.getElementById('gdzAddBtn').onclick = () => openPicker(null);
  document.getElementById('gdzPickClose').onclick = closePicker;
  document.getElementById('gdzPicker').onclick = (e) => { if (e.target.id === 'gdzPicker') closePicker(); };
  document.getElementById('gdzPickSubject').onchange = runBookSearch;
  document.getElementById('gdzPickSearch').oninput = () => { clearTimeout(pickerTimer); pickerTimer = setTimeout(runBookSearch, 300); };
  document.querySelectorAll('#gdzPickType button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#gdzPickType button').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      runBookSearch();
    };
  });
}

/* ---------- Init ---------- */

buildPromptEditors();
wireReveals();
wireGdz();
document.getElementById('save').onclick = save;
document.getElementById('reload').onclick = loadHistory;
load();
loadGdz();
