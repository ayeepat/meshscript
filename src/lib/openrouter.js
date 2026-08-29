/**
 * OpenRouter API wrapper (OpenAI-compatible chat completions).
 * Main model: google/gemini-2.5-flash (text, images AND PDFs natively).
 * Runs ONLY in the background service worker.
 *
 * Streams when opts.onDelta is given; otherwise does a single JSON round-trip.
 * Set opts.responseFormat = 'json_object' for structured replies (test solver).
 */

import { fetchTextBounded, postStream } from './http.js';
import { isImageFile, isPdfFile, isTextFile } from './file-kinds.js';
import { reserveOne, commitOne, cancelOne } from './rate-limit.js';
import { clipText } from './clip-text.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';
const MODEL = 'google/gemini-2.5-flash';

// Daily spend dashboard (Settings). OpenRouter's /credits reports only lifetime
// cumulative usage, which cannot be truthfully assigned to individual days when
// Settings is opened sporadically. Instead, every clean completion records the
// exact per-request `usage.cost` from OpenRouter's terminal stream frame. The
// credits snapshots are retained only as account-scoped observations; they are
// never smeared across unobserved days.
const SPEND_DAYS = 14;
const SNAP_KEY = 'orUsageSnap';
const SPEND_STORE_VERSION = 2;
const MAX_SPEND_ACCOUNTS = 4;
let spendMutationQueue = Promise.resolve();

/**
 * This is only a fingerprint: the raw API key must never be persisted beside
 * chart data.
 */
async function spendKeyId(apiKey) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('').slice(0, 16);
}

function spendDayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function spendLastNDays(n) {
  const today = new Date();
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(today);
    x.setDate(today.getDate() - i);
    days.push(spendDayKey(x));
  }
  return days;
}

function cleanDayMap(value, keepDays) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const day of keepDays) {
    const amount = Number(value[day]);
    if (Number.isFinite(amount) && amount >= 0) out[day] = amount;
  }
  return out;
}

function normalizeSpendStore(value) {
  const keepDays = spendLastNDays(SPEND_DAYS + 1);
  const accounts = {};
  if (value?.version === SPEND_STORE_VERSION && value.accounts &&
      typeof value.accounts === 'object' && !Array.isArray(value.accounts)) {
    for (const [keyId, account] of Object.entries(value.accounts)) {
      if (!/^[a-f0-9]{16}$/.test(keyId) || !account || typeof account !== 'object') continue;
      accounts[keyId] = {
        exact: cleanDayMap(account.exact, keepDays),
        observed: cleanDayMap(account.observed, keepDays),
        updatedAt: Number.isFinite(Number(account.updatedAt)) ? Number(account.updatedAt) : 0
      };
    }
  } else if (/^[a-f0-9]{16}$/.test(value?.keyId || '')) {
    // Legacy v1 snapshots were already fingerprint-scoped, but contained only
    // visit-timed cumulative readings. Preserve them as observations without
    // presenting their deltas as exact daily spend.
    accounts[value.keyId] = {
      exact: {},
      observed: cleanDayMap(value.days, keepDays),
      updatedAt: 0
    };
  }
  return { version: SPEND_STORE_VERSION, accounts };
}

function pruneSpendAccounts(accounts, currentKeyId) {
  const entries = Object.entries(accounts);
  if (entries.length <= MAX_SPEND_ACCOUNTS) return accounts;
  entries.sort(([, a], [, b]) => (Number(b?.updatedAt) || 0) - (Number(a?.updatedAt) || 0));
  const out = { [currentKeyId]: accounts[currentKeyId] };
  for (const [keyId, account] of entries) {
    if (keyId === currentKeyId) continue;
    if (Object.keys(out).length >= MAX_SPEND_ACCOUNTS) break;
    out[keyId] = account;
  }
  return out;
}

function enqueueSpendMutation(work) {
  const run = spendMutationQueue.then(work);
  spendMutationQueue = run.catch(() => {});
  return run;
}

/**
 * Mutate only the account belonging to the key that is still current. The
 * account map means even a key switch in the final read->write gap cannot erase
 * another account; the second current-key read drops ordinary delayed results.
 */
function mutateCurrentSpendAccount(apiKey, mutate) {
  return enqueueSpendMutation(async () => {
    try {
      const keyId = await spendKeyId(apiKey);
      const stored = await chrome.storage.local.get([SNAP_KEY, 'openrouterApiKey']);
      if (stored.openrouterApiKey !== apiKey) return false;
      const spendStore = normalizeSpendStore(stored[SNAP_KEY]);
      const account = spendStore.accounts[keyId] || { exact: {}, observed: {}, updatedAt: 0 };
      mutate(account);
      account.updatedAt = Date.now();
      spendStore.accounts[keyId] = account;
      spendStore.accounts = pruneSpendAccounts(spendStore.accounts, keyId);
      const latest = await chrome.storage.local.get('openrouterApiKey');
      if (latest.openrouterApiKey !== apiKey) return false;
      await chrome.storage.local.set({ [SNAP_KEY]: spendStore });
      return true;
    } catch {
      return false; // spend history is best-effort and never breaks an answer
    }
  });
}

// Keep the latest cumulative reading as an account-scoped observation. It is
// useful for diagnostics/baselines but intentionally not converted into daily
// bars: a delta across sparse visits has no defensible per-day allocation.
function recordSpendSnapshot(apiKey, usage) {
  const amount = Number(usage);
  if (!Number.isFinite(amount) || amount < 0) return Promise.resolve(false);
  return mutateCurrentSpendAccount(apiKey, (account) => {
    account.observed = cleanDayMap(account.observed, spendLastNDays(SPEND_DAYS + 1));
    account.observed[spendDayKey()] = amount;
  });
}

// Record the exact cost only after postStream has seen the terminal [DONE]
// frame. Missing/malformed cost fields stay absent rather than becoming an
// estimate based on list prices.
function recordExactSpend(apiKey, usage) {
  const cost = Number(usage?.cost);
  if (!Number.isFinite(cost) || cost <= 0) return Promise.resolve(false);
  return mutateCurrentSpendAccount(apiKey, (account) => {
    account.exact = cleanDayMap(account.exact, spendLastNDays(SPEND_DAYS + 1));
    const day = spendDayKey();
    account.exact[day] = (Number(account.exact[day]) || 0) + cost;
  });
}

/**
 * Exact per-day OpenRouter spend (USD) observed from completed calls made with
 * the currently stored key. Missing/mismatched keys fail closed to zero rows;
 * another account's history is never returned. Ascending.
 * @returns {Promise<Array<{day:string, spend:number}>>}
 */
export async function getSpendHistory(days = SPEND_DAYS) {
  const requestedDays = Number.isSafeInteger(days) && days > 0
    ? Math.min(days, SPEND_DAYS)
    : SPEND_DAYS;
  const empty = () => spendLastNDays(requestedDays).map((day) => ({ day, spend: 0 }));
  try {
    const stored = await chrome.storage.local.get([SNAP_KEY, 'openrouterApiKey']);
    const apiKey = stored.openrouterApiKey;
    if (typeof apiKey !== 'string' || !apiKey) return empty();
    const keyId = await spendKeyId(apiKey);
    const account = normalizeSpendStore(stored[SNAP_KEY]).accounts[keyId];
    if (!account) return empty();
    const rows = spendLastNDays(requestedDays).map((day) => ({
      day,
      spend: Number.isFinite(Number(account.exact?.[day])) ? Number(account.exact[day]) : 0
    }));
    const latest = await chrome.storage.local.get('openrouterApiKey');
    return latest.openrouterApiKey === apiKey ? rows : empty();
  } catch {
    return empty();
  }
}

/**
 * Account balance from OpenRouter's /credits endpoint, using the stored key.
 * Records an account-scoped cumulative observation on success. Never throws —
 * returns { ok:false, reason } so Settings can show a calm fallback.
 * @returns {Promise<{ok:true,total:number,usage:number,remaining:number}|{ok:false,reason:string,status?:number}>}
 */
export async function fetchOpenRouterCredits() {
  const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
  if (!openrouterApiKey) return { ok: false, reason: 'no_key' };
  try {
    const res = await fetchTextBounded(CREDITS_ENDPOINT, {
      headers: { Authorization: `Bearer ${openrouterApiKey}` },
      redirect: 'error'
    });
    if (!res.ok) return { ok: false, reason: 'http', status: res.status };
    const data = JSON.parse(res.text || 'null');
    const d = data?.data || {};
    const total = Number(d.total_credits);
    const usage = Number(d.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(usage)) return { ok: false, reason: 'parse' };
    // The user can change keys while /credits is in flight. Never return or
    // persist account A's delayed result after Settings has switched to B.
    const latest = await chrome.storage.local.get('openrouterApiKey');
    if (latest.openrouterApiKey !== openrouterApiKey) return { ok: false, reason: 'stale_key' };
    await recordSpendSnapshot(openrouterApiKey, usage);
    const finalKey = await chrome.storage.local.get('openrouterApiKey');
    if (finalKey.openrouterApiKey !== openrouterApiKey) return { ok: false, reason: 'stale_key' };
    return { ok: true, total, usage, remaining: Math.max(0, total - usage) };
  } catch { return { ok: false, reason: 'network' }; }
}

/**
 * Validate an OpenRouter API key for onboarding: 200 = works, 401/403 =
 * definitively rejected. Anything else (network error, 5xx, rate limit) is
 * ambiguous and reported as 'unreachable' so callers can keep a possibly-good
 * key instead of bouncing the user — mirroring license.js's keep-last-good
 * policy. Only the HTTP status is consulted, never the body.
 * @param {string} apiKey the candidate key (NOT read from storage)
 * @returns {Promise<{ok:true}|{ok:false,reason:'bad_key'|'unreachable'}>}
 */
export async function verifyOpenRouterKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { ok: false, reason: 'bad_key' };
  try {
    const res = await fetchTextBounded(CREDITS_ENDPOINT, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error'
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'bad_key' };
    return { ok: false, reason: 'unreachable' };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

// Decode a base64 payload to UTF-8 text (service worker has no FileReader).
function b64ToUtf8(b64) {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch { return null; }
}

async function getKey() {
  const { openrouterApiKey } = await chrome.storage.local.get('openrouterApiKey');
  if (!openrouterApiKey) throw new Error('Ключ OpenRouter не задан. Откройте настройки расширения.');
  return openrouterApiKey;
}

// One file -> one OpenAI-style content part. Shared by the current message and
// by replayed history turns, so a file attached on an earlier turn stays in
// context on follow-ups instead of being dropped.
function fileToContentPart(f) {
  const mime = f.mimeType || 'application/octet-stream';
  const name = f.name || '';
  if (isImageFile(f)) {
    const m = mime.startsWith('image/') ? mime : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (isPdfFile(f)) {
    // Gemini 2.5 reads PDFs (incl. scanned pages) natively; OpenRouter routes
    // the file to the model directly when no file-parser plugin is set.
    return { type: 'file', file: { filename: name || 'file.pdf', file_data: `data:application/pdf;base64,${f.dataBase64}` } };
  }
  if (isTextFile(f)) {
    // Plain-text files (.txt/.csv/.md/…) can't go as a "file" part, but we CAN
    // read them — inline a marked prefix so the model sees the task and knows
    // when unusually long source material is incomplete.
    const text = b64ToUtf8(f.dataBase64);
    return {
      type: 'text',
      text: text
        ? `[Содержимое приложенного файла «${name || 'файл'}»]:\n${clipText(text, 50000)}`
        : `[Приложен файл ${name || mime}, не удалось прочитать его как текст.]`
    };
  }
  // Office formats (Word/PowerPoint/Excel) aren't readable by this provider.
  // Non-blocking wording: if there's other readable material (e.g. a PDF),
  // the model must still solve from it and just ignore this file — otherwise
  // a tag-along .docx made it refuse the whole task. Only ask for it if this
  // file is genuinely required. Never invent its contents.
  return {
    type: 'text',
    text: `[Приложен файл ${name || ''} (${mime}). Офисные файлы (Word/PowerPoint/Excel) я не читаю напрямую. ` +
      `Если для этого задания есть другой материал (PDF/фото/текст) — реши по нему, а этот файл просто проигнорируй. ` +
      `Если же он действительно нужен — попроси прислать его как PDF/фото. Содержимое этого файла НЕ выдумывай.]`
  };
}

function buildContent(userText, files) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f));
  return content;
}

// Map a stored history turn to an API message. User turns that carried files are
// rebuilt as multi-part content so the attachment survives into follow-ups.
function historyToMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) return { role, content: buildContent(m.content || '', m.files) };
  return { role, content: m.content };
}

export async function askOpenRouter(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, reasoning = null, signal = null, onUsage = null } = opts;
  const key = await getKey();

  const content = buildContent(userText, files);

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map(historyToMessage),
      { role: 'user', content: files.length ? content : userText }
    ],
    temperature: 0.3,
    // Ask OpenRouter to append an EXACT cost + token usage frame at the end of
    // the stream (postStream captures it via onUsage → telemetry). Cheap and
    // does not affect the answer.
    usage: { include: true }
  };
  if (responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  // Native model reasoning (OpenRouter `reasoning` param). The test solver uses
  // this so Gemini THINKS fully in its private reasoning channel, then emits a
  // tiny answers-only JSON as the visible content. Two wins:
  //  1. The full step-by-step solving no longer eats the output-token budget,
  //     so the `answers` array can never get truncated (the old cause of the
  //     panel not showing + raw reasoning leaking to the user).
  //  2. Reasoning tokens arrive on `delta.reasoning`, which postStream ignores
  //     for accumulation — so the user NEVER sees the reasoning, only answers.
  // We do NOT set reasoning.exclude: letting the reasoning deltas stream keeps
  // resetting postStream's idle timeout during long thinks (no silent stall).
  if (reasoning) body.reasoning = reasoning;

  // OpenRouter shows these on its apps leaderboard. Keep the value ASCII —
  // fetch() throws on a non-Latin-1 header value (so no Cyrillic in X-Title).
  const headers = {
    Authorization: `Bearer ${key}`,
    'HTTP-Referer': 'https://smeshai.xyz',
    'X-Title': 'SMESH AI'
  };

  // ALWAYS stream — including JSON-mode replies (the test solver). This is the
  // fix for the test feature hanging forever on «Решаю…».
  //
  // The old code sent JSON-mode calls through postJson, whose timeout is a HARD
  // 60-s cap on the whole round-trip. google/gemini-2.5-flash is a reasoning
  // model: with a screenshot + JSON output it routinely spends >60 s "thinking"
  // before the first content token, so the request was aborted at 60 s, then
  // silently retried twice more (re-uploading the screenshot each time) — ~3
  // minutes of a frozen spinner that looked like an infinite hang, then a bare
  // timeout error.
  //
  // postStream instead uses an IDLE timeout that resets on every byte received
  // (reasoning deltas / keep-alives included), so a slow-but-progressing answer
  // completes normally and never trips the timeout. onDelta may be null in JSON
  // mode — postStream just accumulates and returns the full text, which is
  // exactly what solveTest/the popup parse. response_format stays in the body,
  // so the streamed content is still a JSON object.
  const reservation = await reserveOne('openrouter');
  try {
    let completedUsage = null;
    const captureUsage = (usage) => {
      completedUsage = usage;
      try { onUsage?.(usage); } catch { /* usage observers never break the answer */ }
    };
    const result = await postStream(ENDPOINT, {
      headers, body, label: 'OpenRouter', onDelta, onUsage: captureUsage, signal
    });
    // Await the tiny storage write while the worker is alive. The recorder is
    // best-effort internally, so storage pressure cannot turn a good answer
    // into an error.
    if (completedUsage) await recordExactSpend(key, completedUsage);
    await commitOne(reservation);
    return result;
  } catch (e) {
    try { await cancelOne(reservation); } catch { /* orphan expires without becoming usage */ }
    throw e;
  }
}
