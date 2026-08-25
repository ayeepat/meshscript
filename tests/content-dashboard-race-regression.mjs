import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { awaitStablePendingRead } from '../src/lib/pending-read.js';

const panelSource = readFileSync(
  new URL('../src/content/answer-panel.js', import.meta.url),
  'utf8'
);
const scraperSource = readFileSync(
  new URL('../src/content/scraper.js', import.meta.url),
  'utf8'
);
const workerSource = readFileSync(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8'
);
const dashboardSource = readFileSync(
  new URL('../src/dashboard/dashboard.js', import.meta.url),
  'utf8'
);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return source.slice(start, end);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

// A page/account switch during the second, form-fill await happens after the
// fresh answer was rendered. The real continuation must remove that panel when
// the fill reply arrives rather than leave old-capture text on the new page.
{
  const resolveOneSource = panelSource.match(
    /  (async function resolveOne\(btn, generation, panelNonce\) \{[\s\S]*?\n  \})\n\n  function wireButtons/
  )?.[1];
  assert.ok(resolveOneSource, 'answer-panel resolveOne source must be extractable');

  const question = { index: 1, text: 'old question', answer: 'old answer' };
  const answer = { textContent: 'old answer', classList: { add() {}, remove() {} } };
  const line = { querySelector: () => answer, getAttribute: () => '1' };
  const button = {
    disabled: false,
    isConnected: true,
    dataset: { qi: '0' },
    classList: { add() {}, remove() {} },
    closest: () => line,
  };
  let captureMatches = true;
  let hides = 0;
  let marks = 0;
  let refillStarted = false;
  const refill = deferred();
  const context = {
    lastPayload: {
      questions: [question],
      capture: { pageId: 'captured-page' },
      generation: 4,
      panelNonce: 'panel-a',
    },
    isPanelCurrent: () => true,
    captureStillMatches: () => captureMatches,
    hide: () => { hides += 1; },
    sendMsg: async () => ({ ok: true, answer: 'fresh answer for old page' }),
    requestFill: () => { refillStarted = true; return refill.promise; },
    markOneLine: () => { marks += 1; },
    setTimeout() {},
  };
  vm.runInNewContext(
    `${resolveOneSource}\nglobalThis.__resolveOne = resolveOne;`,
    context,
    { filename: 'answer-panel-post-refill-capture.js' }
  );
  const resolving = context.__resolveOne(button, 4, 'panel-a');
  await until(() => refillStarted, 're-solve did not enter its refill wait');
  assert.equal(question.answer, 'old answer',
    'the fresh answer must remain staged until post-refill capture validation');
  captureMatches = false;
  refill.reject(new Error('simulated fill transport failure'));
  await resolving;
  assert.equal(captureMatches, false);
  assert.equal(hides, 1,
    'a capture changed during a rejected refill must still remove the obsolete panel');
  assert.equal(marks, 0, 'the obsolete panel must not receive even a warning marker');
  assert.notEqual(answer.textContent, 'fresh answer for old page',
    'stale answer text must never become readable while the refill is pending');
}

// On an unchanged capture the staged answer is committed only after refill,
// and a single-box response clears any stale multi-part values from the line.
{
  const resolveOneSource = panelSource.match(
    /  (async function resolveOne\(btn, generation, panelNonce\) \{[\s\S]*?\n  \})\n\n  function wireButtons/
  )?.[1];
  const question = {
    index: 1,
    text: 'current question',
    answer: 'old answer',
    parts: [{ label: 'x', value: 'old part' }],
  };
  const answer = { textContent: 'old answer', classList: { add() {}, remove() {} } };
  const line = { querySelector: () => answer, getAttribute: () => '1' };
  const button = {
    disabled: false,
    isConnected: true,
    dataset: { qi: '0' },
    classList: { add() {}, remove() {} },
    closest: () => line,
  };
  const marks = [];
  const context = {
    lastPayload: {
      questions: [question],
      capture: { pageId: 'current-page' },
      generation: 9,
      panelNonce: 'panel-current',
    },
    isPanelCurrent: () => true,
    captureStillMatches: () => true,
    hide: () => assert.fail('an unchanged capture must not be hidden'),
    sendMsg: async () => ({ ok: true, answer: 'fresh answer', parts: null }),
    requestFill: async (questions) => {
      assert.equal(questions[0].answer, 'fresh answer');
      return { filled: ['1'] };
    },
    markOneLine: (...args) => { marks.push(args); },
    setTimeout() {},
  };
  vm.runInNewContext(
    `${resolveOneSource}\nglobalThis.__resolveOne = resolveOne;`,
    context,
    { filename: 'answer-panel-post-refill-success.js' }
  );
  await context.__resolveOne(button, 9, 'panel-current');
  assert.equal(question.answer, 'fresh answer');
  assert.equal(question.parts, undefined);
  assert.equal(answer.textContent, 'fresh answer');
  assert.equal(button.disabled, false);
  assert.equal(marks.length, 1);
  assert.equal(marks[0][1], 'ok');
}

// The full-page fill button has the same delivery window and must enforce the
// same post-await capture boundary.
{
  const wireButtonsSource = sourceSection(
    panelSource,
    'function wireButtons(panel, questions, generation, panelNonce)',
    'function captureStillMatches(expected)'
  );
  const listeners = new Map();
  const makeButton = (text = '') => ({
    textContent: text,
    disabled: false,
    isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { listeners.set(`${text}:${type}`, callback); },
  });
  const close = makeButton('close');
  const toggle = makeButton('toggle');
  const copy = makeButton('copy');
  const fill = makeButton('fill');
  const panel = {
    isConnected: true,
    querySelector(selector) {
      return {
        '.btn-close': close,
        '.btn-toggle': toggle,
        '.btn-copy': copy,
        '.btn-fill': fill,
      }[selector];
    },
    querySelectorAll: () => [],
    classList: { toggle() {} },
  };
  let captureMatches = true;
  let hides = 0;
  let paints = 0;
  const context = {
    lastPayload: {
      questions: [{ index: 1, answer: 'old' }],
      capture: { pageId: 'captured-page' },
      generation: 5,
      panelNonce: 'panel-b',
    },
    isPanelCurrent: () => true,
    requestFill: async () => {
      captureMatches = false;
      return { filled: ['1'], skipped: [] };
    },
    captureStillMatches: () => captureMatches,
    hide: () => { hides += 1; },
    markFillResults: () => { paints += 1; },
    resolveOne() {},
    state: { minimized: false },
    saveState() {},
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout() {},
  };
  vm.runInNewContext(
    `${wireButtonsSource}\nglobalThis.__wireButtons = wireButtons;`,
    context,
    { filename: 'answer-panel-full-fill-capture.js' }
  );
  context.__wireButtons(panel, context.lastPayload.questions, 5, 'panel-b');
  await listeners.get('fill:click')({ isTrusted: true });
  assert.equal(hides, 1, 'a full-fill reply for a changed capture must remove the panel');
  assert.equal(paints, 0, 'a changed capture must not receive fill-result paint');
}

// A same-document history.pushState can preserve the DOM-derived signature,
// document marker and account identity while changing the task URL. Exercise
// the real comparator and copy handler: the old answers must be hidden before
// anything reaches the clipboard.
{
  const captureValidationSource = sourceSection(
    panelSource,
    'function captureStillMatches(expected)',
    'function scheduleActivePanelCaptureCheck()'
  );
  const wireButtonsSource = sourceSection(
    panelSource,
    'function wireButtons(panel, questions, generation, panelNonce)',
    'function captureStillMatches(expected)'
  );
  const listeners = new Map();
  const makeButton = (name) => ({
    textContent: name,
    disabled: false,
    isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { listeners.set(`${name}:${type}`, callback); },
  });
  const close = makeButton('close');
  const toggle = makeButton('toggle');
  const copy = makeButton('copy');
  const fill = makeButton('fill');
  const panel = {
    isConnected: true,
    querySelector(selector) {
      return {
        '.btn-close': close,
        '.btn-toggle': toggle,
        '.btn-copy': copy,
        '.btn-fill': fill,
      }[selector];
    },
    querySelectorAll: () => [],
    classList: { toggle() {} },
  };
  const capturedUrl = 'https://school.mos.ru/test/attempt-a?step=1';
  const liveWindow = {
    location: { href: capturedUrl },
    __smeshCaptureDocumentId: 'same-document-id',
    __smeshPageSig: () => 'same-signature',
    __smeshCurrentPrincipal: () => 'same-principal',
  };
  liveWindow.history = {
    pushState(_state, _title, nextUrl) {
      liveWindow.location.href = new URL(nextUrl, liveWindow.location.href).href;
    },
  };
  const capture = {
    url: capturedUrl,
    pageId: 'same-document-id',
    signature: 'same-signature',
    principal: 'same-principal',
  };
  const questions = [{ index: 1, text: 'private question', answer: 'private answer' }];
  const hidden = [];
  const clipboardWrites = [];
  const context = {
    window: liveWindow,
    lastPayload: {
      questions,
      capture,
      generation: 17,
      panelNonce: 'panel-url-bound',
    },
    hostEl: {},
    isPanelCurrent: () => true,
    hide: (...args) => { hidden.push(args); },
    requestFill: async () => ({ filled: [] }),
    markFillResults() {},
    resolveOne() {},
    state: { minimized: false },
    saveState() {},
    navigator: {
      clipboard: {
        writeText: async (text) => { clipboardWrites.push(text); },
      },
    },
    setTimeout() {},
  };
  vm.runInNewContext(
    `${captureValidationSource}\n${wireButtonsSource}\n` +
      'globalThis.__captureApi = { captureStillMatches, validateActivePanelCapture, wireButtons };',
    context,
    { filename: 'answer-panel-url-capture.js' }
  );
  context.__captureApi.wireButtons(panel, questions, 17, 'panel-url-bound');
  assert.equal(context.__captureApi.captureStillMatches(capture), true);
  context.__captureApi.validateActivePanelCapture();
  assert.equal(hidden.length, 0);

  liveWindow.history.pushState({}, '', '/test/attempt-b?step=1');
  assert.equal(liveWindow.__smeshCaptureDocumentId, capture.pageId);
  assert.equal(liveWindow.__smeshPageSig(), capture.signature);
  assert.equal(liveWindow.__smeshCurrentPrincipal(), capture.principal);
  assert.equal(context.__captureApi.captureStillMatches(capture), false,
    'URL changes must invalidate a capture even when every DOM/account signal is unchanged');
  context.__captureApi.validateActivePanelCapture();
  assert.equal(hidden.length, 1,
    'the proactive capture validator must remove answers after a URL-only route change');

  hidden.length = 0;
  await listeners.get('copy:click')();
  assert.deepEqual(clipboardWrites, [],
    'copy must fail closed before exposing answers from a URL-stale capture');
  assert.equal(hidden.length, 1);
}

// The worker must transport the top-level capture URL into the isolated-world
// panel capability; otherwise the content-side URL check would only fail closed
// and no valid panel could render. Run the real showAnswersInTab function and
// inspect the actual message rather than accepting a source-text coincidence.
{
  const showAnswersSource = sourceSection(
    workerSource,
    'async function showAnswersInTab(tabId, questions, capture, screenshot = null)',
    '/* ---------- Attachment downloads'
  );
  const sent = [];
  const answerPanelContexts = new Map();
  const context = {
    Map,
    crypto: { randomUUID: () => '11111111-1111-4111-8111-111111111111' },
    answerPanelContexts,
    executeScriptInCapturedDocuments: async () => {},
    withMatchingTestCapture: async (capture, _readCurrent, action) => action(capture),
    readTestCaptureContext: async () => assert.fail('the matching helper stub owns this read'),
    matchingAnswerPanelContext: (tabId, panelNonce) => {
      const value = answerPanelContexts.get(tabId);
      assert.equal(value?.panelNonce, panelNonce);
      return value;
    },
    deleteAnswerPanelContext() {},
    testCaptureChangedError: () => new Error('capture changed'),
    TEST_CAPTURE_CHANGED: 'TEST_CAPTURE_CHANGED',
    chrome: {
      tabs: {
        sendMessage: async (...args) => {
          sent.push(args);
          return { ok: true };
        },
      },
    },
  };
  vm.runInNewContext(
    `${showAnswersSource}\nglobalThis.__showAnswersInTab = showAnswersInTab;`,
    context,
    { filename: 'answer-panel-worker-url-transport.js' }
  );
  const capture = {
    tabId: 23,
    url: 'https://school.mos.ru/test/attempt-a?step=1',
    documentId: 'top-document',
    documents: [{
      frameId: 0,
      documentId: 'top-document',
      pageId: 'page-id',
      signature: 'signature',
      principal: 'principal',
      url: 'https://school.mos.ru/test/attempt-a?step=1',
      isTestDocument: true,
    }],
  };
  await context.__showAnswersInTab(23, [{ index: 1, answer: 'four' }], capture);
  assert.equal(sent.length, 1);
  assert.deepEqual({ ...sent[0][1].payload.capture }, {
    url: capture.url,
    pageId: 'page-id',
    signature: 'signature',
    principal: 'principal',
  });
  assert.match(
    sourceSection(
      scraperSource,
      "if (msg && msg.type === 'SHOW_ANSWERS')",
      "if (msg && msg.type === 'HIDE_ANSWERS')"
    ),
    /window\.location\.href === expected\.url/,
    'SHOW_ANSWERS acceptance must enforce the transported URL before rendering'
  );

  // The panel keeps the screenshot its answers came from, so «перерешать» can
  // re-solve from the same material instead of DOM text alone. It is bounded,
  // and it never travels to the content script — only the worker reads it.
  context.MAX_PANEL_SCREENSHOT_CHARS = 16;
  const shot = { mimeType: 'image/jpeg', dataBase64: 'AAAA', name: 'screen.jpg' };
  await context.__showAnswersInTab(23, [{ index: 1, answer: 'four' }], capture, shot);
  assert.equal(answerPanelContexts.get(23).screenshot, shot,
    'the panel context must retain the solve screenshot for a later re-solve');
  assert.equal(sent.at(-1)[1].payload.screenshot, undefined,
    'the screenshot must never be transported into the untrusted page world');

  const oversized = { mimeType: 'image/jpeg', dataBase64: 'A'.repeat(17), name: 'huge.jpg' };
  await context.__showAnswersInTab(23, [{ index: 1, answer: 'four' }], capture, oversized);
  assert.equal(answerPanelContexts.get(23).screenshot, null,
    'an oversized screenshot must be dropped rather than pinned in the worker');

  await context.__showAnswersInTab(23, [{ index: 1, answer: 'four' }], capture);
  assert.equal(answerPanelContexts.get(23).screenshot, null,
    'the pill path retains no screenshot because it can never take one');
}

// «Перерешать» runs from a page click, which confers no activeTab, so it can
// never capture a fresh screenshot. It must reuse the panel's retained one —
// otherwise it answers from strictly less material than the answer it replaces
// — and must not claim a screenshot to the model when it has none.
{
  const resolveSource = sourceSection(
    workerSource,
    'async function resolveOneQuestion(',
    'function normalizeParts('
  );
  assert.match(resolveSource, /panelScreenshot = null,/,
    'the re-solve must accept the panel\'s retained screenshot');
  assert.match(resolveSource, /const shot = panelScreenshot \? \(await compressImageFiles\(\[panelScreenshot\]\)\)\[0\] : null;/,
    'the retained screenshot must be sent with the re-solve request');
  assert.ok(
    resolveSource.indexOf('withMatchingTestCapture(panelCapture') <
      resolveSource.indexOf('const answer = await askAI('),
    'the retained screenshot may only be reused after the page is proven unchanged'
  );
  assert.match(resolveSource, /allowThinText: !!panelScreenshot/,
    'a page whose DOM text is thin must not be refused when a screenshot carries the question');
  assert.match(resolveSource, /shot \? 'текст страницы ниже \+ скриншот' : 'текст страницы ниже'/,
    'the prompt must not promise a screenshot that was not attached');
  assert.match(resolveSource, /files_img: shot \? 1 : 0/,
    'telemetry must count the image actually sent');

  const captureHelper = sourceSection(
    workerSource,
    'async function capturePageForPill(',
    'async function pillSolveOnePage('
  );
  assert.match(captureHelper, /if \(!allowThinText && pageText\.trim\(\)\.length < 20\)/,
    'the thin-DOM refusal stays in force whenever no screenshot is available');
}

// pagehide freezes an isolated world placed in the back-forward cache. Its
// pageshow must re-arm exactly one observer and one poll, while duplicate
// pageshow events remain harmless and the restored callback stays live.
{
  const watcherSource = sourceSection(
    panelSource,
    'let captureObserver = null;',
    '\n})();'
  );
  const listeners = new Map();
  const observers = [];
  const intervals = new Map();
  let nextInterval = 1;
  let scheduledChecks = 0;
  let hides = 0;
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = 0;
      this.disconnectCalls = 0;
      observers.push(this);
    }
    observe() { this.observeCalls += 1; }
    disconnect() { this.disconnectCalls += 1; }
  }
  const context = {
    MutationObserver: FakeMutationObserver,
    document: { documentElement: {} },
    window: {
      addEventListener(type, callback) { listeners.set(type, callback); },
    },
    scheduleActivePanelCaptureCheck: () => { scheduledChecks += 1; },
    hide: () => { hides += 1; },
    setInterval(callback) {
      const id = nextInterval;
      nextInterval += 1;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
  };
  vm.runInNewContext(watcherSource, context, { filename: 'answer-panel-bfcache-watchers.js' });
  assert.equal(observers.length, 1);
  assert.equal(observers[0].observeCalls, 1);
  assert.equal(intervals.size, 1);

  listeners.get('pagehide')({ persisted: true });
  assert.equal(observers[0].disconnectCalls, 1);
  assert.equal(intervals.size, 0);
  assert.equal(hides, 1);

  listeners.get('pageshow')({ persisted: true });
  assert.equal(observers.length, 1, 'BFCache restore should reuse the disconnected observer');
  assert.equal(observers[0].observeCalls, 2);
  assert.equal(intervals.size, 1);
  listeners.get('pageshow')({ persisted: true });
  assert.equal(observers[0].observeCalls, 2,
    'duplicate pageshow must not attach a second observation');
  assert.equal(intervals.size, 1, 'duplicate pageshow must not create a second poll');
  observers[0].callback([]);
  assert.equal(scheduledChecks, 1, 'the observer callback must remain live after BFCache restore');
}

// A rejected SHOW is the privileged replacement operation and may discard the
// now-revoked prior panel. A standalone HIDE remains exact-nonce only.
{
  const showSource = sourceSection(
    panelSource,
    'async function show(payload)',
    'function hide(expectedNonce = null, expectedGeneration = null)'
  );
  const setup = deferred();
  let removals = 0;
  let builds = 0;
  const context = {
    Promise,
    cancelActiveDrag() {},
    captureStillMatches: () => true,
    loadState: () => setup.promise,
    loadTheme: async () => {},
    isPanelCurrent: () => true,
    ensureHost() {},
    buildPanel() { builds += 1; },
    __removed: () => { removals += 1; },
  };
  vm.runInNewContext(
    `let panelGeneration = 4;
     let activePanelNonce = '11111111-1111-4111-8111-111111111111';
     let lastPayload = { questions: [{ answer: 'old private answer' }] };
     let shadow = {};
     let hostEl = { remove() { globalThis.__removed(); } };
     ${showSource}
     globalThis.__showApi = {
       show,
       host: () => hostEl,
       payload: () => lastPayload,
       nonce: () => activePanelNonce
     };`,
    context,
    { filename: 'answer-panel-replacement-setup.js' }
  );
  const showing = context.__showApi?.show?.({
    panelNonce: '22222222-2222-4222-8222-222222222222',
    capture: { pageId: 'new-page' },
    questions: [{ answer: 'new answer' }],
  });
  assert.ok(showing, 'replacement show harness must start');
  assert.equal(removals, 1,
    'replacement ownership must synchronously unmount the previous answer text');
  assert.equal(context.__showApi.host(), null);
  assert.equal(context.__showApi.payload(), null);
  assert.equal(builds, 0, 'the replacement must remain unbuilt while setup is pending');
  setup.resolve();
  await showing;
  assert.equal(builds, 1);
}

// A rejected SHOW is the privileged replacement operation and may discard the
// now-revoked prior panel. A standalone HIDE remains exact-nonce only.
{
  const hideSource = sourceSection(
    panelSource,
    'function hide(expectedNonce = null, expectedGeneration = null)',
    'window.__smeshPanel ='
  );
  const rejectedShowSource = sourceSection(
    scraperSource,
    'function discardPanelForRejectedShow()',
    '// Guard against duplicate listeners:'
  );
  let removals = 0;
  const panelContext = {
    activePanelNonce: '11111111-1111-4111-8111-111111111111',
    panelGeneration: 7,
    lastPayload: { questions: [{ answer: 'old' }] },
    shadow: {},
    hostEl: { remove() { removals += 1; } },
    captureCheckTimer: null,
    cancelActiveDrag() {},
    clearTimeout() {},
  };
  vm.runInNewContext(`${hideSource}\nglobalThis.__hide = hide;`, panelContext);
  assert.equal(
    panelContext.__hide('22222222-2222-4222-8222-222222222222'),
    false,
    'an unrelated standalone nonce must not hide the current panel'
  );
  assert.equal(removals, 0);

  const rejectedContext = {
    window: { __smeshPanel: { hide: (...args) => panelContext.__hide(...args) } },
  };
  vm.runInNewContext(
    `${rejectedShowSource}\nglobalThis.__discard = discardPanelForRejectedShow;`,
    rejectedContext
  );
  rejectedContext.__discard();
  assert.equal(removals, 1, 'the rejected privileged replacement must remove the revoked old panel');
  assert.match(
    sourceSection(scraperSource, "if (msg && msg.type === 'SHOW_ANSWERS')", "if (msg && msg.type === 'HIDE_ANSWERS')"),
    /if \(!captureMatches\) \{\s*discardPanelForRejectedShow\(\);/,
    'the rejected SHOW branch must invoke the privileged replacement teardown'
  );
  assert.match(
    sourceSection(scraperSource, "if (msg && msg.type === 'HIDE_ANSWERS')", '} catch (e) {'),
    /hide\(msg\.payload\?\.panelNonce\)/,
    'standalone HIDE messages must remain nonce-scoped'
  );
  // Every fill is injected by the worker WITH the captured signature and
  // principal, so it fails closed when the page changed. A message-triggered
  // fill carried none of that and had no caller; it must not come back.
  assert.doesNotMatch(scraperSource, /msg\.type === 'FILL_ANSWERS'/,
    'the content script must expose no message that fills the form');
}

function createComposerHarness({ pendingRead = Promise.resolve() } = {}) {
  const composerSource = sourceSection(
    dashboardSource,
    'async function sendFromComposer()',
    "document.getElementById('send').onclick"
  );
  const declaration = dashboardSource.match(/const composerPreparingChats = new WeakSet\(\);/)?.[0];
  assert.ok(declaration, 'per-chat composer ownership declaration missing');
  const chatA = { key: 'a', pending: false };
  const chatB = { key: 'b', pending: false };
  let active = chatA;
  const input = { value: 'question A' };
  const sends = [];
  const solveByChat = new Map();
  const context = {
    Promise,
    WeakSet,
    activeChat: () => active,
    micSession: null,
    inputEl: input,
    fileReadGen: 0,
    pendingFileRead: null,
    pendingFile: null,
    awaitStablePendingRead: () => pendingRead,
    clearAttachment() {},
    sendToChat(chat, text, files) {
      chat.pending = true;
      sends.push({ chat, text, files });
      const solve = deferred();
      solveByChat.set(chat, solve);
      return solve.promise;
    },
  };
  vm.runInNewContext(
    `${declaration}\n${composerSource}\n` +
      'globalThis.__composer = { sendFromComposer, preparing: (chat) => composerPreparingChats.has(chat) };',
    context,
    { filename: 'dashboard-composer-ownership.js' }
  );
  return {
    context,
    chatA,
    chatB,
    input,
    sends,
    solveByChat,
    setMicSession(session) { context.micSession = session; },
    setActive(chat) { active = chat; },
  };
}

// Same-chat double clicks are suppressed during file preparation. Once the
// solve owns chat.pending, that short mutex is released and another idle lesson
// can send while the first model promise remains hung.
{
  const read = deferred();
  const harness = createComposerHarness({ pendingRead: read.promise });
  const first = harness.context.__composer.sendFromComposer();
  assert.equal(harness.context.__composer.preparing(harness.chatA), true);
  await harness.context.__composer.sendFromComposer();
  assert.equal(harness.sends.length, 0, 'same-chat click must not overtake pending file preparation');
  read.resolve();
  await until(() => harness.sends.length === 1, 'first chat did not hand off to solve');
  assert.equal(harness.context.__composer.preparing(harness.chatA), false,
    'composer preparation ownership must end before the model promise settles');

  harness.setActive(harness.chatA);
  harness.input.value = 'same-chat duplicate';
  await harness.context.__composer.sendFromComposer();
  assert.equal(harness.sends.length, 1,
    'chat.pending must keep the in-flight chat single-flight after preparation ends');

  harness.setActive(harness.chatB);
  harness.input.value = 'question B';
  const second = harness.context.__composer.sendFromComposer();
  await until(() => harness.sends.length === 2, 'idle second lesson was globally blocked');
  assert.equal(harness.sends[1].chat, harness.chatB);
  assert.equal(harness.sends[1].text, 'question B');

  harness.solveByChat.get(harness.chatA).resolve(true);
  harness.solveByChat.get(harness.chatB).resolve(true);
  await Promise.all([first, second]);
}

// A newer microphone intent that begins while Send is waiting for a file read
// owns the composer. The stale Send continuation must preserve the recording,
// draft and attachment state instead of cancelling the mic and submitting the
// older picker intent.
{
  const read = deferred();
  const harness = createComposerHarness({ pendingRead: read.promise });
  const sending = harness.context.__composer.sendFromComposer();
  harness.setMicSession({ phase: 'recording' });
  read.resolve();
  await sending;
  assert.deepEqual(harness.sends, []);
  assert.equal(harness.input.value, 'question A');
  assert.equal(harness.context.micSession?.phase, 'recording',
    'a stale Send continuation must not cancel the newer microphone session');
}

// Replacing a valid attachment with an unreadable file clears payload and chip
// together; the UI must never advertise the prior file after the read fails.
{
  const helperSource = sourceSection(
    dashboardSource,
    'function showAttachment(name)',
    "fileInput.onchange = async () =>"
  );
  const onchangeSource = sourceSection(
    dashboardSource,
    'fileInput.onchange = async () =>',
    "document.getElementById('clearfile').onclick"
  );
  const fileInput = { files: [{ name: 'bad.png' }], value: 'bad.png' };
  const fileName = { textContent: 'good.png' };
  const chip = {
    hidden: false,
    classList: { remove() {} },
  };
  const attach = { click() {} };
  const context = {
    Promise,
    fileInput,
    fileNameEl: fileName,
    fileChip: chip,
    micSession: null,
    cancelMicSession() {},
    document: { getElementById: (id) => ({ attach }[id] || attach) },
    fileToInline: () => { throw new Error('decode failed'); },
    showToast() {},
  };
  vm.runInNewContext(
    `let pendingFile = { name: 'good.png' };
     let fileReadGen = 0;
     let pendingFileRead = { stale: true };
     ${helperSource}
     ${onchangeSource}
     globalThis.__attachment = {
       pending: () => pendingFile,
       pendingRead: () => pendingFileRead,
     };`,
    context,
    { filename: 'dashboard-attachment-replacement.js' }
  );
  await fileInput.onchange();
  assert.equal(context.__attachment.pending(), null);
  assert.equal(context.__attachment.pendingRead(), null);
  assert.equal(chip.hidden, true);
  assert.equal(fileName.textContent, '');

  const pasteSource = sourceSection(
    dashboardSource,
    "document.addEventListener('paste'",
    '/* ---------- Microphone capture'
  );
  const pasteListeners = new Map();
  const pasteFileInput = { value: 'good.png' };
  const pasteFileName = { textContent: 'good.png' };
  const pasteChip = { hidden: false, classList: { remove() {} } };
  class FakeFile {
    constructor(_parts, name, { type } = {}) {
      this.name = name;
      this.type = type || '';
    }
  }
  const pasteContext = {
    Promise,
    Date,
    File: FakeFile,
    fileInput: pasteFileInput,
    fileNameEl: pasteFileName,
    fileChip: pasteChip,
    micSession: null,
    cancelMicSession() {},
    document: {
      addEventListener(type, callback) { pasteListeners.set(type, callback); },
    },
    fileToInline: () => { throw new Error('paste decode failed'); },
    showToast() {},
  };
  vm.runInNewContext(
    `let pendingFile = { name: 'good.png' };
     let fileReadGen = 0;
     let pendingFileRead = { stale: true };
     function showAttachment(name) {
       fileNameEl.textContent = name;
       fileChip.hidden = false;
     }
     function clearAttachmentPresentation() {
       pendingFile = null;
       fileInput.value = '';
       fileNameEl.textContent = '';
       fileChip.hidden = true;
       fileChip.classList.remove('recording');
     }
     ${pasteSource}
     globalThis.__pasteAttachment = {
       pending: () => pendingFile,
       pendingRead: () => pendingFileRead,
     };`,
    pasteContext,
    { filename: 'dashboard-paste-attachment-replacement.js' }
  );
  const pastedBlob = { name: 'bad-paste.png', type: 'image/png' };
  let prevented = false;
  await pasteListeners.get('paste')({
    clipboardData: {
      items: [{
        type: 'image/png',
        getAsFile: () => pastedBlob,
      }],
    },
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(pasteContext.__pasteAttachment.pending(), null);
  assert.equal(pasteContext.__pasteAttachment.pendingRead(), null);
  assert.equal(pasteChip.hidden, true,
    'a rejected paste replacement must hide the prior attachment chip');
  assert.equal(pasteFileName.textContent, '');
}

// A send clicked while an attachment is being decoded must be cancelled if
// that decode fails. Continuing with the same text but no file is a different
// request and can produce a confidently wrong, quota-consuming answer.
{
  const helperSource = sourceSection(
    dashboardSource,
    'function showAttachment(name)',
    "fileInput.onchange = async () =>"
  );
  const onchangeSource = sourceSection(
    dashboardSource,
    'fileInput.onchange = async () =>',
    "document.getElementById('clearfile').onclick"
  );
  const composerSource = sourceSection(
    dashboardSource,
    'async function sendFromComposer()',
    "document.getElementById('send').onclick"
  );
  const declaration = dashboardSource.match(/const composerPreparingChats = new WeakSet\(\);/)?.[0];
  const read = deferred();
  const fileInput = { files: [{ name: 'broken.png' }], value: 'broken.png' };
  const fileName = { textContent: '' };
  const chip = { hidden: true, classList: { remove() {} } };
  const controls = { attach: { click() {} }, clearfile: {} };
  const chat = { key: 'lesson', pending: false };
  const sends = [];
  const context = {
    Promise,
    WeakSet,
    awaitStablePendingRead,
    fileInput,
    fileNameEl: fileName,
    fileChip: chip,
    micSession: null,
    cancelMicSession() {},
    fileToInline: () => read.promise,
    showToast() {},
    document: { getElementById: (id) => controls[id] },
    activeChat: () => chat,
    inputEl: { value: 'solve using attached file' },
    sendToChat(_chat, text, files) {
      sends.push({ text, files });
      return Promise.resolve(true);
    },
  };
  vm.runInNewContext(
    `let pendingFile = null;
     let fileReadGen = 0;
     let pendingFileRead = null;
     ${declaration}
     ${helperSource}
     ${onchangeSource}
     ${composerSource}
     globalThis.__failedReadApi = {
       select: () => fileInput.onchange(),
       send: sendFromComposer,
       pending: () => pendingFileRead,
       generation: () => fileReadGen
     };`,
    context,
    { filename: 'dashboard-failed-attachment-send.js' }
  );
  const reading = context.__failedReadApi.select();
  await until(() => context.__failedReadApi.pending() === read.promise,
    'attachment read did not become pending');
  const sending = context.__failedReadApi.send();
  read.reject(new Error('simulated decode failure'));
  await Promise.all([reading, sending]);
  assert.equal(context.__failedReadApi.generation(), 2,
    'the failed current read must invalidate a send that captured its generation');
  assert.deepEqual(sends, [],
    'a request awaiting a failed attachment must not continue text-only');
}

console.log('content/dashboard ownership race regressions passed');
