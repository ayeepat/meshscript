/**
 * Animated "thinking" status — an ordered phase plus a live elapsed-seconds
 * counter, so a long model call never looks frozen. Inspired by the way a CLI
 * agent updates its status while it works.
 *
 * Renders into `container` as: [spinner] Решаю… 12s
 * (with an optional prefix, e.g. "Страница 2 · Решаю… 12s"). The phase moves
 * forward every couple of seconds and the counter ticks each second.
 *
 * Returns { stop } — call it (e.g. in a finally) when the work settles. The
 * animation also stops itself if `container` leaves the DOM, so a removed
 * status bubble never leaks a timer.
 */

// A deliberately simple visual sequence, not real provider progress. It always
// moves forward from reading to the final answer and stays on the last phase;
// a late-running request must never jump back to «Читаю условие».
const THINKING_WORDS = [
  'Читаю условие',
  'Разбираю задание',
  'Ищу подход к решению',
  'Решаю по шагам',
  'Сверяю результат',
  'Формулирую ответ'
];

export const LONG_THINKING_DELAY_MS = 30000;
export const LONG_THINKING_NOTICE = 'Thinking longer for a more accurate response.';

export function startThinking(container, opts = {}) {
  const words = (opts.words && opts.words.length) ? opts.words : THINKING_WORDS;
  const suffix = opts.suffix != null ? opts.suffix : 's';
  const prefix = opts.prefix ? opts.prefix + ' · ' : '';
  const wordIntervalMs = opts.wordIntervalMs || 2400;
  const longNoticeText = opts.longNotice === true
    ? LONG_THINKING_NOTICE
    : (opts.longNoticeText || '');
  const longNoticeDelayMs = Number.isFinite(opts.longNoticeDelayMs)
    ? Math.max(0, opts.longNoticeDelayMs)
    : LONG_THINKING_DELAY_MS;
  const startedAt = Date.now();

  container.innerHTML =
    '<span class="spinner" aria-hidden="true"></span><span class="thinkverb"></span>' +
    (longNoticeText
      ? '<span class="long-think-note" role="status" aria-live="polite" hidden></span>'
      : '');
  const verb = container.querySelector('.thinkverb');
  const longNotice = longNoticeText ? container.querySelector('.long-think-note') : null;
  if (longNotice) longNotice.textContent = longNoticeText;
  let wi = 0;

  let secTimer = null;
  let wordTimer = null;
  let longNoticeTimer = null;
  const stop = () => {
    if (secTimer) clearInterval(secTimer);
    if (wordTimer) clearInterval(wordTimer);
    if (longNoticeTimer != null) clearTimeout(longNoticeTimer);
    secTimer = wordTimer = null;
    longNoticeTimer = null;
    if (longNotice) longNotice.hidden = true;
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
  wordTimer = setInterval(() => {
    if (wi >= words.length - 1) {
      clearInterval(wordTimer);
      wordTimer = null;
      return;
    }
    wi += 1;
    paint();
  }, wordIntervalMs);
  if (longNotice) {
    longNoticeTimer = setTimeout(() => {
      longNoticeTimer = null;
      if (!container.isConnected) { stop(); return; }
      longNotice.hidden = false;
    }, longNoticeDelayMs);
  }

  return { stop };
}
