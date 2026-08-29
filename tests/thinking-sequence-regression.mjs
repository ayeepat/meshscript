import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function createContainer() {
  const verb = { textContent: '' };
  const longNotice = { textContent: '', hidden: true };
  return {
    isConnected: true,
    set innerHTML(_value) {},
    querySelector(selector) {
      if (selector === '.thinkverb') return verb;
      if (selector === '.long-think-note') return longNotice;
      assert.fail(`unexpected selector: ${selector}`);
    },
    verb,
    longNotice,
  };
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    Date: { now: () => now },
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, dueAt: now + ms });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    advance(ms) {
      now += ms;
      for (const { fn, ms: intervalMs } of [...intervals.values()]) {
        if (intervalMs === ms) fn();
      }
      for (const [id, entry] of [...timeouts.entries()]) {
        if (entry.dueAt > now) continue;
        timeouts.delete(id);
        entry.fn();
      }
    },
    intervalCount(ms) {
      return [...intervals.values()].filter((entry) => entry.ms === ms).length;
    },
  };
}

const clock = fakeClock();
const thinking = await import('../src/common/thinking.js');
const originalDate = globalThis.Date;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

globalThis.Date = clock.Date;
globalThis.setInterval = clock.setInterval;
globalThis.clearInterval = clock.clearInterval;
globalThis.setTimeout = clock.setTimeout;
globalThis.clearTimeout = clock.clearTimeout;
try {
  const container = createContainer();
  const ticker = thinking.startThinking(container, {
    words: ['Читаю', 'Решаю', 'Проверяю', 'Формулирую'],
    wordIntervalMs: 2400,
  });
  assert.equal(container.verb.textContent, 'Читаю… 0s',
    'every run must start with the first reading phase');

  clock.advance(2400);
  assert.equal(container.verb.textContent, 'Решаю… 2s');
  clock.advance(2400);
  assert.equal(container.verb.textContent, 'Проверяю… 4s');
  clock.advance(2400);
  assert.equal(container.verb.textContent, 'Формулирую… 7s');
  clock.advance(2400);
  assert.equal(container.verb.textContent, 'Формулирую… 7s',
    'the sequence must stay on its final phase instead of wrapping to reading');
  assert.equal(clock.intervalCount(2400), 0,
    'the completed phase timer should stop waking up');
  ticker.stop();

  const longContainer = createContainer();
  const longTicker = thinking.startThinking(longContainer, {
    longNotice: true,
    longNoticeDelayMs: 30000,
  });
  assert.equal(longContainer.longNotice.hidden, true,
    'the long-thinking reassurance must not appear before the threshold');
  clock.advance(29999);
  assert.equal(longContainer.longNotice.hidden, true,
    'the long-thinking reassurance must stay hidden through 29.999 seconds');
  clock.advance(1);
  assert.equal(longContainer.longNotice.hidden, false,
    'the long-thinking reassurance must appear at 30 seconds');
  assert.equal(
    longContainer.longNotice.textContent,
    'Thinking longer for a more accurate response.',
  );
  longTicker.stop();
  assert.equal(longContainer.longNotice.hidden, true,
    'settling the request must remove the reassurance immediately');

  const cancelledContainer = createContainer();
  const cancelledTicker = thinking.startThinking(cancelledContainer, {
    longNotice: true,
    longNoticeDelayMs: 30000,
  });
  clock.advance(12000);
  cancelledTicker.stop();
  clock.advance(18000);
  assert.equal(cancelledContainer.longNotice.hidden, true,
    'a stopped request must not resurrect its delayed reassurance');
} finally {
  globalThis.Date = originalDate;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

// The floating test pill is a classic content script and carries the same tiny
// implementation inline. Keep its copy forward-only and in the same order.
const pillSource = readFileSync(new URL('../src/content/test-pill.js', import.meta.url), 'utf8');
const start = pillSource.indexOf('const THINK_WORDS =');
const end = pillSource.indexOf('\n  /* ---------- State / theme persistence', start);
assert.ok(start >= 0 && end > start, 'inline pill thinking section must exist');
const inline = pillSource.slice(start, end);
assert.doesNotMatch(inline, /Math\.random|% THINK_WORDS\.length/,
  'the pill must neither start randomly nor wrap its phases');
assert.ok(
  inline.indexOf("'Читаю условие'") < inline.indexOf("'Формулирую ответ'"),
  'the pill must progress from reading to formulating the answer'
);
assert.match(inline, /wi >= THINK_WORDS\.length - 1/,
  'the pill must stop advancing on its final phase');
assert.match(inline, /setPrefix:[\s\S]*wi = 0;[\s\S]*startWordTimer\(\);[\s\S]*paint\(\);/,
  'a new autopilot page must restart the believable sequence');
assert.match(inline, /LONG_THINKING_DELAY_MS = 30000/,
  'the pill reassurance must use the requested 30-second threshold');
assert.match(inline, /startLongNoticeTimer\(\);[\s\S]*setPrefix:[\s\S]*startLongNoticeTimer\(\);/,
  'the pill must schedule the reassurance and reset it for every autopilot page');
assert.match(inline, /stop[\s\S]*clearTimeout\(longNoticeTimer\)[\s\S]*longNotice\.hidden = true/,
  'the pill must cancel and hide the reassurance when thinking stops');

const panelSource = readFileSync(new URL('../src/content/answer-panel.js', import.meta.url), 'utf8');
assert.match(panelSource, /class="long-think-note"[^>]*hidden>\$\{LONG_THINKING_NOTICE\}/,
  'each per-question output slot must carry its own hidden reassurance widget');
assert.match(panelSource, /setTimeout\?\.\([\s\S]*longNotice\.hidden = false[\s\S]*}, 30000\)/,
  'a per-question re-solve must reveal its widget only after 30 seconds');
assert.match(panelSource, /clearTimeout\?\.\(longNoticeTimer\)[\s\S]*longNotice\.hidden = true/,
  'a completed per-question re-solve must cancel and hide its widget');

console.log('thinking sequence regressions passed');
