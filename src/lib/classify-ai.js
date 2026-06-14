/**
 * Groq-backed task classifier (background service worker only).
 *
 * Decides what each homework card needs from the user: an attached file from
 * Mesh, a photo of the textbook page, or nothing. Understanding "сделать
 * упражнение из прикреплённого документа" vs "упр. 25" vs "повторить
 * параграф" is a language task — teachers phrase it endlessly — so we let a
 * model sort it. ALWAYS Groq (free tier), never the paid solve provider:
 * classification must cost nothing.
 *
 * Design:
 *  - regex heuristics (task-classifier.js) give an instant first pass and
 *    are the fallback when no Groq key is set or the call fails;
 *  - all tasks of the week go in ONE batched call, not one per card;
 *  - results are cached in chrome.storage.local by task text, so re-opening
 *    the popup on the same week makes zero API calls.
 */

import { askGroq } from './groq.js';
import { classifyTask } from './task-classifier.js';

const CACHE_KEY = 'taskClassCache';
const CACHE_MAX = 300;
const KINDS = new Set(['attachment', 'textbook', 'none']);

const SYSTEM =
  'Ты классифицируешь домашние задания из электронного дневника МЭШ. ' +
  'Для каждого задания определи, что нужно ученику, чтобы его выполнить:\n' +
  '- "attachment" — задание ссылается на файл/документ/презентацию/рабочий лист/карточку/тест, ' +
  'приложенные в дневнике (их нужно скачать и загрузить сюда);\n' +
  '- "textbook" — задание лишь ссылается на учебник (номер упражнения, задачи, страницы, параграфа), ' +
  'а сам текст задания не приведён — нужно фото страницы учебника;\n' +
  '- "none" — задание самодостаточно, его можно выполнить по приведённому тексту.\n\n' +
  'Ответь ТОЛЬКО JSON-массивом строк, по одной на каждое задание, в том же порядке. ' +
  'Пример ответа: ["none","textbook","attachment"]';

const cacheKeyFor = (task) => (task || '').trim().toLowerCase().slice(0, 200);

/**
 * @param {string[]} tasks homework texts in card order
 * @returns {Promise<Array<'attachment'|'textbook'|'none'>>} same order as input
 */
export async function classifyTasksAI(tasks) {
  // Instant heuristic pass — also the final answer if Groq is unavailable.
  const result = tasks.map((t) => classifyTask(t).kind || 'none');

  const { groqApiKey, [CACHE_KEY]: cache = {} } =
    await chrome.storage.local.get(['groqApiKey', CACHE_KEY]);
  if (!groqApiKey) return result;

  const pending = [];
  tasks.forEach((t, i) => {
    const cached = cache[cacheKeyFor(t)];
    if (KINDS.has(cached)) result[i] = cached;
    else if ((t || '').trim()) pending.push(i);
  });
  if (!pending.length) return result;

  try {
    const list = pending.map((i, n) => `${n + 1}. ${tasks[i].slice(0, 300)}`).join('\n');
    const raw = await askGroq(SYSTEM, list, [], []);
    const m = raw.match(/\[[\s\S]*?\]/);
    const arr = m ? JSON.parse(m[0]) : [];
    pending.forEach((i, n) => {
      if (KINDS.has(arr[n])) {
        result[i] = arr[n];
        cache[cacheKeyFor(tasks[i])] = arr[n];
      }
    });
    // Cap the cache so it can't grow without bound over months of use.
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
    }
    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch (_e) {
    // Groq down / malformed reply — the heuristic result stands.
  }
  return result;
}
