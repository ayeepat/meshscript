/**
 * NaraRouter API wrapper (OpenAI-compatible chat completions).
 * A free model gateway (router.bynara.id) — 7M tokens/day on the free tier,
 * reset daily at 07:00 WIB, rate-limited to ~10 requests/min. Runs ONLY in the
 * background service worker. Key is entered in Settings and stored in
 * chrome.storage.local. Never hardcoded, never exposed to content scripts.
 *
 * Role: a FREE alternative to OpenRouter. Splits text vs. vision across two
 * models:
 *  - Text only:  a MiMo model.
 *  - Vision (images / test screenshots): a Mistral Medium model.
 *
 * MODEL ALIASES ARE RESOLVED LIVE. The NaraRouter free lineup gets renamed and
 * retired without notice (a hardcoded id eventually 404s "model does not exist").
 * So instead of trusting one constant, we fetch the account's actual `/v1/models`
 * list, pick the best match for the modality, cache it, and on a stale-model 404
 * re-discover + retry once. The constants below are only PREFERENCES / fallbacks.
 *
 * Deliberately MINIMAL otherwise: these free models are NOT reasoning models, so
 * we do NOT forward `reasoning`/`reasoning_effort` (it does nothing for them and
 * over-instructing a small model only hurts accuracy). Likewise no native PDF
 * reading — the solver forces OpenRouter for PDFs.
 *
 * Streams when opts.onDelta is given. responseFormat = 'json_object' is sent only
 * on the text path (vision relies on the prompt + the caller's tiered parser).
 */

import { postStream } from './http.js';
import { isImageFile, isTextFile } from './file-kinds.js';
import { base64ToUtf8 } from './extract.js';
import { chargeOne } from './rate-limit.js';

const ENDPOINT = 'https://router.bynara.id/v1/chat/completions';
const MODELS_ENDPOINT = 'https://router.bynara.id/v1/models';

// Preferred aliases, best → worst, matched against the live model list. Vision
// path = the test solver (screenshots); text path = plain homework.
const VISION_PREFS = ['mistral-medium-3.5', 'mistral-medium-3-5', 'mistral-medium', 'mistral-large', 'pixtral-large'];
const TEXT_PREFS = ['mimo-v2.5-pro-free', 'mimo-v2-5-pro-free', 'mimo-v2.5-free', 'mimo-v2-5-free', 'mimo'];
// Used ONLY if /v1/models can't be read at all (offline / unexpected shape).
const VISION_FALLBACK = 'mistral-medium-3-5';
const TEXT_FALLBACK = 'mimo-v2.5-pro-free';

const MODELS_CACHE_KEY = 'nararouterModelsCache';
const MODELS_TTL_MS = 6 * 60 * 60 * 1000;

async function getKey() {
  const { nararouterApiKey } = await chrome.storage.local.get('nararouterApiKey');
  if (!nararouterApiKey) throw new Error('Ключ NaraRouter не задан. Откройте настройки расширения.');
  return nararouterApiKey;
}

/**
 * The model aliases this key/plan can actually use. Cached for MODELS_TTL_MS.
 * Returns string[] or null on any failure — the caller then uses a constant.
 */
async function fetchModelIds(key, force = false) {
  try {
    if (!force) {
      const { [MODELS_CACHE_KEY]: c } = await chrome.storage.local.get(MODELS_CACHE_KEY);
      if (c && Array.isArray(c.ids) && c.ids.length && (Date.now() - c.at) < MODELS_TTL_MS) return c.ids;
    }
    const res = await fetch(MODELS_ENDPOINT, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    // OpenAI shape is { data: [{ id }, ...] }; be lenient about wrappers.
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : null);
    const ids = list ? list.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean) : null;
    if (ids && ids.length) await chrome.storage.local.set({ [MODELS_CACHE_KEY]: { ids, at: Date.now() } });
    return ids && ids.length ? ids : null;
  } catch { return null; }
}

/** Pick the best available alias for the wanted modality from a live id list. */
function chooseModel(ids, wantVision) {
  if (!ids || !ids.length) return null;
  const pairs = ids.map((id) => [id, String(id).toLowerCase()]);
  // 1. an exact preferred alias.
  for (const p of (wantVision ? VISION_PREFS : TEXT_PREFS)) {
    const hit = pairs.find(([, l]) => l === p);
    if (hit) return hit[0];
  }
  // 2. fuzzy by family. Vision stays multimodal-only so a screenshot never goes
  // to a text-only model.
  const fams = wantVision ? [/mistral|pixtral/, /-vl\b|vision|llava/] : [/mimo/];
  for (const fam of fams) {
    const hit = pairs.find(([, l]) => fam.test(l));
    if (hit) return hit[0];
  }
  // Vision: don't risk a text-only model — let the caller use the constant.
  return wantVision ? null : ids[0];
}

/** Resolve the alias to send: live list → preferred → constant fallback. */
async function resolveModel(key, wantVision, force = false) {
  const ids = await fetchModelIds(key, force);
  const chosen = chooseModel(ids, wantVision) || (wantVision ? VISION_FALLBACK : TEXT_FALLBACK);
  // Logged to the SERVICE WORKER console so the user can see which models their
  // key exposes and which one was picked (helps when a lineup changes).
  try {
    console.log('[СМЭШ AI nararouter]', wantVision ? 'vision' : 'text', '→', chosen,
      '· доступные:', ids ? ids.join(', ') : '(список недоступен — fallback)');
  } catch { /* no console */ }
  return chosen;
}

// One file -> one OpenAI-style content part. NaraRouter (like Groq) has no native
// PDF path, so non-image / non-text files are described in a note. Shared by the
// current message and by replayed history turns so attachments survive follow-ups.
function fileToContentPart(f) {
  if (isImageFile(f)) {
    const m = (f.mimeType || '').startsWith('image/') ? f.mimeType : 'image/png';
    return { type: 'image_url', image_url: { url: `data:${m};base64,${f.dataBase64}` } };
  }
  if (isTextFile(f)) {
    // Plain text and locally-extracted Office docs (see extract.js) — inline the
    // contents so the model actually reads them instead of refusing.
    const text = base64ToUtf8(f.dataBase64);
    return {
      type: 'text',
      text: text
        ? `[Содержимое приложенного файла «${f.name || 'файл'}»]:\n${text.slice(0, 50000)}`
        : `[Приложен файл ${f.name || ''}, не удалось прочитать его как текст.]`
    };
  }
  return {
    type: 'text',
    text: `[Приложен файл ${f.name || ''} (${f.mimeType}), который нельзя прочитать напрямую. Попросите фото/скриншот или PDF, если нужен текст. Не выдумывай его содержимое.]`
  };
}

function buildUserContent(userText, files) {
  const content = [{ type: 'text', text: userText }];
  for (const f of files) content.push(fileToContentPart(f));
  return content;
}

function historyToMessage(m) {
  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (role === 'user' && m.files?.length) return { role, content: buildUserContent(m.content || '', m.files) };
  return { role, content: m.content };
}

// The provider rejected the model id (retired / renamed / not on plan).
function isModelMissing(err) {
  return /does not exist|no such model|unknown model|model_not_found|not found/i.test(String(err?.message || err));
}

export async function askNararouter(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, signal = null } = opts;
  const key = await getKey();
  // Charge the daily budget BEFORE the network round-trip — same as openrouter/groq.
  await chargeOne('nararouter');

  // Vision model if EITHER the current message OR a replayed history turn carries
  // an image (so follow-ups keep the photo and stay on the vision model).
  const hasImages = files.some(isImageFile) ||
    history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));

  const userContent = buildUserContent(userText, files);
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(historyToMessage),
    // files.length (not hasImages): a non-image attachment still needs its
    // "can't read this directly" note delivered to the model.
    { role: 'user', content: files.length ? userContent : userText }
  ];
  const headers = { Authorization: `Bearer ${key}` };

  const run = (model) => {
    const body = { model, messages, temperature: 0.3 };
    // JSON mode only on the TEXT model — see groq.js for the same reasoning.
    if (responseFormat === 'json_object' && !hasImages) body.response_format = { type: 'json_object' };
    return postStream(ENDPOINT, { headers, body, label: 'NaraRouter', onDelta, signal });
  };

  const model = await resolveModel(key, hasImages);
  try {
    return await run(model);
  } catch (e) {
    if (!isModelMissing(e)) throw e;
    // Stale/renamed alias → re-discover the live list and retry once.
    const alt = await resolveModel(key, hasImages, true);
    if (alt && alt !== model) {
      try { return await run(alt); }
      catch (e2) { if (!isModelMissing(e2)) throw e2; }
    }
    throw new Error(
      'NaraRouter не нашёл нужную модель (бесплатный список моделей у них часто меняется). ' +
      'Откройте router.bynara.id, посмотрите доступные модели в своём тарифе и сообщите мне точные названия, ' +
      'либо временно переключитесь на OpenRouter / Groq в настройках расширения.'
    );
  }
}
