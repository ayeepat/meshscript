import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scraper = readFileSync(
  new URL('../src/content/scraper.js', import.meta.url),
  'utf8'
);

assert.match(
  scraper,
  /try \{ resources = stableSignatureResourceSemantics\(document\.body\); \}\s*catch \{ resources = \{ value: '', safe: false \}; \}/,
  'an unexpected resource-inspection failure must make page capture fail closed'
);

function sourceSection(startMarker, endMarker) {
  const start = scraper.indexOf(startMarker);
  const end = scraper.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return scraper.slice(start, end);
}

// A bounded signature may never silently omit a later image/background. Both
// resource-count overflow and an unscanned DOM suffix must make capture fail
// closed.
{
  const resourceSource = sourceSection(
    'function stableSignatureResourceSemantics(root)',
    '\nfunction stableSignatureControlSemantics'
  );
  const visibleStyle = { backgroundImage: 'none' };
  const context = {
    SIGNATURE_RESOURCE_SELECTOR: 'resource',
    SIGNATURE_ELEMENT_SCAN_LIMIT: 4096,
    SIGNATURE_RESOURCE_LIMIT: 512,
    SIGNATURE_TRANSIENT_OVERLAY_SELECTOR: 'transient',
    SIGNATURE_MUTABLE_ANSWER_SELECTOR: 'mutable',
    getComputedStyle: (element) => element?._style || visibleStyle,
    signatureElementIsVisuallyHidden: () => false,
    stableSignatureResourceUrl: (value) => String(value || ''),
    stableSignatureBackground: (value) => value && value !== 'none' ? String(value) : '',
    stableSignatureHash: (value) => `hash:${String(value).length}`,
    signatureCanvasCarriesQuestion: () => false,
    stableSignatureCanvasSample: () => '',
    normalize: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
  };
  vm.createContext(context);
  vm.runInContext(
    `${resourceSource}\nthis.__resourceSignature = stableSignatureResourceSemantics;`,
    context
  );

  const resource = (id) => ({
    tagName: 'IMG',
    currentSrc: '',
    _style: visibleStyle,
    getAttribute(name) { return name === 'src' ? `/question/${id}.png` : null; },
    closest() { return null; },
  });
  const rootFor = (resources, all = resources) => ({
    nodeType: 1,
    tagName: 'BODY',
    _style: visibleStyle,
    querySelectorAll(selector) { return selector === 'resource' ? resources : all; },
    getAttribute() { return null; },
    closest() { return null; },
  });

  assert.equal(
    context.__resourceSignature(rootFor(Array.from({ length: 512 }, (_, i) => resource(i)))).safe,
    true,
    'the documented resource budget must remain usable'
  );
  assert.equal(
    context.__resourceSignature(rootFor(Array.from({ length: 513 }, (_, i) => resource(i)))).safe,
    false,
    'a 513th visible resource must not be silently omitted from page identity'
  );
  const oversizedDom = Array.from({ length: 4097 }, (_, i) => ({
    ...resource(`dom-${i}`),
    tagName: 'DIV',
    _style: { backgroundImage: i === 4096 ? 'url(/question/late.png)' : 'none' },
  }));
  assert.equal(
    context.__resourceSignature(rootFor([], oversizedDom)).safe,
    false,
    'an identity-bearing background after the DOM scan budget must make capture fail closed'
  );
}

// Custom controls count as filled only when their settled state proves the
// intended selection—not merely because some visible text changed.
{
  const clickSafetySource = sourceSection(
    'function isUnsafeInteractiveActivator(el)',
    '\n\n// Open a dropdown'
  );
  const clickContext = {};
  vm.createContext(clickContext);
  vm.runInContext(
    `${clickSafetySource}\nthis.__safeInteractiveClick = safeInteractiveClick;`,
    clickContext
  );
  const activator = ({ tag = 'button', type = 'submit', inForm = true } = {}) => {
    let clicks = 0;
    const form = inForm ? {} : null;
    const element = {
      localName: tag,
      tagName: tag.toUpperCase(),
      type,
      form,
      getAttribute(name) {
        if (name === 'type') return type;
        return null;
      },
      closest(selector) {
        if (selector === 'button, input' && (tag === 'button' || tag === 'input')) return this;
        if (selector === 'form') return form;
        return null;
      },
      click() { clicks += 1; }
    };
    return { element, clicks: () => clicks };
  };
  for (const unsafe of [
    activator(),
    activator({ type: 'button', inForm: true }),
    activator({ tag: 'input', type: 'radio', inForm: true })
  ]) {
    assert.equal(clickContext.__safeInteractiveClick(unsafe.element), false,
      'a form-coupled or native submit-capable answer control must be skipped');
    assert.equal(unsafe.clicks(), 0, 'unsafe answer controls must receive no programmatic click');
  }
  const safe = activator({ tag: 'div', type: '', inForm: false });
  assert.equal(clickContext.__safeInteractiveClick(safe.element), true,
    'a detached custom widget must remain fillable');
  assert.equal(safe.clicks(), 1);

  const interactiveSource = sourceSection(
    'function stableControlValues(element, attributeNames = [], includePropertyValue = true)',
    '\n/**\n * Async fill pass'
  );
  const context = {
    document: { documentElement: { contains: () => true } },
    normalizeForMatch: (value) => String(value || '')
      .toLowerCase().replace(/\s+/g, ' ').trim(),
    isUnfillableAnswer: (value) => !String(value || '').trim(),
    interactiveGuardCurrent: () => true,
    interactiveGuardAccept: () => true,
    closeOpenMenu() {},
    __smeshSleep: async () => {},
    parseChoiceIndices: () => [],
    controlLabelText: (element) => element.textContent || '',
    isDisabledControl: () => false,
    safeInteractiveClick(element) { element.click(); return true; },
    precedingFieldText: () => '',
    questionParts: () => [],
    similarity: (a, b) => a === b ? 1 : 0,
    MATCH_MIN: 0.7,
  };
  vm.createContext(context);
  vm.runInContext(
    `${interactiveSource}\n` +
      'this.__fillDropdown = fillOneDropdown; this.__fillInteractive = fillInteractiveUnit;',
    context
  );

  const attributes = (initial = {}) => {
    const values = { ...initial };
    return {
      get(name) { return Object.hasOwn(values, name) ? values[name] : null; },
      set(name, value) { values[name] = String(value); },
    };
  };
  const triggerAttrs = attributes();
  triggerAttrs.set('aria-label', 'Бета');
  const trigger = {
    tagName: 'BUTTON',
    value: 'beta',
    textContent: 'Выберите ответ',
    getAttribute: (name) => triggerAttrs.get(name),
  };
  const targetAttrs = attributes({ 'data-value': 'beta' });
  const target = {
    textContent: 'Бета',
    value: 'beta',
    getAttribute: (name) => targetAttrs.get(name),
    click() { trigger.textContent = 'Альфа'; triggerAttrs.set('data-value', 'alpha'); },
  };
  context.openDropdownOptions = async () => [{ el: target, norm: 'бета' }];
  context.chooseOption = () => target;

  assert.equal(
    await context.__fillDropdown(trigger, 'Бета', null, {}),
    false,
    'a dropdown that settles on a different changed option must not report success, even when its static label matches'
  );
  target.click = () => {
    trigger.textContent = 'Бета';
    triggerAttrs.set('data-value', 'beta');
  };
  assert.equal(
    await context.__fillDropdown(trigger, 'Бета', null, {}),
    true,
    'an exact settled dropdown selection must remain fillable'
  );

  const makeRadio = (label, checked) => {
    let selected = checked;
    return {
      textContent: label,
      checked: undefined,
      getAttribute(name) { return name === 'aria-checked' ? String(selected) : null; },
      setSelected(value) { selected = value; },
      click() { selected = true; },
    };
  };
  const radioA = makeRadio('Альфа', true);
  const radioB = makeRadio('Бета', false);
  context.chooseOption = (_answer, options) =>
    options.find((option) => option.el === radioB)?.el || null;
  assert.equal(
    await context.__fillInteractive(
      { type: 'aria-radio', els: [radioA, radioB] },
      { answer: 'Бета', choice: null },
      {}
    ),
    false,
    'selecting the target while a stale ARIA radio stays selected must fail exclusivity verification'
  );
  radioA.setSelected(false);
  assert.equal(
    await context.__fillInteractive(
      { type: 'aria-radio', els: [radioA, radioB] },
      { answer: 'Бета', choice: null },
      {}
    ),
    true,
    'exactly one selected target radio must remain a valid success'
  );
}

// Native select/radio/checkbox writes are optimistic until one shared settle
// window. A framework rerender that restores an old state must demote the
// question just like a reverted text input.
{
  const helperSource = sourceSection(
    'function nativeElementStillCurrent(element)',
    '\n// Don\'t act on a "not visible, scroll" sentinel'
  );
  const fillUnitSource = sourceSection(
    'function fillUnit(unit, question, pendingVerify, guard = null)',
    '\n/**\n * Fill the Mesh test form'
  );
  const fillAnswersSource = sourceSection(
    "async function fillTestAnswers(questions, expectedSignature = '', expectedPrincipal = '')",
    '\n// Broad, detection-independent scan'
  );
  let activeInputs = [];
  const context = {
    document: { documentElement: { contains: () => true } },
    normalize: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    normalizeForMatch: (value) => String(value || '').toLowerCase().trim(),
    valueTook: (element, want) => String(element.value || '') === String(want),
    isUnfillableAnswer: (value) => !String(value || '').trim(),
    similarity: (a, b) => a === b ? 1 : 0,
    MATCH_MIN: 0.7,
    MATCH_MARGIN: 0.1,
    parseChoiceIndices: () => [],
    distributeFieldValues: () => [],
    setNativeValue: () => false,
    setSelectValue(select, option) {
      for (const candidate of select.options) candidate.selected = false;
      option.selected = true;
      select.value = option.value;
      return true;
    },
    controlLabelText: (input) => input.label || '',
    bestOption(answer, options) {
      const wanted = String(answer || '').toLowerCase();
      return options.find((option) => option.labelNorm === wanted) || null;
    },
    setCheckbox(input, checked) { input.checked = checked; return true; },
    selectRadio(input) {
      for (const option of activeInputs) option.checked = false;
      input.checked = true;
      return true;
    },
    interactiveGuardCurrent: () => true,
    collectUnits: () => [],
    SMESH_DEBUG: false,
    boxInfo: () => null,
    dbg() {},
    __smeshSleep: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(
    `${helperSource}\n${fillUnitSource}\n${fillAnswersSource}\n` +
      'this.__fillNative = fillTestAnswers;',
    context
  );

  const run = async (unit, answer, revert) => {
    activeInputs = unit.inputs;
    context.collectUnits = () => [unit];
    context.__smeshSleep = async () => { revert(); };
    return context.__fillNative([{ index: 1, answer }]);
  };

  const placeholder = { value: '', textContent: 'Выберите', selected: true };
  const beta = { value: 'beta', textContent: 'Бета', selected: false };
  const select = { value: '', options: [placeholder, beta] };
  let result = await run(
    { type: 'select', number: 1, inputs: [select] },
    'Бета',
    () => {
      beta.selected = false;
      placeholder.selected = true;
      select.value = '';
    }
  );
  assert.deepEqual(Array.from(result.filled), []);
  assert.deepEqual(Array.from(result.skipped), [1],
    'a select reverted during the settle window must be demoted');
  result = await run(
    { type: 'select', number: 1, inputs: [select] },
    'Бета',
    () => {}
  );
  assert.deepEqual(Array.from(result.filled), [1],
    'an exact select value that survives the settle window must remain filled');

  const radioA = { label: 'альфа', checked: true };
  const radioB = { label: 'бета', checked: false };
  result = await run(
    { type: 'radio', number: 1, inputs: [radioA, radioB] },
    'бета',
    () => { radioA.checked = true; radioB.checked = false; }
  );
  assert.deepEqual(Array.from(result.filled), []);
  assert.deepEqual(Array.from(result.skipped), [1],
    'a radio group reverted during the settle window must be demoted');
  result = await run(
    { type: 'radio', number: 1, inputs: [radioA, radioB] },
    'бета',
    () => {}
  );
  assert.deepEqual(Array.from(result.filled), [1],
    'an exclusive target radio that survives the settle window must remain filled');

  const checkboxA = { label: 'альфа', checked: true };
  const checkboxB = { label: 'бета', checked: false };
  result = await run(
    { type: 'checkbox', number: 1, inputs: [checkboxA, checkboxB] },
    'бета',
    () => { checkboxA.checked = true; checkboxB.checked = false; }
  );
  assert.deepEqual(Array.from(result.filled), []);
  assert.deepEqual(Array.from(result.skipped), [1],
    'a checkbox set reverted during the settle window must be demoted');
  result = await run(
    { type: 'checkbox', number: 1, inputs: [checkboxA, checkboxB] },
    'бета',
    () => {}
  );
  assert.deepEqual(Array.from(result.filled), [1],
    'an exact checkbox set that survives the settle window must remain filled');
}

console.log('scraper write verification regressions passed');
