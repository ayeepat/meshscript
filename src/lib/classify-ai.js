/**
 * Model-backed task classifier (background service worker only).
 *
 * Decides what each homework card needs from the user: an attached file from
 * Mesh, a photo of the textbook page, or nothing. Understanding "сделать
 * упражнение из прикреплённого документа" vs "упр. 25" vs "повторить
 * параграф" is a language task — teachers phrase it endlessly — so we let a
 * model sort it. Always a CHEAP text model, never the main solve provider:
 * DeepSeek V4 Flash when it's usable — via an active СМЭШ license (the
 * proxy) or a BYO Model Studio key; reachable from Russia, near-free —
 * else Groq (genuinely free, but blocked on Russian networks).
 *
 * Design:
 *  - regex heuristics (task-classifier.js) give an instant first pass and
 *    are the fallback when no cheap-model key is set or the call fails;
 *  - all tasks of the week go in ONE batched call, not one per card;
 *  - results are cached in chrome.storage.local by task text, so re-opening
 *    the popup on the same week makes zero API calls.
 */

import { askGroq } from './groq.js';
import { askDeepseek } from './deepseek.js';
import { classifyTask } from './task-classifier.js';

const CACHE_KEY = 'taskClassCache';
const CACHE_MAX = 300;
const KINDS = new Set(['attachment', 'textbook', 'none']);

const SYSTEM =
  'Ты классифицируешь домашние задания из электронного дневника МЭШ. ' +
  'Для каждого задания определи, что нужно ученику, чтобы его выполнить:\n' +
  '- "attachment" — задание ссылается на файл/документ/презентацию/рабочий лист/карточку/тест ' +
  'или на вариант ОГЭ/ЕГЭ/ВПР, аудиозапись по ссылке (Google Drive, Яндекс.Диск), задание на ' +
  'аудирование — то есть на внешний материал, приложенный в дневнике или по ссылке ' +
  '(его нужно скачать и загрузить сюда);\n' +
  '- "textbook" — задание лишь ссылается на учебник (номер упражнения, задачи, страницы, параграфа), ' +
  'а сам текст задания не приведён — нужно фото страницы учебника;\n' +
  '- "none" — задание самодостаточно, его можно выполнить по приведённому тексту.\n\n' +
  'Ответь ТОЛЬКО JSON-массивом строк, по одной на каждое задание, в том же порядке. ' +
  'Пример ответа: ["none","textbook","attachment"]';

const cacheKeyFor = (task) => (task || '').trim().toLowerCase().slice(0, 200);

// Serialise cache writes (read-modify-write on one storage.local object) so
// overlapping classify calls can't clobber each other's entries. Each write
// re-reads the latest cache, merges the new entries and caps the size.
let classCacheWrite = Promise.resolve();
function mergeClassCache(entries) {
  classCacheWrite = classCacheWrite.then(async () => {
    const { [CACHE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_KEY);
    Object.assign(cache, entries);
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  }).catch(() => { /* cache write is best-effort */ });
  return classCacheWrite;
}

/**
 * @param {string[]} tasks homework texts in card order
 * @returns {Promise<Array<'attachment'|'textbook'|'none'>>} same order as input
 */
export async function classifyTasksAI(tasks) {
  // Instant heuristic pass — also the final answer if no cheap model is available.
  const result = tasks.map((t) => classifyTask(t).kind || 'none');

  const { groqApiKey, qwenApiKey, licenseStatus, [CACHE_KEY]: cache = {} } =
    await chrome.storage.local.get(['groqApiKey', 'qwenApiKey', 'licenseStatus', CACHE_KEY]);
  // DeepSeek runs either on a BYO Model Studio key (one Alibaba key for both
  // Qwen and DeepSeek, see deepseek.js) or through the СМЭШ proxy for
  // licensed users. Preferred over Groq: Groq is unreachable from Russian
  // networks, which is this extension's whole audience.
  const deepseekUsable = !!qwenApiKey || !!licenseStatus?.ok;
  const ask = deepseekUsable ? askDeepseek : (groqApiKey ? askGroq : null);
  if (!ask) return result;

  const pending = [];
  tasks.forEach((t, i) => {
    const cached = cache[cacheKeyFor(t)];
    if (KINDS.has(cached)) result[i] = cached;
    else if ((t || '').trim()) pending.push(i);
  });
  if (!pending.length) return result;

  try {
    const list = pending.map((i, n) => `${n + 1}. ${tasks[i].slice(0, 300)}`).join('\n');
    const raw = await ask(SYSTEM, list, [], []);
    const m = raw.match(/\[[\s\S]*?\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    const newEntries = {};
    pending.forEach((i, n) => {
      if (KINDS.has(arr[n])) {
        result[i] = arr[n];
        newEntries[cacheKeyFor(tasks[i])] = arr[n];
      }
    });
    // Persist via a serialised read-merge-write so concurrent calls don't
    // clobber the cache; capping happens inside (see mergeClassCache).
    await mergeClassCache(newEntries);
  } catch (_e) {
    // Model down / malformed reply — the heuristic result stands.
  }
  return result;
}
