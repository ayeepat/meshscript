/**
 * Settings: theme, API keys, provider, daily limits, referrals, GDZ textbooks,
 * 7-day history.
 *
 * The provider picker, the BYO key fields, the per-vendor daily limits and the
 * usage chart's series switcher are all hidden behind config.SHOW_PROVIDER_UI
 * (see applyProviderVisibility). They are hidden, not removed — the save and
 * hydrate paths still read them, so flipping that one flag brings the whole
 * surface back.
 */
import { initTheme, getThemePref, setThemePref } from '../common/theme.js';
import { iconSvg } from '../common/icons.js';
import { mdToHtml } from '../common/markdown.js';
import { EXERCISE_SUBJECTS } from '../lib/gdz-match.js';
import { DEFAULT_LIMITS, MAX_DAILY_LIMIT, getUsage, getUsageHistory } from '../lib/rate-limit.js';
import {
  setLicenseKey, getLicenseStatus, reasonMessage, deactivateCurrentLicense,
  isUsableLicenseStatus, licenseUsabilityReason,
  normalizeEnteredLicenseKey, validateEnteredLicenseKey
} from '../lib/license.js';
import { getMyReferralCode, fetchReferralStatus } from '../lib/referral.js';
import { hasConsent, setConsent } from '../lib/consent.js';
import { getDeviceId, deleteAllLocalData } from '../lib/history.js';
import {
  SUPPORT_BOT_URL, BACKEND_URL, SHOW_PROVIDER_UI, DEFAULT_PROVIDER, REFERRALS_ENABLED
} from '../lib/config.js';
import { isGdzCoverUrl } from '../lib/gdz-hosts.js';
import { normalizeGdzApiUrl } from '../lib/gdz-api.js';
import { fetchTextBounded } from '../lib/http.js';
import { normalizeGdzBooks } from '../lib/gdz-books.js';
import { isDevModeActive } from '../lib/dev-mode.js';
import { clearDevTraces, readDevTraces } from '../lib/dev-trace.js';

initTheme();

// Point the «Поддержка» card at the support bot (single source of truth in config.js).
const supportLink = document.getElementById('supportLink');
if (supportLink) supportLink.href = SUPPORT_BOT_URL;

// The sidebar version comes from the manifest so it can't drift from the build.
const brandVersion = document.getElementById('brandVersion');
if (brandVersion) brandVersion.textContent = `Настройки · v${chrome.runtime.getManifest().version}`;

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
let historyLoadGeneration = 0;
let historyDeletePromise = null;

/**
 * load() receives its storage snapshot asynchronously. A field the user has
 * already edited must not be repainted with that older stored value.
 */
const touchedControls = new Set();
for (const type of ['input', 'change']) {
  document.addEventListener(type, (e) => {
    if (e.target?.id) touchedControls.add(e.target.id);
  }, true);
}

function setFieldUnlessTouched(id, value) {
  if (!touchedControls.has(id)) document.getElementById(id).value = value;
}

function setCheckedUnlessTouched(id, checked) {
  if (!touchedControls.has(id)) document.getElementById(id).checked = !!checked;
}

/* ---------- Theme segmented control ---------- */

const segButtons = [...document.querySelectorAll('#themeSeg button')];
let themePaintGeneration = 0;
let themeUserGeneration = 0;
let pendingThemePref = null;
let themeWriteQueue = Promise.resolve();
function markActivePref(pref) {
  for (const b of segButtons) b.classList.toggle('active', b.dataset.pref === pref);
}
async function refreshThemePref({ supersede = false } = {}) {
  if (supersede) themePaintGeneration++;
  const paintGeneration = themePaintGeneration;
  const userGeneration = themeUserGeneration;
  const pref = await getThemePref();
  if (paintGeneration === themePaintGeneration && userGeneration === themeUserGeneration &&
      pendingThemePref == null) markActivePref(pref);
}
for (const b of segButtons) {
  b.onclick = async () => {
    const generation = ++themeUserGeneration;
    themePaintGeneration++;
    const pref = b.dataset.pref;
    pendingThemePref = pref;
    markActivePref(pref);
    // Serialize rapid clicks so an older storage write cannot finish last and
    // persist an earlier preference. Themechange events emitted by those local
    // writes are ignored while the newest user choice is pending.
    const write = themeWriteQueue.then(() => setThemePref(pref));
    themeWriteQueue = write.catch(() => {});
    try { await write; }
    catch {
      if (generation === themeUserGeneration) {
        pendingThemePref = null;
        refreshThemePref({ supersede: true });
      }
      return;
    }
    if (generation === themeUserGeneration) {
      pendingThemePref = null;
      markActivePref(pref);
    }
  };
}
refreshThemePref();
document.addEventListener('themechange', () => {
  if (pendingThemePref == null) refreshThemePref({ supersede: true });
});

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

const PROVIDER_OPTIONS = new Set(['openrouter', 'groq', 'qwen', 'deepseek']);

// Show BYO key fields for OpenRouter/Groq; Qwen/DeepSeek need only the license.
function syncProviderKeys() {
  const provider = document.getElementById('aiProvider').value;
  const usesOwnKey = provider === 'openrouter' || provider === 'groq';
  document.getElementById('orKeyFields').hidden = !usesOwnKey;
  document.getElementById('licenseKeyNote').hidden = usesOwnKey;
}

/**
 * Reveal the vendor-named controls, but only when SHOW_PROVIDER_UI is on.
 *
 * The markup ships `hidden` so a vendor name can never flash before this runs —
 * which also means the shipped HTML is honest about what a student sees. The
 * inputs stay in the DOM either way, so readSettingsFormData /
 * hydrateSettingsForm and the whole save transaction are untouched, and
 * flipping the flag in config.js restores the full UI with no other edit.
 */
function applyProviderVisibility() {
  if (!SHOW_PROVIDER_UI) return;
  for (const id of ['providerPanel', 'limitsPanel', 'chartMode']) {
    document.getElementById(id).hidden = false;
  }
  for (const tile of document.querySelectorAll('[data-byo-only]')) tile.hidden = false;
  document.getElementById('todayLabel').textContent = 'Сегодня · OpenRouter';
  document.getElementById('usageLede').textContent =
    'Сколько запросов и денег уходит. Баланс OpenRouter подтягивается при открытии этой страницы.';
}

async function hydrateSettingsForm() {
  const stored = await chrome.storage.local.get([...KEY_FIELDS, 'aiProvider', 'rateLimits']);
  for (const f of KEY_FIELDS) setFieldUnlessTouched(f, stored[f] || '');
  setFieldUnlessTouched('aiProvider', PROVIDER_OPTIONS.has(stored.aiProvider) ? stored.aiProvider : DEFAULT_PROVIDER);
  syncProviderKeys();
  const limits = stored.rateLimits || {};
  setFieldUnlessTouched('limitOpenrouter', limits.openrouter ?? DEFAULT_LIMITS.openrouter);
  setFieldUnlessTouched('limitGroq', limits.groq ?? DEFAULT_LIMITS.groq);
  setFieldUnlessTouched('limitQwen', limits.qwen ?? DEFAULT_LIMITS.qwen);
  setFieldUnlessTouched('limitDeepseek', limits.deepseek ?? DEFAULT_LIMITS.deepseek);
  await loadLicenseUi();
}

async function loadSecondaryUi() {
  // These panels do not contribute values to the Save transaction. Isolate
  // their failures so a broken usage/consent tile cannot reintroduce unsafe
  // default-value saves after the persisted form itself hydrated correctly.
  await Promise.allSettled([
    refreshUsage(),
    loadConsentUi()
  ]);
  // network-backed, deliberately not awaited. Skipped entirely while the
  // programme is off: the backend refuses /referral/*, so the only thing a
  // request could add is a «нет связи» in a card that already says «Скоро».
  if (REFERRALS_ENABLED) loadReferralUi();
}

/* ---------- License key ---------- */

let licenseUiGeneration = 0;
async function loadLicenseUi() {
  const generation = licenseUiGeneration;
  const status = await getLicenseStatus();
  if (generation !== licenseUiGeneration || touchedControls.has('licenseKey')) return;
  setFieldUnlessTouched('licenseKey', status?.key || '');
  renderLicenseStatus(status);
}

function renderLicenseStatus(status) {
  // The one funnel every licence transition passes through (load, save,
  // deactivate), so the owner-only diagnostics tab follows the key without a
  // reload. Fire-and-forget: the licence pill must never wait on a digest.
  void applyDevMode();
  const pill = document.getElementById('licStatus');
  const input = document.getElementById('licenseKey');
  const deactivate = document.getElementById('deactivateLicense');
  if (deactivate) deactivate.hidden = !(status?.key && status?.activation_token);
  if (!status || !status.key) {
    pill.textContent = 'Не активирована';
    pill.dataset.state = 'idle';
    input.removeAttribute('aria-invalid');
    return;
  }
  if (isUsableLicenseStatus(status)) {
    const label = status.type === 'subscription' ? 'Активна · подписка' : 'Активна';
    pill.textContent = label;
    pill.dataset.state = 'ok';
    input.removeAttribute('aria-invalid');
    return;
  }
  const reason = licenseUsabilityReason(status);
  pill.textContent = reasonMessage(reason);
  pill.dataset.state = reason === 'network' ? 'warn' : 'err';
  input.setAttribute('aria-invalid', 'true');
}

const deactivateLicenseButton = document.getElementById('deactivateLicense');
if (deactivateLicenseButton) {
  deactivateLicenseButton.onclick = async () => {
    if (!window.confirm(
      'Деактивировать ключ на этом устройстве? После этого его можно будет активировать на другом устройстве.'
    )) return;
    deactivateLicenseButton.disabled = true;
    const pill = document.getElementById('licStatus');
    pill.textContent = 'Деактивация…';
    pill.dataset.state = 'idle';
    try {
      const status = await deactivateCurrentLicense();
      licenseUiGeneration++;
      document.getElementById('licenseKey').value = '';
      touchedControls.delete('licenseKey');
      renderLicenseStatus(status);
    } catch (error) {
      pill.textContent = error?.message || 'Не удалось деактивировать ключ.';
      pill.dataset.state = 'err';
    } finally {
      deactivateLicenseButton.disabled = false;
    }
  };
}

/* ---------- Referral («Пригласи друга») ---------- */

// Ready-made invite message for the «Скопировать приглашение» button.
const inviteText = (code) =>
  'Решаю домашку и тесты через расширение СМЭШ AI — https://smeshai.xyz\n' +
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
  document.getElementById('refPurchases').textContent = status.purchases ?? 0;
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

/**
 * The card while config.REFERRALS_ENABLED is false. Nothing here touches the
 * network — there is no code to mint and the backend refuses the route anyway.
 *
 * The buttons are deliberately left clickable: a `disabled` button says nothing
 * back, and a student who came to this card to find their invite code deserves
 * an answer. The click IS the answer — it flashes «Скоро :)» where the user
 * pressed and reveals the note explaining that the programme is coming.
 */
function wireReferralComingSoon() {
  const note = document.getElementById('refSoonNote');
  const announce = (btn) => {
    note.hidden = false;
    if (btn) flashButton(btn, 'Скоро :)');
  };
  for (const id of ['refCopyCode', 'refCopyInvite']) {
    const btn = document.getElementById(id);
    btn.disabled = false;
    btn.classList.add('soon');
    btn.setAttribute('aria-disabled', 'true'); // clickable, but not a live action
    btn.onclick = () => announce(btn);
  }
  document.getElementById('refCode').onclick = () => announce(null);
}

function wireReferral() {
  if (!REFERRALS_ENABLED) {
    wireReferralComingSoon();
    return;
  }
  // The live card: swap the shipped «скоро» copy for what the programme
  // actually gives, then wire the real clipboard actions.
  document.getElementById('refSoon').hidden = true;
  document.getElementById('refSoonLede').hidden = true;
  document.getElementById('refLiveLede').hidden = false;
  document.getElementById('refSoonHint').hidden = true;
  document.getElementById('refLiveHint').hidden = false;
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

let consentUiGeneration = 0;
let consentWriteQueue = Promise.resolve();
async function loadConsentUi() {
  const generation = consentUiGeneration;
  const accepted = await hasConsent();
  if (generation !== consentUiGeneration || touchedControls.has('consentToggle')) return;
  setCheckedUnlessTouched('consentToggle', accepted);
  renderConsentStatus(accepted);
}

function wireConsent() {
  document.getElementById('consentToggle').onchange = async (e) => {
    const accepted = e.target.checked;
    const generation = ++consentUiGeneration;
    // Serialize rapid true -> false toggles. Paint generations alone prevent a
    // stale UI update, but without write ordering the older `true` storage write
    // can still finish last and silently persist the wrong consent state.
    const write = consentWriteQueue.then(() => setConsent(accepted));
    consentWriteQueue = write.catch(() => {});
    try {
      await write;
      if (generation === consentUiGeneration) renderConsentStatus(accepted);
    } catch {
      if (generation !== consentUiGeneration) return;
      try {
        const stored = await hasConsent();
        if (generation === consentUiGeneration) {
          document.getElementById('consentToggle').checked = stored;
          renderConsentStatus(stored);
        }
      } catch { /* leave the user's visible choice; a later save can retry */ }
    }
  };
}

/* ---------- Privacy: data deletion ---------- */

// No paint generation any more: with the toggle gone there is no checkbox whose
// state could go stale against a slow write, only this one-way withdrawal.
let telemetryWriteQueue = Promise.resolve();
function setTelemetryPreference(enabled) {
  const write = telemetryWriteQueue.then(() =>
    chrome.storage.local.set({ telemetryEnabled: !!enabled })
  );
  telemetryWriteQueue = write.catch(() => {});
  return write;
}

function privacyFlash(text, state = 'ok') {
  const pill = document.getElementById('privacyStatus');
  pill.hidden = false;
  pill.textContent = text;
  pill.dataset.state = state;
  setTimeout(() => { pill.hidden = true; }, 4000);
}

function wirePrivacy() {
  // Statistics no longer have their own checkbox: they are part of the single
  // agreement accepted above (consent.js setConsent writes telemetryEnabled).
  // The erasure button below is what turns them back off, and lib/telemetry.js
  // still refuses to send anything unless BOTH flags are true at flush time.

  // Server-side erasure: removes this device's pseudonymous rows from the
  // analytics DB. The device id is the only identifier the backend has.
  document.getElementById('deleteStats').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // Erasure also withdraws the statistics flag. This prevents the next
      // client flush or licensed proxy solve from immediately recreating rows,
      // and it is the only remaining way to opt out of statistics without
      // withdrawing consent altogether.
      await setTelemetryPreference(false);
      const { telemetryErasureCapability: erasure } =
        await chrome.storage.local.get('telemetryErasureCapability');
      if (!erasure?.token || erasure.expires_at <= Date.now()) {
        throw new Error('missing_erasure_capability');
      }
      const res = await fetchTextBounded(new URL('/t/delete', BACKEND_URL).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Erasure-Token': erasure.token
        },
        body: JSON.stringify({}),
        redirect: 'error'
      });
      let data = null;
      try { data = JSON.parse(res.text || 'null'); } catch { /* malformed */ }
      if (data?.ok) privacyFlash('Статистика удалена, сбор отключён');
      else privacyFlash('Не удалось удалить — попробуйте позже', 'err');
    } catch (error) {
      privacyFlash(
        error?.message === 'missing_erasure_capability'
          ? 'Сначала подтвердите лицензию, чтобы безопасно удалить статистику'
          : 'Нет связи с сервером',
        'err'
      );
    } finally { btn.disabled = false; }
  };
  const deleteLocalButton = document.getElementById('deleteLocal');
  deleteLocalButton.onclick = async () => {
    if (historyDeletePromise) return;
    if (!window.confirm(
      'Удалить все локальные данные: историю решений, скан недели, кэш и черновики вложений? ' +
      'Лицензия, ключи API и настройки останутся.'
    )) return;

    // Deletion takes ownership at the confirmed click, before its first await.
    // A pre-wipe LIST_SESSIONS/LIST_MESSAGES response must not repaint private
    // rows while the wipe is still running. Reloads requested during the wipe
    // wait below and read only the post-wipe state.
    const generation = ++historyLoadGeneration;
    historyLoaded = false;
    const history = document.getElementById('history');
    history.innerHTML = `<div class="loading"><span class="spinner"></span><span>Удаляю локальные данные…</span></div>`;
    deleteLocalButton.disabled = true;
    const deletion = Promise.resolve().then(() => deleteAllLocalData());
    historyDeletePromise = deletion;
    let failed = false;
    try {
      await deletion;
    } catch {
      failed = true;
    } finally {
      if (historyDeletePromise === deletion) historyDeletePromise = null;
      deleteLocalButton.disabled = false;
    }

    // A reload clicked during deletion has a newer generation and owns the
    // final paint; its request was deferred until `deletion` settled.
    if (generation !== historyLoadGeneration) {
      privacyFlash(failed ? 'Не удалось удалить локальные данные' : 'Локальные данные удалены', failed ? 'err' : 'ok');
      return;
    }
    if (failed) {
      privacyFlash('Не удалось удалить локальные данные', 'err');
      historyLoaded = true;
      loadHistory();
      return;
    }
    history.innerHTML = '';
    privacyFlash('Локальные данные удалены');
  };
}

let usagePaintGeneration = 0;
async function refreshUsage() {
  const generation = ++usagePaintGeneration;
  const usage = await getUsage();
  if (generation !== usagePaintGeneration) return false;
  const fmt = (u) => `${u.used} / ${u.limit} сегодня`;
  document.getElementById('usageOpenrouter').textContent = fmt(usage.openrouter);
  document.getElementById('usageGroq').textContent = fmt(usage.groq);
  document.getElementById('usageQwen').textContent = fmt(usage.qwen);
  document.getElementById('usageDeepseek').textContent = fmt(usage.deepseek);
  return true;
}

/* ---------- Usage & spend dashboard ---------- */

// Loaded by refreshUsageDashboard(), read by renderChart().
let reqHistory = [];   // [{ day, openrouter, groq, qwen, deepseek }]
let spendHistory = []; // [{ day, spend }]  (OpenRouter $/day, from snapshots)
// Forced reloads and post-save refreshes may overlap. Only the newest request
// may publish its snapshots; in particular, a delayed response for a replaced
// OpenRouter key must not erase the valid balance already painted for the new
// key with a stale_key error.
let usageDashboardGeneration = 0;
// The chart shows ONE series at a time, picked by the #chartMode switcher, so
// the providers never clog one cramped column. A provider mode = that
// provider's daily request count; 'usd' = OpenRouter spend. Default: OpenRouter.
// With the switcher hidden there is only ever one series to draw, and it has to
// be the provider that actually answers.
let chartMode = SHOW_PROVIDER_UI ? 'openrouter' : DEFAULT_PROVIDER;

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
  // Purely a BYO-OpenRouter account lookup. With that surface hidden there is
  // no key to query and nowhere to show the answer — skip the request entirely
  // rather than firing it and discarding the result.
  if (!SHOW_PROVIDER_UI) return Promise.resolve(null);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'OPENROUTER_CREDITS' }, (r) => resolve(chrome.runtime.lastError ? null : r));
  });
}

function renderSpend(c) {
  // Tiles and note are hidden with the BYO surface; writing "add an OpenRouter
  // key above" into a hidden note would only wait to reappear if the flag flips.
  if (!SHOW_PROVIDER_UI) return;
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
      // The hover title is user-visible — drop the vendor name with the rest.
      const tip = SHOW_PROVIDER_UI ? `${prov.name} ${v}` : `${v}`;
      bars.push(`<rect class="bar ${prov.cls}" x="${x}" y="${(baselineY - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2"><title>${shortDay(days[i])}: ${tip}</title></rect>`);
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
    legend.innerHTML = '<span class="lg"><i class="sw or"></i>Точные траты через расширение, $/день</span>';
  } else {
    const m = PROVIDER_CHART[mode] || PROVIDER_CHART.openrouter;
    const label = SHOW_PROVIDER_UI ? `${m.label} · запросов в день` : 'Запросов в день';
    legend.innerHTML = `<span class="lg"><i class="sw ${m.sw}"></i>${label}</span>`;
  }
}

function renderChart(mode) {
  const host = document.getElementById('usageChart');
  if (mode === 'usd') {
    const hasUsd = spendHistory.some((d) => d.spend > 0);
    host.innerHTML = hasUsd ? chartSvg(mode)
      : '<div class="chartempty">Точные траты через расширение ещё не записаны. Общий расход аккаунта — в плитке «Потрачено».</div>';
  } else {
    const key = (PROVIDER_CHART[mode] || PROVIDER_CHART.openrouter).key;
    const has = reqHistory.some((d) => (d[key] || 0) > 0);
    host.innerHTML = has ? chartSvg(mode)
      : '<div class="chartempty">Пока нет запросов за этот период.</div>';
  }
  renderLegend(mode);
}

async function refreshUsageDashboard() {
  const generation = ++usageDashboardGeneration;
  try {
    const [usage, hist] = await Promise.all([getUsage(), getUsageHistory(14)]);
    if (generation !== usageDashboardGeneration) return false;
    const credits = await fetchCredits();
    if (generation !== usageDashboardGeneration) return false;

    // Commit the request's complete snapshot together. Publishing reqHistory
    // before the credits await let two refreshes produce a mixed-generation UI.
    reqHistory = hist;
    spendHistory = (credits && credits.spendHistory) || [];
    // Follow the series the chart is actually drawing, so the tile and the bars
    // can't disagree about which budget "Сегодня" refers to.
    const todayUsage = usage[SHOW_PROVIDER_UI ? 'openrouter' : DEFAULT_PROVIDER] || usage.openrouter;
    document.getElementById('orToday').textContent = `${todayUsage.used} / ${todayUsage.limit}`;
    renderSpend(credits);
    renderChart(chartMode);
    return true;
  } catch (error) {
    // A failed superseded request cannot make a newer successful dashboard look
    // unloaded. The current request remains retryable on the next tab open/click.
    if (generation === usageDashboardGeneration) usageDashboardLoaded = false;
    throw error;
  }
}

async function ensureUsageDashboard(force = false) {
  if (usageDashboardLoaded && !force) return;
  usageDashboardLoaded = true;
  await refreshUsageDashboard();
}

function wireUsageDashboard() {
  document.getElementById('usageReload').onclick = () => {
    void ensureUsageDashboard(true).catch(() => {});
  };
  document.querySelectorAll('#chartMode button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#chartMode button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      chartMode = b.dataset.mode;
      renderChart(chartMode);
    };
  });
}

let settingsSaveQueue = Promise.resolve();
let saveToastTimer = null;
let settingsFormReady = false;

function readSettingsFormData() {
  const data = {};
  for (const f of KEY_FIELDS) data[f] = document.getElementById(f).value.trim();
  const selectedProvider = document.getElementById('aiProvider').value;
  data.aiProvider = PROVIDER_OPTIONS.has(selectedProvider) ? selectedProvider : DEFAULT_PROVIDER;
  const boundedLimit = (id, fallback) => Math.min(
    MAX_DAILY_LIMIT,
    Math.max(1, parseInt(document.getElementById(id).value, 10) || fallback)
  );
  data.rateLimits = {
    openrouter: boundedLimit('limitOpenrouter', DEFAULT_LIMITS.openrouter),
    groq: boundedLimit('limitGroq', DEFAULT_LIMITS.groq),
    qwen: boundedLimit('limitQwen', DEFAULT_LIMITS.qwen),
    deepseek: boundedLimit('limitDeepseek', DEFAULT_LIMITS.deepseek)
  };
  return data;
}

function settingsDataEqual(left, right) {
  if (!left || !right || left.aiProvider !== right.aiProvider) return false;
  for (const field of KEY_FIELDS) if (left[field] !== right[field]) return false;
  return ['openrouter', 'groq', 'qwen', 'deepseek'].every(
    (provider) => left.rateLimits?.[provider] === right.rateLimits?.[provider]
  );
}

function normalizedVisibleLicenseKey() {
  return normalizeEnteredLicenseKey(document.getElementById('licenseKey').value);
}

function licenseIntentOwnsUi(intent) {
  return intent.owner === licenseUiGeneration &&
    normalizedVisibleLicenseKey() === intent.licenseKey;
}

function saveIntentOwnsUi(intent) {
  return licenseIntentOwnsUi(intent) &&
    settingsDataEqual(readSettingsFormData(), intent.data);
}

function hideSaveConfirmation() {
  if (saveToastTimer != null) clearTimeout(saveToastTimer);
  saveToastTimer = null;
  document.getElementById('status').classList.remove('show');
}

function showSaveFailure(message) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.dataset.state = 'err';
  status.classList.add('show');
}

function showLicenseInputError(message) {
  const input = document.getElementById('licenseKey');
  const pill = document.getElementById('licStatus');
  input.setAttribute('aria-invalid', 'true');
  pill.textContent = message;
  pill.dataset.state = 'err';
  showSaveFailure('Ключ не сохранён — проверьте сообщение выше.');
}

// Visible edits after a click are not part of that immutable save intent. Hide
// its confirmation immediately; the completion guard below also prevents a
// delayed writer from labelling those newer values as saved.
for (const id of [
  ...KEY_FIELDS,
  'aiProvider',
  'limitOpenrouter',
  'limitGroq',
  'limitQwen',
  'limitDeepseek',
  'licenseKey'
]) {
  const control = document.getElementById(id);
  const invalidate = () => {
    hideSaveConfirmation();
    if (id !== 'licenseKey') return;
    licenseUiGeneration++;
    control.removeAttribute('aria-invalid');
    const pill = document.getElementById('licStatus');
    pill.textContent = 'Изменено · сохраните';
    pill.dataset.state = 'idle';
  };
  control.addEventListener('input', invalidate);
  control.addEventListener('change', invalidate);
}

function requestSettingsSave() {
  // The HTML button starts disabled, but keep the transaction itself
  // fail-closed as well. Until stored keys/provider/limits and the license have
  // hydrated, untouched controls still contain document defaults and must
  // never be snapshotted into storage.
  if (!settingsFormReady) return Promise.resolve(false);
  const licenseInput = document.getElementById('licenseKey');
  const validation = validateEnteredLicenseKey(licenseInput.value);
  if (!validation.ok) {
    hideSaveConfirmation();
    showLicenseInputError(validation.message);
    return Promise.resolve(false);
  }
  // Store and show one canonical spelling, including keys pasted with spaces,
  // Markdown escapes, or without visual grouping hyphens.
  licenseInput.value = validation.key;
  licenseInput.removeAttribute('aria-invalid');
  // Ownership begins at the click, not when this request eventually reaches
  // the serialized writer. Snapshot every persisted value now so later edits
  // remain genuinely unsaved rather than leaking into a queued request.
  const intent = {
    owner: ++licenseUiGeneration,
    licenseKey: normalizedVisibleLicenseKey(),
    data: readSettingsFormData()
  };
  hideSaveConfirmation();
  return save(intent);
}

function save(intent) {
  // Preserve click order across storage, usage refresh and license verification.
  const run = settingsSaveQueue.then(() => saveOnce(intent));
  settingsSaveQueue = run.catch(() => {});
  return run;
}

async function saveOnce(intent) {
  const saveGeneration = intent.owner;
  await chrome.storage.local.set(intent.data);
  // Usage tiles are secondary UI. A stale/corrupt counter must never prevent
  // the independently valid settings and license transaction from completing.
  try { await refreshUsage(); } catch { /* best-effort dashboard repaint */ }
  if (usageDashboardLoaded) {
    // reflect the new limit in the «Сегодня · N / лимит» tile; this refresh is
    // intentionally detached from save/license latency, but never unhandled.
    void refreshUsageDashboard().catch(() => {});
  }
  // A deliberate Save retries a failed same-key verdict. Otherwise a temporary
  // outage or a previously mistyped value stays cached forever even after the
  // user corrects the underlying problem and clicks Save again.
  const newKey = intent.licenseKey;
  const priorStatus = await getLicenseStatus();
  let currentStatus = priorStatus;
  const needsVerification = (priorStatus?.key || '') !== newKey || (
    !!newKey && !isUsableLicenseStatus(priorStatus)
  );
  if (needsVerification) {
    currentStatus = await setLicenseKey(newKey);
  }
  if (licenseIntentOwnsUi(intent)) renderLicenseStatus(currentStatus);
  if (!saveIntentOwnsUi(intent)) return false;
  if (newKey && !isUsableLicenseStatus(currentStatus)) {
    showSaveFailure('Настройки сохранены, но ключ не активирован.');
    return false;
  }
  const s = document.getElementById('status');
  s.innerHTML = `${iconSvg('check', 14)}Сохранено`;
  s.dataset.state = 'ok';
  s.classList.add('show');
  if (saveToastTimer != null) clearTimeout(saveToastTimer);
  const timer = setTimeout(() => {
    // Both checks matter: the generation rejects an older save, while timer
    // identity rejects a cleared callback that was already queued to execute.
    if (saveGeneration !== licenseUiGeneration || saveToastTimer !== timer ||
        !saveIntentOwnsUi(intent)) return;
    saveToastTimer = null;
    s.classList.remove('show');
  }, 2200);
  saveToastTimer = timer;
  return true;
}

function userFacingSaveError(error) {
  const message = String(error?.message || '').trim();
  if (/extension context invalidated|receiving end does not exist/i.test(message)) {
    return 'Расширение обновилось. Перезагрузите страницу настроек и попробуйте снова.';
  }
  // Our license layer already emits short, localized, actionable messages.
  if (/^[А-ЯЁ]/.test(message) && message.length <= 240) return message;
  return 'Не удалось сохранить настройки. Перезагрузите страницу и попробуйте ещё раз.';
}

function isLicenseSaveError(error) {
  const message = String(error?.message || '').trim();
  return /^(Сначала деактивируйте|Ключ |Ключ$|Срок действия ключа|Этот ключ|Не удалось подтвердить (устройство|активацию)|Лицензия |Сервер лицензий|Не удалось связаться с сервером)/.test(message);
}

async function handleSettingsSave(saveButton) {
  if (!settingsFormReady || saveButton.disabled) return false;
  saveButton.disabled = true;
  saveButton.setAttribute('aria-busy', 'true');
  try {
    return await requestSettingsSave();
  } catch (error) {
    const message = userFacingSaveError(error);
    if (isLicenseSaveError(error)) showLicenseInputError(message);
    else showSaveFailure(message);
    return false;
  } finally {
    if (settingsFormReady) saveButton.disabled = false;
    saveButton.setAttribute('aria-busy', 'false');
  }
}

async function initializeSettingsForm(saveButton) {
  try {
    await hydrateSettingsForm();
  } catch {
    // Never enable a full-form save after a partial/failed read: doing so would
    // let blank HTML defaults erase credentials that may still exist locally.
    saveButton.disabled = true;
    saveButton.setAttribute('aria-busy', 'false');
    saveButton.title = 'Не удалось загрузить сохранённые настройки. Перезагрузите страницу.';
    const status = document.getElementById('status');
    status.textContent = 'Не удалось загрузить настройки';
    status.dataset.state = 'err';
    status.classList.add('show');
    return false;
  }

  settingsFormReady = true;
  saveButton.disabled = false;
  saveButton.setAttribute('aria-busy', 'false');
  saveButton.title = '';
  void loadSecondaryUi();
  return true;
}

/* ---------- History ---------- */

function historyMessageEl(message) {
  const row = document.createElement('div');
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  row.className = `history-message ${role}`;

  const label = document.createElement('div');
  label.className = 'history-message-role';
  label.textContent = role === 'assistant' ? 'СМЭШ AI' : 'Вы';

  const content = document.createElement('div');
  content.className = 'history-message-content';
  // Assistant answers are markdown/LaTeX — render them the same way the
  // dashboard chat does (mdToHtml escapes first, so this is not raw HTML).
  // User turns stay plain text so their formatting/line breaks are preserved.
  if (role === 'assistant' && message.content) {
    content.classList.add('md');
    content.innerHTML = mdToHtml(message.content);
  } else {
    content.textContent = message.content || '';
  }
  row.append(label, content);

  if (role === 'assistant' && message.content) {
    const copy = document.createElement('button');
    copy.className = 'history-copy';
    copy.type = 'button';
    copy.title = 'Скопировать ответ';
    copy.setAttribute('aria-label', 'Скопировать ответ');
    copy.innerHTML = iconSvg('copy', 13);
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(message.content);
        copy.innerHTML = iconSvg('check', 13);
        setTimeout(() => { copy.innerHTML = iconSvg('copy', 13); }, 1200);
      } catch { /* clipboard denied — the answer remains selectable */ }
    };
    row.appendChild(copy);
  }
  return row;
}

function loadSessionMessages(session, toggle, conversation, generation = null) {
  conversation.hidden = false;
  conversation.innerHTML = `<div class="loading"><span class="spinner"></span><span>Открываю сохранённый чат…</span></div>`;
  chrome.runtime.sendMessage({ type: 'LIST_MESSAGES', sessionId: session.id }, (resp) => {
    // Read lastError inside the callback even when this response is obsolete.
    const runtimeError = chrome.runtime.lastError;
    if (generation != null && generation !== historyLoadGeneration) return;
    if (runtimeError || !resp?.ok) {
      delete conversation.dataset.loaded;
      conversation.innerHTML = '';
      const error = document.createElement('div');
      error.className = 'empty';
      error.innerHTML = iconSvg('alert', 15);
      const text = document.createElement('span');
      text.textContent = `Не удалось открыть чат: ${resp?.error || 'нет данных'}`;
      error.appendChild(text);
      conversation.appendChild(error);
      return;
    }
    conversation.innerHTML = '';
    if (!resp.messages?.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'В этом чате нет сохранённых сообщений.';
      conversation.appendChild(empty);
      return;
    }
    for (const message of resp.messages) conversation.appendChild(historyMessageEl(message));
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    toggle.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  });
}

function loadHistory() {
  const generation = ++historyLoadGeneration;
  const box = document.getElementById('history');
  box.innerHTML = `<div class="loading"><span class="spinner"></span><span>Загрузка…</span></div>`;
  const requestSessions = () => chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (resp) => {
    // Read lastError even for an obsolete callback so Chrome does not report an
    // unchecked runtime error, but let only the newest request mutate the DOM.
    const runtimeError = chrome.runtime.lastError;
    if (generation !== historyLoadGeneration) return;
    if (runtimeError || !resp?.ok) {
      box.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = iconSvg('alert', 15);
      const message = document.createElement('span');
      message.textContent = `Не удалось загрузить: ${resp?.error || 'нет данных'}`;
      empty.appendChild(message);
      box.appendChild(empty);
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
      toggle.setAttribute('aria-expanded', 'false');
      const top = document.createElement('div');
      top.className = 'session-top';
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = s.subject || 'Задание';
      const date = document.createElement('span');
      date.className = 'date';
      // created_at comes from local storage; a malformed row must render a
      // calm placeholder, not the raw "Invalid Date" string.
      const parsedDate = new Date(s.created_at);
      date.textContent = Number.isNaN(parsedDate.getTime())
        ? '—'
        : parsedDate.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      top.append(pill, date);
      const task = document.createElement('div');
      task.className = 'task';
      task.textContent = s.task_text || '(без описания)';
      const affordance = document.createElement('span');
      affordance.className = 'session-affordance';
      affordance.innerHTML = `${iconSvg('chevronDown', 15)}<span>Открыть чат</span>`;
      toggle.append(top, task, affordance);

      const conversation = document.createElement('div');
      conversation.className = 'history-conversation';
      conversation.hidden = true;
      toggle.onclick = () => {
        const opening = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', String(opening));
        affordance.querySelector('span').textContent = opening ? 'Скрыть чат' : 'Открыть чат';
        if (!opening) {
          conversation.hidden = true;
          return;
        }
        if (!conversation.dataset.loaded) {
          conversation.dataset.loaded = 'true';
          loadSessionMessages(s, toggle, conversation, generation);
        } else {
          conversation.hidden = false;
        }
      };
      d.append(toggle, conversation);
      box.appendChild(d);
    }
  });

  // A reload requested while the wipe is in flight is useful, but issuing it
  // immediately could read the pre-wipe database and win a newer generation.
  // Keep its generation, wait for the mutation, then issue the authoritative
  // read only if no still-newer reload superseded it.
  if (historyDeletePromise) {
    void historyDeletePromise.catch(() => {}).then(() => {
      if (generation === historyLoadGeneration) requestSessions();
    });
  } else {
    requestSessions();
  }
}

/* ---------- Textbooks (GDZ) ---------- */

// gdzBooks: { [subjectId]: [ { url, title, breadcrumb, year, study_level,
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
let bookSearchGeneration = 0;
let bookMutationGeneration = 0;

const asBookArray = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

// Settings keeps one identity for catalog results and both pre-upgrade stored
// forms: the absolute mobile-API URL. Canonicalizing the in-memory snapshot
// also collapses a relative/absolute duplicate left by an older install.
function canonicalizeBookState(value) {
  const source = normalizeGdzBooks(value);
  const normalized = {};
  for (const [subjectId, rawBooks] of Object.entries(source)) {
    const seen = new Set();
    const books = [];
    for (const rawBook of asBookArray(rawBooks)) {
      const url = normalizeGdzApiUrl(rawBook.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      books.push(rawBook.url === url ? rawBook : { ...rawBook, url });
    }
    if (books.length) normalized[subjectId] = books;
  }
  return normalized;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const subjTitle = (id) => (EXERCISE_SUBJECTS.find((s) => String(s.id) === String(id))?.title) || `Предмет ${id}`;

// "10 класс", "7–9 класс" (contiguous range), or "5, 7 класс".
function classesLabel(classes) {
  const c = [...new Set((classes || []).map(Number))].sort((a, b) => a - b);
  if (!c.length) return '';
  const contiguous = c.every((v, i) => i === 0 || v === c[i - 1] + 1);
  return (c.length === 1 ? `${c[0]}` : contiguous ? `${c[0]}–${c[c.length - 1]}` : c.join(', ')) + ' класс';
}
// Covers used to be plain <img src="https://gdz-ru.com/…">, which worked only
// because the declarativeNetRequest rule rewrote the User-Agent on the page's
// own image loads too. With that permission gone the browser can no longer
// reach GDZ at all, so a cover is rendered as a placeholder and hydrated from
// the licensed proxy (hydrateCovers below).
//
// Still gated on isGdzCoverUrl: storage is user-writable, and a tampered book
// record must not turn Settings into a blind third-party image fetcher.
const coverHtml = (url, cls) => (isGdzCoverUrl(url)
  ? `<span class="cover ${cls} ph" data-cover="${esc(url)}">${iconSvg('book', 16)}</span>`
  : `<span class="cover ${cls} ph">${iconSvg('book', 16)}</span>`);

// One entry per cover URL, shared by both lists and kept for the page's
// lifetime: the search results repaint on every keystroke, and re-fetching the
// same dozen covers through the proxy on each one would be pointless traffic.
// A failed cover caches `null` so a dead URL is not retried on every repaint.
const coverCache = new Map();

function loadCover(url) {
  if (!coverCache.has(url)) {
    coverCache.set(url, gdzSend('GDZ_COVER', { url }).then(
      (resp) => (resp?.ok && resp.image?.dataBase64
        ? `data:${resp.image.mimeType};base64,${resp.image.dataBase64}`
        : null),
      () => null
    ));
  }
  return coverCache.get(url);
}

/**
 * Swap every cover placeholder under `root` for the real image.
 *
 * Deliberately fire-and-forget and failure-tolerant: a cover is decoration, and
 * the framed placeholder it replaces is already an acceptable final state. The
 * element is re-checked after the await because a repaint may have replaced the
 * row while the proxy request was in flight.
 */
function hydrateCovers(root) {
  for (const placeholder of root.querySelectorAll('[data-cover]')) {
    const url = placeholder.dataset.cover;
    void loadCover(url).then((dataUrl) => {
      if (!dataUrl || !placeholder.isConnected) return;
      const img = document.createElement('img');
      img.className = placeholder.className.replace(/\bph\b/, '').trim();
      img.alt = '';
      img.loading = 'lazy';
      img.src = dataUrl;
      placeholder.replaceWith(img);
    });
  }
}

function gdzSend(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => resolve(chrome.runtime.lastError ? null : resp));
  });
}

// Is this catalog book already pinned for its subject? (dedupe by canonical URL)
const isAdded = (b) => {
  const url = normalizeGdzApiUrl(b?.url);
  return !!url && asBookArray(gdzBooks[String(b.subject_id)]).some((x) => x.url === url);
};

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
  hydrateCovers(box);
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
  const generation = ++bookSearchGeneration;
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
  if (generation !== bookSearchGeneration) return;
  if (!resp?.ok) {
    count.textContent = '';
    // The catalog now comes through the licensed proxy, so the most likely
    // failure is a missing or expired key — and the proxy already phrases that
    // for a student. A bare "не удалось загрузить" would send them looking for
    // a network problem they don't have.
    const reason = typeof resp?.error === 'string' && resp.error.trim()
      ? resp.error
      : 'Не удалось загрузить каталог ГДЗ.';
    results.innerHTML = `<div class="empty">${iconSvg('alert', 15)}<span>${esc(reason)}</span></div>`;
    return;
  }
  // Only surface subjects the extension can map back from a Mesh lesson — pinning
  // a book for an unmappable subject would never resolve. (No-op when a single
  // subject is already selected; it's one of the allowed ids.)
  const allowed = new Set(EXERCISE_SUBJECTS.map((s) => s.id));
  browseResults = (resp.books || []).map((book) => {
    const url = normalizeGdzApiUrl(book?.url);
    return url ? { ...book, url } : null;
  }).filter((book) => book && allowed.has(book.subject_id));
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
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
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
  hydrateCovers(el);
  el.onclick = () => (isAdded(b) ? removeBook(String(b.subject_id), b.url) : addBook(b));
  el.onkeydown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.key === ' ') e.preventDefault();
    el.click();
  };
}

async function addBook(b) {
  const sid = String(b.subject_id);
  const url = normalizeGdzApiUrl(b.url);
  if (!url || asBookArray(gdzBooks[sid]).some((x) => x.url === url)) return;
  const book = {
    url, title: b.title, breadcrumb: b.breadcrumb, year: b.year,
    study_level: b.study_level, subtype: b.subtype, cover_url: b.cover_url,
    classes: b.classes, is_paid: b.is_paid, subjectId: Number(sid), subject_id: Number(sid)
  };
  const generation = ++bookMutationGeneration;
  const response = await gdzSend('GDZ_BOOK_ADD', { book });
  if (!response?.ok) return;
  // A newer local action or storage.onChanged event owns the UI now. Do not
  // repaint it with this older response snapshot if delivery was reordered.
  if (generation === bookMutationGeneration) renderGdzState(response.gdzBooks);
}

async function removeBook(sid, url) {
  const canonicalUrl = normalizeGdzApiUrl(url);
  if (!canonicalUrl) return;
  const generation = ++bookMutationGeneration;
  const response = await gdzSend('GDZ_BOOK_REMOVE', { subjectId: sid, url: canonicalUrl });
  if (!response?.ok) return;
  if (generation === bookMutationGeneration) renderGdzState(response.gdzBooks);
}

function renderGdzState(value) {
  gdzBooks = canonicalizeBookState(value);
  renderBooks();
  for (const book of browseResults) syncResultRow(book.url);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.gdzBooks || !gdzLoaded) return;
  bookMutationGeneration++;
  renderGdzState(changes.gdzBooks.newValue);
});

// Repaint the single catalog row for a url so its added/removed state reflects
// storage — without rebuilding the list or disturbing scroll. A url is unique in
// the catalog, so at most one row matches. Comparing dataset in JS sidesteps any
// attribute-selector escaping of slash-bearing urls.
function syncResultRow(url) {
  const canonicalUrl = normalizeGdzApiUrl(url);
  if (!canonicalUrl) return;
  const b = browseResults.find((x) => x.url === canonicalUrl);
  if (!b) return;
  for (const el of document.getElementById('gdzPickResults').children) {
    if (el.dataset.url === canonicalUrl) { paintResultRow(el, b); return; }
  }
}

async function loadGdz() {
  const generation = bookMutationGeneration;
  const { studentGrade = '', gdzBooks: stored = {} } = await chrome.storage.local.get(['studentGrade', 'gdzBooks']);
  // If onChanged delivered a newer cross-tab write while this read was in
  // flight, keep that newer state instead of repainting the older snapshot.
  if (generation === bookMutationGeneration) renderGdzState(stored);
  setFieldUnlessTouched('studentGrade', studentGrade || '');
  buildSubjectFilter();
  runBookSearch();
}

async function ensureGdz() {
  if (gdzLoaded) return;
  gdzLoaded = true;
  await loadGdz();
}

function wireGdz() {
  let gradeWriteQueue = Promise.resolve();
  document.getElementById('studentGrade').onchange = (e) => {
    const value = e.target.value;
    const write = gradeWriteQueue.then(() => chrome.storage.local.set({ studentGrade: value }));
    gradeWriteQueue = write.catch(() => {});
    runBookSearch();
    return write;
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

/* ---------- Developer diagnostics (owner-only) ---------- */

/**
 * Reveal or hide the «Диагностика» tab for the currently activated key.
 *
 * Called from renderLicenseStatus, which is the single funnel every licence
 * transition passes through (initial load, save, deactivate) — so pasting the
 * owner key reveals the tab without a reload, and deactivating hides it again.
 * Hiding also leaves the tab: an owner who deactivates must not be left staring
 * at a panel that no longer refreshes.
 */
async function applyDevMode() {
  const active = await isDevModeActive();
  document.body.classList.toggle('dev-mode', active);
  if (!active) {
    devTracesLoaded = false;
    if (activeSection === 'devtools' && showSection) showSection('general');
  }
}

const DEV_TRACE_KIND_LABEL = {
  test: 'Тест',
  requestion: 'Перерешать',
  cache: 'Из кэша',
};

function devTraceTime(at) {
  const date = new Date(Number(at) || 0);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
}

/**
 * One collapsible text field. `value` is scraped page content and model output —
 * untrusted by definition — so it is only ever assigned through textContent.
 * Nothing here goes near innerHTML or mdToHtml: this panel exists to show what
 * the model literally received, and rendering it would both hide the answer and
 * hand a Мэш page a script injection into the settings origin.
 */
function devTraceField(label, value, { mono = 'plain', always = false } = {}) {
  const text = String(value ?? '');
  // `always` is for the scraped input: an EMPTY capture is the single most
  // important thing this panel can report, and silently omitting the section
  // would hide the very failure the tab exists to surface.
  if (!text && !always) return null;
  const field = document.createElement('div');
  field.className = 'devtrace-field';
  const header = document.createElement('header');
  const title = document.createElement('span');
  title.textContent = `${label} · ${text.length.toLocaleString('ru-RU')} симв.`;
  header.appendChild(title);
  if (text) {
    const copy = document.createElement('button');
    copy.className = 'ghostbtn';
    copy.type = 'button';
    copy.textContent = 'Копировать';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        flashButton(copy);
      } catch { /* clipboard denied — the text is selectable by hand */ }
    };
    header.appendChild(copy);
  }
  field.appendChild(header);
  if (!text) {
    const empty = document.createElement('div');
    empty.className = 'devtrace-error';
    empty.textContent = 'Пусто — со страницы не считано ничего. Это и есть проблема считывания.';
    field.appendChild(empty);
    return field;
  }
  const pre = document.createElement('pre');
  if (mono === 'reasoning') pre.className = 'reasoning';
  pre.textContent = text;
  field.appendChild(pre);
  return field;
}

function devTraceCard(trace) {
  const card = document.createElement('details');
  card.className = 'devtrace';

  const summary = document.createElement('summary');
  const kind = document.createElement('span');
  kind.className = 'devtrace-kind';
  kind.dataset.kind = trace.kind || 'test';
  if (trace.ok === false) kind.dataset.state = 'fail';
  kind.textContent = trace.ok === false
    ? 'Ошибка'
    : (DEV_TRACE_KIND_LABEL[trace.kind] || trace.kind || 'Тест');
  summary.appendChild(kind);

  const title = document.createElement('span');
  title.className = 'devtrace-title';
  title.textContent = devTraceTime(trace.at);
  summary.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'devtrace-meta';
  const facts = [];
  if (Number.isInteger(trace.questionCount)) facts.push(`${trace.questionCount} отв.`);
  // Coverage at a glance. "0 исправлено" alone is ambiguous — it can mean
  // "everything checked out" or "nothing was checkable" — so the header always
  // reports how many answers the checker could actually verify.
  if (Array.isArray(trace.checks) && trace.checks.length) {
    const verified = trace.checks.filter((check) => check.status === 'verified').length;
    const fixed = trace.checks.filter((check) => check.status === 'fixed').length;
    facts.push(`проверено ${verified + fixed}/${trace.checks.length}`);
  }
  if (Number.isInteger(trace.pageTextChars)) facts.push(`вход ${trace.pageTextChars.toLocaleString('ru-RU')} симв.`);
  if (trace.effort) facts.push(`effort ${trace.effort}`);
  if (trace.screenshot) facts.push('+скриншот');
  if (trace.model) facts.push(trace.model);
  if (Number.isFinite(trace.durationMs)) facts.push(`${(trace.durationMs / 1000).toFixed(1)}s`);
  if (trace.usage?.total) facts.push(`${trace.usage.total} tok`);
  for (const fact of facts) {
    const span = document.createElement('span');
    span.textContent = fact;
    meta.appendChild(span);
  }
  summary.appendChild(meta);
  card.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'devtrace-body';
  if (trace.error) {
    const error = document.createElement('div');
    error.className = 'devtrace-error';
    error.textContent = trace.error;
    body.appendChild(error);
  }
  if (trace.url) {
    const url = devTraceField('Страница', trace.url);
    if (url) body.appendChild(url);
  }
  // Answers the arithmetic checker rewrote. Shown FIRST and loudly: each row is
  // a case where the model showed correct working and typed a different number,
  // which is the regression this whole checker exists to stop
  // (lib/test-answer-arithmetic.js). An empty section here is the healthy state.
  if (Array.isArray(trace.corrections) && trace.corrections.length) {
    const fixed = document.createElement('div');
    fixed.className = 'devtrace-field';
    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = `Исправлена арифметика · ${trace.corrections.length}`;
    header.appendChild(title);
    fixed.appendChild(header);
    for (const correction of trace.corrections) {
      const row = document.createElement('div');
      row.className = 'devtrace-fix';
      row.textContent =
        `№${correction.index}: модель написала «${correction.from}», ` +
        `но её же выражение ${correction.work} даёт «${correction.to}» — подставлено ${correction.to}`;
      fixed.appendChild(row);
    }
    body.appendChild(fixed);
  }
  // The answers nothing could check, with the reason. This is the honest half
  // of the coverage story: these are the ones still riding on the model getting
  // its own transcription right.
  const skipped = Array.isArray(trace.checks)
    ? trace.checks.filter((check) => check.status === 'unchecked')
    : [];
  if (skipped.length) {
    const box = document.createElement('div');
    box.className = 'devtrace-field';
    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = `Не проверено автоматически · ${skipped.length}`;
    header.appendChild(title);
    box.appendChild(header);
    for (const check of skipped) {
      const row = document.createElement('div');
      row.className = 'devtrace-skip';
      row.textContent = `№${check.index}: ${check.reason || 'нечем проверить'}`;
      box.appendChild(row);
    }
    body.appendChild(box);
  }
  // Ordered by what you check first when answers come back wrong: the scraped
  // input, then what we asked, then how the model reasoned, then what it said.
  const fields = [
    devTraceField('Вход — текст со страницы (то, что «спарсилось»)', trace.pageText, { always: true }),
    devTraceField('Полное сообщение пользователю модели', trace.userText),
    devTraceField('Рассуждение модели', trace.reasoning, { mono: 'reasoning' }),
    devTraceField('Сырой ответ модели', trace.rawAnswer),
    devTraceField('Системный промпт', trace.systemPrompt),
  ];
  for (const field of fields) if (field) body.appendChild(field);
  card.appendChild(body);
  return card;
}

let devTracesLoaded = false;
let devTraceGeneration = 0;

async function loadDevTraces() {
  const generation = ++devTraceGeneration;
  const box = document.getElementById('devTraces');
  if (!box) return;
  const traces = await readDevTraces();
  if (generation !== devTraceGeneration) return;
  box.innerHTML = '';
  if (!traces.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'Пока пусто. Решите тест — здесь появится текст, который расширение считало со страницы, ' +
      'рассуждение модели и её сырой ответ.';
    box.appendChild(empty);
    return;
  }
  for (const trace of traces) box.appendChild(devTraceCard(trace));
}

function wireDevTools() {
  const reload = document.getElementById('devReload');
  if (reload) reload.onclick = () => { devTracesLoaded = true; void loadDevTraces(); };
  const clear = document.getElementById('devClear');
  if (clear) {
    clear.onclick = async () => {
      await clearDevTraces();
      devTracesLoaded = true;
      void loadDevTraces();
    };
  }
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
    if (name === 'analytics') void ensureUsageDashboard().catch(() => {});
    if (name === 'books') ensureGdz();
    if (name === 'history' && !historyLoaded) {
      historyLoaded = true;
      loadHistory();
    }
    if (name === 'devtools' && !devTracesLoaded) {
      devTracesLoaded = true;
      void loadDevTraces();
    }
  }
  showSection = show;
  for (const t of tabs) t.onclick = () => show(t.dataset.tab);
  show('general');
}

/* ---------- Init ---------- */

applyProviderVisibility(); // before anything paints, so no vendor name flashes
wireReveals();
wireTabs();
applyConsentGate(false);
wireGdz();
wireConsent();
wirePrivacy();
wireReferral();
wireUsageDashboard();
wireDevTools();
void applyDevMode();
const saveButton = document.getElementById('save');
saveButton.onclick = () => { void handleSettingsSave(saveButton); };
document.getElementById('aiProvider').addEventListener('change', syncProviderKeys);
document.getElementById('reload').onclick = () => { historyLoaded = true; loadHistory(); };
void initializeSettingsForm(saveButton);
