/**
 * Arithmetic reconciliation for test answers.
 *
 * ┌─ WHAT WENT WRONG (2026-08-29), because this WILL look over-engineered ─────┐
 * │ The models were solving the tests correctly and then writing down the      │
 * │ wrong number. A real capture: the private reasoning ended with a clean     │
 * │ per-question summary — "a96 = 5 + 3*95 = 290", "a103 = 8 + 1.6*102 =       │
 * │ 171.2", "a5 = 6 - 1.25*4 = 1" — and the JSON that came out immediately     │
 * │ after said 287, 164 and -1.25. Four of eight answers were wrong, and every │
 * │ single one was right in the reasoning a few hundred tokens earlier.        │
 * │                                                                            │
 * │ It was never a scraping bug and never a "dumb model" — it is a             │
 * │ TRANSCRIPTION bug. The prompt used to demand answers-only JSON             │
 * │ ("никаких рассуждений… в ответе"), so the model had nowhere to put the     │
 * │ arithmetic in its VISIBLE output. It had to reproduce eight numbers from   │
 * │ memory of a long thinking block, in one constrained JSON pass, and it      │
 * │ drifted. Raising effort or swapping providers does not fix this; the       │
 * │ model already did the work.                                                │
 * │                                                                            │
 * │ The fix has two halves and you need BOTH:                                  │
 * │  1. lib/prompts.js asks for "s" — the final arithmetic with the numbers    │
 * │     substituted — and requires it BEFORE "a" in each object. Generation    │
 * │     is left-to-right, so writing "5+3*95" first anchors the very next      │
 * │     token; the answer is no longer recalled from far away.                 │
 * │  2. THIS FILE re-does the arithmetic in code and, when "s" and "a"         │
 * │     disagree, trusts the arithmetic. JavaScript does not lose track of a   │
 * │     number between two tokens, so this half cannot regress like a prompt.  │
 * │                                                                            │
 * │ ROUND 2 (2026-08-30). The first version used doubles and only understood   │
 * │ answers that were bare decimals. It let this through:                      │
 * │     reasoning  a47 = 15 + 46*(-5/7) = -125/7        JSON said -155/7       │
 * │ — because "-155/7" is not a decimal, so nothing was checked. Evaluating    │
 * │ in floating point could not have fixed it either: the exact answer is      │
 * │ -17.857142857…, and writing that into a box that wants "-125/7" trades     │
 * │ one wrong answer for another.                                              │
 * │ So the evaluator is EXACT RATIONAL arithmetic over BigInt, and a           │
 * │ correction is rendered in the same shape the model used — a fraction stays │
 * │ a fraction, a decimal stays a decimal. School arithmetic is exactly the    │
 * │ rationals, so this is not gold-plating: it is the only representation      │
 * │ that can both compare and re-render these answers without lying. It also   │
 * │ deletes a whole bug class — 8 + 1.6*102 is exactly 171.2 here, with no     │
 * │ 171.20000000000002 to round away.                                          │
 * │                                                                            │
 * │ If you are tempted to delete this: first reproduce a multi-question maths  │
 * │ test and compare «Рассуждение модели» with «Сырой ответ модели» in         │
 * │ Settings → «Диагностика». That is exactly how both rounds were found.      │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ROUND 3 (2026-08-30) widened the net, because arithmetic fill-ins are not the
 * only answers this happens to. Now covered:
 *   - numbers, fractions, and numbers with a unit ("290 см", "45°", "12%");
 *   - comparisons — «поставьте знак» — where "s" carries the comparison and "a"
 *     the sign, or where "a" is a full statement that checks itself.
 * Deliberately NOT covered, because the DOM already decides them: multiple
 * choice and dropdowns. scraper.js `bestOption()` matches the answer TEXT
 * against the real options on the page, so a small transcription drift there
 * still lands on the right option and the page is the source of truth. Also not
 * covered: free-text answers, which nothing can verify.
 *
 * Because of that last group, reconcileAnswer reports a STATUS for every answer
 * — 'verified', 'fixed' or 'unchecked' with a reason — rather than only
 * reporting corrections. "No corrections" must never be mistaken for
 * "everything was checked"; the diagnostics tab shows both numbers.
 *
 * Deliberately conservative — it may only ever fix an answer, never invent or
 * damage one. Every override requires ALL of:
 *   - "s" (or a self-contained "a") parses and evaluates exactly;
 *   - "a" is a number, a fraction, a number+unit, or a comparison sign, so
 *     prose, choice text and «не видно, прокрутите» can never be overwritten;
 *   - the model's claim is demonstrably FALSE, not merely non-strict — a "≤"
 *     that happens to be true of strictly-less values is left alone;
 *   - the corrected value can be written faithfully in the shape "a" used.
 * Anything else leaves the answer exactly as the model wrote it.
 */

// Long enough for a school-level expression with a couple of brackets, short
// enough that a runaway "s" (a whole solution pasted into the field) is
// rejected rather than parsed.
const MAX_EXPRESSION_CHARS = 200;

// Numerator and denominator are capped so a crafted or hallucinated expression
// ("99999999*99999999*…") cannot grow a BigInt without bound inside the service
// worker. 256 bits is ~77 decimal digits — far past any school answer.
const MAX_BITS = 256n;

function tooBig(value) {
  const magnitude = value < 0n ? -value : value;
  // BigInt has no bitLength; comparing against 2^MAX_BITS is exact and cheap.
  return magnitude >> MAX_BITS !== 0n;
}

function gcd(left, right) {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b) { const next = a % b; a = b; b = next; }
  return a;
}

/**
 * Build a reduced rational with a positive denominator, or null when it cannot
 * be represented (division by zero, or values past the size cap).
 */
function rational(numerator, denominator) {
  if (denominator === 0n) return null;
  let n = numerator;
  let d = denominator;
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  if (divisor > 1n) { n /= divisor; d /= divisor; }
  if (tooBig(n) || tooBig(d)) return null;
  return { n, d };
}

const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
const divide = (a, b) => (b.n === 0n ? null : rational(a.n * b.d, a.d * b.n));

export const rationalsEqual = (a, b) => a.n === b.n && a.d === b.d;

/**
 * Normalise the characters a model actually emits: unicode minus and dashes,
 * the two multiplication signs and the division sign. Everything else is left
 * alone so the strict character check below still rejects it.
 *
 * `expression` mode is deliberately opt-in and is enabled ONLY for "s", because
 * two characters mean different things in an ANSWER and getting them wrong is
 * destructive:
 *   - a comma: "2,3" is the multi-select answer «варианты 2 и 3» far more often
 *     than the number 2.3, and reading it as a number let an earlier draft
 *     silently rewrite a correct choice answer to "2";
 *   - a colon: Russian notation writes division as "15 : 3", but an answer of
 *     "10:30" is a time, and turning that into a fraction would be nonsense.
 * Inside an arithmetic expression neither is ambiguous.
 */
function normalizeExpression(raw, { expression = false } = {}) {
  const text = String(raw ?? '')
    .replace(/[−‒–—―]/g, '-')
    .replace(/[×·∙*]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\s+/g, '');
  return expression ? text.replace(/,/g, '.').replace(/:/g, '/') : text;
}

/**
 * Evaluate a plain arithmetic expression EXACTLY, as a rational.
 *
 * A hand-written recursive-descent parser rather than eval/Function: this string
 * comes from a model, which means it is untrusted input inside the extension's
 * own origin, and `eval` on it would be a code-execution hole for anything that
 * can influence the model.
 *
 * Grammar: expr := term (('+'|'-') term)* ; term := factor (('*'|'/') factor)*
 *          factor := '-' factor | '(' expr ')' | number
 *
 * @returns {{n: bigint, d: bigint}|null} the exact value, or null when the text
 *   is not pure arithmetic, divides by zero, overflows, or has trailing junk.
 */
export function evaluateArithmetic(raw) {
  const text = normalizeExpression(raw, { expression: true });
  if (!text || text.length > MAX_EXPRESSION_CHARS) return null;
  // Strict allowlist. An identifier, unit, '=' or '^' means this is not the
  // "final arithmetic with the numbers substituted" the prompt asked for, and
  // guessing at its meaning is how a checker starts inventing answers.
  if (!/^[0-9.+\-*/()]+$/.test(text)) return null;

  let index = 0;
  let failed = false;
  const fail = () => { failed = true; return null; };
  // Every operation can return null (overflow, divide by zero); this keeps the
  // arithmetic below readable without a null check on each line.
  const step = (value) => (value === null ? fail() : value);

  function parseExpression() {
    let value = parseTerm();
    while (!failed && (text[index] === '+' || text[index] === '-')) {
      const operator = text[index++];
      const right = parseTerm();
      if (failed) return null;
      value = step(operator === '+' ? add(value, right) : subtract(value, right));
    }
    return value;
  }

  function parseTerm() {
    let value = parseFactor();
    while (!failed && (text[index] === '*' || text[index] === '/')) {
      const operator = text[index++];
      const right = parseFactor();
      if (failed) return null;
      value = step(operator === '*' ? multiply(value, right) : divide(value, right));
    }
    return value;
  }

  function parseFactor() {
    if (failed) return null;
    if (text[index] === '+') { index += 1; return parseFactor(); }
    if (text[index] === '-') {
      index += 1;
      const value = parseFactor();
      return failed ? null : { n: -value.n, d: value.d };
    }
    if (text[index] === '(') {
      index += 1;
      const value = parseExpression();
      if (failed) return null;
      if (text[index] !== ')') return fail();
      index += 1;
      return value;
    }
    return parseNumberLiteral();
  }

  function parseNumberLiteral() {
    const start = index;
    while (index < text.length && text[index] >= '0' && text[index] <= '9') index += 1;
    let scale = 0;
    if (text[index] === '.') {
      index += 1;
      const fractionStart = index;
      while (index < text.length && text[index] >= '0' && text[index] <= '9') index += 1;
      scale = index - fractionStart;
    }
    const digits = text.slice(start, index).replace('.', '');
    if (!digits) return fail();
    // A decimal literal IS a rational: 1.6 is 16/10. Building it this way is
    // what keeps 8 + 1.6*102 exactly 171.2 instead of 171.20000000000002.
    return step(rational(BigInt(digits), 10n ** BigInt(scale)));
  }

  const result = parseExpression();
  // Trailing junk means we parsed a PREFIX of something else — treat the whole
  // expression as unusable rather than silently answering from half of it.
  if (failed || result === null || index !== text.length) return null;
  return result;
}

/* ------------------------------ Relations --------------------------------- */

/**
 * «Поставьте знак» questions — сравните 3/7 и 0,5 — are the other big family of
 * mechanically checkable answers, and they fail the same way: the model works
 * out the comparison correctly and writes the opposite sign.
 *
 * Longest tokens first: "<=" must win over "<".
 */
const RELATION_TOKENS = [
  ['<=', 'le'], ['>=', 'ge'], ['!=', 'ne'], ['<>', 'ne'], ['==', 'eq'],
  ['≤', 'le'], ['⩽', 'le'], ['≥', 'ge'], ['⩾', 'ge'], ['≠', 'ne'],
  ['<', 'lt'], ['>', 'gt'], ['=', 'eq'],
];

const RELATION_SYMBOL = { lt: '<', gt: '>', eq: '=' };

/** Split "105/7<230/7" into its two sides and the asserted relation. */
function splitRelation(raw) {
  const text = String(raw ?? '').replace(/\s+/g, '');
  for (let index = 0; index < text.length; index += 1) {
    for (const [token, relation] of RELATION_TOKENS) {
      if (!text.startsWith(token, index)) continue;
      const left = text.slice(0, index);
      const right = text.slice(index + token.length);
      if (!left || !right) return null;
      return { left, right, relation, token };
    }
  }
  return null;
}

/** The relation that actually holds. Cross-multiplied: both denominators > 0. */
function trueRelation(left, right) {
  const a = left.n * right.d;
  const b = right.n * left.d;
  if (a < b) return 'lt';
  if (a > b) return 'gt';
  return 'eq';
}

/**
 * Whether the model's asserted relation is TRUE of the actual values.
 *
 * Note the asymmetry: a claim of "≤" when the values are strictly less is
 * SATISFIED, and is therefore left alone. Rewriting it to "<" would be second-
 * guessing what the question asked for, and this checker only ever overturns
 * statements that are demonstrably false.
 */
function relationSatisfied(stated, actual) {
  if (stated === 'ne') return actual !== 'eq';
  if (stated === 'le') return actual === 'lt' || actual === 'eq';
  if (stated === 'ge') return actual === 'gt' || actual === 'eq';
  return stated === actual;
}

/**
 * Evaluate a full relation statement ("105/7<230/7") into what the model
 * claimed and what is actually true.
 * @returns {{stated: string, actual: string}|null}
 */
export function evaluateRelation(raw) {
  const split = splitRelation(raw);
  if (!split) return null;
  const left = evaluateArithmetic(split.left);
  const right = evaluateArithmetic(split.right);
  if (left == null || right == null) return null;
  return { stated: split.relation, actual: trueRelation(left, right), token: split.token };
}

const BARE_RELATION_RE = /^(<=|>=|!=|<>|==|[≤⩽≥⩾≠<>=])$/;

/** An answer that is ONLY a comparison sign, as «поставьте знак» questions want. */
export function parseRelationAnswer(raw) {
  const text = String(raw ?? '').replace(/\s+/g, '');
  if (!BARE_RELATION_RE.test(text)) return null;
  const match = RELATION_TOKENS.find(([token]) => token === text);
  return match ? match[1] : null;
}

/* ------------------------------- Numbers ---------------------------------- */

const BARE_NUMBER_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const FRACTION_RE = /^([+-]?)(\d+)\/(\d+)$/;
// A unit or symbol trailing the number: "290 см", "45°", "12%". Matched against
// the ORIGINAL string so the spacing survives a repair — rebuilding "287 см" as
// "290см" would change what gets typed into the box.
//
// The suffix is deliberately digit-free and short, which is what stops
// "2 или 3" (a multi-select) and "4; -6" (two values) from posing as a number
// with a unit.
const SUFFIXED_NUMBER_RE = /^([+-]?[\d.,/]+)(\s*[^\d\s.,;/][^\d;]{0,11})$/;

function toSigned(value, sign) {
  return sign === '-' ? { n: -value.n, d: value.d } : value;
}

function parsePlainNumber(text) {
  const fraction = FRACTION_RE.exec(text);
  if (fraction) {
    const [, sign, numerator, denominator] = fraction;
    const value = rational(BigInt(numerator), BigInt(denominator));
    return value ? { value: toSigned(value, sign), shape: 'fraction' } : null;
  }
  const bare = BARE_NUMBER_RE.exec(text);
  if (!bare) return null;
  const [, sign, whole, fractionDigits = ''] = bare;
  const value = rational(BigInt(whole + fractionDigits), 10n ** BigInt(fractionDigits.length));
  return value ? { value: toSigned(value, sign), shape: 'decimal' } : null;
}

/**
 * Parse an answer that is ONLY a number — a decimal (point separator), a simple
 * fraction like "-125/7", or either of those followed by a unit ("290 см").
 * Returns the exact value, the SHAPE the model used and any unit suffix, so a
 * correction can be written back in the same form: МЭШ wants "-125/7" in that
 * box, and "-17.857142857" is a different wrong answer.
 *
 * A comma is refused outright rather than read as a decimal — see
 * normalizeExpression. That costs the repair of comma-formatted decimals, which
 * is the right trade: failing to fix a wrong number leaves the student where
 * they were, while "fixing" the multi-select answer "1,3" into "1.3" invents a
 * wrong answer where the model had a right one.
 *
 * Anything with a variable, a word before the number, or a second value returns
 * null, which is what keeps the reconciler away from text answers.
 *
 * @returns {{value: {n: bigint, d: bigint}, shape: 'decimal'|'fraction',
 *            suffix: string}|null}
 */
export function parseNumericAnswer(raw) {
  // Only the dash family is normalised up front: it is length-preserving, so
  // the suffix below keeps the author's original spacing.
  const original = String(raw ?? '').trim().replace(/[−‒–—―]/g, '-');
  if (!original) return null;

  const plain = parsePlainNumber(normalizeExpression(original));
  if (plain) return { ...plain, suffix: '' };

  // "290 см" → number "290" + unit " см", carried through untouched so a repair
  // keeps it: replacing "287 см" with a bare "290" would lose part of the
  // answer the question asked for.
  const suffixed = SUFFIXED_NUMBER_RE.exec(original);
  if (!suffixed) return null;
  const withUnit = parsePlainNumber(normalizeExpression(suffixed[1]));
  return withUnit ? { ...withUnit, suffix: suffixed[2] } : null;
}

/** Render an exact rational as "n/d", collapsing a unit denominator. */
function formatFraction(value) {
  return value.d === 1n ? String(value.n) : `${value.n}/${value.d}`;
}

/**
 * Render an exact rational as a finite decimal, or null when it has none.
 *
 * A denominator whose prime factors are only 2 and 5 terminates; anything else
 * (7, 3, …) would need rounding, and this checker has no idea how many places
 * the question wants. Refusing is a missed repair; guessing is a wrong answer.
 */
function formatDecimal(value) {
  let denominator = value.d;
  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos += 1; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives += 1; }
  if (denominator !== 1n) return null;

  const places = Math.max(twos, fives);
  const scaled = value.n * (2n ** BigInt(places - twos)) * (5n ** BigInt(places - fives));
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = places ? digits.slice(digits.length - places).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

const unchecked = (stated, reason) => ({ answer: stated, status: 'unchecked', reason });
const verified = (stated) => ({ answer: stated, status: 'verified' });

/**
 * Reconcile a relation answer — either «поставьте знак» (the answer IS a sign,
 * and "s" carries the comparison) or a full statement written into "a".
 * @returns {object|null} null when this is not a relation question at all.
 */
function reconcileRelation(stated, work) {
  // A full statement in "a" ("105/7 < 230/7") checks itself; "s" is not needed.
  const selfContained = evaluateRelation(stated);
  if (selfContained) {
    if (relationSatisfied(selfContained.stated, selfContained.actual)) return verified(stated);
    const fixed = stated.replace(selfContained.token, RELATION_SYMBOL[selfContained.actual]);
    return fixed === stated
      ? unchecked(stated, 'не удалось переписать знак')
      : { answer: fixed, status: 'fixed', from: stated, to: fixed, work: stated };
  }

  // A bare sign in "a" needs the comparison in "s".
  const statedRelation = parseRelationAnswer(stated);
  if (statedRelation == null) return null;
  if (!work) return unchecked(stated, 'нет "s" для сравнения');
  const relation = evaluateRelation(work);
  if (!relation) return unchecked(stated, '"s" не является сравнением');
  if (relationSatisfied(statedRelation, relation.actual)) return verified(stated);
  const fixed = RELATION_SYMBOL[relation.actual];
  return { answer: fixed, status: 'fixed', from: stated, to: fixed, work: String(work) };
}

/**
 * Reconcile one answer against the working the model showed for it.
 *
 * Always reports a STATUS, not just a correction, so the diagnostics tab can
 * show how much of a test was actually machine-verified rather than leaving
 * "no corrections" to be misread as "everything checked".
 *
 * @param {string} answer the model's "a"
 * @param {string} work the model's "s" (may be absent)
 * @returns {{answer: string, status: 'verified'|'fixed'|'unchecked',
 *            reason?: string, from?: string, to?: string, work?: string}}
 */
export function reconcileAnswer(answer, work) {
  const stated = String(answer ?? '');

  // Relations first: "=" is a relation token, so "x=4" style answers must not
  // be mistaken for arithmetic.
  const relation = reconcileRelation(stated, work);
  if (relation) return relation;

  if (!work) return unchecked(stated, 'модель не показала вычисление');

  const computed = evaluateArithmetic(work);
  if (computed == null) return unchecked(stated, '"s" не является арифметикой');

  // Only a numeric answer may be replaced. A choice like «крахмал», a
  // multi-value string like "x=4; y=-6", or «не видно, прокрутите» is left
  // untouched even when "s" evaluates cleanly — those are not what "s"
  // describes.
  const parsed = parseNumericAnswer(stated);
  if (!parsed) return unchecked(stated, 'ответ не число — проверить нечем');

  // Exact comparison — no tolerance needed, and none wanted: with rationals,
  // "0.1+0.2" really is "0.3", so a mismatch is a genuine disagreement rather
  // than floating-point dust.
  if (rationalsEqual(parsed.value, computed)) return verified(stated);

  // Write the fix back in the shape the model used. A fraction question wants a
  // fraction; substituting a decimal there would swap one wrong answer for
  // another. When the value cannot be written that way (a repeating decimal in
  // a decimal-shaped answer), leave the answer alone.
  const number = parsed.shape === 'fraction'
    ? formatFraction(computed)
    : formatDecimal(computed);
  if (number == null) return unchecked(stated, 'точное значение — бесконечная дробь');
  const fixed = `${number}${parsed.suffix}`;
  if (fixed === stated) return verified(stated);

  return { answer: fixed, status: 'fixed', from: stated, to: fixed, work: String(work) };
}
