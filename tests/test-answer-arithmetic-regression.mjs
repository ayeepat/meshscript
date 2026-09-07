/**
 * The reasoning-to-answer transcription bug, pinned.
 *
 * OBSERVED 2026-08-29 on a live МЭШ arithmetic-progression test. The model's
 * private reasoning ended with a correct per-question summary and the JSON it
 * emitted immediately afterwards disagreed with it on half the questions:
 *
 *   reasoning  a96 = 5 + 3*95      = 290      JSON said 287
 *   reasoning  a103 = 8 + 1.6*102  = 171.2    JSON said 164
 *   reasoning  a112 = 5 - 0.75*111 = -78.25   JSON said -73
 *   reasoning  a5 = 6 - 1.25*4     = 1        JSON said -1.25
 *
 * The model was right and its transcription was wrong, because the prompt gave
 * it nowhere to write the arithmetic in the VISIBLE output — it had to recall
 * eight results from a long thinking block in one constrained JSON pass.
 *
 * The fix is prompt ("s" holds the arithmetic, written before "a") plus this
 * checker (re-compute "s"; when it disagrees with "a", trust the arithmetic).
 * This file pins the real capture above, and — more importantly — pins that the
 * checker CANNOT damage a correct answer: it may only ever replace a bare
 * number with the value of the model's own expression.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const {
  evaluateArithmetic, evaluateRelation, parseNumericAnswer, parseRelationAnswer,
  rationalsEqual, reconcileAnswer,
} = await import('../src/lib/test-answer-arithmetic.js');

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** Exact value as "n/d", so a test failure prints something readable. */
const exact = (expression) => {
  const value = evaluateArithmetic(expression);
  return value === null ? null : `${value.n}/${value.d}`;
};

/* ---------- 1. The evaluator is EXACT, not floating point ---------- */

for (const [expression, expected] of [
  ['5+3*95', '290/1'],
  ['3+6*2', '15/1'],
  ['3-2*5', '-7/1'],
  ['10-2*99', '-188/1'],
  ['(3+4)*(3+4)', '49/1'],
  ['-5+10', '5/1'],
  ['12/4', '3/1'],
  ['2*(3+(4-1))', '12/1'],
  ['5-0.75*111', '-313/4'],
  ['6-1.25*4', '1/1'],
  // The two that doubles get wrong. 8+1.6*102 is 171.2 exactly here — there is
  // no 171.20000000000002 left to round away — and 0.1+0.2 is exactly 0.3.
  ['8+1.6*102', '856/5'],
  ['0.1+0.2', '3/10'],
  // ROUND 2: the question-8 shape. A fraction in the expression must stay a
  // fraction all the way through, not collapse to -17.857142857…
  ['15+46*(-5/7)', '-125/7'],
  ['15+(-5/7)*46', '-125/7'],
]) {
  assert.equal(exact(expression), expected, `bad value for ${expression}`);
}

// The characters a model actually emits: unicode minus, both multiplication
// signs, the division sign, Russian decimal comma and colon-division, spaces.
assert.equal(exact('5 + 3 × 95'), '290/1');
assert.equal(exact('5 − 0,75 · 111'), '-313/4');
assert.equal(exact('12 ÷ 4'), '3/1');
assert.equal(exact('15 : 3'), '5/1');

// Size cap: a crafted expression must not grow a BigInt without bound inside
// the service worker. 122 characters, so it is the MAGNITUDE cap doing the work
// here and not the length cap.
{
  const huge = ['9'.repeat(40), '9'.repeat(40), '9'.repeat(40)].join('*');
  assert.ok(huge.length < 200, 'this case must be rejected on size, not on length');
  assert.equal(evaluateArithmetic(huge), null, 'an oversized product must be refused');
  // …while an ordinary large-ish product still computes.
  assert.equal(exact('99999999*99999999'), '9999999800000001/1');
}

// Anything that is not pure arithmetic must be REFUSED, not guessed at. A
// checker that interprets half an expression is worse than no checker.
for (const rejected of [
  '', null, undefined, 'a1 + d*95', '5 + 3*95 = 290', '290 см', '3^2', 'x=4',
  '5 +', '(5+3', '5+3)', '1/0', '5 + + ', 'Math.max(1,2)', 'alert(1)',
  '1e400', '99'.repeat(200),
]) {
  assert.equal(evaluateArithmetic(rejected), null, `should have refused: ${rejected}`);
}

// Division by zero anywhere in the expression, not just at the top level.
assert.equal(evaluateArithmetic('5+(3/0)'), null);

/* ---------- 2. Numeric-answer detection guards every text answer ---------- */

const answerOf = (text) => {
  const parsed = parseNumericAnswer(text);
  return parsed === null
    ? null
    : `${parsed.value.n}/${parsed.value.d} ${parsed.shape}${parsed.suffix ? ` +${parsed.suffix}` : ''}`;
};

for (const [text, expected] of [
  ['290', '290/1 decimal'],
  ['-78.25', '-313/4 decimal'],
  ['−78.25', '-313/4 decimal'],
  ['+5', '5/1 decimal'],
  [' 15 ', '15/1 decimal'],
  // ROUND 2: a fraction answer is numeric too. Not recognising this is exactly
  // why question 8's "-155/7" sailed through unchecked.
  ['-125/7', '-125/7 fraction'],
  ['3/4', '3/4 fraction'],
  ['-250/14', '-125/7 fraction'],
  // A unit rides along untouched, so a repair keeps it: replacing "287 см"
  // with a bare "290" would drop part of what the question asked for.
  ['290 см', '290/1 decimal + см'],
  ['45°', '45/1 decimal +°'],
  ['12%', '12/1 decimal +%'],
  ['-3/4 кг', '-3/4 fraction + кг'],
]) {
  assert.equal(answerOf(text), expected, `bad numeric answer for ${text}`);
}

// The suffix rule is deliberately digit-free and short, so a multi-value or
// multi-select answer can never pose as "a number with a unit".
for (const notNumeric of [
  '', 'крахмал', 'x=4', '4; -6', 'не видно, прокрутите', '2 или 3',
  '1/0', '10:30', 'а) верно', '2 и 3', '5 или 6', 'около 290',
]) {
  assert.equal(parseNumericAnswer(notNumeric), null, `should not be numeric: ${notNumeric}`);
}

// A COMMA IN AN ANSWER IS NOT A DECIMAL POINT. "2,3" is the multi-select answer
// «варианты 2 и 3» far more often than the number 2.3, and an earlier draft of
// this checker read it as a number and rewrote a correct choice answer to "2".
// Refusing commas costs the repair of comma-formatted decimals and buys the
// guarantee that a choice answer can never be mangled. Inside the "s"
// EXPRESSION a comma is unambiguous and still means a decimal point.
for (const commaAnswer of ['2,3', '1,3', '171,2', '-25,8']) {
  assert.equal(parseNumericAnswer(commaAnswer), null,
    `a comma answer must not be read as a number: ${commaAnswer}`);
}
assert.equal(exact('8+1,6*102'), '856/5',
  'a comma inside an expression is still a decimal point');
// Same story for the colon: division in an expression, a time in an answer.
assert.equal(parseNumericAnswer('10:30'), null, 'a colon answer must not become a fraction');

/* ---------- 3. Equal values are equal regardless of how they are written --- */

assert.ok(
  rationalsEqual(parseNumericAnswer('-250/14').value, evaluateArithmetic('15+46*(-5/7)')),
  'an unreduced fraction must compare equal to the same exact value'
);

/* ---------- 4. Both real captures are repaired ---------- */

for (const [work, wrong, right] of [
  // 2026-08-29, round 1.
  ['5+3*95', '287', '290'],
  ['8+1.6*102', '164', '171.2'],
  ['5-0.75*111', '-73', '-78.25'],
  ['6-1.25*4', '-1.25', '1'],
  // 2026-08-30, round 2 — the fraction the first version could not see. The
  // repair MUST stay a fraction: "-17.857142857…" is a different wrong answer.
  ['15+(-5/7)*46', '-155/7', '-125/7'],
  ['15+46*(-5/7)', '-155/7', '-125/7'],
]) {
  const result = reconcileAnswer(wrong, work);
  assert.equal(result.answer, right, `${work} should have corrected ${wrong} to ${right}`);
  assert.equal(result.status, 'fixed', 'a repaired answer must report status "fixed"');
  assert.equal(result.from, wrong);
  assert.equal(result.to, right);
  assert.equal(result.work, work);
}

// The four the model got right must pass through byte-identical, with no
// correction reported — a checker that "fixes" correct answers is a new bug.
for (const [work, answer] of [
  ['3+6*2', '15'], ['3-2*5', '-7'], ['10-2*99', '-188'], ['11-0.4*92', '-25.8'],
]) {
  const result = reconcileAnswer(answer, work);
  assert.equal(result.answer, answer, `${answer} must survive untouched`);
  assert.equal(result.status, 'verified', `${answer} must be reported as verified`);
}

/* ---------- 5. It must never damage an answer ---------- */

// No "s" at all — every legacy reply, and every non-computed question. The
// answer is untouched and honestly reported as unchecked rather than passing
// for verified.
for (const [answer, work] of [['290', undefined], ['крахмал', ''], ['290', null]]) {
  const result = reconcileAnswer(answer, work);
  assert.equal(result.answer, answer);
  assert.equal(result.status, 'unchecked');
  assert.ok(result.reason, 'an unchecked answer must say why');
}

// A text answer is never overwritten, however cleanly "s" evaluates. This is
// the guard that keeps a stray expression from destroying a choice answer.
// ("290 см" is NOT in this list: a number with a unit is checkable, and is
// covered by the unit-suffix cases above.)
for (const textAnswer of [
  'крахмал', 'x=4; y=-6', 'не видно, прокрутите', '2,3', 'а) верно', '10:30',
  '2 и 3', 'около 290',
]) {
  const result = reconcileAnswer(textAnswer, '1+1');
  assert.equal(result.answer, textAnswer, `text answer was overwritten: ${textAnswer}`);
  assert.equal(result.status, 'unchecked');
}

// An unusable "s" leaves the model's own answer alone rather than blanking it.
for (const badWork of ['a1+d*95', '5+3*95=290', '3^2', '1/0', 'скорость*время']) {
  const result = reconcileAnswer('287', badWork);
  assert.equal(result.answer, '287', `answer was damaged by unusable s: ${badWork}`);
  assert.equal(result.status, 'unchecked');
}

// Exact arithmetic means there is no float dust to mistake for a disagreement.
assert.equal(reconcileAnswer('171.2', '8+1.6*102').status, 'verified',
  'an exactly-correct decimal must not be "corrected"');
assert.equal(reconcileAnswer('0.3', '0.1+0.2').status, 'verified');
// Nor is a differently-written but equal value a disagreement.
assert.equal(reconcileAnswer('-250/14', '15+46*(-5/7)').status, 'verified',
  'an unreduced but correct fraction must be left alone');

// A comma-formatted answer is left alone entirely — see the numeric-answer
// section above for why guessing at it is not worth the repair.
assert.equal(reconcileAnswer('164,0', '8+1.6*102').answer, '164,0');
assert.equal(reconcileAnswer('164,0', '8+1.6*102').status, 'unchecked');
assert.equal(reconcileAnswer('164.0', '8+1.6*102').answer, '171.2');

// The question can request rounding; the checker has no precision contract.
// Preserve plausible rounded values (including ties, signs and units) without
// claiming that they were verified against the question.
for (const [answer, work] of [
  ['0.33', '1/8+1/5'], ['-0.33', '-(1/8+1/5)'],
  ['0.33 кг', '1/8+1/5'], ['2', '5/2'], ['-2', '-7/4'],
  ['0.00', '1/1000'], ['1.20', '1.204'], ['-0.00', '-1/1000'],
]) {
  const result = reconcileAnswer(answer, work);
  assert.equal(result.answer, answer, `must preserve potentially rounded ${answer}`);
  assert.equal(result.status, 'unchecked');
}
assert.equal(reconcileAnswer('0.34', '1/8+1/5').answer, '0.325',
  'an answer that is not a rounded result must still be corrected');

// A multi-select answer is the case that made the comma rule necessary: it must
// survive even when "s" evaluates to something else entirely.
assert.equal(reconcileAnswer('2,3', '1+1').answer, '2,3');
assert.equal(reconcileAnswer('2,3', '1+1').status, 'unchecked');

// A DECIMAL answer whose true value repeats forever cannot be written back
// faithfully, so it is left alone rather than rounded to a guessed precision.
// (The same value in a FRACTION-shaped answer is repaired — that is question 8.)
{
  const repeating = reconcileAnswer('-17.86', '15+46*(-5/7)');
  assert.equal(repeating.answer, '-17.86',
    'a repeating decimal must not be rounded to an invented precision');
  assert.equal(repeating.status, 'unchecked');
}
assert.equal(reconcileAnswer('-155/7', '15+46*(-5/7)').answer, '-125/7');

// A fraction that reduces to a whole number is written as that whole number,
// not as "290/1".
assert.equal(reconcileAnswer('287/1', '5+3*95').answer, '290');

/* ---------- 5b. Comparisons — «поставьте знак» ---------- */

// The other big family of mechanically checkable answers, and it fails the same
// way: the model compares correctly and writes the opposite sign.
{
  // The sign lives in "a", the comparison in "s".
  assert.equal(reconcileAnswer('<', '105/7<230/7').status, 'verified');
  assert.equal(reconcileAnswer('>', '105/7<230/7').answer, '<', 'a false sign must be flipped');
  assert.equal(reconcileAnswer('>', '105/7<230/7').status, 'fixed');
  assert.equal(reconcileAnswer('=', '3/7<0.5').answer, '<');
  assert.equal(reconcileAnswer('<', '2/4=0.5').answer, '=');
  assert.equal(reconcileAnswer('>', '0.5=1/2').answer, '=');

  // Unicode and ASCII spellings are the same relation.
  for (const sign of ['≤', '<=', '⩽']) {
    assert.equal(parseRelationAnswer(sign), 'le', `unrecognised relation: ${sign}`);
  }
  for (const sign of ['≥', '>=', '⩾']) assert.equal(parseRelationAnswer(sign), 'ge');
  for (const sign of ['≠', '!=', '<>']) assert.equal(parseRelationAnswer(sign), 'ne');

  // A SATISFIED-but-not-strict claim is left alone. "≤" is true when the values
  // are strictly less, and rewriting it to "<" would second-guess what the
  // question asked for. This checker only overturns FALSE statements.
  assert.equal(reconcileAnswer('≤', '3<5').status, 'verified');
  assert.equal(reconcileAnswer('≥', '3<5').answer, '<', 'a false ≥ must still be corrected');
  assert.equal(reconcileAnswer('≠', '3<5').status, 'verified');
  assert.equal(reconcileAnswer('≠', '5=5').answer, '=');

  // A full statement written into "a" checks itself, with no "s" needed.
  assert.equal(reconcileAnswer('105/7 > 230/7', undefined).answer, '105/7 < 230/7');
  assert.equal(reconcileAnswer('105/7 < 230/7', undefined).status, 'verified');

  // Relations are tried BEFORE arithmetic, so an "=" answer is never mistaken
  // for a number.
  assert.equal(reconcileAnswer('x=4', '1+1').status, 'unchecked');

  // Nothing to compare against leaves the sign alone, honestly reported.
  const noWork = reconcileAnswer('<', undefined);
  assert.equal(noWork.answer, '<');
  assert.equal(noWork.status, 'unchecked');
  assert.equal(reconcileAnswer('<', '2+2').status, 'unchecked',
    'a plain expression cannot verify a comparison sign');

  assert.equal(evaluateRelation('5>3').actual, 'gt');
  assert.equal(evaluateRelation('нет'), null);
}

/* ---------- 6. Never eval() ---------- */

// The expression comes from a model, which means anything that can influence
// the model can put a string here. It is parsed, never executed.
{
  const checker = source('../src/lib/test-answer-arithmetic.js');
  for (const forbidden of ['eval(', 'new Function', 'Function(']) {
    assert.ok(!checker.includes(forbidden),
      `test-answer-arithmetic.js must not use ${forbidden} on model-supplied text`);
  }
}

/* ---------- 7. The prompt half is still in place ---------- */

{
  const prompts = source('../src/lib/prompts.js');
  assert.ok(prompts.includes('"s"'), 'the TEST_ANSWER prompt must still ask for "s"');
  // Order is the whole mechanism: generation is left-to-right, so the answer
  // must be written immediately AFTER its arithmetic, not before it.
  assert.ok(
    prompts.indexOf('{"answers":[{"n":1,"s":') >= 0,
    'the prompt example must put "s" before "a"'
  );
  assert.ok(
    prompts.includes('ПЕРЕД "a"'),
    'the prompt must state that "s" comes before "a"'
  );

  // The worker must actually route answers through the checker, and the
  // salvage regex must tolerate the "s" now sitting between "n" and "a" —
  // otherwise truncated replies silently stop being rescued.
  const worker = source('../src/background/service-worker.js');
  assert.ok(worker.includes("import { reconcileAnswer } from '../lib/test-answer-arithmetic.js';"),
    'the worker must import the arithmetic checker');
  assert.ok(worker.includes('reconcileAnswer(stated, s)'),
    'parseTestAnswers must reconcile every answer it builds');
  assert.ok(worker.includes('"s"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*,\\s*)?"a"'),
    'the salvage regex must skip an optional "s" between "n" and "a"');
}

/* ---------- 8. End to end: the real reply, through the real parser ---------- */

// The unit tests above prove the checker. This proves the WIRING: the exact
// JSON the model emitted on 2026-08-29, pushed through the worker's own
// parseTestAnswers, must come out with the answers its reasoning had.
{
  const worker = source('../src/background/service-worker.js');
  const start = worker.indexOf('function normalizeParts(p)');
  const end = worker.indexOf('function serializeTestAnswers(');
  assert.ok(start >= 0 && end > start, 'could not slice parseTestAnswers out of the worker');

  const context = { reconcileAnswer };
  vm.createContext(context);
  vm.runInContext(
    `${worker.slice(start, end)}\nvar __parse = parseTestAnswers;`,
    context
  );

  const roundedReply = context.__parse('{"answers":[{"n":1,"s":"1/8+1/5","a":"0.33"}]}');
  assert.equal(roundedReply[0].answer, '0.33', 'rounding must survive the actual answer parser');

  // Verbatim from the capture, with the "s" the prompt now requires. The "a"
  // values are the wrong ones the model actually produced.
  const reply = JSON.stringify({
    answers: [
      { n: 1, s: '5+3*95', a: '287' },
      { n: 2, s: '3+6*2', a: '15' },
      { n: 3, s: '3-2*5', a: '-7' },
      { n: 4, s: '10-2*99', a: '-188' },
      { n: 5, s: '8+1.6*102', a: '164' },
      { n: 6, s: '11-0.4*92', a: '-25.8' },
      { n: 7, s: '5-0.75*111', a: '-73' },
      { n: 8, s: '6-1.25*4', a: '-1.25' },
    ],
  });

  const checks = [];
  // Array.from, not .map: the sandbox returns arrays from its own realm and
  // deepStrictEqual compares prototypes.
  const questions = context.__parse(reply, { onCheck: (c) => checks.push(c) });
  const corrections = checks.filter((check) => check.status === 'fixed');
  assert.deepEqual(
    Array.from(questions, (q) => q.answer),
    ['290', '15', '-7', '-188', '171.2', '-25.8', '-78.25', '1'],
    'the parsed answers must match the model’s own reasoning, not its typos'
  );
  assert.equal(corrections.length, 4, 'exactly the four wrong answers must be reported');
  assert.deepEqual(corrections.map((c) => c.index), [1, 5, 7, 8]);

  // "s" is scaffolding for generation — no consumer (panel, autofill, cache)
  // should ever see it on a question object.
  for (const question of questions) {
    assert.ok(!('s' in question), '"s" must not leak onto parsed questions');
    assert.deepEqual(Object.keys(question).sort(), ['answer', 'index', 'text']);
  }

  // ROUND 2, verbatim from the 2026-08-30 capture. Seven answers were right and
  // question 8 was the fraction slip. The seven must pass through untouched and
  // the eighth must come back as the fraction the reasoning derived.
  const roundTwo = '{"answers":[{"n":1,"s":"1+2*5","a":"11"},{"n":2,"s":"1+9*1","a":"10"},'
    + '{"n":3,"s":"5+(-6)*3","a":"-13"},{"n":4,"s":"9+(-2)*62","a":"-115"},'
    + '{"n":5,"s":"3+2.4*1","a":"5.4"},{"n":6,"s":"11+(-2.5)*80","a":"-189"},'
    + '{"n":7,"s":"5+(-3/4)*4","a":"2"},{"n":8,"s":"15+(-5/7)*46","a":"-155/7"}]}';
  const roundTwoChecks = [];
  const roundTwoQuestions = context.__parse(roundTwo, {
    onCheck: (c) => roundTwoChecks.push(c),
  });
  const roundTwoFixes = roundTwoChecks.filter((check) => check.status === 'fixed');
  assert.deepEqual(
    Array.from(roundTwoQuestions, (q) => q.answer),
    ['11', '10', '-13', '-115', '5.4', '-189', '2', '-125/7'],
    'question 8 must be repaired to the fraction, and the other seven left alone'
  );
  assert.equal(roundTwoFixes.length, 1, 'exactly one correction in the round-2 capture');
  assert.deepEqual(
    { ...roundTwoFixes[0] },
    { index: 8, status: 'fixed', from: '-155/7', to: '-125/7', work: '15+(-5/7)*46' }
  );
  // Every answer is accounted for, so "no corrections" can never be confused
  // with "nothing was checkable".
  assert.equal(roundTwoChecks.length, 8, 'every answer must report a status');
  assert.equal(
    roundTwoChecks.filter((check) => check.status === 'verified').length, 7,
    'the seven correct answers must be reported as verified, not merely untouched'
  );

  // A legacy reply with no "s" at all still parses exactly as before.
  const legacy = context.__parse('{"answers":[{"n":1,"a":"287"}]}');
  assert.deepEqual(
    JSON.parse(JSON.stringify(legacy)),
    [{ index: 1, text: '', answer: '287' }]
  );

  // The salvage tier: a reply truncated mid-array must still be rescued now
  // that "s" sits between "n" and "a", and must still be corrected.
  const truncated = '{"answers":[{"n":"1","s":"5+3*95","a":"287"},{"n":"2","s":"3+6*2","a":"15"';
  const salvaged = context.__parse(truncated);
  assert.deepEqual(Array.from(salvaged, (q) => q.answer), ['290', '15'],
    'the salvage regex must skip "s" and still reconcile');
}

console.log('test-answer-arithmetic-regression: ok');
