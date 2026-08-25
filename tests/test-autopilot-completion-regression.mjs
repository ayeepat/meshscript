import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { classifyAutopilotFill, resolvePaginationTarget } from '../src/lib/test-autopilot.js';

const pageUnit = (id, {
  documentId = 'doc-main', source = 'native', ordinal = 0, type = 'text'
} = {}) => ({ documentId, source, type, id, ordinal });
const fillSummary = (filled, skipped, units, exact = true) => ({
  filled, skipped, coverage: { exact, units }
});

const questions = [{ index: 1 }, { index: 2 }];
assert.equal(classifyAutopilotFill([], { filled: [], skipped: [] }), 'unrecognized');
const numberedUnits = [pageUnit('1'), pageUnit('2', { ordinal: 1 })];
assert.equal(classifyAutopilotFill(questions, fillSummary([], [1, 2], numberedUnits)), 'partial');
assert.equal(classifyAutopilotFill(questions, fillSummary([1], [2], numberedUnits)), 'partial');
assert.equal(classifyAutopilotFill(questions, fillSummary([1], [], numberedUnits)), 'partial');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], numberedUnits)), 'complete');
assert.equal(classifyAutopilotFill(questions, { filled: [1, 2], skipped: [] }), 'partial',
  'model/fill agreement without a page inventory must never authorize pagination');
assert.equal(classifyAutopilotFill([{ index: 1 }, { index: 1 }],
  fillSummary([1, 1], [], numberedUnits)), 'partial',
  'duplicate model question ids cannot prove that every page question was filled');

// The original residual: the model omits visible Q2, fills Q1, and its own
// subset looks internally complete. The independent page inventory must stop.
assert.equal(classifyAutopilotFill(
  [{ index: 1 }], fillSummary([1], [], numberedUnits)
), 'partial', 'a model-returned subset cannot authorize leaving a larger page');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [], true)), 'partial',
  'no detectable page units is uncertainty, not completion');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], numberedUnits, false)), 'partial',
  'a missing/malformed frame inventory must fail closed');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [
  pageUnit('1'), pageUnit('1', { source: 'interactive', ordinal: 0 })
])), 'partial', 'duplicate page ids across fill mechanisms are ambiguous');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [
  pageUnit('1', { documentId: 'top' }),
  pageUnit('2', { documentId: 'iframe', ordinal: 0 })
])), 'complete', 'unique numbered units remain provable across captured frames');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [
  pageUnit(null), pageUnit(null, { ordinal: 1 })
])), 'complete', 'one ordered unnumbered unit list can be proven positionally');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [
  pageUnit(null, { documentId: 'top' }),
  pageUnit(null, { documentId: 'iframe', ordinal: 0 })
])), 'partial', 'unnumbered position 1 in separate frames cannot prove two questions');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [
  pageUnit(null), pageUnit(null, { source: 'interactive', ordinal: 0 })
])), 'partial', 'independent native/interactive positional lists are ambiguous');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2], [], [
  pageUnit('1'), pageUnit(null, { ordinal: 1 })
])), 'partial', 'mixed numbered and positional ownership must fail closed');
assert.equal(classifyAutopilotFill(questions, fillSummary([1, 2, 3], [], numberedUnits)), 'partial',
  'extra fill ids are not exact proof');

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const scraper = source('../src/content/scraper.js');

// Exercise the page-side inventory itself with all three mechanisms. Native
// and interactive units retain their own order; same-number MathQuill fields
// collapse into one multi-field question while a loose field stays explicit.
// MathQuill ordinals run ONE counter in document order across numbered and
// loose fields: numbering them separately let a loose field and a numbered
// question both claim ordinal 0, which collides in the worker's unit identity.
{
  const start = scraper.indexOf('function testQuestionUnitInventory()');
  const end = scraper.indexOf('window.__smeshQuestionInventory =', start);
  assert.ok(start >= 0 && end > start, 'page inventory source must be extractable');
  const inventorySource = scraper.slice(start, end);
  const mathFields = [{ number: 3 }, { number: 3 }, { number: null }];
  const context = {
    window: {},
    document: { querySelectorAll: () => mathFields },
    isVisible: () => true,
    collectUnits: () => [{ type: 'text', number: 1 }, { type: 'radio', number: null }],
    collectInteractiveUnits: () => [{ type: 'toggle', number: 2 }],
    collectQuestionMarkers: () => ['markers'],
    numberForNode: (field) => field.number,
  };
  vm.runInNewContext(
    `${inventorySource}\nglobalThis.__inventory = testQuestionUnitInventory;`,
    context,
    { filename: 'test-question-unit-inventory.js' }
  );
  const inventory = context.__inventory();
  assert.equal(inventory.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      inventory.units.map(({ source, id, ordinal }) => [source, id, ordinal])
    )),
    [
      ['native', '1', 0], ['native', null, 1],
      ['interactive', '2', 0],
      ['mathquill', '3', 0], ['mathquill', null, 1]
    ]
  );
  const mathOrdinals = inventory.units
    .filter((unit) => unit.source === 'mathquill')
    .map((unit) => unit.ordinal);
  assert.equal(new Set(mathOrdinals).size, mathOrdinals.length,
    'mathquill ordinals must be unique so two units cannot share one identity');
}

const popupLoop = source('../src/popup/popup.js').slice(
  source('../src/popup/popup.js').indexOf('async function solveAllPages()')
);
assert.ok(
  popupLoop.indexOf("fillState === 'partial'") < popupLoop.indexOf('const navigationCapture'),
  'popup must stop on a partial fill before it captures or activates pagination'
);
assert.ok(
  popupLoop.indexOf("fillState === 'unrecognized'") < popupLoop.indexOf('const navigationCapture'),
  'popup must stop on an unrecognized page before pagination'
);

const worker = source('../src/background/service-worker.js');
assert.match(worker, /const coverage = await readAutopilotCoverage\(capture, expectedDocuments\)/,
  'fill must inventory the exact capture before its first form mutation');
assert.match(worker, /return \{ filled: filledIds, skipped, coverage \}/,
  'fill summary must carry page coverage to the autopilot classifier');
assert.match(worker, /var complete = flds\.length > 0;[\s\S]*?if \(complete\) filled\.push/,
  'a multi-field MathQuill unit is filled only when every field settles');
const pillLoop = worker.slice(
  worker.indexOf('async function pillSolveAllPages'),
  worker.indexOf('// One screen-solve operation per tab')
);
assert.ok(
  pillLoop.indexOf("fillState === 'partial'") < pillLoop.indexOf('const navigationCapture'),
  'pill must stop on a partial fill before pagination'
);
assert.ok(
  pillLoop.indexOf("fillState === 'unrecognized'") < pillLoop.indexOf('const navigationCapture'),
  'pill must stop on an unrecognized page before pagination'
);

/* ---------- pagination outcome (what the student is actually told) ---------- */

const frame = (documentId, counts) => ({
  documentId,
  result: {
    candidateCount: 0, enabledCount: 0, finishCount: 0, blockedCount: 0, signature: 'sig', ...counts
  }
});

assert.deepEqual(
  resolvePaginationTarget([frame('top', { candidateCount: 1, enabledCount: 1 })]),
  { outcome: 'next', documentId: 'top' },
  'one safely-activatable control in one frame is the click target'
);

// THE REGRESSION. Mesh renders «Далее» as a <button> (implicit type=submit), so
// discovery reports it blocked, not activatable. Answering 'finish' here is what
// told students «дошёл до конца теста» after page 1 of a test never advanced.
assert.deepEqual(
  resolvePaginationTarget([frame('top', { blockedCount: 1 })]),
  { outcome: 'blocked', documentId: null },
  'an unpressable Next must report blocked, never finish'
);
assert.equal(
  resolvePaginationTarget([frame('top', { blockedCount: 1, finishCount: 1 })]).outcome,
  'blocked',
  'a page carrying both a blocked Next and a finish control has not finished'
);
assert.equal(
  resolvePaginationTarget([
    frame('top', { finishCount: 1 }),
    frame('player', { blockedCount: 2 })
  ]).outcome,
  'blocked',
  'a blocked control in any captured frame outranks a finish control in another'
);

assert.equal(resolvePaginationTarget([frame('top', { finishCount: 1 })]).outcome, 'finish',
  'only submit/finish controls remaining is a genuine end of test');
assert.equal(resolvePaginationTarget([frame('top', {})]).outcome, 'none',
  'a page with no forward control at all reports none');
assert.equal(
  resolvePaginationTarget([
    frame('top', { candidateCount: 1, enabledCount: 1 }),
    frame('player', { candidateCount: 1, enabledCount: 1 })
  ]).outcome,
  'ambiguous',
  'two equally eligible frames must not be guessed between'
);
assert.equal(
  resolvePaginationTarget([frame('top', { candidateCount: 2, enabledCount: 2 })]).outcome,
  'ambiguous',
  'two enabled controls in one frame must not be guessed between'
);
assert.deepEqual(
  resolvePaginationTarget([
    { documentId: 'chrome', result: { enabledCount: 1, candidateCount: 1, signature: '' } },
    frame('player', { candidateCount: 1, enabledCount: 1 })
  ]),
  { outcome: 'next', documentId: 'player' },
  'the frame that also reports a question signature is the test player'
);
assert.equal(resolvePaginationTarget([]).outcome, 'none', 'no discovery is not an advance');
assert.equal(resolvePaginationTarget(null).outcome, 'none', 'malformed discovery fails closed');

const workerPagination = worker.slice(
  worker.indexOf('async function testNextPage('),
  worker.indexOf('/* ---------- Floating "Solve" pill')
);
assert.match(workerPagination, /const \{ outcome, documentId \} = resolvePaginationTarget\(discovery\)/,
  'the worker must not re-implement the pagination decision');
for (const [caller, marker] of [
  ['pill', 'advancePillPage'],
  ['popup', null]
]) {
  const body = marker
    ? worker.slice(worker.indexOf(`async function ${marker}`), worker.indexOf('// Fire-and-forget live-status ping'))
    : source('../src/popup/popup.js');
  assert.match(body, /status === 'blocked'/,
    `${caller} must forward the blocked outcome instead of collapsing it into none`);
}
for (const [surface, path, marker] of [
  ['popup', '../src/popup/popup.js', "case 'blocked':"],
  ['pill', '../src/content/test-pill.js', "case 'blocked':"]
]) {
  assert.ok(source(path).includes(marker),
    `${surface} must render its own message for a blocked pagination outcome`);
}

// Every handler that MUTATES the tab (fills a form or navigates it) must hold
// the per-tab solve lock. The popup autopilot and the in-page pill autopilot
// drive the same tab, so a fill or a «Далее» that skips the lock lands under a
// run that already owns it.
{
  const handlers = worker.slice(worker.indexOf('chrome.runtime.onMessage.addListener'));
  for (const type of ['SOLVE_TEST', 'FILL_ANSWERS_ALL', 'FILL_ANSWERS_TAB', 'PILL_SOLVE_PAGE',
    'PILL_SOLVE_ALL', 'RESOLVE_QUESTION']) {
    const body = handlers.slice(handlers.indexOf(`case '${type}':`));
    const end = body.indexOf('\n        case ');
    assert.match(end > 0 ? body.slice(0, end) : body, /withTabSolveLock\(/,
      `${type} mutates the tab and must hold the per-tab solve lock`);
  }
  const nextPage = handlers.slice(handlers.indexOf("case 'TEST_NEXT_PAGE':"));
  const nextPageBody = nextPage.slice(0, nextPage.indexOf('\n        case '));
  assert.match(nextPageBody, /click\s*\n?\s*\? await withTabSolveLock\(/,
    'an activating TEST_NEXT_PAGE must hold the lock');
  assert.match(nextPageBody, /: await testNextPage\(capture, \{ click \}\)/,
    'the read-only page-cap inspection must stay lock-free');
}

console.log('test autopilot completion regression passed');
