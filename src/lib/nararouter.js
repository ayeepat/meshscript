/**
 * NaraRouter API wrapper (OpenAI-compatible chat completions).
 * A free model gateway (router.bynara.id) — 7M tokens/day on the free tier,
 * reset daily at 07:00 WIB, rate-limited to ~10 requests/min. Runs ONLY in the
 * background service worker. Key is entered in Settings and stored in
 * chrome.storage.local. Never hardcoded, never exposed to content scripts.
 *
 * Role: a FREE alternative to OpenRouter for the user's own testing. Like Groq
 * it splits text vs. vision across two models:
 *  - Text only:  a MiMo model.
 *  - Vision (images / test screenshots / any upload that needs seeing):
 *                a Mistral Medium model.
 *
 * MODEL ALIASES ARE RESOLVED LIVE. The NaraRouter free lineup gets renamed and
 * retired without notice — a hardcoded id eventually 404s with "model does not
 * exist". So instead of trusting one constant, we fetch the account's actual
 * `/v1/models` list, pick the best match for the wanted modality, cache it, and
 * (on a stale-model 404) re-discover + retry once. The constants below are only
 * PREFERENCES / last-resort fallbacks.
 *
 * Caveats vs. OpenRouter (kept deliberately out of this file's job):
 *  - No native PDF reading — the solver still forces OpenRouter for PDFs.
 *  - No OpenRouter-style `reasoning` channel — we don't forward opts.reasoning.
 *
 * Streams when opts.onDelta is given. Set opts.responseFormat = 'json_object'
 * for structured replies (only sent on the text path; the vision path relies on
 * the prompt + the caller's tiered JSON parser, mirroring groq.js).
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
 * The model aliases this key/plan can actually use. Cached for MODELS_TTL_MS
 * (a renamed lineup is rare). Returns string[] or null on any failure — the
 * caller then falls back to a constant.
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
  // 2. fuzzy by family name.
  const fam = wantVision ? /mistral|pixtral/ : /mimo/;
  const fuzzy = pairs.find(([, l]) => fam.test(l));
  if (fuzzy) return fuzzy[0];
  // 3. vision needs a multimodal model — accept any obviously-vision id.
  if (wantVision) {
    const v = pairs.find(([, l]) => /vision|vl|pixtral|gemini|claude|llava/.test(l));
    if (v) return v[0];
  }
  return null;
}

/** Resolve the alias to send: live list → preferred → constant fallback. */
async function resolveModel(key, wantVision, force = false) {
  const ids = await fetchModelIds(key, force);
  return chooseModel(ids, wantVision) || (wantVision ? VISION_FALLBACK : TEXT_FALLBACK);
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

// True when the provider rejected the model id (retired / renamed / not on plan).
function isModelMissing(err) {
  return /does not exist|no such model|unknown model|model_not_found|not found/i.test(String(err?.message || err));
}

export async function askNararouter(systemPrompt, userText, files = [], history = [], opts = {}) {
  const { onDelta = null, responseFormat = null, signal = null } = opts;
  const key = await getKey();
  // Charge the daily budget BEFORE the network round-trip — same reasoning as
  // openrouter.js / groq.js: a runaway loop can't burn through the day's tokens.
  await chargeOne('nararouter');

  // Pick the vision model if EITHER the current message OR a replayed history
  // turn carries an image — otherwise a follow-up would route to the text model
  // and lose the original photo (same logic as groq.js).
  const hasImages = files.some(isImageFile) ||
    history.some((m) => m.role !== 'assistant' && m.files?.some(isImageFile));

  const userContent = buildUserContent(userText, files);
  const body = {
    model: await resolveModel(key, hasImages),
    messages: [
      { role: 'system', content: systemPrompt },
      ...history.map(historyToMessage),
      // files.length (not hasImages): a non-image attachment still needs its
      // "can't read this directly" note delivered to the model.
      { role: 'user', content: files.length ? userContent : userText }
    ],
    temperature: 0.3
  };
  // JSON mode only on the TEXT model — see groq.js for the same reasoning.
  if (responseFormat === 'json_object' && !hasImages) body.response_format = { type: 'json_object' };

  // We intentionally do NOT forward opts.reasoning: it's an OpenRouter-specific
  // param and these models aren't reasoning models on the free tier.

  const headers = { Authorization: `Bearer ${key}` };

  // ALWAYS stream (per-chunk idle timeout keeps slow vision replies from tripping
  // the hard timeout). The 404 path below only fires PRE-stream (bad model id), so
  // nothing has been emitted yet — a clean retry is safe.
  try {
    return await postStream(ENDPOINT, { headers, body, label: 'NaraRouter', onDelta, signal });
  } catch (e) {
    if (!isModelMissing(e)) throw e;
    // The cached/preferred alias was retired or renamed. Re-discover the live
    // list (bypassing cache) and retry ONCE with a fresh pick.
    const alt = await resolveModel(key, hasImages, true);
    if (alt && alt !== body.model) {
      body.model = alt;
      try {
        return await postStream(ENDPOINT, { headers, body, label: 'NaraRouter', onDelta, signal });
      } catch (e2) { if (!isModelMissing(e2)) throw e2; /* else fall through to guidance */ }
    }
    throw new Error(
      'NaraRouter не нашёл нужную модель (бесплатный список моделей у них часто меняется). ' +
      'Откройте router.bynara.id, посмотрите доступные модели в своём тарифе и сообщите мне точные названия, ' +
      'либо временно переключитесь на OpenRouter / Groq в настройках расширения.'
    );
  }
}
