/**
 * Regressions for the verified E-16–E-20 solver findings. Pure helpers and the
 * transcript cache run functionally; extension entry points with large browser
 * surfaces are pinned by narrow source assertions around the affected branch.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const scraper = source('../src/content/scraper.js');
const worker = source('../src/background/service-worker.js');
const dashboard = source('../src/dashboard/dashboard.js');
const popup = source('../src/popup/popup.js');
const transcribeSource = source('../src/lib/transcribe.js');

// Mixed timer/question lines must remain stable as the countdown changes, but
// masking the timer must not collapse genuinely different question wording.
const signatureFunction = scraper.match(/function stableSignatureText\(raw\) \{[\s\S]*?\n\}/);
assert.ok(signatureFunction, 'stableSignatureText source not found');
const signatureContext = {
  normalize: (text) => String(text).replace(/\s+/g, ' ').trim().toLowerCase()
};
vm.createContext(signatureContext);
vm.runInContext(`${signatureFunction[0]}\nthis.stableSignatureText = stableSignatureText;`, signatureContext);
assert.equal(
  signatureContext.stableSignatureText('Осталось времени 12:45 — Вопрос 3'),
  signatureContext.stableSignatureText('Осталось времени 13:07 — Вопрос 3'),
  'a countdown embedded in a mixed question line must not churn the page signature'
);
assert.equal(
  signatureContext.stableSignatureText('Осталось 5 минут'),
  signatureContext.stableSignatureText('Осталось 4 минуты'),
  'Cyrillic duration suffixes on timer lines must be masked without ASCII word-boundary bugs'
);
assert.notEqual(
  signatureContext.stableSignatureText('Осталось времени 12:45 — Вопрос 3: Сколько будет 2 + 2?'),
  signatureContext.stableSignatureText('Осталось времени 13:07 — Вопрос 3: Сколько будет 3 + 3?'),
  'timer masking must preserve genuinely different question text'
);
assert.notEqual(
  signatureContext.stableSignatureText('На решение задачи даётся 5 минут.'),
  signatureContext.stableSignatureText('На решение задачи даётся 7 минут.'),
  'duration literals outside timer context must continue distinguishing question variants'
);
assert.notEqual(
  signatureContext.stableSignatureText('Поезд отправляется в 12:30. Когда он прибудет?'),
  signatureContext.stableSignatureText('Поезд отправляется в 13:30. Когда он прибудет?'),
  'clock literals outside timer context must remain part of the captured question identity'
);

// Live regions often contain elapsed counters and rotating status verbs that
// change while AI is pending. Their text must not churn the capture signature,
// while the actual prompt outside that region must remain authoritative.
const domSignatureSection = scraper.slice(
  scraper.indexOf('const SIGNATURE_BLOCK_TAGS'),
  scraper.indexOf('/**\n * Read-only discovery', scraper.indexOf('const SIGNATURE_BLOCK_TAGS')),
);
assert.ok(domSignatureSection.startsWith('const SIGNATURE_BLOCK_TAGS'),
  'stable DOM signature helper source not found');
let signatureUnits = [{ type: 'text', number: null, inputs: [{ _label: 'Ответ' }] }];
const visibleStyle = {
  display: 'block', visibility: 'visible', contentVisibility: 'visible', opacity: '1',
  position: 'static', overflow: 'visible', overflowX: 'visible', overflowY: 'visible',
  clip: 'auto', clipPath: 'none', transform: 'none'
};
const domSignatureContext = {
  normalize: (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase(),
  normalizeForMatch: (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase(),
  fieldLabel: (input) => input?._label || '',
  controlLabelText: (input) => input?._label || '',
  collectUnits: () => signatureUnits,
  collectInteractiveUnits: () => [],
  document: {
    body: null,
    createElement(tag) {
      assert.equal(tag, 'canvas');
      let source = null;
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage(canvas) { source = canvas; },
          getImageData() {
            if (source?._tainted) throw new Error('tainted canvas');
            return { data: Uint8Array.from(source?._pixels || new Array(1024).fill(0)) };
          },
        }),
      };
    },
  },
  location: { href: 'https://uchebnik.mos.ru/exam/challenge/7?registration=attempt-7' },
  getComputedStyle: (node) => node?._style || visibleStyle,
};
vm.createContext(domSignatureContext);
vm.runInContext(
  `${signatureFunction[0]}\n${domSignatureSection}\n` +
  'this.stableSignatureDomText = stableSignatureDomText; this.pageSignature = pageSignature;',
  domSignatureContext,
);
const textNode = (value) => ({ nodeType: 3, nodeValue: value });
const RESOURCE_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'OBJECT', 'EMBED', 'IFRAME']);
const element = (tagName, children = [], attrs = {}, options = {}) => {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: children,
    hidden: false,
    id: attrs.id || '',
    className: attrs.class || '',
    currentSrc: options.currentSrc || '',
    outerHTML: options.outerHTML || '',
    width: options.width || Number(attrs.width) || 0,
    height: options.height || Number(attrs.height) || 0,
    _pixels: options.pixels || null,
    _tainted: !!options.tainted,
    _style: { ...visibleStyle, ...(options.style || {}) },
    _rect: options.rect || { width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.hasOwn(attrs, name); },
    getBoundingClientRect() { return this._rect; },
    querySelector(selector) {
      const controls = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
      const stack = [...children];
      while (stack.length) {
        const child = stack.shift();
        if (child?.nodeType === 1 && controls.has(child.tagName) && /input|textarea|select|role|contenteditable/.test(selector)) return child;
        if (child?.childNodes) stack.push(...child.childNodes);
      }
      return null;
    },
    querySelectorAll(selector = '') {
      const all = [];
      const stack = [...children];
      while (stack.length) {
        const child = stack.shift();
        if (child?.nodeType === 1) all.push(child);
        if (child?.childNodes) stack.push(...child.childNodes);
      }
      if (selector === '*') return all;
      return all.filter((child) =>
        RESOURCE_TAGS.has(child.tagName) || child.getAttribute?.('role') === 'img'
      );
    },
    get textContent() { return children.map((child) => child.nodeValue ?? child.textContent ?? '').join(''); },
    get innerText() { return this.textContent; },
  };
  for (const child of children) if (child && typeof child === 'object') child.parentElement = node;
  return node;
};
const signatureInput = (question, liveText) => element('body', [
  element('main', [element('h2', [textNode('Задание №3')]), element('p', [textNode(question)])]),
  element('div', [textNode(liveText)], { 'aria-live': 'polite', class: 'solve-status' }),
  element('div', [textNode(`Статус: ${liveText}`)], { role: 'status' }),
  element('span', [textNode(`Таймер: ${liveText}`)], { 'data-testid': 'test-countdown' }),
]);
assert.equal(
  domSignatureContext.stableSignatureDomText(signatureInput('Сколько будет 2 + 2?', 'Решаю, 4 секунды')),
  domSignatureContext.stableSignatureDomText(signatureInput('Сколько будет 2 + 2?', 'Проверяю, 18 секунд')),
  'aria-live status changes must be absent from the page signature input',
);
assert.notEqual(
  domSignatureContext.stableSignatureDomText(signatureInput('Сколько будет 2 + 2?', 'Решаю, 4 секунды')),
  domSignatureContext.stableSignatureDomText(signatureInput('Сколько будет 3 + 3?', 'Решаю, 4 секунды')),
  'excluding live status must not collapse different question prompts',
);
const liveQuestionInput = (question, liveText) => element('body', [
  element('section', [
    element('h2', [textNode('Задание №3')]),
    element('p', [textNode(question)]),
    element('span', [textNode(liveText)], { role: 'status' }),
  ], { 'aria-live': 'polite' }),
]);
assert.equal(
  domSignatureContext.stableSignatureDomText(liveQuestionInput('Сколько будет 2 + 2?', 'Решаю')),
  domSignatureContext.stableSignatureDomText(liveQuestionInput('Сколько будет 2 + 2?', 'Проверяю')),
  'a question-bearing live wrapper must retain the prompt but omit its nested status',
);
assert.notEqual(
  domSignatureContext.stableSignatureDomText(liveQuestionInput('Сколько будет 2 + 2?', 'Решаю')),
  domSignatureContext.stableSignatureDomText(liveQuestionInput('Сколько будет 3 + 3?', 'Решаю')),
  'question changes inside a live wrapper must remain visible to the signature',
);

// E-03/E-19: the complete signature, not just the text normalizer, must bind
// every semantic form of a question and reject hidden volatility.
const signatureFor = (body) => {
  domSignatureContext.document.body = body;
  return domSignatureContext.pageSignature();
};
const unnumberedLivePrompt = (question) => element('body', [
  element('header', [textNode('Контрольная работа')]),
  element('div', [textNode(question)], { 'aria-live': 'polite' }),
  element('input', [], { type: 'text', 'aria-label': 'Ответ' }),
]);
assert.notEqual(
  signatureFor(unnumberedLivePrompt('Найдите x: x + 2 = 5')),
  signatureFor(unnumberedLivePrompt('Найдите x: 2x = 10')),
  'unnumbered prompts inside a live region must remain part of question identity',
);

const longShell = 'Статическая инструкция. '.repeat(260);
assert.notEqual(
  signatureFor(element('body', [textNode(longShell), element('p', [textNode('Найдите корень x + 2 = 5')])])),
  signatureFor(element('body', [textNode(longShell), element('p', [textNode('Найдите корень 2x = 10')])])),
  'question text after the former 4,000-character prefix must distinguish captures',
);

const imageQuestion = (src) => element('body', [
  element('p', [textNode('Введите ответ по рисунку')]),
  element('img', [], { src, alt: 'Рисунок к задаче' }),
  element('input', [], { type: 'text', 'aria-label': 'Ответ' }),
]);
assert.notEqual(
  signatureFor(imageQuestion('/media/question-a.png')),
  signatureFor(imageQuestion('/media/question-b.png')),
  'stable image resource identity must distinguish visually different questions',
);

const backgroundQuestion = (src) => element('body', [
  element('p', [textNode('Введите ответ по рисунку')]),
  element('div', [], {}, { style: { backgroundImage: `url("${src}")` } }),
  element('input', [], { type: 'text', 'aria-label': 'Ответ' }),
]);
assert.notEqual(
  signatureFor(backgroundQuestion('/media/background-a.png')),
  signatureFor(backgroundQuestion('/media/background-b.png')),
  'CSS background-image questions must participate in capture identity',
);

const canvasQuestion = (pixel) => element('body', [
  element('section', [
    element('p', [textNode('Введите ответ по рисунку')]),
    element('canvas', [], {}, {
      width: 320,
      height: 180,
      pixels: new Array(1024).fill(pixel),
    }),
    element('input', [], { type: 'text', 'aria-label': 'Ответ' }),
  ]),
]);
assert.notEqual(
  signatureFor(canvasQuestion(17)),
  signatureFor(canvasQuestion(23)),
  'same-sized canvas questions with different pixels must not share a capture signature',
);

const taintedCanvasQuestion = () => element('body', [
  element('section', [
    element('p', [textNode('Введите ответ по рисунку')]),
    element('canvas', [], {}, { width: 320, height: 180, tainted: true }),
    element('input', [], { type: 'text', 'aria-label': 'Ответ' }),
  ]),
]);
assert.equal(
  signatureFor(taintedCanvasQuestion()),
  '',
  'an unreadable question canvas must make capture fail closed, not collide by size',
);

const hiddenTickPage = (tick, options) => element('body', [
  element('p', [textNode('Найдите x: x + 2 = 5')]),
  element('div', [textNode(`background tick ${tick}`)], {}, options),
  element('input', [], { type: 'text', 'aria-label': 'Ответ' }),
]);
for (const [label, options] of [
  ['opacity', { style: { opacity: '0' } }],
  ['clipped', { style: { clipPath: 'inset(50%)' } }],
  ['offscreen', { style: { position: 'absolute' }, rect: { width: 20, height: 20, left: -2000, right: -1980, top: 0, bottom: 20 } }],
  ['zero geometry', { style: { position: 'absolute', overflow: 'hidden' }, rect: { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 } }],
]) {
  assert.equal(
    signatureFor(hiddenTickPage(1, options)),
    signatureFor(hiddenTickPage(2, options)),
    `${label} hidden volatility must not masquerade as page navigation`,
  );
}

const selectBranch = scraper.slice(
  scraper.indexOf("if (unit.type === 'select')"),
  scraper.indexOf('const options = unit.inputs', scraper.indexOf("if (unit.type === 'select')"))
);
assert.match(selectBranch, /if \(idxs\.length[\s\S]*?else return false;/,
  'a native select without a usable choice hint must skip every weak/ambiguous match');
assert.doesNotMatch(selectBranch, /else if \(!best \|\| best\.s < MATCH_MIN\) return false;/,
  'the ambiguous-above-floor fallthrough must not survive in the native-select branch');

const solveBody = worker.slice(worker.indexOf('async function solve('), worker.indexOf('async function solveTest('));
const historyPipeline = solveBody.slice(
  solveBody.indexOf('const preparedHistory = []'),
  solveBody.indexOf('const finalAttachments')
);
assert.doesNotMatch(historyPipeline, /Promise\.all\(history\.map/,
  'history image preprocessing must not decode several large bitmaps concurrently');
assert.ok(
  historyPipeline.indexOf('prepareFiles(m.files)') <
    historyPipeline.indexOf('transcribeAudioFiles(historyFiles)') &&
    historyPipeline.indexOf('transcribeAudioFiles(historyFiles)') <
    historyPipeline.indexOf('compressImageFiles(historyFiles)'),
  'history attachments must run prepare → transcribe → compress before final deduplication'
);

const solveTestBody = worker.slice(
  worker.indexOf('async function solveTest('),
  worker.indexOf('async function resolveOneQuestion(')
);
// The emptiness test and the throw are now two statements: the owner-only
// diagnostics recorder sits between them so that an empty completion — a
// provider failure worth inspecting — is still traced before it is rejected.
// The invariant is unchanged: nothing may treat an empty answer as a solve.
const emptyTest = "const empty = !answer || answer.trim() === '' || answer.trim() === EMPTY_ANSWER;";
const emptyThrow = 'if (empty) throw new Error';
assert.ok(solveTestBody.includes(emptyTest), 'solveTest must detect empty/sentinel provider answers');
assert.ok(solveTestBody.includes(emptyThrow), 'solveTest must reject empty/sentinel provider answers');
assert.ok(solveTestBody.indexOf(emptyThrow) < solveTestBody.indexOf("track('test_solve'"),
  'solveTest must reject an empty answer before recording successful solve telemetry');
// The trace must not itself claim the failed solve succeeded.
assert.ok(solveTestBody.includes('ok: !empty'),
  'the diagnostics trace must record an empty completion as a failure');

const resolveOneBody = worker.slice(
  worker.indexOf('async function resolveOneQuestion('),
  worker.indexOf('function normalizeParts(')
);
assert.ok(resolveOneBody.includes(emptyTest), 'single-question re-solve must detect empty/sentinel answers');
assert.ok(resolveOneBody.includes(emptyThrow), 'single-question re-solve must reject empty/sentinel answers');
assert.ok(resolveOneBody.indexOf(emptyThrow) < resolveOneBody.indexOf("track('test_requestion'"),
  'single-question re-solve must reject an empty answer before success telemetry');
assert.ok(resolveOneBody.includes('ok: !empty'),
  'the diagnostics trace must record an empty re-solve as a failure');

assert.match(dashboard,
  /port\.onDisconnect\.addListener\(\(\) => finish\([\s\S]*?Ответ оборван — соединение прервано[\s\S]*?\{ isError: true \}\)\);/,
  'a dashboard port disconnect must retain partial text while marking the turn retryable');
assert.match(dashboard,
  /const prior = replayableHistory\(chat\.history\);/,
  'a normal follow-up must filter failed turns and cap replay before budgeting');
assert.match(dashboard,
  /const priorHistory = replayableHistory\(h\.slice\(0, h\.length - 1\)\);/,
  'retry history must also filter failed turns and cap replay before budgeting');
assert.match(solveBody,
  /history = history\.filter\(\(message\) => message\?\.error !== true\)[\s\S]*?\.slice\(-MAX_HISTORY_MESSAGES\);/,
  'the service worker must defensively reject errored history from every caller');

const paginationLoop = popup.slice(
  popup.indexOf('async function solveAllPages()'),
  popup.indexOf('/* ---------- Tabs + init ---------- */')
);
assert.match(paginationLoop, /let partial = 0;[\s\S]*?let unrecognized = 0;/,
  'multi-page solving must track partial and unrecognized pages separately');
assert.match(paginationLoop,
  /const fillState = classifyAutopilotFill\(questions, fill\?\.summary\);/,
  'pagination must classify completion from the exact captured question set');
assert.ok(
  paginationLoop.indexOf("fillState === 'partial'") < paginationLoop.indexOf('solved++;'),
  'a partial page must stop before it is counted or abandoned by pagination'
);
assert.ok(
  paginationLoop.indexOf("fillState === 'unrecognized'") < paginationLoop.indexOf('solved++;'),
  'an unrecognized page must stop before pagination can leave it'
);
assert.match(popup, /renderPaginationSummary\(box, outcome, solved, partial, unrecognized\)/,
  'pagination warnings must receive both new counters');
assert.match(popup, /заполнены не полностью — проверь их вручную/,
  'the final summary must warn about partially filled pages');
assert.match(popup, /вопросы не распознаны — проверь их вручную/,
  'the final summary must warn about unrecognized pages');

// Exercise the real transcribeAudioFiles module. The network stub stands in for
// Groq Whisper; if the cache misses twice, the second call increments fetches.
const localStore = {
  groqApiKey: 'test-key',
  aiConsent: { accepted: true, version: 3, at: new Date().toISOString() }
};
const sessionStore = {};
const storageArea = (store) => ({
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.map((key) => [key, store[key]]));
  },
  async set(values) { Object.assign(store, values); },
  async remove(keys) {
    for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
  }
});
globalThis.chrome = {
  storage: {
    local: storageArea(localStore),
    session: storageArea(sessionStore)
  }
};

let whisperCalls = 0;
globalThis.fetch = async () => {
  whisperCalls++;
  return new Response(JSON.stringify({ text: 'Точный текст аудиозаписи' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};

const { transcribeAudioFiles } = await import('../src/lib/transcribe.js');
const audio = { name: 'listening.mp3', mimeType: 'audio/mpeg', dataBase64: 'U01FU0gtQVVESU8=' };
const firstTranscript = await transcribeAudioFiles([audio]);
const secondTranscript = await transcribeAudioFiles([audio]);
assert.equal(whisperCalls, 1, 'replaying identical audio must not invoke Whisper twice');
assert.equal(firstTranscript[0].mimeType, 'text/plain');
assert.deepEqual(secondTranscript, firstTranscript, 'a cache hit must rebuild the same transcript file');

const cache = localStore.smeshTranscriptCache;
assert.equal(Object.keys(cache).length, 1, 'one audio payload must occupy one SHA-256 cache slot');
assert.match(Object.keys(cache)[0], /^[a-f0-9]{64}$/,
  'the transcript cache key must be a SHA-256 hex digest');
assert.equal(cache[Object.keys(cache)[0]].text, 'Точный текст аудиозаписи');
assert.equal(typeof cache[Object.keys(cache)[0]].at, 'number');
assert.match(transcribeSource, /const TRANSCRIPT_CACHE_MAX = 8;/,
  'the trusted transcript cache must remain tightly bounded');
assert.match(transcribeSource, /crypto\.subtle\.digest\('SHA-256'/,
  'audio fingerprints must use SHA-256 over the base64 payload');
assert.match(transcribeSource, /storage\.local\.set\([\s\S]*?\?\.catch\(\(\) => \{\}\)/,
  'best-effort cache writes must absorb asynchronous storage rejection');
assert.doesNotMatch(transcribeSource, /storage\.session\.(?:get|set)\([^)]*TRANSCRIPT_CACHE_KEY/,
  'plaintext transcripts must never enter content-script-readable session storage');

const nonAudio = { name: 'task.txt', mimeType: 'text/plain', dataBase64: '0KLQtdC60YHRgg==' };
assert.equal((await transcribeAudioFiles([nonAudio]))[0], nonAudio,
  'non-audio files must pass through by identity');

const parallelAudio = [
  { ...audio, name: 'parallel-a.mp3', dataBase64: 'UEFSQUxMRUwtQQ==' },
  { ...audio, name: 'parallel-b.mp3', dataBase64: 'UEFSQUxMRUwtQg==' }
];
await Promise.all(parallelAudio.map((file) => transcribeAudioFiles([file])));
assert.equal(Object.keys(localStore.smeshTranscriptCache).length, 3,
  'parallel history preprocessing must preserve both cache read-modify-writes');
assert.equal(whisperCalls, 3);

// A synchronous storage write failure is non-fatal: successful transcription
// still replaces the audio, exactly as it did before caching existed.
const cacheFailureStore = {
  groqApiKey: 'test-key',
  aiConsent: { accepted: true, version: 3, at: new Date().toISOString() }
};
chrome.storage.local = {
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.map((key) => [key, cacheFailureStore[key]]));
  },
  set(values) {
    if (Object.hasOwn(values, 'smeshTranscriptCache')) {
      throw new Error('transcript cache unavailable');
    }
    Object.assign(cacheFailureStore, values);
    return Promise.resolve();
  }
};
const uncachedAudio = { ...audio, name: 'second.mp3', dataBase64: 'U01FU0gtQVVESU8tMg==' };
const withoutCache = await transcribeAudioFiles([uncachedAudio]);
assert.equal(withoutCache[0].mimeType, 'text/plain');
assert.equal(whisperCalls, 4, 'cache write failure must degrade to a normal Whisper call');

globalThis.fetch = async () => { whisperCalls++; throw new Error('Groq unavailable'); };
const failedAudio = { ...audio, name: 'failed.mp3', dataBase64: 'RkFJTEVELUFVRElP' };
assert.equal((await transcribeAudioFiles([failedAudio]))[0], failedAudio,
  'a failed transcription must keep the original audio file without throwing');

console.log('verified solver bugfix regressions passed');
