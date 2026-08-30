import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pillSource = readFileSync(new URL('../src/content/test-pill.js', import.meta.url), 'utf8');

// The pill inlines SHOW_PROVIDER_UI (a content script can't import config.js).
// ai-provider-regression asserts the two stay in sync; here it decides whether
// the vendor tag should be painted at all.
const PILL_SHOWS_PROVIDER = pillSource.includes('const SHOW_PROVIDER_UI = true;');

/**
 * The pill tracks the active provider whether or not it paints one. When the
 * tag is on, assert the rendered abbreviation; when it's off, assert nothing
 * leaked into the shadow root — the tracked value is checked via the solve
 * payload instead.
 */
function assertPillProvider(host, expectedAbbr) {
  assert.equal(
    host.shadow.nodes.provider.textContent,
    PILL_SHOWS_PROVIDER ? expectedAbbr : '',
    PILL_SHOWS_PROVIDER
      ? `pill must show ${expectedAbbr}`
      : 'the pill must not paint a vendor tag onto the Mesh page'
  );
}

// The closed shadow root hides its controls, but the page still owns the
// anonymous host's computed style. Keep the security-critical host geometry
// authoritative so page CSS cannot invisibly move a paid action over a decoy.
for (const declaration of [
  'all: initial', 'position: fixed', 'inset: 0 auto auto 0',
  'width: 0', 'height: 0', 'z-index: 2147483647',
  'pointer-events: none', 'opacity: 1', 'visibility: visible',
  'transform: none', 'filter: none', 'clip: auto', 'clip-path: none'
]) {
  assert.match(
    pillSource,
    new RegExp(`${declaration.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*!important`),
    `the privileged pill host must pin ${declaration} with !important`
  );
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function fakeClassList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
    contains: (name) => values.has(name)
  };
}

function createHarness({ deferredReads = false, deferredTokens = false } = {}) {
  const readRequests = [];
  const pendingSolves = [];
  const pendingTokens = [];
  const hosts = [];
  const windowListeners = new Map();
  let storageListener = null;
  let frames = ['https://uchebnik.mos.ru/player'];
  let panelHideCalls = 0;
  let nextTimer = 1;

  const location = {};
  const setUrl = (raw) => {
    const url = new URL(raw);
    location.href = url.href;
    location.pathname = url.pathname;
    location.search = url.search;
  };
  setUrl('https://school.mos.ru/lesson?lesson_id=42');

  const addWindowListener = (type, callback) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set());
    windowListeners.get(type).add(callback);
  };
  const removeWindowListener = (type, callback) => windowListeners.get(type)?.delete(callback);

  function makeNode(host) {
    const listeners = new Map();
    const node = {
      style: {},
      dataset: {},
      classList: fakeClassList(),
      textContent: '',
      disabled: false,
      offsetWidth: 220,
      offsetHeight: 48,
      complete: false,
      naturalWidth: 32,
      addEventListener(type, callback) { listeners.set(type, callback); },
      querySelector() { return null; },
      getBoundingClientRect() { return { left: 20, top: 20 }; },
      __listener(type) { return listeners.get(type); }
    };
    Object.defineProperty(node, 'isConnected', { get: () => host.connected });
    return node;
  }

  function makeHost() {
    const host = {
      connected: false,
      removeCalls: 0,
      shadow: null,
      remove() {
        this.connected = false;
        this.removeCalls++;
      },
      attachShadow() {
        const pill = makeNode(host);
        const status = makeNode(host);
        const provider = makeNode(host);
        const image = makeNode(host);
        const pageButton = makeNode(host);
        const allButton = makeNode(host);
        const closeButton = makeNode(host);
        pill.querySelector = (selector) => ({
          '.act-page': pageButton,
          '.act-all': allButton,
          '.close': closeButton
        })[selector] || null;
        let html = '';
        const shadow = {
          renderCount: 0,
          nodes: { pill, status, provider, image, pageButton, allButton, closeButton },
          set innerHTML(value) {
            html = value;
            this.renderCount++;
            pill.dataset.theme = value.match(/class="pill" data-theme="([^"]+)"/)?.[1];
            provider.textContent = value.match(/class="prov"[^>]*>([^<]*)</)?.[1] || '';
          },
          get innerHTML() { return html; },
          querySelector(selector) {
            return ({
              '.pill': pill,
              '.stext': status,
              '.prov': provider,
              '.grip img': image
            })[selector] || null;
          },
          querySelectorAll(selector) {
            return selector === '.actions button' ? [pageButton, allButton, closeButton] : [];
          }
        };
        host.shadow = shadow;
        return shadow;
      }
    };
    hosts.push(host);
    return host;
  }

  const documentElement = {
    contains: (node) => !!node?.connected,
    appendChild(host) { host.connected = true; }
  };
  const document = {
    fonts: null,
    documentElement,
    querySelectorAll(selector) {
      assert.equal(selector, 'iframe[src]');
      return frames.map((src) => ({ getAttribute: () => src }));
    },
    createElement(tag) {
      assert.equal(tag, 'div');
      return makeHost();
    }
  };

  const sessionValues = {
    smeshTestPill2: { x: 4, y: 5 },
    theme: 'light',
    aiProvider: 'openrouter'
  };
  const deliverRead = (key, callback) => {
    callback({ [key]: sessionValues[key] });
  };
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener() {} },
      sendMessage(message, callback) {
        if (message.type === 'GET_ACTION_TOKEN') {
          if (deferredTokens) pendingTokens.push({ message, callback });
          else queueMicrotask(() => callback({ ok: true, token: 'token' }));
        } else {
          pendingSolves.push({ message, callback });
        }
      }
    },
    storage: {
      session: {
        get(key, callback) {
          if (deferredReads) readRequests.push({ key, callback });
          else queueMicrotask(() => deliverRead(key, callback));
        },
        set(values) { Object.assign(sessionValues, values); return Promise.resolve(); }
      },
      onChanged: { addListener(callback) { storageListener = callback; } }
    }
  };

  const darkMedia = { matches: false, addEventListener() {} };
  const window = {
    matchMedia: () => darkMedia,
    addEventListener: addWindowListener,
    removeEventListener: removeWindowListener,
    __smeshPanel: { hide() { panelHideCalls++; } }
  };
  window.window = window;

  const context = {
    window,
    location,
    document,
    chrome,
    innerWidth: 1280,
    innerHeight: 800,
    setInterval: () => nextTimer++,
    clearInterval() {},
    setTimeout: () => nextTimer++,
    clearTimeout() {},
    queueMicrotask,
    console
  };
  vm.runInNewContext(pillSource, context, { filename: 'test-pill.js' });

  return {
    pillApi: window.__smeshPill,
    hosts,
    readRequests,
    pendingSolves,
    setFrames(next) { frames = next; },
    setUrl,
    emitSessionChanges(changes) {
      assert.ok(storageListener, 'storage listener must be wired before initial reads settle');
      storageListener(changes, 'session');
    },
    resolveRead(index, value) {
      const request = readRequests[index];
      assert.ok(request, `missing storage read ${index}`);
      request.callback(value);
    },
    pendingTokens,
    resolveToken(index, value) {
      const request = pendingTokens[index];
      assert.ok(request, `missing action-token request ${index}`);
      request.callback(value);
    },
    emitWindowEvent(type, event) {
      const listeners = windowListeners.get(type);
      assert.ok(listeners?.size, `no window listener registered for ${type}`);
      for (const listener of [...listeners]) listener(event);
    },
    latestHost: () => hosts[hosts.length - 1],
    panelHideCalls: () => panelHideCalls
  };
}

// Detection can disappear and return while the first build is awaiting storage.
// The old build must never inherit the new build's `built=true`, and storage
// events delivered after each get started must beat both stale snapshots.
{
  const h = createHarness({ deferredReads: true });
  assert.equal(h.readRequests.length, 3, 'initial build must request state, theme and provider');

  h.setFrames([]); // same URL, but weak test detection is now gone
  h.pillApi.evaluate();
  h.setFrames(['https://uchebnik.mos.ru/player']);
  h.pillApi.evaluate();
  assert.equal(h.readRequests.length, 6, 'returning detection must start a new lifecycle build');

  h.emitSessionChanges({
    smeshTestPill2: { newValue: { x: 88, y: 66 } },
    theme: { newValue: 'dark' },
    aiProvider: { newValue: 'groq' }
  });

  // Resolve the NEW build with older snapshots. Revisions make the storage
  // event authoritative, so the first rendered pill uses the event values.
  h.resolveRead(3, { smeshTestPill2: { x: 1, y: 2 } });
  h.resolveRead(4, { theme: 'light' });
  h.resolveRead(5, { aiProvider: 'openrouter' });
  await flushMicrotasks();
  const host = h.latestHost();
  assert.equal(h.hosts.length, 1);
  assert.equal(host.shadow.renderCount, 1);
  assert.equal(host.shadow.nodes.pill.style.left, '88px');
  assert.equal(host.shadow.nodes.pill.style.top, '66px');
  assert.equal(host.shadow.nodes.pill.dataset.theme, 'dark');
  assertPillProvider(host, 'GRQ');

  // Resolving the abandoned generation last must neither repaint state nor run
  // its stale build continuation against the newer host.
  h.resolveRead(0, { smeshTestPill2: { x: 7, y: 8 } });
  h.resolveRead(1, { theme: 'light' });
  h.resolveRead(2, { aiProvider: 'deepseek' });
  await flushMicrotasks();
  assert.equal(host.shadow.renderCount, 1, 'an abandoned build must not render into the new lifecycle');
  assert.equal(host.shadow.nodes.pill.style.left, '88px');
  assert.equal(host.shadow.nodes.pill.dataset.theme, 'dark');
  assertPillProvider(host, 'GRQ');

  // The provider the pill settled on is what rides the solve request, so a
  // stale snapshot winning here would send the worker to the wrong backend.
  host.shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();
  const solve = h.pendingSolves.find((e) => e.message.type === 'PILL_SOLVE_PAGE');
  assert.equal(solve?.message.payload.provider, 'groq',
    'the solve payload must carry the event-provided provider, not the stale read');
}

// A route change owns the UI immediately, even while a privileged solve message
// is still pending. Its eventual reply cannot mutate the pill rebuilt on the new
// route; later detection loss removes that replacement too.
{
  const h = createHarness();
  await flushMicrotasks();
  const oldHost = h.latestHost();
  assert.ok(oldHost?.connected);
  oldHost.shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();
  assert.equal(h.pendingSolves.length, 1, 'solve must still be in flight for the route race');
  assert.equal(oldHost.shadow.nodes.pill.classList.contains('busy'), true);

  h.setUrl('https://school.mos.ru/course/cwork?id=next');
  h.setFrames([]);
  h.pillApi.evaluate();
  assert.equal(oldHost.connected, false, 'route change must remove a busy old pill synchronously');
  assert.ok(h.panelHideCalls() >= 1, 'route teardown must hide the page-bound answer panel too');
  await flushMicrotasks();

  const newHost = h.latestHost();
  assert.notEqual(newHost, oldHost);
  assert.ok(newHost.connected, 'a detected new test route may mount a fresh pill');
  const newStatusBefore = newHost.shadow.nodes.status.textContent;
  h.pendingSolves[0].callback({ ok: true, count: 1, summary: { filled: ['1'], skipped: [] } });
  await flushMicrotasks();
  assert.equal(newHost.shadow.nodes.status.textContent, newStatusBefore,
    'the old route solve reply must not paint the new route pill');
  assert.equal(newHost.shadow.nodes.pill.classList.contains('result'), false);

  h.setUrl('https://school.mos.ru/home');
  h.pillApi.evaluate();
  assert.equal(newHost.connected, false, 'detection loss must remove the current pill');
}

// Closing the pill must CANCEL the worker's run, not just remove local UI.
// Previously ×, Esc, route loss and page teardown all left the worker solving,
// filling, navigating and spending for up to 30 pages against a page the
// student believed they had stopped — and the hidden answer panel could
// reappear mid-run.
for (const [label, stop] of [
  ['panic hide (× / Esc)', (h) => h.pillApi.hide()],
  ['detection loss', (h) => { h.setFrames([]); h.pillApi.evaluate(); }],
  ['page teardown', (h) => h.emitWindowEvent('pagehide', {})]
]) {
  const h = createHarness();
  await flushMicrotasks();
  h.latestHost().shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();

  const solve = h.pendingSolves.find((entry) => entry.message.type === 'PILL_SOLVE_PAGE');
  assert.ok(solve, `${label}: a solve must be in flight`);
  const opId = solve.message.payload?.opId;
  assert.ok(opId, `${label}: every run must be named so it can be cancelled`);

  stop(h);
  const cancel = h.pendingSolves.find((entry) => entry.message.type === 'PILL_CANCEL');
  assert.ok(cancel, `${label}: closing the pill must tell the worker to stop`);
  assert.equal(cancel.message.payload?.opId, opId,
    `${label}: the cancel must name the run that is actually in flight`);
  assert.equal(cancel.message.token, undefined,
    `${label}: cancelling must not depend on a capability token`);

  // A second teardown must not cancel anything else — a stale cancel could
  // otherwise kill a later, unrelated run.
  const before = h.pendingSolves.filter((entry) => entry.message.type === 'PILL_CANCEL').length;
  stop(h);
  assert.equal(
    h.pendingSolves.filter((entry) => entry.message.type === 'PILL_CANCEL').length, before,
    `${label}: cancellation must not repeat once the run is released`
  );
}

// Closing during the ACTION-TOKEN round trip must cancel too. The token
// request is an await, and allocating the operation id after it left a window
// where teardown found nothing to cancel — so no cancel was sent AND the
// operation still started once the token resolved.
{
  const h = createHarness({ deferredTokens: true });
  await flushMicrotasks();
  h.latestHost().shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();

  assert.equal(h.pendingSolves.length, 0, 'no solve may be sent before the token arrives');
  assert.equal(h.pendingTokens.length, 1, 'the token request must be in flight');

  // Tear the pill down while the token is still pending.
  h.pillApi.hide();
  const cancel = h.pendingSolves.find((entry) => entry.message.type === 'PILL_CANCEL');
  assert.ok(cancel, 'teardown during the token wait must still cancel the run');
  const cancelledOpId = cancel.message.payload?.opId;
  assert.ok(cancelledOpId, 'the run must already be named at that point');

  // Now let the token resolve: the abandoned run must NOT be dispatched.
  h.resolveToken(0, { ok: true, token: 'token' });
  await flushMicrotasks();
  assert.equal(
    h.pendingSolves.filter((entry) => entry.message.type === 'PILL_SOLVE_PAGE').length, 0,
    'a run abandoned during the token wait must never reach the worker'
  );
}

// The worker must refuse a solve whose cancel overtook it, and must hand the
// operation signal to the PAID provider call, not only to the page effects.
{
  const workerSource = readFileSync(
    new URL('../src/background/service-worker.js', import.meta.url), 'utf8'
  );
  assert.match(workerSource, /if \(id && preCancelledPillOps\.delete\(id\)\) return null;/,
    'a cancel that arrives before the solve message must block that operation');
  // Matched field-wise rather than as one exact literal: the argument object
  // also carries the owner-diagnostics `pageUrl`, which never reaches a
  // provider. What must not drift is that the media and cancellation signals
  // are still handed down.
  assert.match(workerSource,
    /const answer = await solveTest\(\{\s*text: pageText, hasVisualMedia, provider, signal[,\s}]/,
    'the pill solve must hand its media signal and cancellation signal to solveTest');
  assert.match(workerSource,
    /async function solveTest\(\{ text, screenshot, hasVisualMedia = false, provider, signal = null[,\s}]/,
    'solveTest must accept a signal');
  const askOpts = workerSource.slice(
    workerSource.indexOf('const askOpts = {'),
    workerSource.indexOf('if (providerOverride) askOpts.provider')
  );
  assert.match(askOpts, /\n\s*signal,/,
    'solveTest must forward the signal to askAI so a cancelled solve stops spending');
}

console.log('test pill lifecycle regressions passed');
