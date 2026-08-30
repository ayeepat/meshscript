/**
 * Where the reasoning-to-answer transcription bug CAN happen, and where it
 * structurally cannot.
 *
 * The 2026-08-29/30 bug (see lib/test-answer-arithmetic.js) needed BOTH of:
 *   (a) the model reasons in a private channel the user never sees — true on
 *       every path, since createSseSink drops reasoning deltas everywhere; and
 *   (b) the VISIBLE output has no room for the derivation, so the model must
 *       recall its results from far away and gets one wrong.
 *
 * Condition (b) is the one that varies, and it is created by exactly one thing:
 * constraining the reply to answers only. So this file pins the shape of the
 * whole surface:
 *
 *   solveTest()          json_object, answers-only  → AT RISK → has "s" + checker
 *   resolveOneQuestion() json_object, answers-only  → AT RISK → has "s" + checker
 *   solve()              free prose, steps required → NOT at risk
 *
 * solve() is the homework path — PDFs, photos, text, follow-ups. It is safe
 * because the worked steps ARE the visible answer: the model derives in place
 * instead of recalling. That safety is a property of the PROMPT and the absence
 * of a response-format constraint, and both are easy to "optimise" away later
 * ("make homework answers shorter", "return JSON so we can parse the answer").
 * Either change would silently recreate the bug on PDFs, where it is far harder
 * to notice than on a test page. Hence these assertions.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const worker = source('../src/background/service-worker.js');

/* ---------- 1. The complete set of model call sites ---------- */

// askAI is the single dispatcher every chat-facing call goes through (ai.js),
// so counting its call sites bounds the entire surface. A new one must be
// classified here deliberately rather than inheriting whatever it happens to do.
const callSites = [...worker.matchAll(/await askAI\(/g)];
assert.equal(
  callSites.length, 3,
  'a new askAI() call site appeared in the worker — decide whether it constrains ' +
  'the visible answer, and if so give it the "s" field + lib/test-answer-arithmetic.js'
);

/* ---------- 2. The two constrained paths are the test paths ---------- */

function bodyOf(startMarker, endMarker) {
  const start = worker.indexOf(startMarker);
  const end = worker.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `could not slice ${startMarker}`);
  return worker.slice(start, end);
}

const solveTestBody = bodyOf('async function solveTest(', 'async function resolveOneQuestion(');
const resolveOneBody = bodyOf('async function resolveOneQuestion(', 'function normalizeParts(');
const solveBody = bodyOf('async function solve(\n', 'async function solveTest(');

for (const [name, body] of [['solveTest', solveTestBody], ['resolveOneQuestion', resolveOneBody]]) {
  assert.ok(body.includes("responseFormat: 'json_object'"), `${name} must still be the JSON path`);
}
// Both are answers-only, so both must carry the mitigation — but they get it
// differently: solveTest relies on the shared TEST_ANSWER prompt (whose "s"
// spec is pinned in section 5), while resolveOneQuestion writes its own
// single-question JSON shape inline and has to repeat the requirement.
assert.ok(
  solveTestBody.includes('DEFAULT_PROMPTS[PROMPT_CATEGORIES.TEST_ANSWER]'),
  'solveTest must keep using the shared TEST_ANSWER prompt, which is what carries "s"'
);
assert.ok(
  resolveOneBody.includes('"s":"…"') && resolveOneBody.includes('ПЕРЕД "a"'),
  'resolveOneQuestion writes its own JSON shape, so it must ask for "s" before "a" itself'
);
assert.ok(
  worker.includes("import { reconcileAnswer } from '../lib/test-answer-arithmetic.js';"),
  'the worker must import the answer checker'
);

/* ---------- 3. The homework path must stay unconstrained ---------- */

// THE load-bearing assertion. Adding a response format here would put homework
// and PDF answers in exactly the state that produced 287-instead-of-290, with
// no test page to notice it on.
assert.ok(
  !solveBody.includes('responseFormat'),
  'solve() must NOT constrain its output format — the worked steps are the answer. ' +
  'If you need structured homework output, add an "s"-style checked field FIRST ' +
  '(see lib/test-answer-arithmetic.js) instead of just switching on json_object.'
);
// The same reason the free-form path is safe: nothing parses a short answer out
// of it, so there is no second representation to drift from.
assert.ok(
  !solveBody.includes('parseTestAnswers'),
  'solve() must not extract structured answers from prose'
);

/* ---------- 4. Both answer modes must keep the working VISIBLE ---------- */

{
  const router = source('../src/lib/subject-router.js');
  const modes = router.slice(
    router.indexOf('const MODE_INSTRUCTIONS'),
    router.indexOf('export async function buildSystemPrompt')
  );
  assert.ok(modes.length > 0, 'could not find the answer-mode instructions');

  // «кратко» is the risky one: it is the DEFAULT mode, and "brief" is a natural
  // thing to tighten into "answer only". It must keep asking for the steps.
  assert.ok(
    modes.includes('пошаговый ход'),
    'the brief mode must still require the step-by-step working in the visible answer — ' +
    'without it, a PDF of maths problems becomes the same recall-from-memory task ' +
    'that produced the test-answer bug'
  );
  assert.ok(
    modes.includes('подробно объясни'),
    'the explain mode must still require a full explanation'
  );
  for (const forbidden of ['только ответ', 'без решения', 'без шагов']) {
    assert.ok(
      !modes.includes(forbidden),
      `an answer mode must never demand "${forbidden}" — that recreates the transcription bug`
    );
  }
}

/* ---------- 5. Only the test prompt may forbid visible reasoning ---------- */

{
  const prompts = source('../src/lib/prompts.js');
  const testPrompt = prompts.slice(prompts.indexOf('[PROMPT_CATEGORIES.TEST_ANSWER]'));
  // The test prompt DOES forbid visible reasoning — that is inherent to filling
  // a form — which is precisely why it, and only it, needs the "s" field.
  assert.ok(
    testPrompt.includes('не должно быть рассуждений'),
    'the test prompt is expected to forbid visible reasoning'
  );
  assert.ok(
    testPrompt.includes('ПЕРЕД "a"'),
    'the test prompt must keep requiring "s" before "a" — the ordering IS the fix'
  );

  // The worked-solution prompt (maths, physics, chemistry — the homework that
  // would be most damaged by a silent transcription slip) must keep demanding
  // the visible derivation.
  const worked = prompts.slice(
    prompts.indexOf('[PROMPT_CATEGORIES.WORKED_SOLUTION]'),
    prompts.indexOf('[PROMPT_CATEGORIES.DIRECT_ANSWER]')
  );
  assert.ok(
    worked.includes('пошаговым решением'),
    'the worked-solution prompt must keep requiring step-by-step work in the answer'
  );
}

console.log('answer-transcription-surface-regression: ok');
