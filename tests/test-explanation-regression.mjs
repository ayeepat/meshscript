/**
 * The per-question «разбор» — one sentence of model reasoning per test answer,
 * folded away behind a chevron in the floating answer panel.
 *
 * It is one extra JSON field ("e") on a reply the model was already producing,
 * and that choice is the whole feature. The alternative — fetching the
 * explanation on demand when the student opens the panel — would re-capture the
 * page and re-solve the question, paying the expensive INPUT tokens (screenshot
 * + page text) again for text that costs a few dozen output tokens to carry
 * along the first time. So this file pins the three things that keep the field
 * cheap, correct and safe:
 *
 *  1. ORDER. "e" is written LAST, after "a". Generation is left-to-right, so a
 *     field after the answer cannot disturb the s→a anchoring that
 *     lib/test-answer-arithmetic.js exists to protect. Moving "e" before "a"
 *     would put prose between the arithmetic and the number it anchors, which
 *     is precisely the 2026-08-29 transcription bug.
 *  2. HONESTY. When the arithmetic checker OVERTURNS an answer, the model's
 *     sentence explains the number it wrote, not the corrected one on screen.
 *     That explanation is dropped rather than shown next to a value it
 *     contradicts. Same rule after a «перерешать».
 *  3. RESILIENCE. The prompt requires the field, while legacy cache entries or
 *     malformed model replies receive an honest fallback. The chevron remains
 *     usable before and after a per-question re-solve.
 *  4. CONTAINMENT. The sentence is model-controlled text rendered into the
 *     panel's innerHTML and sent back across the privileged message boundary,
 *     so it is escaped, length-capped by the parser, and named in the message
 *     schema — a question object the panel returns for filling must not be
 *     rejected merely because it carries its explanation.
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { reconcileAnswer } from '../src/lib/test-answer-arithmetic.js';
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from '../src/lib/prompts.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const worker = source('../src/background/service-worker.js');
const panel = source('../src/content/answer-panel.js');

function sourceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

/* ---------- 1. The prompt asks for "e" last, and briefly ---------- */
{
  const prompt = DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER];

  // THE ordering assertion. In the shape example and in the field spec alike,
  // the explanation must trail the answer.
  const shape = prompt.match(/\{"answers":\[\{[^\]]*\}\]\}/)?.[0];
  assert.ok(shape, 'the test prompt must still show the model an example object');
  assert.ok(shape.includes('"e":'), 'the example object must carry the explanation field');
  assert.ok(
    shape.indexOf('"s":') < shape.indexOf('"a":') &&
    shape.indexOf('"a":') < shape.indexOf('"e":'),
    'the example must keep the order s → a → e: "s" before "a" is the arithmetic ' +
    'anchor (lib/test-answer-arithmetic.js), and "e" after "a" is what keeps the ' +
    'explanation from disturbing it'
  );
  assert.ok(
    prompt.includes('ПОСЛЕ "a"'),
    'the "e" spec must state in words that it comes after the answer'
  );
  assert.ok(
    prompt.includes('ПЕРЕД "a"'),
    'adding "e" must not have disturbed the "s" ordering requirement'
  );

  // The word cap keeps expected output small. The parser cap below is a
  // rendering/message bound; neither assertion pretends to enforce billing.
  assert.match(
    prompt, /не длиннее \d+ слов/,
    'the explanation must carry an explicit length cap — an uncapped field is ' +
    'paid for on every question of every solve'
  );
  assert.ok(prompt.includes('Поле "e" ОБЯЗАТЕЛЬНО для КАЖДОГО'),
    'the prompt must require an explanation for every answer object');
  assert.ok(prompt.includes('Поля "n", "a" и "e" обязательны'),
    'the closing contract must not accidentally classify "e" as optional');
  assert.ok(!prompt.includes('необязательных "s", "c", "p" и "e"'),
    'the old contradictory optional-field wording must stay removed');

  // The panel's own guard against loose prose truncating the answers array is
  // still in place — "e" lives INSIDE the JSON, so this stays true.
  assert.ok(
    prompt.includes('не должно быть рассуждений'),
    'reasoning outside the JSON object must still be forbidden'
  );

  // The single-question re-solve writes its own JSON shape inline, so it has to
  // repeat both requirements itself.
  const resolveOne = sourceSection(
    worker, 'async function resolveOneQuestion(', 'function normalizeParts('
  );
  assert.ok(
    resolveOne.includes('"s":"…","a":"…","e":"…"'),
    '«перерешать» must ask for the same s → a → e order as the bulk solve'
  );
  assert.ok(resolveOne.includes('Поле "e" ОБЯЗАТЕЛЬНО'),
    '«перерешать» must require a fresh explanation too');
  assert.ok(
    resolveOne.includes('explain: match.explain'),
    '«перерешать» must return the fresh explanation, not leave the old one in place'
  );
}

/* ---------- 2. Parsing: carried, capped, and dropped when overturned ------- */

const parser = { reconcileAnswer, console };
vm.createContext(parser);
vm.runInContext(
  `${sourceSection(worker, 'function normalizeParts(p) {', 'const answerPanelContexts = new Map();')}
   this.parseTestAnswers = parseTestAnswers;
   this.serializeTestAnswers = serializeTestAnswers;
   this.MAX_EXPLANATION_CHARS = MAX_EXPLANATION_CHARS;`,
  parser
);
const { parseTestAnswers, serializeTestAnswers, MAX_EXPLANATION_CHARS } = parser;

{
  const [q] = parseTestAnswers(JSON.stringify({
    answers: [{ n: 1, s: '5+3*95', a: '290', e: 'Формула n-го члена: a₁+d(n-1).' }]
  }));
  assert.equal(q.answer, '290');
  assert.equal(q.explain, 'Формула n-го члена: a₁+d(n-1).',
    'a verified answer keeps the sentence that explains it');

  // A choice question with no arithmetic still gets its explanation.
  const [choice] = parseTestAnswers(JSON.stringify({
    answers: [{ n: 2, a: 'Пушкин', c: '2', e: 'Автор «Евгения Онегина».' }]
  }));
  assert.equal(choice.explain, 'Автор «Евгения Онегина».');
  assert.equal(choice.choice, '2', 'the fill hint is untouched by the new field');

  // The parser remains honest: it does not invent model reasoning. The panel
  // owns the user-facing fallback for missing/legacy values.
  assert.equal('explain' in parseTestAnswers('{"answers":[{"n":3,"a":"42"}]}')[0], false);
  assert.equal('explain' in parseTestAnswers('{"answers":[{"n":3,"a":"42","e":"   "}]}')[0], false,
    'whitespace is not an explanation');
}

{
  // THE honesty case. "s" says 290, the model wrote 287: the checker overturns
  // the answer, so the sentence that argued for 287 must not survive next to it.
  const [fixed] = parseTestAnswers(JSON.stringify({
    answers: [{ n: 1, s: '5+3*95', a: '287', e: 'Получается 287 по формуле.' }]
  }));
  assert.equal(fixed.answer, '290', 'the arithmetic checker still owns the answer');
  assert.equal('explain' in fixed, false,
    'an overturned answer must not keep the explanation written for the old value — ' +
    'a confident sentence about a number that is no longer on screen is worse ' +
    'than no sentence at all');
}

{
  // A model that ignores the word cap must not be able to push an essay onto a
  // panel line, or an unbounded string across the message boundary.
  const [long] = parseTestAnswers(JSON.stringify({
    answers: [{ n: 1, a: '42', e: 'я'.repeat(5000) }]
  }));
  assert.equal(long.explain.length, MAX_EXPLANATION_CHARS);
  assert.ok(MAX_EXPLANATION_CHARS <= 240, 'the panel line has no room for more than a sentence');
}

{
  // Cache round trip: a reopened test must fill the same answers AND show the
  // same explanations, so serialize → parse has to be the identity it claims.
  const questions = parseTestAnswers(JSON.stringify({
    answers: [
      { n: 1, a: '290', e: 'Арифметическая прогрессия.' },
      { n: 2, a: 'x=4; y=-6', p: [{ l: 'x', v: '4' }, { l: 'y', v: '-6' }], e: 'Метод подстановки.' },
      { n: 3, a: 'свободный ответ' },
    ]
  }));
  assert.deepEqual(
    parseTestAnswers(serializeTestAnswers(questions)),
    questions,
    'a page answered from the reuse cache must round-trip to identical questions, ' +
    'explanations included — otherwise reopening a solved test silently loses them'
  );
  assert.ok(
    serializeTestAnswers(questions).indexOf('"a":"290"') <
    serializeTestAnswers(questions).indexOf('"e":"Арифметическая прогрессия."'),
    'the rebuilt wire shape must keep "e" after "a" like the prompt orders it'
  );
}

/* ---------- 3. The privileged boundary accepts the field, bounded ---------- */
{
  const schema = {};
  vm.createContext(schema);
  vm.runInContext(
    `${sourceSection(worker, 'const MAX_TEXT_CHARS = 200 * 1024;', 'function validTestCapture(')}
     this.validQuestion = validQuestion;`,
    schema
  );
  const base = { index: 1, text: '', answer: '290' };

  // The panel hands whole question objects back for filling. If the schema did
  // not name `explain`, hasOnlyKeys would reject every question of every solved
  // page and «Заполнить» would stop working entirely.
  assert.equal(schema.validQuestion({ ...base, explain: 'Формула прогрессии.' }), true);
  assert.equal(schema.validQuestion(base), true);
  assert.equal(schema.validQuestion({ ...base, explain: 'x'.repeat(1024) }), true);
  assert.equal(schema.validQuestion({ ...base, explain: 'x'.repeat(1025) }), false,
    'the schema must bound the field it now accepts');
  assert.equal(schema.validQuestion({ ...base, explain: 42 }), false);
  assert.equal(schema.validQuestion({ ...base, reasoning: 'whole essay' }), false,
    'accepting "explain" must not have opened the object to arbitrary keys');
}

/* ---------- 4. A correction updates the cached explanation too ------------- */
{
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: store[key] }; },
        async set(data) { Object.assign(store, data); },
      },
    },
  };
  const { patchCachedTestAnswer, readCachedTestAnswers, writeCachedTestAnswers } =
    await import('../src/lib/test-answer-cache.js');
  const capture = {
    tabId: 7,
    url: 'https://uchebnik.mos.ru/exam/challenge/1',
    documentId: 'doc-0',
    signature: '0:sig',
    documents: [{ frameId: 0, signature: 'sig' }],
  };
  await writeCachedTestAnswers(capture, [
    { index: 1, text: '', answer: '287', explain: 'Старое пояснение.' },
    { index: 2, text: '', answer: 'Пушкин', explain: 'Другой вопрос.' },
  ]);

  await patchCachedTestAnswer(capture, 1, { answer: '290', explain: 'Новое пояснение.' });
  let cached = await readCachedTestAnswers(capture);
  assert.equal(cached.questions[0].explain, 'Новое пояснение.');
  assert.equal(cached.questions[1].explain, 'Другой вопрос.', 'other questions are untouched');

  // A re-solve that returned no sentence must clear the stored one rather than
  // leave it explaining the answer the student just replaced.
  await patchCachedTestAnswer(capture, 1, { answer: '291' });
  cached = await readCachedTestAnswers(capture);
  assert.equal('explain' in cached.questions[0], false,
    'a correction with no fresh explanation must drop the stale one');
  assert.equal(cached.questions[0].answer, '291');
}

/* ---------- 5. The panel: escaped, stable across legacy and re-solve ------- */
{
  const render = { console };
  vm.createContext(render);
  vm.runInContext(
    `const LONG_THINKING_NOTICE = 'thinking';
     const MISSING_EXPLANATION = 'Пояснение для этого ответа не получено.';
     ${sourceSection(panel, '  function escapeHtml(s) {', '  function isPanelCurrent(')}
     this.questionLine = questionLine;
     this.explanationText = explanationText;`,
    render
  );

  // Model-controlled text lands in the panel's innerHTML. It is escaped at the
  // same boundary as the answer text; an unescaped one would be script
  // injection into the extension's own closed shadow root.
  const line = render.questionLine(
    { index: 1, text: '', answer: '290', explain: '<img src=x onerror=alert(1)>' }, 0
  );
  assert.ok(!line.includes('<img'), 'the explanation must be escaped before it reaches innerHTML');
  assert.ok(line.includes('&lt;img'), 'and escaped, not dropped');

  const legacyLine = render.questionLine({ index: 2, answer: '42' }, 1);
  assert.ok(legacyLine.includes('Пояснение для этого ответа не получено.'),
    'old cache entries without "e" must expand to an honest fallback, not an empty panel');
  assert.equal(render.explanationText({ explain: { unexpected: true } }),
    'Пояснение для этого ответа не получено.',
    'malformed persisted values must not crash question rendering');

  // Collapsed by default; once opened, every question has either real reasoning
  // or the explicit fallback above.
  assert.match(panel, /\.why \{\s*display: none;/,
    'explanations must be folded away until the chevron is pressed');
  assert.match(panel, /\.panel\.explain \.why \{ display: block; \}/,
    'an expanded panel must reveal every question-by-question row');
  assert.match(panel, /let state = \{ x: null, y: null, minimized: false, explain: false \};/,
    'the panel opens with the answers, not the reasoning');

  // The chevron follows question availability, not the first response's shape.
  // This keeps it present when old cached data is replaced by a fresh re-solve.
  assert.ok(!panel.includes('const hasExplanations ='),
    'a one-time explanation snapshot would make the toggle stale after re-solve');
  assert.match(panel, /\$\{questions\.length[\s\S]{0,80}?btn-why/,
    'every non-empty answer panel must expose its stable explanation control');
  assert.match(panel, /state\.explain = !state\.explain;[\s\S]*?saveState\(\);/,
    'the chevron must persist its state like the other panel controls');

  // The toggle is presentation only: no message, no token, no capture round
  // trip. If it ever grows one, it stops being free and this test should fail.
  const whyHandler = sourceSection(panel, "const whyBtn = panel.querySelector('.btn-why');", 'toggleBtn.addEventListener');
  for (const forbidden of ['sendMsg', 'requestFill', 'chrome.runtime']) {
    assert.ok(
      !whyHandler.includes(forbidden),
      `expanding the «разбор» must not call ${forbidden} — the sentences already ` +
      'arrived with the answers, which is the entire reason the field is cheap'
    );
  }

  assert.ok(panel.includes('whyEl.textContent = explanationText(nextQuestion);'),
    'per-question re-solve must update the visible row through the same fallback policy');
  assert.match(panel, /width: min\(\$\{DEFAULT_W\}px, calc\(100vw - 24px\)\);/,
    'the fixed panel must fit narrow viewports');
  assert.ok(panel.includes('innerWidth - panelWidth'),
    'saved drag coordinates must be clamped by the panel\'s real responsive width');
  assert.match(panel, /@media \(pointer: coarse\)[\s\S]*?min-width: 44px; min-height: 44px;/,
    'touch devices need 44px controls even though desktop controls stay compact');
}

console.log('test explanation regression passed');
