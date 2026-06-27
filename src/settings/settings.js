/** Settings: theme, API keys, provider, daily limits, GDZ textbooks, prompts, 7-day history. */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../lib/prompts.js';
import { initTheme, getThemePref, setThemePref } from '../common/theme.js';
import { iconSvg } from '../common/icons.js';
import { EXERCISE_SUBJECTS } from '../lib/gdz-match.js';
import { DEFAULT_LIMITS, getUsage, getUsageHistory } from '../lib/rate-limit.js';
import { setLicenseKey, getLicenseStatus, reasonMessage } from '../lib/license.js';
import { hasConsent, setConsent } from '../lib/consent.js';
import { SUPPORT_BOT_URL } from '../lib/config.js';

initTheme();

// Point the «Поддержка» card at the support bot (single source of truth in config.js).
const supportLink = document.getElementById('supportLink');
if (supportLink) supportLink.href = SUPPORT_BOT_URL;

const KEY_FIELDS = ['openrouterApiKey', 'groqApiKey', 'nararouterApiKey'];
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
  const stored = await chrome.storage.local.get([...KEY_FIELDS, 'promptOverrides', 'aiProvider', 'rateLimits']);
  for (const f of KEY_FIELDS) document.getElementById(f).value = stored[f] || '';
  document.getElementById('aiProvider').value = stored.aiProvider || 'openrouter';
  const limits = stored.rateLimits || {};
  document.getElementById('limitOpenrouter').value = limits.openrouter ?? DEFAULT_LIMITS.openrouter;
  document.getElementById('limitGroq').value = limits.groq ?? DEFAULT_LIMITS.groq;
  document.getElementById('limitNararouter').value = limits.nararouter ?? DEFAULT_LIMITS.nararouter;
  const overrides = stored.promptOverrides || {};
  for (const cat of CATS) {
    const ta = document.getElementById('p_' + cat);
    ta.value = overrides[cat] || DEFAULT_PROMPTS[cat];
    ta._refresh?.();
  }
  await refreshUsage();
  refreshUsageDashboard(); // async, not awaited — the credits fetch shouldn't block the form
  await loadLicenseUi();
  await loadConsentUi();
}

/* ---------- License key ---------- */

async function loadLicenseUi() {
  const status = await getLicenseStatus();
  document.getElementById('licenseKey').value = status?.key || '';
  renderLicenseStatus(status);
}

function renderLicenseStatus(status) {
  const pill = document.getElementById('licStatus');
  if (!status || !status.key) {
    pill.textContent = 'Не активирована';
    pill.dataset.state = 'idle';
    return;
  }
  if (status.ok) {
    const label = status.owner
      ? 'Активна · доступ владельца'
      : (status.type === 'subscription' ? 'Активна · подписка' : 'Активна');
    pill.textContent = label;
    pill.dataset.state = 'ok';
    return;
  }
  pill.textContent = reasonMessage(status.reason);
  pill.dataset.state = status.reason === 'network' ? 'warn' : 'err';
}

/* ---------- Privacy consent ---------- */

function renderConsentStatus(accepted) {
  const pill = document.getElementById('consentStatus');
  pill.textContent = accepted ? 'Согласие дано' : 'Не подтверждено';
  pill.dataset.state = accepted ? 'ok' : 'warn';
}

async function loadConsentUi() {
  const accepted = await hasConsent();
  document.getElementById('consentToggle').checked = accepted;
  renderConsentStatus(accepted);
}

function wireConsent() {
  document.getElementById('consentToggle').onchange = async (e) => {
    await setConsent(e.target.checked);
    renderConsentStatus(e.target.checked);
  };
}

async function refreshUsage() {
  const usage = await getUsage();
  const fmt = (u) => `${u.used} / ${u.limit} сегодня`;
  document.getElementById('usageOpenrouter').textContent = fmt(usage.openrouter);
  document.getElementById('usageGroq').textContent = fmt(usage.groq);
  document.getElementById('usageNararouter').textContent = fmt(usage.nararouter);
}

/* ---------- Usage & spend dashboard ---------- */

// Loaded by refreshUsageDashboard(), read by renderChart().
let reqHistory = [];   // [{ day, openrouter, groq }]
let spendHistory = []; // [{ day, spend }]  (OpenRouter $/day, from snapshots)
let chartMode = 'req'; // 'req' | 'usd'

const fmtUsd = (n) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// 'YYYY-MM-DD' → 'D.M'
const shortDay = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)}.${Number(m)}`; };

// OpenRouter balance via the service worker (keeps the network call + key in the
// worker, and records the daily spend snapshot as a side effect).
function fetchCredits() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OPENROUTER_CREDITS' }, (r) => resolve(chrome.runtime.lastError ? null : r));
  });
}

function renderSpend(c) {
  const spent = document.getElementById('orSpent');
  const remain = document.getElementById('orRemain');
  const bar = document.getElementById('balanceBar');
  const fill = document.getElementById('balanceFill');
  const note = document.getElementById('spendNote');
  if (c && c.ok) {
    spent.textContent = fmtUsd(c.usage);
    remain.textContent = fmtUsd(c.remaining);
    if (c.total > 0) {
      bar.hidden = false;
      fill.style.width = Math.min(100, Math.max(0, (c.usage / c.total) * 100)).toFixed(1) + '%';
    } else { bar.hidden = true; }
    note.textContent = '';
  } else {
    spent.textContent = '—';
    remain.textContent = '—';
    bar.hidden = true;
    note.textContent = c?.reason === 'no_key'
      ? 'Добавьте ключ OpenRouter выше, чтобы видеть баланс и траты.'
      : 'Не удалось получить баланс OpenRouter — проверьте ключ и интернет.';
  }
}

// Compact responsive bar chart (inline SVG). Requests mode = grouped OR+Groq
// bars; dollars mode = single OpenRouter spend bar. Exact values ride on each
// bar's <title> for hover.
function chartSvg(mode) {
  const W = 340, H = 110, padT = 10, padB = 18, padX = 6;
  const plotW = W - padX * 2, plotH = H - padT - padB;
  const days = (mode === 'usd' ? spendHistory : reqHistory).map((d) => d.day);
  const n = days.length || 1;
  const colW = plotW / n;
  const baselineY = padT + plotH;

  let max = 0;
  if (mode === 'usd') for (const d of spendHistory) max = Math.max(max, d.spend);
  else for (const d of reqHistory) max = Math.max(max, d.openrouter, d.groq);
  if (max <= 0) max = 1;

  const bars = [];
  for (let i = 0; i < n; i++) {
    const cx = padX + i * colW;
    if (mode === 'usd') {
      const v = spendHistory[i].spend;
      const h = (v / max) * plotH;
      const bw = Math.max(3, colW * 0.6);
      bars.push(`<rect class="bar bar-usd" x="${(cx + (colW - bw) / 2).toFixed(1)}" y="${(baselineY - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${shortDay(days[i])}: ${fmtUsd(v)}</title></rect>`);
    } else {
      const o = reqHistory[i].openrouter, g = reqHistory[i].groq;
      const bw = Math.max(2, colW * 0.3), gap = colW * 0.08;
      const bx = cx + (colW - (bw * 2 + gap)) / 2;
      const ho = (o / max) * plotH, hg = (g / max) * plotH;
      bars.push(`<rect class="bar bar-or" x="${bx.toFixed(1)}" y="${(baselineY - ho).toFixed(1)}" width="${bw.toFixed(1)}" height="${ho.toFixed(1)}" rx="1.5"><title>${shortDay(days[i])}: OpenRouter ${o}</title></rect>`);
      bars.push(`<rect class="bar bar-groq" x="${(bx + bw + gap).toFixed(1)}" y="${(baselineY - hg).toFixed(1)}" width="${bw.toFixed(1)}" height="${hg.toFixed(1)}" rx="1.5"><title>${shortDay(days[i])}: Groq ${g}</title></rect>`);
    }
  }

  const labelIdx = new Set([0, Math.floor(n / 2), n - 1]);
  const labels = [];
  for (let i = 0; i < n; i++) {
    if (!labelIdx.has(i)) continue;
    labels.push(`<text class="xlab" x="${(padX + i * colW + colW / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${shortDay(days[i])}</text>`);
  }
  const base = `<line class="axis" x1="${padX}" y1="${baselineY}" x2="${W - padX}" y2="${baselineY}"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${base}${bars.join('')}${labels.join('')}</svg>`;
}

function renderLegend(mode) {
  const legend = document.getElementById('chartLegend');
  legend.innerHTML = mode === 'usd'
    ? '<span class="lg"><i class="sw or"></i>Траты OpenRouter, $/день</span>'
    : '<span class="lg"><i class="sw or"></i>OpenRouter</span><span class="lg"><i class="sw groq"></i>Groq · бесплатно</span>';
}

function renderChart(mode) {
  const host = document.getElementById('usageChart');
  const hasReq = reqHistory.some((d) => d.openrouter + d.groq > 0);
  const hasUsd = spendHistory.some((d) => d.spend > 0);
  if (mode === 'usd' && !hasUsd) {
    host.innerHTML = '<div class="chartempty">Данные о тратах по дням ещё копятся — загляните завтра. Общий расход — в плитке «Потрачено».</div>';
  } else if (mode !== 'usd' && !hasReq) {
    host.innerHTML = '<div class="chartempty">Пока нет запросов за этот период.</div>';
  } else {
    host.innerHTML = chartSvg(mode);
  }
  renderLegend(mode);
}

async function refreshUsageDashboard() {
  const [usage, hist] = await Promise.all([getUsage(), getUsageHistory(14)]);
  reqHistory = hist;
  document.getElementById('orToday').textContent = `${usage.openrouter.used} / ${usage.openrouter.limit}`;
  const credits = await fetchCredits();
  spendHistory = (credits && credits.spendHistory) || [];
  renderSpend(credits);
  renderChart(chartMode);
}

function wireUsageDashboard() {
  document.getElementById('usageReload').onclick = () => refreshUsageDashboard();
  document.querySelectorAll('#chartMode button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#chartMode button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      chartMode = b.dataset.mode;
      renderChart(chartMode);
    };
  });
}

async function save() {
  const data = {};
  for (const f of KEY_FIELDS) data[f] = document.getElementById(f).value.trim();
  data.aiProvider = document.getElementById('aiProvider').value;
  const orLimit = Math.max(1, parseInt(document.getElementById('limitOpenrouter').value, 10) || DEFAULT_LIMITS.openrouter);
  const groqLimit = Math.max(1, parseInt(document.getElementById('limitGroq').value, 10) || DEFAULT_LIMITS.groq);
  const naraLimit = Math.max(1, parseInt(document.getElementById('limitNararouter').value, 10) || DEFAULT_LIMITS.nararouter);
  data.rateLimits = { openrouter: orLimit, groq: groqLimit, nararouter: naraLimit };
  const promptOverrides = {};
  for (const cat of CATS) {
    const v = document.getElementById('p_' + cat).value.trim();
    if (v && v !== DEFAULT_PROMPTS[cat]) promptOverrides[cat] = v;
  }
  data.promptOverrides = promptOverrides;
  await chrome.storage.local.set(data);
  await refreshUsage();
  refreshUsageDashboard(); // reflect the new limit in the «Сегодня · N / лимит» tile
  // Verify license against the backend ONLY when the key changed — saves a
  // network round-trip when the user is just editing prompts or limits.
  const newKey = document.getElementById('licenseKey').value.trim().toUpperCase();
  const priorStatus = await getLicenseStatus();
  if ((priorStatus?.key || '') !== newKey) {
    const fresh = await setLicenseKey(newKey);
    renderLicenseStatus(fresh);
  }
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

// gdzBooks: { [subjectId]: [ { url, title, breadcrumb, year, authors, study_level,
//            subtype, cover_url, subjectId, subject_id }, ... ] }. Keyed by catalog
// subject_id (the dashboard looks a subject up via mapSubjectToId); the VALUE is an
// array so one subject can hold both a textbook AND its workbook. Legacy installs
// stored a single object per subject — `asBookArray` normalises that on read.
let gdzBooks = {};

// Inline catalog browser state. The full result set lives here; the DOM is filled
// in batches as the user scrolls (the catalog can return hundreds of books).
let browseResults = [];
let browseShown = 0;
const BROWSE_BATCH = 24;
let pickerTimer = null;

const asBookArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

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

// Is this catalog book already pinned for its subject? (dedupe by url)
const isAdded = (b) => asBookArray(gdzBooks[String(b.subject_id)]).some((x) => x.url === b.url);

/** Render the student's pinned books — flattened across every subject. */
function renderBooks() {
  const box = document.getElementById('gdzBooks');
  const rows = [];
  for (const id of Object.keys(gdzBooks)) for (const b of asBookArray(gdzBooks[id])) rows.push([id, b]);
  if (!rows.length) {
    box.innerHTML = '<div class="empty">Учебники ещё не выбраны. Найдите их в каталоге ниже — готовые ответы из ГДЗ будут подставляться автоматически вместо запроса фото.</div>';
    return;
  }
  box.innerHTML = '';
  for (const [id, b] of rows) {
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
         <button data-del-sid="${esc(id)}" data-del-url="${esc(b.url)}" type="button">Убрать</button>
       </div>`;
    box.appendChild(row);
  }
  box.querySelectorAll('[data-del-url]').forEach((btn) => {
    btn.onclick = () => removeBook(btn.dataset.delSid, btn.dataset.delUrl);
  });
}

/** Populate the catalog subject filter ("Все предметы" + curated subjects). */
function buildSubjectFilter() {
  const sel = document.getElementById('gdzPickSubject');
  sel.innerHTML =
    `<option value="all">Все предметы</option>` +
    EXERCISE_SUBJECTS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
}

/** Query the catalog and reset the infinite-scroll buffer. */
async function runBookSearch() {
  const results = document.getElementById('gdzPickResults');
  const count = document.getElementById('gdzCount');
  const grade = document.getElementById('studentGrade').value;
  const subjectId = document.getElementById('gdzPickSubject').value; // 'all' | id
  const subtype = document.querySelector('#gdzPickType button.active')?.dataset.st || '';
  const query = document.getElementById('gdzPickSearch').value.trim();

  browseResults = [];
  browseShown = 0;
  // Grade is required: without it the list mixes every grade and the matcher
  // later can't trust the book either.
  if (!grade) {
    count.textContent = '';
    results.innerHTML = `<div class="empty">${iconSvg('info', 15)}<span>Сначала выберите класс выше.</span></div>`;
    return;
  }
  results.innerHTML = `<div class="loading"><span class="spinner"></span><span>Загрузка каталога…</span></div>`;

  const resp = await gdzSend('GDZ_SEARCH', { grade, subjectId, subtype, query });
  if (!resp?.ok) {
    count.textContent = '';
    results.innerHTML = `<div class="empty">${iconSvg('alert', 15)}<span>Не удалось загрузить каталог ГДЗ.</span></div>`;
    return;
  }
  // Only surface subjects the extension can map back from a Mesh lesson — pinning
  // a book for an unmappable subject would never resolve. (No-op when a single
  // subject is already selected; it's one of the allowed ids.)
  const allowed = new Set(EXERCISE_SUBJECTS.map((s) => s.id));
  browseResults = (resp.books || []).filter((b) => allowed.has(b.subject_id));
  if (!browseResults.length) {
    count.textContent = '';
    results.innerHTML = `<div class="empty">${iconSvg('search', 15)}<span>Ничего не найдено. Проверьте класс или измените запрос.</span></div>`;
    return;
  }
  results.innerHTML = '';
  renderResultBatch();
}

const subtypeLabel = (b) => /тетрад/i.test(b.subtype || '') ? 'Раб. тетрадь' : (b.subtype || 'Учебник');

/** Append the next BROWSE_BATCH results to the list (infinite scroll). */
function renderResultBatch() {
  const results = document.getElementById('gdzPickResults');
  const count = document.getElementById('gdzCount');
  const slice = browseResults.slice(browseShown, browseShown + BROWSE_BATCH);
  for (const b of slice) results.appendChild(resultRow(b));
  browseShown += slice.length;
  count.textContent = `найдено ${browseResults.length}` + (browseShown < browseResults.length ? ` · показано ${browseShown}` : '');
}

function resultRow(b) {
  const el = document.createElement('div');
  el.dataset.url = b.url;
  paintResultRow(el, b);
  return el;
}

// Fill a result row's content + handler for the book's CURRENT added state. Used
// both on first render and to update one row in place after add/remove — mutating
// a row's innerHTML (not the container's) keeps the scroll position intact.
function paintResultRow(el, b) {
  const added = isAdded(b);
  el.className = 'gdz-result' + (added ? ' added' : '');
  el.innerHTML =
    coverHtml(b.cover_url, '') +
    `<div class="info">
       <div class="subj">${esc(subjTitle(b.subject_id))} · ${esc(subtypeLabel(b))}</div>
       <div class="ttl">${esc(b.breadcrumb || b.title)}</div>
       <div class="det">${esc([classesLabel(b.classes), b.study_level, b.year].filter(Boolean).join(' · '))}</div>
     </div>` +
    (b.is_paid ? '<span class="tag paid">платно · без картинок</span>' : '') +
    (added
      ? `<span class="tag added">${iconSvg('check', 12)}добавлено</span>`
      : `<span class="tag">${iconSvg('plus', 12)}добавить</span>`);
  el.onclick = () => (isAdded(b) ? removeBook(String(b.subject_id), b.url) : addBook(b));
}

async function addBook(b) {
  const sid = String(b.subject_id);
  const arr = (gdzBooks[sid] = asBookArray(gdzBooks[sid]));
  if (arr.some((x) => x.url === b.url)) return;
  arr.push({
    url: b.url, title: b.title, breadcrumb: b.breadcrumb, year: b.year, authors: b.authors,
    study_level: b.study_level, subtype: b.subtype, cover_url: b.cover_url,
    classes: b.classes, is_paid: b.is_paid, subjectId: Number(sid), subject_id: Number(sid)
  });
  await chrome.storage.local.set({ gdzBooks });
  renderBooks();
  syncResultRow(b.url);
}

async function removeBook(sid, url) {
  const arr = asBookArray(gdzBooks[sid]).filter((x) => x.url !== url);
  if (arr.length) gdzBooks[sid] = arr; else delete gdzBooks[sid];
  await chrome.storage.local.set({ gdzBooks });
  renderBooks();
  syncResultRow(url);
}

// Repaint the single catalog row for a url so its added/removed state reflects
// storage — without rebuilding the list or disturbing scroll. A url is unique in
// the catalog, so at most one row matches. Comparing dataset in JS sidesteps any
// attribute-selector escaping of slash-bearing urls.
function syncResultRow(url) {
  const b = browseResults.find((x) => x.url === url);
  if (!b) return;
  for (const el of document.getElementById('gdzPickResults').children) {
    if (el.dataset.url === url) { paintResultRow(el, b); return; }
  }
}

async function loadGdz() {
  const { studentGrade = '', gdzBooks: stored = {} } = await chrome.storage.local.get(['studentGrade', 'gdzBooks']);
  gdzBooks = {};
  for (const id of Object.keys(stored)) gdzBooks[id] = asBookArray(stored[id]);
  document.getElementById('studentGrade').value = studentGrade || '';
  buildSubjectFilter();
  renderBooks();
  runBookSearch();
}

function wireGdz() {
  document.getElementById('studentGrade').onchange = async (e) => {
    await chrome.storage.local.set({ studentGrade: e.target.value });
    runBookSearch();
  };
  document.getElementById('gdzPickSubject').onchange = runBookSearch;
  document.getElementById('gdzPickSearch').oninput = () => { clearTimeout(pickerTimer); pickerTimer = setTimeout(runBookSearch, 300); };
  document.querySelectorAll('#gdzPickType button').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('#gdzPickType button').forEach((x) => x.classList.remove('active'));
      btn.classList.add('active');
      runBookSearch();
    };
  });
  // Infinite scroll: load the next batch as the list nears its bottom.
  const results = document.getElementById('gdzPickResults');
  results.addEventListener('scroll', () => {
    if (browseShown < browseResults.length &&
        results.scrollTop + results.clientHeight >= results.scrollHeight - 80) {
      renderResultBatch();
    }
  });
}

/* ---------- Tabs ---------- */

function wireTabs() {
  const tabs = [...document.querySelectorAll('.tab')];
  const panels = [...document.querySelectorAll('.tabpanel')];
  function show(name) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panels) p.classList.toggle('active', p.dataset.panel === name);
    // The save bar only matters on the AI/prompts tab — textbooks & grade auto-save.
    document.body.classList.toggle('on-settings', name === 'settings');
  }
  for (const t of tabs) t.onclick = () => show(t.dataset.tab);
  show('books');
}

/* ---------- Init ---------- */

buildPromptEditors();
wireReveals();
wireTabs();
wireGdz();
wireConsent();
wireUsageDashboard();
document.getElementById('save').onclick = save;
document.getElementById('reload').onclick = loadHistory;
load();
loadGdz();
