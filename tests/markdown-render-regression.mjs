/**
 * Shared markdown renderer regression — src/common/markdown.js is the ONE
 * renderer behind both the dashboard chat and the Settings history view, and
 * it feeds innerHTML, so two things must hold forever:
 *   1. SAFETY: model output is escaped before any tag is built — markup in an
 *      answer must never become live HTML.
 *   2. FIDELITY: the emphasis/code/list shapes models actually emit render as
 *      valid, correctly nested HTML (***…*** used to split into
 *      <strong><em>…</strong></em>, and a `*` inside inline code used to be
 *      read as emphasis).
 */
import assert from 'node:assert/strict';
import { mdToHtml } from '../src/common/markdown.js';

// --- safety: answer text can never inject live HTML -------------------------
const hostile = mdToHtml('Ответ: <img src=x onerror=alert(1)> и <script>hack()</script>');
assert.ok(!hostile.includes('<img'), 'raw tags must be escaped');
assert.ok(!hostile.includes('<script'), 'raw tags must be escaped');
assert.ok(hostile.includes('&lt;script&gt;'), 'escaped source must survive visibly');
// ...including inside inline code and emphasis
const hostileCode = mdToHtml('код `<b>x</b>` и *<i>y</i>*');
assert.ok(!hostileCode.includes('<b>') && !hostileCode.includes('<i>'),
  'markup inside code/emphasis must stay escaped');

// --- emphasis nesting --------------------------------------------------------
assert.equal(mdToHtml('**жирный** и *курсив*'),
  '<p><strong>жирный</strong> и <em>курсив</em></p>');
assert.equal(mdToHtml('***жирный курсив*** дальше'),
  '<p><strong><em>жирный курсив</em></strong> дальше</p>',
  '***…*** must nest, not interleave <strong><em>…</strong></em>');

// --- inline code is verbatim -------------------------------------------------
assert.equal(mdToHtml('код `a * b * c` рядом'),
  '<p>код <code>a * b * c</code> рядом</p>',
  'a * inside backticks is code, not emphasis');
assert.equal(mdToHtml('`x**2 + y**2`'),
  '<p><code>x**2 + y**2</code></p>',
  '** inside backticks is code, not bold');

// --- blocks: headings and both list kinds ------------------------------------
// Heading LEVEL must survive rendering (structure/a11y), not flatten to one tag.
assert.equal(mdToHtml('# Заголовок\nтекст'), '<h1>Заголовок</h1><p>текст</p>');
assert.equal(mdToHtml('## Уровень 2'), '<h2>Уровень 2</h2>');
assert.equal(mdToHtml('###### Шесть'), '<h6>Шесть</h6>');
assert.equal(mdToHtml('- один\n- два'), '<ul><li>один</li><li>два</li></ul>');
assert.equal(mdToHtml('1. один\n2. два'), '<ol><li>один</li><li>два</li></ol>');

// --- LaTeX passes through untouched by emphasis ------------------------------
// extractMath pulls $…$ out BEFORE markdown, so *, _ inside a formula must
// survive; the restored span carries the .math class math.css styles.
const math = mdToHtml('Дробь $\\frac{1}{2}$ и произведение $a*b$.');
assert.ok(math.includes('class="math"'), 'math span must be restored');
assert.ok(!math.includes('<em>'), '* inside $…$ must not become emphasis');

// Degenerate nesting must degrade inside the math span, not abort rendering.
const deeplyNested = '$' + '{'.repeat(10000) + '1' + '}'.repeat(10000) + '$';
assert.equal(typeof mdToHtml(deeplyNested), 'string');

// Every literal code point survives, including the private-use characters the
// old renderer consumed as fixed sentinels. They are ordinary user/model text,
// not a reserved alphabet.
const literalPua = 'до \uE0000\uE001 \uE0020\uE003 после';
assert.equal(mdToHtml(literalPua), `<p>${literalPua}</p>`,
  'literal private-use text must round-trip exactly');
assert.equal(mdToHtml('`\uE000\uE001\uE002\uE003`'), '<p><code>\uE000\uE001\uE002\uE003</code></p>',
  'private-use text inside inline code must also survive exactly');

// Placeholder-looking input is still literal. Include several candidate
// nonces so the implementation must choose an actually unused namespace,
// rather than merely replacing one fixed sentinel with another fixed token.
const forgedMathTokens = [0, 1, 2]
  .map((nonce) => `SMESH_INTERNAL_PLACEHOLDER_MATH_${nonce}_0_END`);
const forgedCodeTokens = [0, 1, 2]
  .map((nonce) => `SMESH_INTERNAL_PLACEHOLDER_CODE_${nonce}_0_END`);
const forgedSource = [
  ...forgedMathTokens,
  ...forgedCodeTokens,
  'настоящая формула $x$',
  'настоящий `code`'
].join(' ');
const forged = mdToHtml(forgedSource);
for (const token of [...forgedMathTokens, ...forgedCodeTokens]) {
  assert.ok(forged.includes(token), `literal placeholder-shaped text was consumed: ${token}`);
}
assert.equal((forged.match(/class="math"/g) || []).length, 1,
  'forged math placeholders must not duplicate the real formula chunk');
assert.equal((forged.match(/<code>/g) || []).length, 1,
  'forged code placeholders must not duplicate the real code chunk');
assert.ok(!forged.includes('undefined'), 'an invalid placeholder must never render undefined');

// --- junk in, no crash out ----------------------------------------------------
assert.equal(mdToHtml(''), '');
assert.equal(mdToHtml(null), '');
assert.equal(mdToHtml(undefined), '');

console.log('markdown render regression passed');
