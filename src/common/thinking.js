/**
 * Animated "thinking" status — a shifting verb plus a live elapsed-seconds
 * counter, so a long model call never looks frozen. Inspired by the way a CLI
 * agent rotates its status word while it works.
 *
 * Renders into `container` as: [spinner] Решаю… 12s
 * (with an optional prefix, e.g. "Страница 2 · Решаю… 12s"). The verb rotates
 * every couple of seconds and the counter ticks each second.
 *
 * Returns { stop } — call it (e.g. in a finally) when the work settles. The
 * animation also stops itself if `container` leaves the DOM, so a removed
 * status bubble never leaks a timer.
 */

// Present-tense synonyms for "solving / thinking". The displayed word starts at
// a random index and cycles, so each run reads a little differently — same idea
// as Claude Code's shifting status verb.
const THINKING_WORDS = [
  'Думаю', 'Решаю', 'Считаю', 'Разбираю', 'Анализирую',
  'Соображаю', 'Вникаю', 'Размышляю', 'Сверяю', 'Проверяю',
  'Читаю условие', 'Выстраиваю ход решения', 'Слежу за условием задачи',
  'Иду по шагам', 'Прикидываю план решения', 'Ищу подходящий способ',
  'Прохожу задание по порядку', 'Складываю картину', 'Уточняю детали',
  'Сверяюсь с заданием', 'Прикидываю варианты', 'Формулирую ответ'
];

export function startThinking(container, opts = {}) {
  const words = (opts.words && opts.words.length) ? opts.words : THINKING_WORDS;
  const suffix = opts.suffix != null ? opts.suffix : 's';
  const prefix = opts.prefix ? opts.prefix + ' · ' : '';
  const wordIntervalMs = opts.wordIntervalMs || 2400;
  const startedAt = Date.now();

  container.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="thinkverb"></span>';
  const verb = container.querySelector('.thinkverb');
  let wi = Math.floor(Math.random() * words.length);

  let secTimer = null;
  let wordTimer = null;
  const stop = () => {
    if (secTimer) clearInterval(secTimer);
    if (wordTimer) clearInterval(wordTimer);
    secTimer = wordTimer = null;
  };

  const paint = () => {
    // Self-terminate if the bubble was removed (innerHTML reset, .remove(), a
    // lesson switch) so a discarded ticker never keeps firing.
    if (!container.isConnected) { stop(); return; }
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    verb.textContent = `${prefix}${words[wi]}… ${secs}${suffix}`;
  };

  paint();
  secTimer = setInterval(paint, 1000);
  wordTimer = setInterval(() => { wi = (wi + 1) % words.length; paint(); }, wordIntervalMs);

  return { stop };
}
