import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as cache from '../src/lib/test-answer-cache.js';
import { reconcileAnswer } from '../src/lib/test-answer-arithmetic.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const worker = read('../src/background/service-worker.js');
const scraper = read('../src/content/scraper.js');
const panel = read('../src/content/answer-panel.js');
function section(source, start, end) {
  const i = source.indexOf(start), j = source.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `missing section ${start}`);
  return source.slice(i, j);
}
const store = {};
globalThis.chrome = { storage: { local: {
  async get(k) { return { [k]: structuredClone(store[k]) }; },
  async set(v) { Object.assign(store, structuredClone(v)); },
} } };
const capture = (signature) => ({ tabId: 7, documents: [{ frameId: 0, documentId: 'doc', signature }] });
const rawAnswers = (answers) => JSON.stringify({ answers });
const full = rawAnswers([1, 2, 3].map((n) => ({ n, a: String(n * 2) })));
let currentCapture, response, providerCalls, inventoryIds;
const context = {
  ...cache, reconcileAnswer, chrome: globalThis.chrome,
  throwIfPillCancelled() {}, ensureLicensed: async () => {}, hasConsent: async () => true,
  capturePageForPill: async () => ({ capture: currentCapture, pageText: 'Three questions', hasVisualMedia: false }),
  capturePageForWeb: async () => ({ capture: currentCapture, pageText: 'Three questions', unitCount: 3 }),
  runInCapturedDocumentsWithIds: async () => [{ documentId: 'doc', result: { ids: inventoryIds } }],
  solveTest: async () => { providerCalls++; return response; },
  solveWebPage: async () => { providerCalls++; return response; },
  recordDevTrace: async () => {},
  withMatchingTestCapture: async (_capture, _read, fn) => fn(), readTestCaptureContext() {},
  showAnswersInTab: async () => {}, fillAllFrames: async (_id, questions) => ({ filled: questions.map((q) => q.index), skipped: [] }),
};
vm.createContext(context);
vm.runInContext(
  section(worker, 'function normalizeParts(p)', 'const answerPanelContexts = new Map();') +
  section(worker, 'async function readTestAnswerIds(', '// Combined signature') +
  section(worker, 'async function pillSolveOnePage(', '// Poll the page signature') +
  section(worker, 'async function webSolveOnePage(', '/**\n * Keep the generic pill'), context);

// Execute the actual popup message handler as well as both page solve paths.
let handler;
const handlerContext = {
  ...context,
  chrome: { runtime: { onMessage: { addListener(fn) { handler = fn; } } } },
  classifyMessageSender: () => 'extension', validateMessage: () => null,
  blockedFeature: () => null, getRuntimeConfig: async () => ({}),
  withTabSolveLock: async (_id, fn) => fn(), withKeepAlive: async (fn) => fn(),
  readTestAnswerIds: context.readTestAnswerIds, parseTestAnswers: context.parseTestAnswers,
  serializeTestAnswers: context.serializeTestAnswers, errorCode: () => 'test', track() {},
};
vm.runInNewContext(section(worker, 'chrome.runtime.onMessage.addListener(', '// MV3 keepalive.'), handlerContext);
const popupSolve = () => new Promise((resolve, reject) => handler({
  type: 'SOLVE_TEST', payload: { tabId: 7, capture: currentCapture, text: 'Three questions' },
}, { tab: { id: 7 } }, (reply) => reply.ok ? resolve(reply) : reject(new Error(reply.error))));

for (const [name, solve] of [
  ['pill', () => context.pillSolveOnePage(7, 'deepseek')],
  ['web', () => context.webSolveOnePage(7, 'deepseek')],
  ['popup', popupSolve],
]) {
  for (const [kind, bad] of [
    ['truncated', '{"answers":[{"n":1,"a":"2"},'],
    ['partial-valid-json', rawAnswers([{ n: 1, a: '2' }])],
    ['sentinel', rawAnswers([{ n: 1, a: '2' }, { n: 2, a: 'не видно, нужен скриншот' }, { n: 3, a: '6' }])],
    ['duplicate-id', rawAnswers([{ n: 1, a: '2' }, { n: 1, a: '4' }, { n: 3, a: '6' }])],
  ]) {
    currentCapture = capture(`${name}-${kind}`); inventoryIds = ['1', '2', '3']; providerCalls = 0; response = bad;
    const partial = await solve();
    assert.ok(partial.questions.length, `${name}: keep usable partial output visible`);
    response = full;
    const retry = await solve();
    assert.equal(providerCalls, 2, `${name}/${kind}: retry must call the provider`);
    assert.equal(retry.questions.length, 3);
    const replay = await solve();
    assert.equal(providerCalls, 2, `${name}: a complete answer is reused`);
    assert.equal(replay.cached, true);
  }
}

// Unknown inventory, missing frames, and ambiguous cross-frame numbering are
// cache misses. A legacy entry without completeness evidence cannot be replayed.
currentCapture = capture('legacy');
store[cache.TEST_ANSWER_CACHE_KEY][cache.testAnswerCacheKey(currentCapture)] = {
  v: { questions: [{ index: 1, answer: '2' }], image: false }, at: Date.now(),
};
assert.equal(await cache.readCachedTestAnswers(currentCapture), null);
inventoryIds = null; response = full; providerCalls = 0;
await context.pillSolveOnePage(7); await context.pillSolveOnePage(7);
assert.equal(providerCalls, 2, 'an unknown inventory never certifies reuse');
context.runInCapturedDocumentsWithIds = async () => [{ documentId: 'shell', result: { ids: [] } }];
assert.equal(await context.readTestAnswerIds({ documents: [{ frameId: 0, documentId: 'shell' }, { frameId: 1, documentId: 'child' }] }), null);
context.runInCapturedDocumentsWithIds = async () => ['child1', 'child2'].map((documentId) => ({ documentId, result: { ids: ['1'] } }));
assert.equal(await context.readTestAnswerIds({ documents: [{ frameId: 1, documentId: 'child1' }, { frameId: 2, documentId: 'child2' }] }), null);

// Actual parser -> re-solve -> privileged response -> panel -> cache. Only the
// external AI and browser write boundary are stubs; option metadata is not.
const page = capture('choice');
const old = { index: 1, answer: 'Москва', choice: '1' };
const seed = () => cache.writeCachedTestAnswers(page, [old], {
  expectedIds: ['1'], raw: rawAnswers([{ n: 1, a: old.answer, c: old.choice }]),
});
let choice = '2';
Object.assign(context, {
  isWebCapture: () => false, DEFAULT_PROMPTS: { test: '' }, PROMPT_CATEGORIES: { TEST_ANSWER: 'test' },
  isDevModeActive: async () => false, EMPTY_ANSWER: 'empty',
  askAI: async () => rawAnswers([{ n: 1, a: 'Париж', ...(choice == null ? {} : { c: choice }) }]),
  track() {}, usageFields: () => ({}),
});
vm.runInContext(section(worker, 'async function resolveOneQuestion(', 'function normalizeParts('), context);
Object.assign(handlerContext, {
  matchingAnswerPanelContext: () => ({ capture: page }),
  resolveOneQuestion: context.resolveOneQuestion,
});
const resolveReply = () => new Promise((resolve, reject) => handler({
  type: 'RESOLVE_QUESTION', payload: { tabId: 7, index: 1, panelNonce: 'panel' },
}, { tab: { id: 7 } }, (reply) => reply.ok ? resolve(reply) : reject(new Error(reply.error))));
for (choice of ['2', null]) {
  await seed();
  const q = { ...old };
  const aEl = { textContent: old.answer, classList: { add() {}, remove() {} } };
  const li = { querySelector: (s) => s === '.a' ? aEl : null, getAttribute: () => '1' };
  const btn = { dataset: { qi: '0' }, closest: () => li, classList: { add() {}, remove() {} } };
  const panelContext = {
    lastPayload: { generation: 1, panelNonce: 'panel', questions: [q], capture: page },
    isPanelCurrent: () => true, captureStillMatches: () => true, sendMsg: resolveReply,
    requestFill: async ([updated]) => {
      assert.equal(updated.answer, 'Париж');
      assert.equal(updated.choice, choice ?? undefined, 'the immediate refill uses only fresh indices');
      return { filled: [1] };
    }, markOneLine() {}, setTimeout() {},
  };
  vm.runInNewContext(section(panel, 'async function resolveOne(', 'function wireButtons('), panelContext);
  await panelContext.resolveOne(btn, 1, 'panel');
  assert.equal(q.choice, choice ?? undefined, 'later full-panel fill uses the corrected indices');
  assert.equal((await cache.readCachedTestAnswers(page)).questions[0].choice, choice ?? undefined,
    'later page reuse uses the corrected indices');
}

// Real radio grouping: same-name independent forms/tree scopes must remain
// distinct, while same-form siblings and externally associated controls unite.
const tree = {}, tree2 = {}, form1 = {}, form2 = {};
const radio = (form, number, root = tree, name = 'answer') => ({
  form, name, number, getRootNode: () => root, parentElement: {}, closest: () => null,
});
let radios = [radio(form1, 1), radio(form1, 1), radio(form2, 2), radio(form2, 2)];
const grouping = {
  collectQuestionMarkers: () => [], numberForNode: (r) => r.number,
  pickControls: (sel) => sel === 'input[type=radio]' ? radios : [],
  makeUnit: (type, inputs, _parent, number) => ({ type, inputs, number, anchor: inputs[0] }),
  domOrderCompare: () => 0,
};
vm.runInNewContext(section(scraper, 'let __smeshUid = 0;', 'function nearestCommonAncestor(') +
  section(scraper, 'function collectUnits()', '// Resolve the visible label text'), grouping);
assert.equal(grouping.collectUnits().length, 2);
assert.deepEqual(Array.from(grouping.collectUnits(), (u) => u.number), [1, 2]);
radios = [radio(form1, 1), radio(form1, 1)];
assert.equal(grouping.collectUnits().length, 1, 'different parents do not split a shared form owner');
radios = [radio(null, 1), radio(null, 1), radio(form1, 2), radio(null, 3, tree2)];
assert.equal(grouping.collectUnits().length, 3, 'no-form and different-tree radios stay distinct');

// The completeness inventory includes a numbered question without a control,
// and refuses mixed positional/numbered numbering and truncated inventories.
let units = [{ id: '1', source: 'native' }], markers = [{ number: 2, node: {} }], web = false;
const inventory = {
  window: {}, isVisible: () => true, collectQuestionMarkers: () => markers,
  isWebSolvableDocument: () => web, testQuestionUnitInventory: () => ({ ok: true, units }),
  MAX_WEB_UNITS: 40, webQuestionUnits: () => units,
  webUnitIds: () => ({ ids: ['1'], numbered: false }),
};
vm.runInNewContext(section(scraper, 'function testAnswerInventory()', '// True only for'), inventory);
assert.deepEqual(Array.from(inventory.testAnswerInventory().ids), ['1', '2']);
units = [{ id: null, source: 'native' }];
assert.equal(inventory.testAnswerInventory(), null);
markers = [];
assert.deepEqual(Array.from(inventory.testAnswerInventory().ids), ['1']);
units.push({ id: null, source: 'interactive' });
assert.equal(inventory.testAnswerInventory(), null);
web = true; markers = [{ number: 2, node: {} }];
assert.equal(inventory.testAnswerInventory(), null);
markers = []; units = Array.from({ length: 40 }, () => ({}));
assert.equal(inventory.testAnswerInventory(), null);
console.log('test answer integrity regression passed');
