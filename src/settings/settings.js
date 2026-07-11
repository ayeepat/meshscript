/** Settings: theme, API keys, provider, daily limits, referrals, GDZ textbooks, 7-day history. */
import { initTheme, getThemePref, setThemePref } from '../common/theme.js';
import { iconSvg } from '../common/icons.js';
import { EXERCISE_SUBJECTS } from '../lib/gdz-match.js';
import { DEFAULT_LIMITS, getUsage, getUsageHistory } from '../lib/rate-limit.js';
import { setLicenseKey, getLicenseStatus, reasonMessage } from '../lib/license.js';
import { getMyReferralCode, fetchReferralStatus } from '../lib/referral.js';
import { hasConsent, setConsent } from '../lib/consent.js';
import { getDeviceId, deleteAllLocalData } from '../lib/history.js';
import { SUPPORT_BOT_URL, BACKEND_URL } from '../lib/config.js';
import { isGdzCoverUrl } from '../lib/gdz-hosts.js';

initTheme();

// Point the «Поддержка» card at the support bot (single source of truth in config.js).
const supportLink = document.getElementById('supportLink');
if (supportLink) supportLink.href = SUPPORT_BOT_URL;

// No qwenApiKey here: Qwen/DeepSeek run through the СМЭШ proxy on the license
// key (see lib/smesh-proxy.js) — students never handle an Alibaba key. A BYO
// key set directly in storage still works as a hidden power-user path.
const KEY_FIELDS = ['openrouterApiKey', 'groqApiKey'];
const SAVE_SECTIONS = new Set(['general', 'analytics']);

let activeSection = 'general';
let showSection = null;
let usageDashboardLoaded = false;
let gdzLoaded = false;
let historyLoaded = false;

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

// The visible dropdown offers two paths — OpenRouter (BYO keys) and 302.AI
// (СМЭШ-licensed). Internally the four provider values still exist: 302.AI maps
// to `deepseek`, which auto-upgrades to Qwen for images/PDFs (see lib/ai.js), so
// the single «302.AI» choice = DeepSeek on text, Qwen on media. Legacy stored
// values (groq / qwen) fold onto whichever path owns them.
const PROVIDER_TO_OPTION = { openrouter: 'openrouter', groq: 'openrouter', qwen: 'deepseek', deepseek: 'deepseek' };

// Show the OpenRouter+Groq key fields only on the OpenRouter path; the 302.AI
// path needs no keys, so it shows the license note instead.
function syncProviderKeys() {
  const isOpenRouter = document.getElementById('aiProvider').value === 'openrouter';
  document.getElementById('orKeyFields').hidden = !isOpenRouter;
  document.getElementById('licenseKeyNote').hidden = isOpenRouter;
}

async function load() {
  const stored = await chrome.storage.local.get([...KEY_FIELDS, 'aiProvider', 'rateLimits']);
  for (const f of KEY_FIELDS) document.getElementById(f).value = stored[f] || '';
  document.getElementById('aiProvider').value = PROVIDER_TO_OPTION[stored.aiProvider] || 'openrouter';
  syncProviderKeys();
  const limits = stored.rateLimits || {};
  document.getElementById('limitOpenrouter').value = limits.openrouter ?? DEFAULT_LIMITS.openrouter;
  document.getElementById('limitGroq').value = limits.groq ?? DEFAULT_LIMITS.groq;
  document.getElementById('limitQwen').value = limits.qwen ?? DEFAULT_LIMITS.qwen;
  document.getElementById('limitDeepseek').value = limits.deepseek ?? DEFAULT_LIMITS.deepseek;
  await refreshUsage();
  await loadLicenseUi();
  await loadConsentUi();
  await loadPrivacyUi();
  loadReferralUi(); // network-backed, deliberately not awaited
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
    const label = status.type === 'subscription' ? 'Активна · подписка' : 'Активна';
    pill.textContent = label;
    pill.dataset.state = 'ok';
    return;
  }
  pill.textContent = reasonMessage(status.reason);
  pill.dataset.state = status.reason === 'network' ? 'warn' : 'err';
}

/* ---------- Referral («Пригласи друга») ---------- */

// Ready-made invite message for the «Скопировать приглашение» button.
const inviteText = (code) =>
  'Решаю домашку и тесты МЭШ через расширение СМЭШ AI — https://www.smeshai.xyz\n' +
  `Когда будешь оформлять подписку, введи мой код ${code} — тебе +10% дней к подписке, а мне пара дней в подарок :)`;

function flashButton(btn, text = 'Скопировано!') {
  const prior = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = prior; }, 1600);
}

function renderReferralStatus(status) {
  const days = document.getElementById('refDays');
  if (status.days_earned > 0) {
    days.hidden = false;
    days.textContent = `+${status.days_earned} дн. заработано`;
  }
  const stats = document.getElementById('refStats');
  stats.hidden = false;
  document.getElementById('refPurchases').textContent = status.purchases;
  if (status.reward_key) {
    const box = document.getElementById('refReward');
    box.hidden = false;
    document.getElementById('refRewardKey').textContent = status.reward_key;
    const until = status.reward_expires_at
      ? new Date(status.reward_expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    document.getElementById('refRewardUntil').textContent = until ? `Действует до ${until}.` : '';
  }
}

async function loadReferralUi() {
  const codeEl = document.getElementById('refCode');
  try {
    const code = await getMyReferralCode({ sync: true }); // sync refreshes the license pointer
    codeEl.textContent = code;
    document.getElementById('refCopyCode').disabled = false;
    document.getElementById('refCopyInvite').disabled = false;
  } catch {
    codeEl.textContent = 'нет связи';
    return;
  }
  try {
    renderReferralStatus(await fetchReferralStatus());
  } catch { /* stats are decorative — the code alone is enough to share */ }
}

function wireReferral() {
  const copy = (getText) => async (e) => {
    const btn = e.currentTarget; // capture NOW — currentTarget is null after an await
    try {
      await navigator.clipboard.writeText(getText());
      flashButton(btn);
    } catch { /* clipboard denied — user can select the code by hand */ }
  };
  const codeText = () => document.getElementById('refCode').textContent;
  document.getElementById('refCopyCode').onclick = copy(codeText);
  document.getElementById('refCopyInvite').onclick = copy(() => inviteText(codeText()));
  document.getElementById('refRewardCopy').onclick = copy(() => document.getElementById('refRewardKey').textContent);
}

/* ---------- Privacy consent ---------- */

function renderConsentStatus(accepted) {
  const pill = document.getElementById('consentStatus');
  pill.textContent = accepted ? 'Согласие дано' : 'Не подтверждено';
  pill.dataset.state = accepted ? 'ok' : 'warn';
  applyConsentGate(accepted);
}

function applyConsentGate(accepted) {
  document.body.classList.toggle('consent-missing', !accepted);
  for (const tab of document.querySelectorAll('.tab.gated')) {
    tab.disabled = !accepted;
    tab.setAttribute('aria-disabled', accepted ? 'false' : 'true');
    tab.title = accepted ? '' : 'Сначала подтвердите согласие в разделе «Основное»';
  }
  if (!accepted && activeSection !== 'general' && showSection) showSection('general');
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

/* ---------- Privacy: statistics opt-in + data deletion ---------- */

async function loadPrivacyUi() {
  const { telemetryEnabled = false } = await chrome.storage.local.get('telemetryEnabled');
  document.getElementById('telemetryToggle').checked = !!telemetryEnabled;
}

function privacyFlash(text, state = 'ok') {
  const pill = document.getElementById('privacyStatus');
  pill.hidden = false;
  pill.textContent = text;
  pill.dataset.state = state;
  setTimeout(() => { pill.hidden = true; }, 4000);
}

function wirePrivacy() {
  // Statistics are OPT-IN (default off) and additionally gated on the general
  // consent at flush time — see lib/telemetry.js.
  document.getElementById('telemetryToggle').onchange = (e) => {
    chrome.storage.local.set({ telemetryEnabled: e.target.checked });
  };
  // Server-side erasure: removes this device's pseudonymous rows from the
  // analytics DB. The device id is the only identifier the backend has.
  document.getElementById('deleteStats').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await fetch(new URL('/t/delete', BACKEND_URL).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: await getDeviceId() })
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) privacyFlash('Статистика удалена');
      else privacyFlash('Не удалось удалить — попробуйте позже', 'err');
    } catch {
      privacyFlash('Нет связи с сервером', 'err');
    } finally { btn.disabled = false; }
  };
  document.getElementById('deleteLocal').onclick = async () => {
    if (!window.confirm(
      'Удалить все локальные данные: историю решений, скан недели, кэш и черновики вложений? ' +
      'Лицензия, ключи API и настройки останутся.'
    )) return;
    await deleteAllLocalData();
    historyLoaded = false;
    privacyFlash('Локальные данные удалены');
  };
}

async function refreshUsage() {
  const usage = await getUsage();
  const fmt = (u) => `${u.used} / ${u.limit} сегодня`;
  document.getElementById('usageOpenrouter').textContent = fmt(usage.openrouter);
  document.getElementById('usageGroq').textContent = fmt(usage.groq);
  document.getElementById('usageQwen').textContent = fmt(usage.qwen);
  document.getElementById('usageDeepseek').textContent = fmt(usage.deepseek);
}

/* ---------- Usage & spend dashboard ---------- */

// Loaded by refreshUsageDashboard(), read by renderChart().
let reqHistory = [];   // [{ day, openrouter, groq, qwen, deepseek }]
let spendHistory = []; // [{ day, spend }]  (OpenRouter $/day, from snapshots)
// The chart shows ONE series at a time, picked by the #chartMode switcher, so
// the providers never clog one cramped column. A provider mode = that
// provider's daily request count; 'usd' = OpenRouter spend. Default: OpenRouter.
let chartMode = 'openrouter'; // 'openrouter' | 'groq' | 'qwen' | 'deepseek' | 'usd'

// Per-provider chart metadata: which reqHistory field to read, the legend label,
// and the bar/swatch CSS classes (colours defined in settings.css).
const PROVIDER_CHART = {
  openrouter: { key: 'openrouter', name: 'OpenRouter', label: 'OpenRouter', cls: 'bar-or', sw: 'or' },
  groq:       { key: 'groq',       name: 'Groq',       label: 'Groq · бесплатно', cls: 'bar-groq', sw: 'groq' },
  qwen:       { key: 'qwen',       name: 'Qwen',       label: 'Qwen', cls: 'bar-qwen', sw: 'qwen' },
  deepseek:   { key: 'deepseek',   name: 'DeepSeek',   label: 'DeepSeek', cls: 'bar-deepseek', sw: 'deepseek' }
};

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

// Compact responsive bar chart (inline SVG). One series at a time: a provider
// mode draws that provider's daily request count; 'usd' draws OpenRouter spend.
// Exact values ride on each bar's <title> for hover.
function chartSvg(mode) {
  const W = 340, H = 110, padT = 10, padB = 18, padX = 6;
  const plotW = W - padX * 2, plotH = H - padT - padB;
  const days = (mode === 'usd' ? spendHistory : reqHistory).map((d) => d.day);
  const n = days.length || 1;
  const colW = plotW / n;
  const baselineY = padT + plotH;

  const prov = PROVIDER_CHART[mode] || null; // null only for 'usd'
  let max = 0;
  if (mode === 'usd') for (const d of spendHistory) max = Math.max(max, d.spend);
  else for (const d of reqHistory) max = Math.max(max, d[prov.key] || 0);
  if (max <= 0) max = 1;

  const bars = [];
  const bw = Math.max(3, colW * 0.6); // one centered bar per day
  for (let i = 0; i < n; i++) {
    const cx = padX + i * colW;
    const x = (cx + (colW - bw) / 2).toFixed(1);
    if (mode === 'usd') {
      const v = spendHistory[i].spend;
      const h = (v / max) * plotH;
      bars.push(`<rect class="bar bar-usd" x="${x}" y="${(baselineY - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${shortDay(days[i])}: ${fmtUsd(v)}</title></rect>`);
    } else {
      const v = reqHistory[i][prov.key] || 0;
      const h = (v / max) * plotH;
      bars.push(`<rect class="bar ${prov.cls}" x="${x}" y="${(baselineY - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${shortDay(days[i])}: ${prov.name} ${v}</title></rect>`);
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
  if (mode === 'usd') {
    legend.innerHTML = '<span class="lg"><i class="sw or"></i>Траты OpenRouter, $/день</span>';
  } else {
    const m = PROVIDER_CHART[mode] || PROVIDER_CHART.openrouter;
    legend.innerHTML = `<span class="lg"><i class="sw ${m.sw}"></i>${m.label} · запросов в день</span>`;
  }
}

function renderChart(mode) {
  const host = document.getElementById('usageChart');
  if (mode === 'usd') {
    const hasUsd = spendHistory.some((d) => d.spend > 0);
    host.innerHTML = hasUsd ? chartSvg(mode)
      : '<div class="chartempty">Данные о тратах по дням ещё копятся — загляните завтра. Общий расход — в плитке «Потрачено».</div>';
  } else {
    const key = (PROVIDER_CHART[mode] || PROVIDER_CHART.openrouter).key;
    const has = reqHistory.some((d) => (d[key] || 0) > 0);
    host.innerHTML = has ? chartSvg(mode)
      : '<div class="chartempty">Пока нет запросов за этот период.</div>';
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

async function ensureUsageDashboard(force = false) {
  if (usageDashboardLoaded && !force) return;
  usageDashboardLoaded = true;
  await refreshUsageDashboard();
}

function wireUsageDashboard() {
  document.getElementById('usageReload').onclick = () => ensureUsageDashboard(true);
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
  const qwenLimit = Math.max(1, parseInt(document.getElementById('limitQwen').value, 10) || DEFAULT_LIMITS.qwen);
  const deepseekLimit = Math.max(1, parseInt(document.getElementById('limitDeepseek').value, 10) || DEFAULT_LIMITS.deepseek);
  data.rateLimits = { openrouter: orLimit, groq: groqLimit, qwen: qwenLimit, deepseek: deepseekLimit };
  await chrome.storage.local.set(data);
  await refreshUsage();
  if (usageDashboardLoaded) refreshUsageDashboard(); // reflect the new limit in the «Сегодня · N / лимит» tile
  // Verify license against the backend ONLY when the key changed — saves a
  // network round-trip when the user is just editing settings or limits.
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
      const d = document.createElement('article');
      d.className = 'session';
      const toggle = document.createElement('button');
      toggle.className = 'session-toggle';
      toggle.type = 'button';
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
      const affordance = document.createElement('span');
      affordance.className = 'session-affordance';
      affordance.innerHTML = `<span>Открыть в панели</span>${iconSvg('chevronRight', 15)}`;
      toggle.append(top, task, affordance);
      toggle.onclick = () => {
        const url = chrome.runtime.getURL(
          `src/dashboard/dashboard.html?history=${encodeURIComponent(s.id)}`
        );
        chrome.tabs.create({ url });
      };
      d.appendChild(toggle);
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
// just shows the empty framed box, which is fine. Also only render remote
// covers from the known GDZ hosts — storage is user-writable, so a tampered
// book record must not turn Settings into a blind third-party image embedder.
const coverHtml = (url, cls) => (isGdzCoverUrl(url)
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

async function ensureGdz() {
  if (gdzLoaded) return;
  gdzLoaded = true;
  await loadGdz();
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
    if (name !== 'general' && document.body.classList.contains('consent-missing')) name = 'general';
    activeSection = name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const p of panels) p.classList.toggle('active', p.dataset.panel === name);
    document.body.classList.toggle('has-savebar', SAVE_SECTIONS.has(name));
    if (name === 'analytics') ensureUsageDashboard();
    if (name === 'books') ensureGdz();
    if (name === 'history' && !historyLoaded) {
      historyLoaded = true;
      loadHistory();
    }
  }
  showSection = show;
  for (const t of tabs) t.onclick = () => show(t.dataset.tab);
  show('general');
}

/* ---------- Init ---------- */

wireReveals();
wireTabs();
applyConsentGate(false);
wireGdz();
wireConsent();
wirePrivacy();
wireReferral();
wireUsageDashboard();
document.getElementById('save').onclick = save;
document.getElementById('aiProvider').addEventListener('change', syncProviderKeys);
document.getElementById('reload').onclick = () => { historyLoaded = true; loadHistory(); };
load();
