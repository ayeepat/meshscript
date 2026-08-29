import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  executeScriptInCapturedDocuments,
  isTestCaptureContext,
  sameTestCaptureContext,
  withMatchingTestCapture,
} from '../src/lib/test-capture-context.js';
import { capturePillDomText, captureTestVisualMedia } from '../src/lib/pill-dom-capture.js';

const captured = {
  tabId: 41,
  url: 'https://school.mos.ru/test/lesson-7',
  documentId: '5fa85f64-5717-4562-b3fc-2c963f66afa6',
  signature: 'frame-0:question-12',
  documents: [{
    frameId: 0,
    documentId: '5fa85f64-5717-4562-b3fc-2c963f66afa6',
    pageId: '2f1c8f86-8d08-4b72-8675-54254f0f1001',
    signature: 'question-12',
    principal: '["v1","account-7","subject-7","student-12","selected"]',
    url: 'https://school.mos.ru/test/lesson-7',
    isTestDocument: true,
  }],
};

assert.equal(isTestCaptureContext(captured), true);
assert.equal(isTestCaptureContext({ ...captured, signature: '' }), false);
assert.equal(isTestCaptureContext({ ...captured, url: 'javascript:alert(1)' }), false);
assert.equal(isTestCaptureContext({
  ...captured,
  documents: captured.documents.map(({ principal: _principal, ...document }) => document),
}), false, 'every captured browser document must carry a current-principal identity');
assert.equal(isTestCaptureContext({
  ...captured,
  documents: captured.documents.map((document) => ({ ...document, principal: 'x'.repeat(513) })),
}), false, 'captured principal identities must be bounded');
assert.equal(isTestCaptureContext({
  ...captured,
  documents: captured.documents.map((document) => ({ ...document, principal: 'account\u0000student' })),
}), false, 'captured principal identities must not contain control characters');
assert.equal(isTestCaptureContext({
  ...captured,
  documents: captured.documents.map((document) => ({
    ...document,
    principal: '["v2","","","","unbound",""]',
  })),
}), false, 'an all-unknown account/child capture must fail closed');

assert.equal(sameTestCaptureContext(captured, { ...captured }), true);
assert.equal(
  sameTestCaptureContext(captured, { ...captured, url: 'https://meshclass.com/test/lesson-8' }),
  false,
);
assert.equal(
  sameTestCaptureContext(captured, { ...captured, signature: 'frame-0:question-13' }),
  false,
);
assert.equal(
  sameTestCaptureContext(captured, { ...captured, documentId: '38400000-8cf0-11bd-b23e-10b96e4ef00d' }),
  false,
);
assert.equal(sameTestCaptureContext(captured, { ...captured, tabId: 42 }), false);
assert.equal(sameTestCaptureContext(captured, {
  ...captured,
  documents: captured.documents.map((document) => ({
    ...document,
    principal: '["v1","account-7","subject-7","student-99","selected"]',
  })),
}), false, 'switching the selected child in the same document must invalidate old AI work');
assert.equal(sameTestCaptureContext(captured, {
  ...captured,
  documents: captured.documents.map((document) => ({
    ...document,
    principal: '["v1","account-8","subject-8","student-12","selected"]',
  })),
}), false, 'switching the signed-in account in the same document must invalidate old AI work');

// Browser documentIds, not tabId/allFrames, must own the final mutation. A
// navigation after validation removes the captured document, so the simulated
// scripting API rejects and the replacement document receives no write.
let liveDocuments = new Set(captured.documents.map((document) => document.documentId));
let documentMutations = 0;
const scripting = {
  async executeScript(details) {
    assert.deepEqual(details.target, {
      tabId: captured.tabId,
      documentIds: [captured.documentId],
    });
    if (details.target.documentIds.some((id) => !liveDocuments.has(id))) {
      throw new Error('No document with the given ID');
    }
    documentMutations += 1;
    return [];
  }
};
liveDocuments = new Set(['replacement-document']);
await assert.rejects(
  executeScriptInCapturedDocuments(captured, {
    documentIds: [captured.documentId],
    func: () => { documentMutations += 1; },
  }, scripting),
  /No document/,
);
assert.equal(documentMutations, 0, 'a replacement document must never receive old answers');

const childDocument = {
  frameId: 7,
  documentId: 'child-document-7',
  pageId: 'dd50bd85-3bda-4598-a9f8-e37e8d274f5d',
  signature: 'question-frame-7',
  principal: '["v1","","","","none"]',
  url: 'https://uchebnik.mos.ru/exam/challenge/7?registration=attempt-7',
  isTestDocument: true,
};
const pillCapture = {
  ...captured,
  signature: `${captured.signature}||7:${childDocument.signature}`,
  documents: [...captured.documents, childDocument],
};
assert.equal(isTestCaptureContext(pillCapture), true,
  'a positively identified Uchebnik test iframe remains valid when the top document supplies identity');
let screenshotCalls = 0;
const pillText = await capturePillDomText(pillCapture, {
  async executeScript(details) {
    assert.deepEqual(details.target.documentIds, pillCapture.documents.map((document) => document.documentId));
    assert.deepEqual(details.args[0][captured.documents[0].pageId], {
      signature: captured.documents[0].signature,
      principal: captured.documents[0].principal,
      url: captured.documents[0].url,
      requireTestDocument: false,
    });
    assert.deepEqual(details.args[0][childDocument.pageId], {
      signature: childDocument.signature,
      principal: childDocument.principal,
      url: childDocument.url,
      requireTestDocument: true,
    });
    return [
      { frameId: 0, result: { stale: false, text: 'Задание №1. Решите уравнение.' } },
      { frameId: 7, result: { stale: false, text: 'Варианты ответа: 2, 3, 4.' } },
    ];
  },
  async captureVisibleTab() { screenshotCalls += 1; },
});
assert.match(pillText, /Решите уравнение/);
assert.match(pillText, /Варианты ответа/);
assert.equal(screenshotCalls, 0, 'the in-page pill must remain DOM-only without activeTab');

// Media detection is bound to the same exact browser documents as text capture.
// One positive frame is enough to choose Qwen; a text-only capture stays false.
for (const [visualFrames, expected] of [
  [new Set(), false],
  [new Set([childDocument.documentId]), true],
]) {
  let readCalls = 0;
  const hasVisualMedia = await captureTestVisualMedia(pillCapture, {
    async executeScript(details) {
      if (details.files) return [];
      readCalls += 1;
      assert.deepEqual(details.target.documentIds,
        pillCapture.documents.map((document) => document.documentId));
      return details.target.documentIds.map((documentId, index) => ({
        frameId: index,
        documentId,
        result: { stale: false, visualMedia: visualFrames.has(documentId) },
      }));
    },
  });
  assert.equal(readCalls, 1);
  assert.equal(hasVisualMedia, expected);
}

// The per-frame budget must charge the "\n\n" separator it prepends. Without
// that the result overran its own cap, and a frame arriving with no room left
// still appended a bare separator.
{
  const MAX_PILL_TEXT_CHARS = 15000;
  const texts = new Map([
    [pillCapture.documents[0].documentId, 'A'.repeat(MAX_PILL_TEXT_CHARS - 1)],
    [pillCapture.documents[1].documentId, 'B'.repeat(500)],
  ]);
  const overflowText = await capturePillDomText(pillCapture, {
    async executeScript(details) {
      return details.target.documentIds.map((documentId, index) => ({
        frameId: index,
        documentId,
        result: { stale: false, text: texts.get(documentId) },
      }));
    },
  });
  assert.ok(overflowText.length <= MAX_PILL_TEXT_CHARS,
    `captured page text must stay within its cap (got ${overflowText.length})`);
  assert.doesNotMatch(overflowText, /\n\n$/,
    'a frame with no remaining budget must not append a bare separator');
}

// The document-targeted DOM read also checks the live principal itself. This
// closes the same-document account switch between context capture and reading
// the exact text that will be sent to AI.
const priorWindow = globalThis.window;
const priorDocument = globalThis.document;
globalThis.window = {
  __smeshCaptureDocumentId: captured.documents[0].pageId,
  __smeshPageSig: () => captured.documents[0].signature,
  __smeshCurrentPrincipal: () => '["v1","account-8","subject-8","student-12","selected"]',
  __smeshIsTestDocument: () => true,
};
globalThis.location = { href: captured.documents[0].url };
globalThis.document = {
  body: { innerText: 'Задание другого аккаунта' },
  querySelectorAll: () => [],
};
try {
  await assert.rejects(
    capturePillDomText(captured, {
      async executeScript(details) {
        return [{ frameId: 0, result: details.func(...details.args) }];
      },
    }),
    (error) => error?.code === 'TEST_CAPTURE_CHANGED',
  );
} finally {
  if (priorWindow === undefined) delete globalThis.window;
  else globalThis.window = priorWindow;
  if (priorDocument === undefined) delete globalThis.document;
  else globalThis.document = priorDocument;
}

let mutations = 0;
const result = await withMatchingTestCapture(
  captured,
  async () => ({ ...captured }),
  async () => {
    mutations += 1;
    return 'applied';
  },
);
assert.equal(result, 'applied');
assert.equal(mutations, 1);

await assert.rejects(
  withMatchingTestCapture(
    captured,
    async () => ({ ...captured, signature: 'frame-0:question-99' }),
    async () => {
      mutations += 1;
    },
  ),
  (error) => error?.code === 'TEST_CAPTURE_CHANGED',
);
assert.equal(mutations, 1, 'a stale solve must not reach the mutation callback');

await assert.rejects(
  withMatchingTestCapture(
    captured,
    async () => ({
      ...captured,
      documents: captured.documents.map((document) => ({
        ...document,
        principal: '["v1","account-7","subject-7","student-13","selected"]',
      })),
    }),
    async () => {
      mutations += 1;
    },
  ),
  (error) => error?.code === 'TEST_CAPTURE_CHANGED',
);
assert.equal(mutations, 1, 'a child/account mismatch must fail before any answer mutation');

// Exercise the real principal encoder with local account claims and selected
// student signals. A token refresh can change the raw bearer token, so only the
// bounded stable claims — never the token itself — participate.
const scraper = readFileSync(new URL('../src/content/scraper.js', import.meta.url), 'utf8');
const visualStart = scraper.indexOf('const TEST_VISUAL_MEDIA_SELECTOR');
const visualEnd = scraper.indexOf('\nfunction stableSignatureControlSemantics', visualStart);
assert.ok(visualStart >= 0 && visualEnd > visualStart, 'visual media detector source not found');

function visualElement(tagName, width, height, attrs = {}, backgroundImage = 'none') {
  return {
    tagName,
    backgroundImage,
    getBoundingClientRect: () => ({ width, height, left: 10, top: 10, right: 10 + width, bottom: 10 + height }),
    getAttribute: (name) => attrs[name] || '',
    closest: () => null,
  };
}

function runVisualDetector(media, all = media) {
  const context = {
    innerWidth: 1200,
    innerHeight: 900,
    document: {
      documentElement: { clientWidth: 1200, clientHeight: 900 },
      querySelectorAll: (selector) => selector === '*' ? all : media,
    },
    getComputedStyle: (element) => ({
      display: 'block', visibility: 'visible', contentVisibility: 'visible',
      opacity: '1', position: 'static', overflow: 'visible', overflowX: 'visible',
      overflowY: 'visible', transform: 'none', clip: 'auto', clipPath: 'none',
      backgroundImage: element.backgroundImage,
    }),
    SIGNATURE_ELEMENT_SCAN_LIMIT: 4096,
    SIGNATURE_MUTABLE_ANSWER_SELECTOR: '.answer-widget',
    signatureElementIsVisuallyHidden: () => false,
  };
  vm.createContext(context);
  vm.runInContext(
    `${scraper.slice(visualStart, visualEnd)}\nthis.__smeshHasVisualMedia = testPageHasVisualMedia;`,
    context,
  );
  return context.__smeshHasVisualMedia();
}

assert.equal(runVisualDetector([visualElement('svg', 24, 24)]), false,
  'a normal UI icon must not route a text-only test to Qwen');
assert.equal(runVisualDetector([visualElement('img', 320, 180)]), true,
  'a substantial visible image must route the test to Qwen');
assert.equal(runVisualDetector([visualElement('img', 28, 28, { alt: 'График функции' })]), true,
  'an explicitly labelled graph is a visual signal even when compact');
assert.equal(runVisualDetector([], [visualElement('div', 400, 220, {}, 'url(question.png)')]), true,
  'a substantial CSS background image must also route to Qwen');
assert.equal(runVisualDetector([], [visualElement('div', 400, 220, {}, 'linear-gradient(red, blue)')]), false,
  'a decorative CSS gradient must not route a text-only test to Qwen');
assert.equal(runVisualDetector([visualElement('canvas', 400, 220, { class: 'myscript-answer' })]), false,
  'an answer-input canvas must not be mistaken for question media');

const principalStart = scraper.indexOf('const MAX_CAPTURE_PRINCIPAL_PART');
const principalEnd = scraper.indexOf('\n/**\n * Resolve the numeric student_id', principalStart);
assert.ok(principalStart >= 0 && principalEnd > principalStart, 'principal encoder source not found');
let localStudent = { id: 'student-12' };
let localClaims = { msh: 'account-7', sub: 'subject-7' };
const principalContext = {
  findStudentId: () => localStudent,
  findAuthToken: () => 'raw-token-is-never-returned',
  jwtPayload: () => localClaims,
  URL,
  location: { href: 'https://uchebnik.mos.ru/exam/challenge/7?registration=attempt-7' },
  document: { querySelectorAll: () => [] },
};
vm.createContext(principalContext);
vm.runInContext(
  `${scraper.slice(principalStart, principalEnd)}\nthis.currentPrincipalIdentity = currentPrincipalIdentity;`,
  principalContext,
);
const basePrincipal = principalContext.currentPrincipalIdentity();
assert.ok(basePrincipal.length <= 512 && !basePrincipal.includes('raw-token-is-never-returned'),
  'the encoder must be bounded and must never expose the bearer token');
localStudent = { id: 'student-13' };
assert.notEqual(principalContext.currentPrincipalIdentity(), basePrincipal,
  'changing only the selected child must change the captured principal');
localStudent = { id: 'student-12' };
localClaims = { msh: 'account-8', sub: 'subject-8' };
assert.notEqual(principalContext.currentPrincipalIdentity(), basePrincipal,
  'changing only the local account claims must change the captured principal');
localStudent = { id: 's'.repeat(1000) };
localClaims = { msh: 'a'.repeat(1000), sub: 'b'.repeat(1000) };
assert.ok(principalContext.currentPrincipalIdentity().length <= 512,
  'hostile local signals must still produce a bounded principal identity');
localStudent = { id: null };
localClaims = {};
principalContext.location.href = 'https://uchebnik.mos.ru/exam/challenge/7?registration=attempt-a';
const attemptA = principalContext.currentPrincipalIdentity();
principalContext.location.href = 'https://uchebnik.mos.ru/exam/challenge/7?registration=attempt-b';
const attemptB = principalContext.currentPrincipalIdentity();
assert.notEqual(attemptA, attemptB,
  'cross-origin players without Mesh storage must bind capture identity to the XAPI attempt');
assert.equal(JSON.parse(attemptA)[4], 'session');
assert.ok(!attemptA.includes('attempt-a'), 'raw XAPI registration values must not enter capture messages');

const worker = readFileSync(
  new URL('../src/background/service-worker.js', import.meta.url),
  'utf8',
);
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/content/answer-panel.js', import.meta.url), 'utf8');

assert.ok(!manifest.host_permissions.includes('https://*.mos.ru/*'),
  'the extension must not receive script access to every authenticated MOS subdomain');
assert.deepEqual(
  manifest.host_permissions.filter((value) => value.includes('mos.ru')),
  ['https://school.mos.ru/*', 'https://uchebnik.mos.ru/*'],
  'MOS host permission must be limited to the two product origins');
assert.match(worker,
  /isMeshContentUrl\(entry\.result\?\.url\)[\s\S]*entry\.frameId === 0 \|\| entry\.result\?\.isTestDocument === true/,
  'child frames must be positively identified test documents before capture');
assert.doesNotMatch(worker, /hostname\.endsWith\(['"]\.mos\.ru['"]\)/,
  'capture must not accept arbitrary sibling MOS origins');

// Exercise the real worker capability primitives. A token minted for panel A
// must be useless for panel B even in the same tab/action, and every token stays
// single-use on both successful and mismatched presentation.
{
  const tokenStart = worker.indexOf('function clearExpiredActionTokens(');
  const tokenEnd = worker.indexOf('\nchrome.runtime.onMessage.addListener', tokenStart);
  assert.ok(tokenStart >= 0 && tokenEnd > tokenStart,
    'action capability helpers must be extractable');
  let uuidCounter = 0;
  const tokenContext = {
    actionTokens: new Map(),
    ACTION_TOKEN_TTL_MS: 30_000,
    crypto: { randomUUID: () => `token-${++uuidCounter}` },
    Date,
  };
  vm.createContext(tokenContext);
  vm.runInContext(
    `${worker.slice(tokenStart, tokenEnd)}\n` +
      'this.issueActionToken = issueActionToken; this.consumeActionToken = consumeActionToken;',
    tokenContext,
  );
  const nonceA = '11111111-1111-4111-8111-111111111111';
  const nonceB = '22222222-2222-4222-8222-222222222222';
  const mismatched = tokenContext.issueActionToken(7, 'FILL_ANSWERS_ALL', nonceA);
  assert.equal(
    tokenContext.consumeActionToken(mismatched.token, 7, 'FILL_ANSWERS_ALL', nonceB),
    false,
  );
  assert.equal(
    tokenContext.consumeActionToken(mismatched.token, 7, 'FILL_ANSWERS_ALL', nonceA),
    false,
    'a mismatched presentation must still burn the capability',
  );
  const exact = tokenContext.issueActionToken(7, 'FILL_ANSWERS_ALL', nonceA);
  assert.equal(
    tokenContext.consumeActionToken(exact.token, 7, 'FILL_ANSWERS_ALL', nonceA),
    true,
  );
  assert.equal(
    tokenContext.consumeActionToken(exact.token, 7, 'FILL_ANSWERS_ALL', nonceA),
    false,
    'a successful capability must be single-use',
  );
}

// A pending replacement revokes the old panel immediately but is not itself
// authorized until SHOW_ANSWERS and final capture validation finish.
{
  const contextStart = worker.indexOf('const answerPanelContexts = new Map();');
  const contextEnd = worker.indexOf('\nasync function showAnswersInTab', contextStart);
  assert.ok(contextStart >= 0 && contextEnd > contextStart,
    'answer-panel context helpers must be extractable');
  const panelContext = {
    testCaptureChangedError: () => Object.assign(new Error('stale'), {
      code: 'TEST_CAPTURE_CHANGED',
    }),
  };
  vm.createContext(panelContext);
  vm.runInContext(
    `${worker.slice(contextStart, contextEnd)}\n` +
      'this.answerPanelContexts = answerPanelContexts;' +
      'this.matchingAnswerPanelContext = matchingAnswerPanelContext;' +
      'this.deleteAnswerPanelContext = deleteAnswerPanelContext;',
    panelContext,
  );
  const nonce = '33333333-3333-4333-8333-333333333333';
  panelContext.answerPanelContexts.set(9, {
    panelNonce: nonce,
    capture: captured,
    ready: false,
  });
  assert.throws(
    () => panelContext.matchingAnswerPanelContext(9, nonce),
    (error) => error?.code === 'TEST_CAPTURE_CHANGED',
    'a half-rendered panel must not receive mutation authority',
  );
  panelContext.answerPanelContexts.get(9).ready = true;
  assert.equal(panelContext.matchingAnswerPanelContext(9, nonce).capture, captured);
  assert.throws(
    () => panelContext.matchingAnswerPanelContext(
      9,
      '44444444-4444-4444-8444-444444444444',
    ),
    (error) => error?.code === 'TEST_CAPTURE_CHANGED',
  );
  panelContext.deleteAnswerPanelContext(9, '44444444-4444-4444-8444-444444444444');
  assert.equal(panelContext.answerPanelContexts.has(9), true,
    'an old failure must not delete a newer panel context');
  panelContext.deleteAnswerPanelContext(9, nonce);
  assert.equal(panelContext.answerPanelContexts.has(9), false);
}

// The worker's final read happens before its response crosses back into the
// content script. Exercise the real resolveOne continuation with a page switch
// during that delivery: the fresh answer must never reach q/aEl or the form.
const resolveOneSource = panel.match(
  /  (async function resolveOne\(btn, generation, panelNonce\) \{[\s\S]*?\n  \})\n\n  function wireButtons/
)?.[1];
assert.ok(resolveOneSource, 'answer-panel resolveOne source must be extractable');
const question = { index: 1, text: '2 + 2', answer: 'old' };
const textWrites = [];
let answerText = 'old';
const answerEl = {
  classList: { add() {}, remove() {} },
  get textContent() { return answerText; },
  set textContent(value) { answerText = value; textWrites.push(value); },
};
const line = {
  querySelector: () => answerEl,
  getAttribute: () => '1',
};
const resolveButton = {
  disabled: false,
  dataset: { qi: '0' },
  classList: { add() {}, remove() {} },
  closest: () => line,
};
let captureMatches = true;
let hiddenPanels = 0;
let refillCalls = 0;
const resolveContext = {
  lastPayload: {
    questions: [question],
    capture: { pageId: 'captured-page' },
    generation: 7,
    panelNonce: 'panel-a',
  },
  isPanelCurrent: () => true,
  captureStillMatches: () => captureMatches,
  hide: () => { hiddenPanels += 1; },
  sendMsg: async () => {
    captureMatches = false; // same-document question/account switch during delivery
    return { ok: true, answer: 'fresh-but-stale' };
  },
  requestFill: async () => { refillCalls += 1; return { filled: ['1'] }; },
  markOneLine() {},
  setTimeout() {},
};
vm.createContext(resolveContext);
vm.runInContext(`${resolveOneSource}\nthis.resolveOne = resolveOne;`, resolveContext);
await resolveContext.resolveOne(resolveButton, 7, 'panel-a');
assert.equal(question.answer, 'old', 'a raced re-solve response must not replace the captured answer');
assert.ok(!textWrites.includes('fresh-but-stale'), 'a raced re-solve response must not render on the replacement page');
assert.equal(refillCalls, 0, 'a raced re-solve response must not reach form mutation');
assert.equal(hiddenPanels, 1, 'the obsolete answer panel must be removed after a capture mismatch');

// Even when the browser document/capture is unchanged, displaying a newer
// solve in the same tab must invalidate every continuation from the older
// panel. The old AI response may not repaint or fill the replacement panel.
{
  const oldQuestion = { index: 1, text: 'old question', answer: 'old answer' };
  let oldAnswerText = oldQuestion.answer;
  const oldWrites = [];
  const oldAnswerEl = {
    classList: { add() {}, remove() {} },
    get textContent() { return oldAnswerText; },
    set textContent(value) { oldAnswerText = value; oldWrites.push(value); },
  };
  const oldLine = {
    querySelector: () => oldAnswerEl,
    getAttribute: () => '1',
  };
  const oldButton = {
    disabled: false,
    dataset: { qi: '0' },
    classList: { add() {}, remove() {} },
    closest: () => oldLine,
  };
  let currentGeneration = 11;
  let oldRefills = 0;
  const generationContext = {
    lastPayload: {
      questions: [oldQuestion],
      capture: { pageId: 'same-document' },
      generation: 11,
      panelNonce: 'panel-old',
    },
    isPanelCurrent: (generation, panelNonce) =>
      generation === currentGeneration && panelNonce === 'panel-old',
    captureStillMatches: () => true,
    hide: () => {},
    sendMsg: async () => {
      currentGeneration = 12; // SHOW_ANSWERS for the newer solve won the race.
      return { ok: true, answer: 'answer from obsolete solve' };
    },
    requestFill: async () => { oldRefills += 1; return { filled: ['1'] }; },
    markOneLine() {},
    setTimeout() {},
  };
  vm.createContext(generationContext);
  vm.runInContext(`${resolveOneSource}\nthis.resolveOne = resolveOne;`, generationContext);
  await generationContext.resolveOne(oldButton, 11, 'panel-old');
  assert.equal(oldQuestion.answer, 'old answer');
  assert.ok(!oldWrites.includes('answer from obsolete solve'));
  assert.equal(oldRefills, 0,
    'an obsolete panel generation must not invoke the form filler');
}

assert.match(panel, /lastPayload = \{[\s\S]*capture: payload\?\.capture \|\| null,[\s\S]*panelNonce,[\s\S]*generation,/,
  'the panel must retain the exact capture alongside the displayed questions');
assert.match(panel, /isPanelCurrent\(generation, panelNonce, btn\)/,
  'a late per-question continuation must be bound to the panel generation that launched it');
assert.match(worker, /matchingAnswerPanelContext\(tabId, panelNonce\)/,
  'panel mutations must require the worker-minted nonce for the currently authorized panel');
assert.match(worker, /grant\.panelNonce !== panelNonce/,
  'single-use action tokens must also be bound to the exact panel generation');
assert.match(scraper, /window\.__smeshPanel\?\.hide\(msg\.payload\?\.panelNonce\)/,
  'a delayed HIDE_ANSWERS message must carry its nonce into the panel generation guard');

const solveCase = worker.slice(
  worker.indexOf("case 'SOLVE_TEST':"),
  worker.indexOf("case 'FILL_ANSWERS_ALL':"),
);
const solveIndex = solveCase.indexOf('await solveTest');
const solveGuardIndex = solveCase.indexOf('await withMatchingTestCapture', solveIndex);
const panelIndex = solveCase.indexOf('await showAnswersInTab', solveGuardIndex);
assert.ok(solveIndex >= 0 && solveGuardIndex > solveIndex && panelIndex > solveGuardIndex,
  'the worker must revalidate only after AI returns and before displaying answers');

assert.match(popup, /payload: \{ text: pageText, screenshot, hasVisualMedia, tabId, provider, capture \}/,
  'popup solve requests must carry the captured identity and media-routing signal');
assert.match(popup, /if \(hasVisualMedia\) \{[\s\S]*captureVisibleTarget\(currentTab\)/,
  'the popup must capture pixels only after the page reports visual media');
assert.match(popup, /payload: \{ tabId: tab\.id, questions, capture \}/,
  'popup autofill requests must carry the same captured identity');
assert.match(popup, /payload: \{ tabId, capture \}/,
  'popup pagination requests must carry the exact captured page identity');
assert.match(worker, /runInCapturedDocumentsWithIds\(capture, '__smeshNextDiscovery'\)/,
  'pagination discovery must target only the captured browser documents');
assert.match(worker, /__smeshNextClick\(expectedSignature, expectedPrincipal\)/,
  'the click injection must carry the discovered frame signature and principal into the page');
assert.match(worker, /__smeshFill\(qs, currentSignature, currentPrincipal\)/,
  'native form filling must carry the same per-document signature and principal');
assert.match(worker, /__smeshCurrentPrincipal/,
  'capture and final mutation guards must read the current local account/child identity');
assert.match(panel, /principal === expected\.principal/,
  'the in-page answer UI must reject an account or child switch immediately before rendering');
assert.doesNotMatch(panel, /return localFill\(/,
  'the answer panel must not bypass worker-side capture validation on failure');

// A React transition can reuse the exact control node for a different
// question. Attachment alone is not proof: the post-click signature must still
// equal the captured question, and a native input transition must stop before
// dispatching its second event into the replacement page.
{
  const guardStart = scraper.indexOf('function interactiveGuardCurrent(guard)');
  const guardEnd = scraper.indexOf('\n// Open a dropdown', guardStart);
  let liveSignature = 'question-b';
  const guardContext = {
    document: { documentElement: { contains: () => true } },
    pageSignature: () => liveSignature,
    currentPrincipalIdentity: () => 'principal-a'
  };
  vm.createContext(guardContext);
  vm.runInContext(
    `${scraper.slice(guardStart, guardEnd)}\n` +
      'this.interactiveGuardAccept = interactiveGuardAccept;',
    guardContext
  );
  const reused = {};
  const interactiveGuard = {
    signature: 'question-a',
    principal: 'principal-a',
    stale: false
  };
  assert.equal(guardContext.interactiveGuardAccept(interactiveGuard, reused), false);
  assert.equal(interactiveGuard.stale, true,
    'a reused attached node must not authorize a different question signature');

  const mutationStart = scraper.indexOf('function mutationGuardCurrent(guard, element)');
  const mutationEnd = scraper.indexOf('\n// Compact element description', mutationStart);
  let nativeCurrent = true;
  const nativeEvents = [];
  class FakeInput {}
  const nativeContext = {
    document: { documentElement: { contains: () => true } },
    interactiveGuardCurrent: () => nativeCurrent,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    Event: class { constructor(type) { this.type = type; } }
  };
  vm.createContext(nativeContext);
  vm.runInContext(
    `${scraper.slice(mutationStart, mutationEnd)}\nthis.setNativeValue = setNativeValue;`,
    nativeContext
  );
  const reusedInput = new FakeInput();
  reusedInput.dispatchEvent = (event) => {
    nativeEvents.push(event.type);
    if (event.type === 'input') nativeCurrent = false;
  };
  assert.equal(nativeContext.setNativeValue(reusedInput, 'old answer', {}), false);
  assert.deepEqual(nativeEvents, ['input'],
    'a page switch during input must prevent change from reaching the reused node');
}

console.log('test capture binding regression passed');
