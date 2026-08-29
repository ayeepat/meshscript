/**
 * `hidden` must actually hide, on every extension page.
 *
 * The UA stylesheet's `[hidden] { display: none }` loses to ANY author
 * `display:` declaration, so an element that ships `hidden` in the markup and
 * also matches a `.class { display: flex }` rule renders normally. That is not
 * a cosmetic slip here: the provider picker (`#obProvider.seg`), the
 * «OPR GRQ QWN DSK» chart switcher (`#chartMode.seg`), the OpenRouter spend
 * tiles (`.spendtile[data-byo-only]`) and the provider badge
 * (`#provBadge.provbadge`) are all kept out of the product by `hidden` alone
 * while SHOW_PROVIDER_UI is false — and all four leaked.
 *
 * This resolves the cascade statically instead of trusting a review: for every
 * element that ships `hidden`, find every CSS rule that matches it and check
 * that nothing outranks the global `[hidden]` reset.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseHtml } from 'parse5';
import { parse as parseCss } from 'postcss';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const PAGES = [
  { html: '../src/popup/popup.html', css: ['../src/common/theme.css', '../src/common/math.css', '../src/popup/popup.css'] },
  { html: '../src/settings/settings.html', css: ['../src/common/theme.css', '../src/common/math.css', '../src/settings/settings.css'] },
  { html: '../src/dashboard/dashboard.html', css: ['../src/common/theme.css', '../src/common/math.css', '../src/dashboard/dashboard.css'] },
  { html: '../src/welcome/welcome.html', css: ['../src/common/theme.css', '../src/welcome/welcome.css'] },
];

/** Every element carrying a bare `hidden` attribute, with its id/classes. */
function hiddenElements(html) {
  const found = [];
  (function walk(node) {
    const attrs = node.attrs;
    if (attrs?.some((a) => a.name === 'hidden')) {
      found.push({
        tag: node.nodeName,
        id: attrs.find((a) => a.name === 'id')?.value || null,
        classes: (attrs.find((a) => a.name === 'class')?.value || '').split(/\s+/).filter(Boolean),
        attributes: new Set(attrs.map((a) => a.name)),
      });
    }
    for (const child of node.childNodes || []) walk(child);
  })(parseHtml(html));
  return found;
}

/**
 * Does `selector` match this element on its own terms (ignoring ancestors)?
 * Deliberately conservative: anything with a combinator is treated as a
 * possible match, so an unparsed selector can only ever ADD a finding.
 */
function selectorTargets(selector, element) {
  const last = selector.split(/[\s>+~]+/).filter(Boolean).pop() || '';
  if (!last) return false;
  const parts = last.match(/[.#]?[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g) || [];
  return parts.every((part) => {
    if (part.startsWith('.')) return element.classes.includes(part.slice(1));
    if (part.startsWith('#')) return element.id === part.slice(1);
    if (part.startsWith('[')) {
      const name = part.slice(1, -1).split(/[~^|$*]?=/)[0].trim();
      return element.attributes.has(name);
    }
    if (part.startsWith(':')) return true; // states can be true at any time
    return part === '*' || part.toLowerCase() === element.tag;
  });
}

// The reset is what makes every ordinary `display:` rule lose, so check it
// first: `!important` author declarations outrank all normal ones regardless of
// specificity or order. Without the flag this is just another (0,1,0) author
// rule that any later `.class { display: flex }` silently beats — which is
// exactly how the leak happened.
const theme = parseCss(source('../src/common/theme.css'));
let reset = null;
theme.walkRules((rule) => {
  if (rule.selectors?.some((s) => s.trim() === '[hidden]')) {
    reset = rule.nodes?.find((n) => n.type === 'decl' && n.prop === 'display') || reset;
  }
});
assert.ok(reset, 'theme.css must define a global [hidden] display reset');
assert.equal(reset.value, 'none', 'the [hidden] reset must resolve to display:none');
assert.equal(reset.important, true,
  'the [hidden] reset must be !important, or a later author rule silently wins ' +
  'and elements that ship `hidden` render anyway');

// With that in place, only another `!important` display declaration can still
// win. Those are rare and always worth a second look, so flag every one that
// could apply to an element shipping `hidden`.
let checked = 0;
for (const page of PAGES) {
  // A page may legitimately ship none (welcome.html has no toggled state).
  const elements = hiddenElements(source(page.html));
  const offenders = [];
  for (const stylesheet of page.css) {
    parseCss(source(stylesheet)).walkRules((rule) => {
      if (rule.selectors?.every((s) => s.trim() === '[hidden]')) return; // the reset itself
      const display = rule.nodes?.find((n) => n.type === 'decl' && n.prop === 'display');
      if (!display?.important) return;
      for (const selector of rule.selectors || []) {
        for (const element of elements) {
          if (selectorTargets(selector, element)) {
            offenders.push(`${stylesheet} :: ${selector} { display: ${display.value} !important } ` +
              `can outrank [hidden] on ${element.id ? `#${element.id}` : `.${element.classes.join('.')}`}`);
          }
        }
      }
    });
    checked += 1;
  }

  assert.deepEqual(offenders, [],
    `${page.html}: these !important rules can render a hidden element anyway:\n` +
    `${offenders.join('\n')}`);
}

// Finally, pin the elements this actually protects. Each is hidden by markup
// alone while SHOW_PROVIDER_UI is false; if one stops shipping `hidden`, the
// reset above cannot save it and a vendor name reaches the student.
const popup = hiddenElements(source('../src/popup/popup.html'));
const settings = hiddenElements(source('../src/settings/settings.html'));
const byId = (list, id) => list.some((element) => element.id === id);
assert.ok(byId(popup, 'obProvider'), 'the onboarding provider picker must ship hidden');
assert.ok(byId(popup, 'provBadge'), 'the popup provider badge must ship hidden');
assert.ok(byId(settings, 'chartMode'), 'the vendor chart switcher must ship hidden');
assert.ok(byId(settings, 'providerPanel'), 'the settings provider panel must ship hidden');
assert.ok(
  settings.some((element) => element.attributes.has('data-byo-only')),
  'the BYO-only spend tiles must ship hidden',
);

console.log(`hidden-attribute regression passed (${checked} stylesheets checked)`);
