import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isLicenseEnforced, LICENSE_ENFORCED_FROM } from '../src/lib/config.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function sourceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

assert.equal(isLicenseEnforced(LICENSE_ENFORCED_FROM - 1), false);
assert.equal(isLicenseEnforced(LICENSE_ENFORCED_FROM), true,
  'license enforcement must turn on automatically at launch');
assert.equal(LICENSE_ENFORCED_FROM, Date.parse('2026-07-25T00:00:00Z'));
assert.match(source('../backend/src/worker.js'), /Date\.now\(\) < Date\.parse\('2026-07-25T00:00:00Z'\)/,
  'client enforcement and backend preorder classification must share the launch instant');

const theme = source('../src/common/theme.css');
const dashboard = source('../src/dashboard/dashboard.js');
const settings = source('../src/settings/settings.js');
assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);

// Execute the dashboard's real typewriter. Reduced-motion users must receive
// the final render synchronously, without scheduling even one animation frame.
{
  const typewriterSource = sourceSection(dashboard, 'function typewriter(', '/* ---------- Chat UI');
  let animationFrames = 0;
  const context = {
    globalThis: null,
    mdToHtml: (value) => `<p>${value}</p>`,
    requestAnimationFrame() { animationFrames += 1; },
    chatEl: { scrollTop: 0, scrollHeight: 0 },
  };
  context.globalThis = context;
  context.matchMedia = (query) => {
    assert.equal(query, '(prefers-reduced-motion: reduce)');
    return { matches: true };
  };
  vm.runInNewContext(
    `${typewriterSource}\nglobalThis.__typewriter = typewriter;`,
    context,
    { filename: 'dashboard-typewriter.js' }
  );
  const element = { innerHTML: '', isConnected: true };
  context.__typewriter(element, 'готовый ответ');
  assert.equal(element.innerHTML, '<p>готовый ответ</p>');
  assert.equal(animationFrames, 0);
}

// Execute Settings history loading twice and observe the actual scroll option:
// accessibility preference on → instant; preference off → smooth.
{
  const loaderSource = sourceSection(settings, 'function loadSessionMessages(', 'function loadHistory(');
  async function scrollBehavior(reduceMotion) {
    let option = null;
    const conversation = {
      hidden: true,
      innerHTML: '',
      dataset: {},
      appendChild() {},
    };
    const toggle = {
      scrollIntoView(value) { option = value; },
    };
    const context = {
      globalThis: null,
      historyMessageEl: () => ({}),
      chrome: {
        runtime: {
          lastError: null,
          sendMessage(_message, callback) {
            callback({ ok: true, messages: [{ role: 'assistant', content: 'ok' }] });
          },
        },
      },
    };
    context.globalThis = context;
    context.matchMedia = (query) => {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return { matches: reduceMotion };
    };
    vm.runInNewContext(
      `${loaderSource}\nglobalThis.__load = loadSessionMessages;`,
      context,
      { filename: 'settings-history-scroll.js' }
    );
    context.__load({ id: 'session-1' }, toggle, conversation);
    return JSON.parse(JSON.stringify(option));
  }
  assert.deepEqual(await scrollBehavior(true), { block: 'nearest', behavior: 'auto' });
  assert.deepEqual(await scrollBehavior(false), { block: 'nearest', behavior: 'smooth' });
}

// Quota durability is deliberately exercised through process-level behavior in
// vps-shutdown-quota-regression and vps-quota-persist-retry-regression; this
// test no longer treats fsync/rename source spelling as proof of persistence.
console.log('launch gate and reduced-motion regressions passed');
