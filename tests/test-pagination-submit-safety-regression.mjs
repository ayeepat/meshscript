import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scraperSource = readFileSync(new URL('../src/content/scraper.js', import.meta.url), 'utf8');

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener.call(this, event);
      if (event.immediatePropagationStopped) break;
    }
    return !event.defaultPrevented;
  }
}

class FakeMouseEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.immediatePropagationStopped = false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopImmediatePropagation() {
    this.immediatePropagationStopped = true;
  }
}

class FakeHTMLElement extends FakeEventTarget {
  constructor(tagName, attrs = {}, textContent = '') {
    super();
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs).map(([key, value]) => [key.toLowerCase(), String(value)]));
    this.textContent = textContent;
    this.value = attrs.value || '';
    this.id = attrs.id || '';
    this.disabled = false;
    this.parentElement = null;
    this.nativeClickCount = 0;
    this.overriddenClickCount = 0;
    this.scrollCount = 0;

    // A page can shadow an element's click property. Pagination must invoke the
    // browser's native method, not this page-controlled replacement.
    this.click = () => { this.overriddenClickCount += 1; };
  }

  get type() {
    const raw = (this.getAttribute('type') || '').toLowerCase();
    if (this.localName === 'button') {
      return ['button', 'reset', 'submit'].includes(raw) ? raw : 'submit';
    }
    if (this.localName === 'input') return raw || 'text';
    return '';
  }

  getAttribute(name) {
    return this.attrs.has(name.toLowerCase()) ? this.attrs.get(name.toLowerCase()) : null;
  }

  hasAttribute(name) {
    return this.attrs.has(name.toLowerCase());
  }

  getBoundingClientRect() {
    return { width: 100, height: 30, left: 0, right: 100, top: 0, bottom: 30 };
  }

  scrollIntoView() {
    this.scrollCount += 1;
    this.onScroll?.();
  }

  closest(selector) {
    if (selector !== 'button, input' && selector !== 'label') return null;
    const tags = selector.split(',').map((tag) => tag.trim());
    for (let node = this; node; node = node.parentElement) {
      if (tags.includes(node.localName)) return node;
    }
    return null;
  }
}

FakeHTMLElement.prototype.click = function nativeClick() {
  this.nativeClickCount += 1;
  this.onNativeClick?.();
};

function matchesSelector(el, selector) {
  const part = selector.trim();
  if (part === 'button') return el.localName === 'button';
  if (part === 'a[href]') return el.localName === 'a' && el.getAttribute('href') !== null;
  if (part === '[role="button"]') return el.getAttribute('role') === 'button';
  if (part === '[tabindex]') return el.getAttribute('tabindex') !== null;
  const inputType = part.match(/^input\[type="([^"]+)"\]$/);
  return !!inputType && el.localName === 'input' && el.type === inputType[1];
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.candidates = [];
    let bodyText = '';
    this.body = {
      nodeType: 1,
      tagName: 'BODY',
      hidden: false,
      childNodes: [],
      getAttribute() { return null; },
      get innerText() { return bodyText; },
      set innerText(value) {
        bodyText = String(value || '');
        this.childNodes = [{ nodeType: 3, nodeValue: bodyText }];
      }
    };
    this.documentElement = { contains: () => true };
    this.nativeSubmissions = 0;
    this.blockedSubmissions = 0;
  }

  querySelectorAll(selector) {
    // Only the pagination query should see our controls. Other scraper queries
    // run while deriving an optional page signature and intentionally see none.
    if (!selector.includes('a[href]') || !selector.includes('[role="button"]')) return [];
    const selectors = selector.split(',');
    return this.candidates.filter((el) => selectors.some((part) => matchesSelector(el, part)));
  }

  attemptNativeSubmission() {
    const event = new FakeMouseEvent('submit', { cancelable: true });
    this.dispatchEvent(event);
    if (event.defaultPrevented) this.blockedSubmissions += 1;
    else this.nativeSubmissions += 1;
  }
}

const document = new FakeDocument();
const location = {
  href: 'https://school.mos.ru/test/page/1',
  origin: 'https://school.mos.ru',
  assignments: [],
  assign(url) { this.assignments.push(String(url)); },
};
const window = {
  getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  location,
};
window.window = window;

vm.runInNewContext(scraperSource, {
  window,
  document,
  HTMLElement: FakeHTMLElement,
  EventTarget: FakeEventTarget,
  MouseEvent: FakeMouseEvent,
  chrome: { runtime: { onMessage: { addListener() {} } } },
  crypto: { randomUUID: () => 'test-uuid' },
  location,
  URL,
  AbortController,
  TextDecoder,
  setTimeout,
  clearTimeout,
  console
}, { filename: 'scraper.js' });

// Shared safety floor for every control pagination refuses to activate,
// whatever it is classified as.
function expectNeverActivated(control, discovery, label) {
  assert.equal(discovery.candidateCount, 0, `${label} must not be a Next candidate`);
  assert.equal(discovery.enabledCount, 0, `${label} must not be enabled for pagination`);
  assert.equal(window.__smeshNextClick().status, 'none', `${label} must never be activated`);
  assert.equal(control.nativeClickCount, 0, `${label} must not receive a native programmatic click`);
  assert.equal(control.overriddenClickCount, 0, `${label} must not receive a page-overridden click`);
}

// A control that ENDS the test. Only these may be reported as evidence that the
// student has reached the last page.
function expectFinishControl(control, label) {
  document.candidates = [control];
  const discovery = window.__smeshNextDiscovery();
  assert.equal(discovery.finishCount, 1, `${label} must be reported as a stop/finish control`);
  assert.equal(discovery.blockedCount, 0, `${label} must not be reported as a blocked Next`);
  expectNeverActivated(control, discovery, label);
}

// A real FORWARD control that we refuse to activate because we cannot prove the
// activation is non-submitting. It is not evidence of completion: reporting one
// as 'finish' is what made the autopilot claim it had finished a test it never
// advanced past (Mesh renders «Далее» as a <button>, implicit type=submit).
function expectBlockedControl(control, label) {
  document.candidates = [control];
  const discovery = window.__smeshNextDiscovery();
  assert.equal(discovery.blockedCount, 1, `${label} must be reported as a blocked Next control`);
  assert.equal(discovery.finishCount, 0, `${label} is unpressable, not evidence of test completion`);
  expectNeverActivated(control, discovery, label);
}

expectFinishControl(new FakeHTMLElement('button', { type: 'submit' }, 'Завершить тест'), 'labelled finish button');
expectFinishControl(new FakeHTMLElement('input', { type: 'image', alt: 'Отправить работу' }), 'image submit button');
expectFinishControl(new FakeHTMLElement('button', {}, ''), 'unlabelled default-type button');

expectBlockedControl(new FakeHTMLElement('input', { type: 'submit', value: 'Далее' }), 'submit input');
expectBlockedControl(new FakeHTMLElement('input', { type: 'image', alt: 'Далее' }), 'image submit input');
expectBlockedControl(new FakeHTMLElement('button', {}, 'Далее'), 'default-type button');
expectBlockedControl(new FakeHTMLElement('button', { type: 'not-a-real-state' }, 'Далее'), 'invalid-type button');
expectBlockedControl(new FakeHTMLElement('button', { type: 'submit' }, 'Next'), 'explicit submit button');
expectBlockedControl(
  new FakeHTMLElement('button', { type: 'submit', form: 'external-quiz' }, 'Дальше'),
  'externally form-associated submit button'
);
expectBlockedControl(new FakeHTMLElement('button', { type: 'reset' }, 'Далее'), 'form reset button');

// A nested role=button still activates its enclosing native button in browsers.
// Treat it as unsafe even when only the descendant appears in discovery.
const submitParent = new FakeHTMLElement('button', { type: 'submit' }, '');
const nestedRole = new FakeHTMLElement('span', { role: 'button', tabindex: '0' }, 'Далее');
nestedRole.parentElement = submitParent;
expectBlockedControl(nestedRole, 'descendant of a submit button');

const submitInput = new FakeHTMLElement('input', { type: 'submit', value: 'Далее' });
const submitLabel = new FakeHTMLElement('label', { role: 'button', tabindex: '0' }, 'Далее');
submitLabel.control = submitInput;
expectBlockedControl(submitLabel, 'label associated with a submit input');

expectBlockedControl(
  new FakeHTMLElement('a', { href: 'javascript:document.forms[0].submit()' }, 'Next'),
  'script URL disguised as a Next link'
);

function expectSafeControl(control, label) {
  const assignmentsBefore = location.assignments.length;
  document.candidates = [control];
  const discovery = window.__smeshNextDiscovery();
  assert.equal(discovery.candidateCount, 1, `${label} must remain a Next candidate`);
  assert.equal(discovery.enabledCount, 1, `${label} must remain enabled`);
  assert.equal(discovery.finishCount, 0, `${label} must not look like a finish control`);
  assert.equal(discovery.blockedCount, 0, `${label} must not look like a blocked control`);
  assert.equal(window.__smeshNextClick().status, 'clicked', `${label} must be activated`);
  assert.equal(control.nativeClickCount, 0, `${label} must not dispatch a page-controlled click`);
  assert.equal(control.overriddenClickCount, 0, `${label} must bypass a page-overridden click property`);
  assert.equal(location.assignments.length, assignmentsBefore + 1);
  assert.equal(
    location.assignments.at(-1),
    new URL(control.getAttribute('href'), location.href).href,
    `${label} must navigate directly to its validated destination`,
  );
}

expectSafeControl(new FakeHTMLElement('a', { href: '/test/page/2' }, 'Следующая'), 'numbered Next link');

// Forward controls without a provably safe activation primitive. None may be
// activated, and none may be counted as evidence the test is over.
expectBlockedControl(
  new FakeHTMLElement('a', { href: '/next' }, 'Следующая'),
  'generic redirectable Next endpoint',
);
expectBlockedControl(
  new FakeHTMLElement('button', { type: 'button' }, 'Далее'),
  'page-controlled non-submit button',
);
expectBlockedControl(
  new FakeHTMLElement('button', { type: 'button', form: 'external-quiz' }, 'Дальше'),
  'form-associated non-submit button',
);
expectBlockedControl(
  new FakeHTMLElement('input', { type: 'button', value: 'Next' }),
  'non-submit input button',
);
expectBlockedControl(
  new FakeHTMLElement('div', { role: 'button', tabindex: '0' }, 'Вперёд'),
  'ARIA Next button',
);
expectBlockedControl(
  new FakeHTMLElement('a', { href: 'https://evil.example/next' }, 'Next'),
  'cross-origin Next link',
);
expectBlockedControl(
  new FakeHTMLElement('a', { href: '/submit?next=1' }, 'Next'),
  'mislabelled submit endpoint',
);
expectBlockedControl(
  new FakeHTMLElement('a', { href: '/%73ubmit-test?next=1' }, 'Next'),
  'encoded submit endpoint',
);
for (const route of [
  '/complete', '/result', '/grade', '/send', '/finalize', '/turn-in',
  '/assessment/done', '/quiz/end', '/attempt/close', '/exam/pass',
  '/test/over', '/summary', '/review'
]) {
  expectBlockedControl(
    new FakeHTMLElement('a', { href: route }, 'Далее'),
    `completion-like route ${route}`,
  );
}

// A control the page has DISABLED is the page saying there is nowhere to go —
// the ordinary last-page state, not our refusal to press it. Counting it as
// blocked would turn every final page into "advance it yourself".
const disabledNext = new FakeHTMLElement('button', { type: 'button' }, 'Далее');
disabledNext.disabled = true;
document.candidates = [disabledNext];
const disabledDiscovery = window.__smeshNextDiscovery();
assert.equal(disabledDiscovery.blockedCount, 0, 'a disabled Next must not be reported as blocked');
assert.equal(disabledDiscovery.candidateCount, 0);
assert.equal(disabledDiscovery.enabledCount, 0);

// Discovery authority belongs to one exact same-document question signature.
// If an SPA replaces the question before the separate click injection, the old
// decision must fail closed even when the replacement also has one Next button.
const replacedPageNext = new FakeHTMLElement('a', { href: '/test/page/2' }, 'Далее');
document.candidates = [replacedPageNext];
document.body.innerText = 'ЗАДАНИЕ №7\nСколько будет 2 + 2?';
const discoveredSignature = window.__smeshPageSig();
assert.equal(window.__smeshNextDiscovery().enabledCount, 1);
document.body.innerText = 'ЗАДАНИЕ №8\nСколько будет 9 + 9?';
assert.equal(window.__smeshNextClick(discoveredSignature).status, 'stale');
assert.equal(replacedPageNext.nativeClickCount, 0,
  'a replacement SPA page must not inherit the prior page\'s Next-click authority');

// scrollIntoView can synchronously run page code. Re-check the control after
// scrolling so a safe link changed into a submit endpoint cannot navigate.
const changedDuringScroll = new FakeHTMLElement('a', { href: '/test/page/2' }, 'Далее');
changedDuringScroll.onScroll = () => changedDuringScroll.attrs.set('href', '/submit');
document.candidates = [changedDuringScroll];
assert.equal(window.__smeshNextDiscovery().enabledCount, 1);
assert.equal(window.__smeshNextClick().status, 'none');
assert.equal(changedDuringScroll.nativeClickCount, 0);
assert.equal(changedDuringScroll.overriddenClickCount, 0);

// The same final-boundary check must cover semantic mutation. A button can
// remain type=button while a synchronous re-render turns it into Finish.
const relabelledDuringScroll = new FakeHTMLElement('a', { href: '/test/page/2' }, 'Далее');
relabelledDuringScroll.onScroll = () => { relabelledDuringScroll.textContent = 'Отправить тест'; };
document.candidates = [relabelledDuringScroll];
assert.equal(window.__smeshNextDiscovery().enabledCount, 1);
assert.equal(window.__smeshNextClick().status, 'none');
assert.equal(relabelledDuringScroll.nativeClickCount, 0);

// Even an explicitly non-submit button can run a page handler that calls
// requestSubmit(), including from a later microtask or timer. It is never
// activated, so no handler/default-action guard window can be bypassed.
const scriptedSubmit = new FakeHTMLElement('button', { type: 'button' }, 'Далее');
scriptedSubmit.onNativeClick = () => {
  queueMicrotask(() => document.attemptNativeSubmission());
  setTimeout(() => { document.nativeSubmissions += 1; }, 0); // models event-less form.submit()
};
document.candidates = [scriptedSubmit];
assert.equal(window.__smeshNextClick().status, 'none');
await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(document.nativeSubmissions, 0,
  'pagination must not run handlers that can submit synchronously or later');
assert.equal(document.blockedSubmissions, 0, 'the page handler must never run');
assert.equal(scriptedSubmit.nativeClickCount, 0);

// The same signature is also the post-AI capture guard. A visible countdown
// must not make every otherwise unchanged solve look stale, while a changed
// question still must produce a different signature.
document.candidates = [];
document.body.innerText = 'ЗАДАНИЕ №1\nСколько будет 2 + 2?\nОсталось 09:59';
const timedSignature = window.__smeshPageSig();
document.body.innerText = 'ЗАДАНИЕ №1\nСколько будет 2 + 2?\nОсталось 09:58';
assert.equal(window.__smeshPageSig(), timedSignature,
  'countdown ticks must not invalidate a capture of the same question');
document.body.innerText = 'ЗАДАНИЕ №2\nСколько будет 3 + 3?\nОсталось 09:58';
assert.notEqual(window.__smeshPageSig(), timedSignature,
  'question changes must still invalidate the captured signature');

console.log('test pagination submit-safety regression passed');
