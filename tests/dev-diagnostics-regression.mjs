/**
 * Owner-only solve diagnostics.
 *
 * The «Диагностика» tab exists to answer one question when a test comes back
 * with wrong answers: did the model fail, or did we hand it badly scraped text?
 * That makes three things load-bearing, and this file pins all three.
 *
 *  1. IT STAYS OFF. A student install must record nothing — no storage, no
 *     privacy surface, no reasoning subscription. The gate is a strict marker
 *     issued only after the backend recognizes its server-side owner key.
 *  2. THE SHIPPED SOURCE CARRIES NO KEY VERIFIER. Everything under src/ is
 *     readable by anyone who unpacks the extension from the store, so neither
 *     the owner key nor a hash that permits offline guesses may ship.
 *  3. REASONING NEVER REACHES THE ANSWER. The visible completion is
 *     answers-only JSON; folding `delta.reasoning` into it truncates the
 *     answers array and leaks raw thinking into the student's panel. The
 *     diagnostics channel must be strictly a side channel.
 *
 * Plus the housekeeping that owner-only data still deserves: traces hold
 * verbatim scraped page text, so «Удалить все локальные данные» must reach
 * them, and the ring buffer must stay bounded.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const store = {};

function readStore(area, keys) {
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, area[key]]));
  if (typeof keys === 'string') return { [keys]: area[keys] };
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, area[key] ?? fallback]));
  }
  return { ...area };
}

let localGets = 0;
let localSets = 0;

globalThis.chrome = {
  runtime: { id: 'test', lastError: null },
  storage: {
    local: {
      async get(keys) { localGets += 1; return readStore(store, keys); },
      async set(data) { localSets += 1; Object.assign(store, data); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }
    },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {}
    }
  }
};

const { isDevModeActive } = await import('../src/lib/dev-mode.js');
const {
  DEV_TRACE_KEY, MAX_DEV_TRACES, clearDevTraces, createReasoningCollector,
  readDevTraces, recordDevTrace
} = await import('../src/lib/dev-trace.js');
const { createSseSink } = await import('../src/lib/http.js');

/* ---------- 1. The server-issued gate ---------- */

assert.equal(await isDevModeActive(), false, 'dev mode must be off with no licence');
store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: true };
assert.equal(await isDevModeActive(), false, 'a normal licence must not unlock dev mode');
store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: true, developer_mode: 'true' };
assert.equal(await isDevModeActive(), false, 'a truthy lookalike must not unlock dev mode');
store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: true, developer_mode: true };
assert.equal(await isDevModeActive(), true, 'the backend owner marker must unlock dev mode');
store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: false, developer_mode: true };
assert.equal(await isDevModeActive(), true,
  'a previously issued owner marker must keep diagnostics available during a licence problem');

/* ---------- 2. No owner verifier in shipped source ---------- */

{
  const devMode = source('../src/lib/dev-mode.js');
  assert.doesNotMatch(devMode, /[0-9a-f]{64}/i,
    'dev-mode.js must not ship an offline hash oracle for the owner bearer key');
  assert.doesNotMatch(devMode, /isDevLicenseKey|subtle\.digest/,
    'the public client must not classify owner credentials locally');
  assert.match(devMode, /licenseStatus\?\.developer_mode === true/,
    'developer mode must require the strict server-issued marker');
}

/* ---------- 3. Off by default: a student install records nothing ---------- */

{
  delete store.licenseStatus;
  assert.equal(await isDevModeActive(), false, 'dev mode must be off with no licence');

  store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: true };
  assert.equal(await isDevModeActive(), false, 'a normal licence must not unlock dev mode');

  localSets = 0;
  const wrote = await recordDevTrace({ kind: 'test', pageText: 'x'.repeat(100) });
  assert.equal(wrote, false, 'recordDevTrace must be a no-op without the owner key');
  assert.equal(localSets, 0, 'recordDevTrace must not touch storage without the owner key');
  assert.equal(store[DEV_TRACE_KEY], undefined);
  assert.deepEqual(await readDevTraces(), [], 'readDevTraces must stay empty without the owner key');

  // A storage failure means "not a developer", never a thrown error on the
  // solve path.
  const get = chrome.storage.local.get;
  chrome.storage.local.get = async () => { throw new Error('storage down'); };
  assert.equal(await isDevModeActive(), false);
  assert.equal(await recordDevTrace({ kind: 'test' }), false);
  chrome.storage.local.get = get;
}

/* ---------- 4. On for the owner: bounded ring buffer ---------- */

{
  store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: true, developer_mode: true };
  assert.equal(await isDevModeActive(), true);

  // Deliberately NOT gated on `ok`/expiry: a licence problem is exactly the
  // thing you would open diagnostics to look at.
  store.licenseStatus = {
    key: 'SMESH-AAAA-BBBB-CCCC', ok: false, reason: 'expired', developer_mode: true
  };
  assert.equal(await isDevModeActive(), true, 'diagnostics must survive a bad licence verdict');
  store.licenseStatus = { key: 'SMESH-AAAA-BBBB-CCCC', ok: true, developer_mode: true };

  assert.equal(await recordDevTrace({ kind: 'test', pageText: 'вопрос 1', questionCount: 3 }), true);
  let traces = await readDevTraces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0].pageText, 'вопрос 1');
  assert.equal(traces[0].questionCount, 3);
  assert.equal(traces[0].ok, true);
  assert.match(traces[0].id, /^[0-9a-f-]{36}$/);

  for (let i = 0; i < MAX_DEV_TRACES + 5; i++) {
    await recordDevTrace({ kind: 'test', pageText: `page ${i}` });
  }
  traces = await readDevTraces();
  assert.equal(traces.length, MAX_DEV_TRACES, 'the ring buffer must stay capped');
  // Newest first, so the UI renders in order and the tail is what ages out.
  assert.equal(traces[0].pageText, `page ${MAX_DEV_TRACES + 4}`);

  // Long fields are bounded on write: page text, reasoning and raw replies are
  // all provider-controlled length, and storage.local is not a log file.
  await recordDevTrace({ kind: 'test', pageText: 'y'.repeat(500000), reasoning: 'z'.repeat(500000) });
  const [big] = await readDevTraces();
  assert.ok(big.pageText.length < 25000, `page text not bounded: ${big.pageText.length}`);
  assert.ok(big.reasoning.length < 45000, `reasoning not bounded: ${big.reasoning.length}`);
  // Reasoning keeps its TAIL — the part that reaches the answer is the end.
  assert.ok(big.reasoning.endsWith('z'), 'reasoning must be trimmed from the front');

  await clearDevTraces();
  assert.deepEqual(await readDevTraces(), []);
}

/* ---------- 5. The reasoning collector is bounded in memory ---------- */

{
  const collector = createReasoningCollector(50);
  for (let i = 0; i < 100; i++) collector.push('0123456789');
  const value = collector.value();
  assert.ok(value.length < 200, `collector grew unbounded: ${value.length}`);
  assert.ok(value.endsWith('0123456789'), 'the collector must keep the tail');
  assert.equal(createReasoningCollector(50).value(), '', 'an unused collector yields no text');
}

/* ---------- 6. Reasoning is a side channel, never the answer ---------- */

function feed(sink, frames) {
  for (const frame of frames) sink.push(`data: ${JSON.stringify(frame)}\n`);
  sink.push('data: [DONE]\n');
  return sink.finish();
}

{
  // OpenRouter spells it `reasoning`; DashScope / DeepSeek / GLM spell it
  // `reasoning_content`. Both must reach the side channel, and neither may
  // reach the returned text.
  const frames = [
    { choices: [{ delta: { reasoning: 'сначала подумаю' } }] },
    { choices: [{ delta: { reasoning_content: ' ещё подумаю' } }] },
    { choices: [{ delta: { content: '{"answers":' } }] },
    { choices: [{ delta: { reasoning: ' и ещё' } }] },
    { choices: [{ delta: { content: '[{"n":"1","a":"42"}]}' } }] },
  ];

  const thoughts = [];
  const answer = feed(
    createSseSink({ label: 'T', onReasoning: (chunk) => thoughts.push(chunk) }),
    frames
  );
  assert.equal(answer, '{"answers":[{"n":"1","a":"42"}]}', 'reasoning leaked into the answer');
  assert.equal(thoughts.join(''), 'сначала подумаю ещё подумаю и ещё');

  // Without a subscriber the behaviour is byte-identical to before the change.
  const unsubscribed = feed(createSseSink({ label: 'T' }), frames);
  assert.equal(unsubscribed, answer, 'the answer must not depend on onReasoning');

  // Empty-string reasoning frames are the common filler on non-thinking deltas;
  // forwarding them would spam the collector with nothing.
  const empties = [];
  feed(
    createSseSink({ label: 'T', onReasoning: (chunk) => empties.push(chunk) }),
    [{ choices: [{ delta: { reasoning: '', content: 'ok' } }] }]
  );
  assert.deepEqual(empties, [], 'empty reasoning frames must not be forwarded');
}

/* ---------- 7. Every provider adapter forwards the channel ---------- */

// Threading onReasoning through one adapter and not the rest would silently
// produce empty «Рассуждение» sections on exactly the route being debugged.
for (const [file, calls] of Object.entries({
  '../src/lib/qwen.js': ['askViaProxy', 'postStream'],
  '../src/lib/deepseek.js': ['askViaProxy', 'postStream'],
  '../src/lib/openrouter.js': ['postStream'],
  '../src/lib/groq.js': ['postStream'],
  '../src/lib/smesh-proxy.js': ['createSseSink'],
})) {
  const text = source(file);
  assert.ok(text.includes('onReasoning'), `${file} does not accept onReasoning`);
  for (const call of calls) {
    const index = text.indexOf(`${call}(`);
    assert.ok(index >= 0, `${file} no longer calls ${call}`);
    const window = text.slice(index, index + 400);
    assert.ok(window.includes('onReasoning'), `${file} does not pass onReasoning to ${call}`);
  }
}

/* ---------- 8. Traces are wiped with every other local page content ---------- */

{
  const history = source('../src/lib/history.js');
  assert.ok(
    history.includes(`'${DEV_TRACE_KEY}'`),
    `deleteAllLocalData must remove ${DEV_TRACE_KEY} — it holds verbatim scraped page text`
  );
}

/* ---------- 9. The tab is gated by a body class, not by `hidden` ---------- */

{
  const html = source('../src/settings/settings.html');
  const css = source('../src/settings/settings.css');
  assert.ok(html.includes('data-tab="devtools"'), 'the diagnostics tab is missing');
  assert.ok(html.includes('data-panel="devtools"'), 'the diagnostics panel is missing');
  // `.tab { display: flex }` outranks the UA's `[hidden]` reset, so a `hidden`
  // attribute here would leave the tab visible on every student install — the
  // exact leak tests/hidden-attribute-regression.mjs was written for.
  const tabButton = html.slice(html.indexOf('data-tab="devtools"') - 200, html.indexOf('data-tab="devtools"') + 60);
  assert.ok(!/\shidden[\s>]/.test(tabButton), 'the diagnostics tab must not rely on `hidden`');
  assert.ok(html.includes('dev-only'), 'the diagnostics tab must carry the .dev-only gate');
  assert.match(
    css,
    /body:not\(\.dev-mode\)\s+\.dev-only\s*\{\s*display:\s*none/,
    'settings.css must hide .dev-only outside dev mode'
  );

  // Untrusted scraped text renders through textContent only. mdToHtml or
  // innerHTML here would both hide what the model actually received and give a
  // Мэш page script execution in the settings origin.
  const settings = source('../src/settings/settings.js');
  const panel = settings.slice(
    settings.indexOf('function devTraceField'),
    settings.indexOf('let devTracesLoaded')
  );
  assert.ok(panel.length > 0, 'the diagnostics renderer is missing');
  assert.ok(!panel.includes('innerHTML ='), 'the diagnostics renderer must not assign innerHTML');
  assert.ok(!panel.includes('mdToHtml'), 'the diagnostics renderer must not render markdown');
  assert.ok(panel.includes('textContent'), 'the diagnostics renderer must use textContent');
}

// The renderer clears its container between loads; that one assignment is the
// only innerHTML in the section and it writes a constant.
{
  const settings = source('../src/settings/settings.js');
  const loader = settings.slice(
    settings.indexOf('async function loadDevTraces'),
    settings.indexOf('function wireDevTools')
  );
  for (const match of loader.matchAll(/innerHTML\s*=\s*(.+)/g)) {
    assert.match(match[1].trim(), /^''\s*;?$/, `loadDevTraces writes non-constant innerHTML: ${match[1]}`);
  }
}

assert.ok(localGets > 0, 'the storage shim was never exercised');
console.log('dev-diagnostics-regression: ok');
