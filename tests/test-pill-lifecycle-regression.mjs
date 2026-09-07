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
  // The detection poll is the only 1200 ms interval the pill starts on a Mesh
  // page; startThinking() creates the rest. Tracking both ends lets the
  // context-loss tests prove an orphaned script actually stops polling.
  const intervals = [];
  const clearedIntervals = [];
  // Armed setTimeout callbacks, so a test can advance time. showResult() uses
  // one to return the pill to idle and re-enable its buttons a few seconds
  // later — the exact behaviour a terminal state has to suppress.
  const timeouts = new Map();

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
            // Only «Решить» and «все страницы» live in .actions — the × sits
            // outside it in the real markup, so disabling the actions never
            // takes away the student's way out of a stuck pill.
            return selector === '.actions button' ? [pageButton, allButton] : [];
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
      // Present on every live content script — the pill reads it to decide
      // whether the extension is still there. See handleContextLoss().
      id: 'smeshid',
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
    setInterval: (fn, ms) => {
      const id = nextTimer++;
      intervals.push({ id, fn, ms });
      return id;
    },
    clearInterval: (id) => { clearedIntervals.push(id); },
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { timeouts.delete(id); },
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
    panelHideCalls: () => panelHideCalls,
    // Reproduce an extension reload/update: Chrome invalidates the context of
    // every content script already in the page, and chrome.runtime.id — which
    // the pill probes — goes undefined. Nothing else about the page changes,
    // which is exactly what makes the failure so easy to miss.
    killContext() { chrome.runtime.id = undefined; },
    pollTimer: () => intervals.find((entry) => entry.ms === 1200),
    clearedIntervals: () => clearedIntervals,
    armedTimeouts: () => timeouts.size,
    // Let every armed timer fire, the way the clock eventually would.
    fireArmedTimeouts() {
      const armed = [...timeouts.values()];
      timeouts.clear();
      for (const entry of armed) entry.fn();
      return armed.length;
    }
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

/* ============ Extension context loss (reload / update under an open tab) ============
 *
 * Chrome does not re-inject content scripts into tabs that are already open, so
 * an extension reload or auto-update leaves this script orphaned and permanently
 * unable to reach the worker. Nothing about the page signals it: every storage
 * read here is try/catch'd and falls back to defaults, so the pill used to keep
 * mounting, keep looking ready, and answer each click with «Соединение с
 * расширением прервалось. Попробуйте ещё раз.» — advice that cannot ever work.
 */

const CONTEXT_LOST = 'Расширение обновилось. Обновите страницу (F5).';

// An orphaned pill stops polling, stops offering its actions, and says the one
// thing that fixes it — while leaving the answers already on screen alone.
{
  const h = createHarness();
  await flushMicrotasks();
  const host = h.latestHost();
  assert.ok(host?.connected, 'the pill must be mounted before the extension goes away');
  const poll = h.pollTimer();
  assert.ok(poll, 'the Mesh detection poll must be running');

  h.killContext();
  h.pillApi.evaluate(); // the next poll tick

  assert.ok(host.connected,
    'a pill that is already on screen must stay to explain itself, not vanish silently');
  assert.equal(host.shadow.nodes.status.textContent, CONTEXT_LOST,
    'an orphaned pill must name the reload, not offer a retry that cannot work');
  assert.equal(host.shadow.nodes.pageButton.disabled, true,
    '«Решить» must be retired once no click can reach the worker');
  assert.equal(host.shadow.nodes.allButton.disabled, true,
    '«все страницы» must be retired too');
  assert.equal(host.shadow.nodes.closeButton.disabled, false,
    'the student must still be able to dismiss a dead pill');
  assert.ok(h.clearedIntervals().includes(poll.id),
    'the detection poll must stop: it can never bring the pill back');
  assert.equal(h.panelHideCalls(), 0,
    'the answers already on screen stay valid — context loss must not hide the panel');

  // Later ticks must not repaint or clear it either.
  h.pillApi.evaluate();
  assert.equal(host.shadow.nodes.status.textContent, CONTEXT_LOST,
    'later ticks must not repaint or clear the terminal message');
  assert.equal(host.shadow.nodes.pageButton.disabled, true,
    'the buttons must not come back');
}

// The terminal state has to survive the clock. An ordinary error schedules
// showResult's return to idle a few seconds out, and toIdle() re-enables the
// buttons — so context loss arriving while that timer is armed must disarm it.
// Otherwise the message reads "обновите страницу" while the buttons quietly
// light up again underneath it, inviting the click that started all this.
{
  const h = createHarness();
  await flushMicrotasks();
  const host = h.latestHost();
  host.shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();

  // A transient failure first: this is what arms the return-to-idle timer.
  const solve = h.pendingSolves.find((entry) => entry.message.type === 'PILL_SOLVE_PAGE');
  assert.ok(solve, 'the solve must be in flight');
  solve.callback({ ok: false, error: 'нет связи с сервером' });
  await flushMicrotasks();
  assert.equal(host.shadow.nodes.pageButton.disabled, true,
    'the buttons stay down while the error is on screen');
  assert.ok(h.armedTimeouts() > 0,
    'an ordinary error must arm the return-to-idle timer this case depends on');

  // ...and now the extension goes away before that timer fires.
  h.killContext();
  h.pillApi.evaluate();
  assert.equal(host.shadow.nodes.status.textContent, CONTEXT_LOST);

  h.fireArmedTimeouts();
  assert.equal(host.shadow.nodes.status.textContent, CONTEXT_LOST,
    'the clock must not wipe the terminal message');
  assert.equal(host.shadow.nodes.pageButton.disabled, true,
    'and must not re-enable a button that can never work again');
}

// Same rule when the pill is NOT on screen — the student pressed × or Esc but
// left the answer panel up to copy from. Context loss tears down the pill's own
// remains silently, and must still leave those answers where they are: they were
// solved and paid for, and nothing about them stopped being true.
{
  const h = createHarness();
  await flushMicrotasks();
  h.pillApi.hide();
  const hidesAfterClose = h.panelHideCalls();

  h.killContext();
  h.pillApi.evaluate();
  assert.equal(h.panelHideCalls(), hidesAfterClose,
    'losing the extension must not take the answer panel down with it');
}

// The route watcher must not rebuild a working-looking pill after the extension
// is gone. This is the case that actually reaches students: the tab was open,
// СМЭШ auto-updated, and the next SPA navigation into a test mounted a fresh
// pill whose every button was already dead.
{
  const h = createHarness();
  await flushMicrotasks();
  const before = h.hosts.length;
  h.killContext();
  h.pillApi.evaluate();

  h.setUrl('https://school.mos.ru/course/cwork?id=next');
  h.pillApi.evaluate();
  await flushMicrotasks();
  assert.equal(h.hosts.length, before,
    'an orphaned script must never mount a fresh pill on a new route');
}

// A click that lands before the poll notices must fail instantly with the same
// message — not burn the 5-second action-token timeout and then report a
// generic timeout, which reads as a network problem and sends the student off
// to check their connection.
{
  const h = createHarness();
  await flushMicrotasks();
  const host = h.latestHost();
  h.killContext();

  host.shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();

  assert.equal(h.pendingTokens.length, 0,
    'no action token may be requested through a dead runtime');
  assert.equal(h.pendingSolves.length, 0, 'and no solve may be attempted');
  assert.equal(host.shadow.nodes.status.textContent, CONTEXT_LOST,
    'a click after context loss must report the reload immediately');
  assert.equal(host.shadow.nodes.pageButton.disabled, true,
    'and must not re-arm the button');
}

// The other half of the split: a LIVE extension whose worker merely dropped the
// reply is genuinely retryable, and must keep saying so. The two failures are
// indistinguishable by error text — "message port closed" is what Chrome
// reports for both — so only the runtime probe separates them.
{
  const h = createHarness();
  await flushMicrotasks();
  const host = h.latestHost();
  host.shadow.nodes.pageButton.__listener('click')({ isTrusted: true });
  await flushMicrotasks();

  const solve = h.pendingSolves.find((entry) => entry.message.type === 'PILL_SOLVE_PAGE');
  assert.ok(solve, 'the solve must have reached the worker while the context was live');
  solve.callback({
    ok: false,
    error: 'The message port closed before a response was received.'
  });
  await flushMicrotasks();

  assert.equal(
    host.shadow.nodes.status.textContent,
    'Соединение с расширением прервалось. Попробуйте ещё раз.',
    'a recycled worker on a live extension must still invite a retry'
  );
  assert.equal(host.shadow.nodes.pill.classList.contains('result'), true,
    'and must land in the ordinary, expiring error state');
}

// The answer panel is the other surface a student touches after a solve, and it
// carries the same orphaning risk. Its answers are plain text by then, so it
// must retire only the two worker-backed controls and keep the panel readable.
{
  const panelSource = readFileSync(
    new URL('../src/content/answer-panel.js', import.meta.url), 'utf8'
  );
  assert.match(panelSource, /function contextAlive\(\)\s*\{\s*try \{ return !!chrome\.runtime\?\.id; \}/,
    'the panel must probe the runtime id the same way the pill does');
  assert.match(panelSource, /if \(!contextAlive\(\)\) \{ noteContextLoss\(\); return; \}/g,
    'a failed fill must check for a dead context before painting a transient error');
  assert.equal(
    (panelSource.match(/if \(!contextAlive\(\)\) \{ noteContextLoss\(\); return; \}/g) || []).length,
    2,
    'both worker-backed controls (fill and per-line resolve) must check'
  );
  assert.doesNotMatch(panelSource, /\.ai-note'\)[^\n]*\.textContent =/,
    'the standing «Это ИИ» disclaimer must not be overwritten by the status note');
  assert.match(panelSource, /body\.appendChild\(note\);/,
    'the status note must be appended alongside that disclaimer, not replace it');

  // «Заполнить» and every ↻ must be both inert AND visibly retired. Disabling
  // alone left them at full strength with a live hover, still reading as ready.
  const retire = panelSource.slice(
    panelSource.indexOf('function noteContextLoss()'),
    panelSource.indexOf('// Fill the test form.')
  );
  for (const control of ['.btn-fill', '.btn-resolve']) {
    assert.ok(retire.includes(control), `noteContextLoss must reach ${control}`);
  }
  assert.equal((retire.match(/classList\.add\('retired'\)/g) || []).length, 2,
    'both control families must be marked retired, not merely disabled');
  assert.match(panelSource, /button\.retired \{ opacity: 0\.5; cursor: default; \}/,
    'the retired class must actually mute the control');
  // Scoped to `.retired`, never to :disabled — an ordinary in-flight fill
  // disables the button too, and that state must keep looking untouched.
  assert.doesNotMatch(panelSource, /\bbutton:disabled \{ opacity/,
    'the ordinary mid-fill disabled state must not be restyled by this fix');
}

console.log('test pill lifecycle regressions passed');
