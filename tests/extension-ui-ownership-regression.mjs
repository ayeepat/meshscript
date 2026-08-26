import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { SHOW_PROVIDER_UI, DEFAULT_PROVIDER } from '../src/lib/config.js';

const answerPanelSource = readFileSync(
  new URL('../src/content/answer-panel.js', import.meta.url),
  'utf8'
);
const settingsSource = readFileSync(
  new URL('../src/settings/settings.js', import.meta.url),
  'utf8'
);
const dashboardSource = readFileSync(
  new URL('../src/dashboard/dashboard.js', import.meta.url),
  'utf8'
);

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return source.slice(start, end);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

// Rebuilding or hiding the answer panel during a drag must remove every
// window-level capture listener. A late mouseup from that cancelled gesture
// must not persist coordinates from a detached panel.
{
  const dragSource = sourceSection(
    answerPanelSource,
    'function wireDrag(panel)',
    '// Paint the ✓'
  );
  const listeners = new Map();
  const barListeners = new Map();
  const classes = new Set();
  let saves = 0;
  const bar = {
    addEventListener(type, callback) { barListeners.set(type, callback); },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
    },
  };
  const panel = {
    isConnected: true,
    offsetWidth: 400,
    style: {},
    querySelector: () => bar,
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
  };
  const context = {
    innerWidth: 1200,
    innerHeight: 800,
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    saveState() { saves += 1; },
    window: {
      addEventListener(type, callback) {
        const set = listeners.get(type) || new Set();
        set.add(callback);
        listeners.set(type, set);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    },
  };
  vm.runInNewContext(
    `let activeDragCleanup = null;
     let state = { x: null, y: null, minimized: false };
     ${dragSource}
     globalThis.__dragApi = { wireDrag, cancelActiveDrag, state: () => state };`,
    context,
    { filename: 'answer-panel-drag.js' }
  );

  context.__dragApi.wireDrag(panel);
  const down = barListeners.get('mousedown');
  down({
    button: 0,
    target: { closest: () => null },
    clientX: 100,
    clientY: 100,
    preventDefault() {},
  });
  const staleMouseup = [...listeners.get('mouseup')][0];
  assert.equal(listeners.get('mousemove').size, 1);
  assert.equal(listeners.get('mouseup').size, 1);
  assert.equal(listeners.get('blur').size, 1);
  assert.equal(classes.has('dragging'), true);

  context.__dragApi.cancelActiveDrag();
  assert.equal(listeners.get('mousemove').size, 0);
  assert.equal(listeners.get('mouseup').size, 0);
  assert.equal(listeners.get('blur').size, 0);
  assert.equal(classes.has('dragging'), false);
  assert.equal(saves, 0, 'teardown is not a completed user drag and must not persist');
  staleMouseup();
  assert.equal(saves, 0, 'a stale mouseup must be inert after cancellation');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__dragApi.state())),
    { x: null, y: null, minimized: false }
  );

  down({
    button: 0,
    target: { closest: () => null },
    clientX: 100,
    clientY: 100,
    preventDefault() {},
  });
  panel.isConnected = false;
  [...listeners.get('mousemove')][0]({ clientX: 140, clientY: 150 });
  assert.equal(listeners.get('mousemove').size, 0,
    'a detached panel must tear down capture on the next move');
  assert.equal(saves, 0, 'detached coordinates must never overwrite saved state');
}
assert.match(
  sourceSection(answerPanelSource, 'function buildPanel(', 'function positionPanel('),
  /cancelActiveDrag\(\)/,
  'panel replacement must cancel an active drag before rebuilding the Shadow DOM'
);
assert.match(
  sourceSection(answerPanelSource, 'function hide(', 'window.__smeshPanel'),
  /cancelActiveDrag\(\)/,
  'panel hide must cancel active global drag listeners'
);

// Two usage refreshes are deliberately completed newest-first. The stale-key
// response from the older refresh must not create a mixed snapshot or repaint
// the valid balance/history from the newer key.
{
  const stateSource = sourceSection(
    settingsSource,
    'let reqHistory =',
    '// The chart shows ONE series'
  );
  const refreshSource = sourceSection(
    settingsSource,
    'async function refreshUsageDashboard()',
    'async function ensureUsageDashboard('
  );
  const credits = [deferred(), deferred()];
  // Carry every provider so the fixture matches whichever series
  // refreshUsageDashboard reads for the "Сегодня" tile — that depends on
  // config.SHOW_PROVIDER_UI, and this test is about the generation race, not
  // about which provider is on screen.
  const usageFrame = (used, limit) => ({
    openrouter: { used, limit },
    groq: { used, limit },
    qwen: { used, limit },
    deepseek: { used, limit },
  });
  const usages = [usageFrame(1, 10), usageFrame(2, 20)];
  const histories = [
    [{ day: 'old', openrouter: 1 }],
    [{ day: 'new', openrouter: 2 }],
  ];
  let usageCall = 0;
  let historyCall = 0;
  let creditsCall = 0;
  const today = { textContent: '' };
  const paints = [];
  const context = {
    Promise,
    SHOW_PROVIDER_UI,
    DEFAULT_PROVIDER,
    getUsage: () => Promise.resolve(usages[usageCall++]),
    getUsageHistory: () => Promise.resolve(histories[historyCall++]),
    fetchCredits: () => credits[creditsCall++].promise,
    document: { getElementById: (id) => {
      assert.equal(id, 'orToday');
      return today;
    } },
    renderSpend(value) { paints.push({ type: 'spend', value }); },
    renderChart(mode) { paints.push({ type: 'chart', mode }); },
  };
  vm.runInNewContext(
    `let usageDashboardLoaded = true;
     let chartMode = 'openrouter';
     ${stateSource}
     ${refreshSource}
     globalThis.__usageApi = {
       refreshUsageDashboard,
       reqHistory: () => reqHistory,
       spendHistory: () => spendHistory,
       loaded: () => usageDashboardLoaded,
     };`,
    context,
    { filename: 'settings-usage-generation.js' }
  );

  const oldRefresh = context.__usageApi.refreshUsageDashboard();
  await flushMicrotasks();
  const newRefresh = context.__usageApi.refreshUsageDashboard();
  await flushMicrotasks();
  assert.equal(creditsCall, 2, 'both overlapping refreshes must reach their credit request');

  const currentCredits = {
    ok: true,
    usage: 2,
    remaining: 18,
    spendHistory: [{ day: 'new', spend: 2 }],
  };
  credits[1].resolve(currentCredits);
  assert.equal(await newRefresh, true);
  assert.equal(today.textContent, '2 / 20');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__usageApi.reqHistory())),
    histories[1]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__usageApi.spendHistory())),
    currentCredits.spendHistory
  );
  assert.equal(paints.length, 2);

  credits[0].resolve({ ok: false, reason: 'stale_key', spendHistory: [] });
  assert.equal(await oldRefresh, false);
  assert.equal(today.textContent, '2 / 20');
  assert.equal(paints.length, 2, 'the older completion must not repaint either widget');
  assert.equal(context.__usageApi.loaded(), true,
    'a stale completion must not mark a newer successful dashboard unloaded');
}

const operationSource = sourceSection(
  dashboardSource,
  'function beginChatOperation(',
  '/** Re-render the whole chat'
);
const startLessonSource = sourceSection(
  dashboardSource,
  'async function startLesson(',
  'async function activateLesson('
);

function createStartupHarness(gdzResult) {
  const gdz = deferred();
  const sends = [];
  const tickerStops = [];
  const context = {
    Promise,
    Symbol,
    launchPayload: { scanId: 'scan-1', rowToken: 'row-1' },
    initialFiles: [],
    activeKey: 'lesson-1',
    sameMeshRow: () => true,
    maybeShowGdz: () => gdz.promise,
    thinkingBubble: () => ({
      remove() {},
      __ticker: { stop() { tickerStops.push('stop'); } },
    }),
    stopThinking(chat, owner = null) {
      if (owner != null && chat.thinkingOwner !== owner) return;
      chat.thinkingEl?.__ticker?.stop();
      chat.thinkingEl?.remove();
      chat.thinkingEl = null;
      chat.thinkingOwner = null;
    },
    renderSidebar() {},
    async sendToChat(chat, task, files, owner) {
      sends.push({ chat, task, files, owner });
      assert.equal(chat.pendingOwner, owner,
        'startup must hand the same owner into the solve');
      context.__startupApi.releaseChatOperation(chat, owner);
      return true;
    },
  };
  vm.runInNewContext(
    `${operationSource}
     ${startLessonSource}
     globalThis.__startupApi = {
       startLesson, releaseChatOperation, ownsChatOperation,
     };`,
    context,
    { filename: 'dashboard-startup-ownership.js' }
  );
  return { context, gdz, sends, tickerStops, gdzResult };
}

// First-open discovery owns pending state immediately, before its network await,
// so the composer cannot launch a second solve in the same chat.
{
  const { context, gdz, sends } = createStartupHarness(false);
  const chat = {
    key: 'lesson-1',
    task: 'Решить 2 + 2',
    history: [],
    started: false,
    pending: false,
    pendingOwner: null,
    thinkingOwner: null,
    rowToken: 'row-1',
    scanId: 'scan-1',
  };
  const starting = context.__startupApi.startLesson(chat);
  const startupOwner = chat.pendingOwner;
  assert.equal(chat.pending, true, 'GDZ discovery must mark the chat pending synchronously');
  assert.equal(typeof startupOwner, 'symbol');

  // Model a defensive supersession and then finish the older discovery. Its
  // continuation/finally must not clear or send through the newer owner.
  const newerOwner = Symbol('newer-operation');
  chat.pendingOwner = newerOwner;
  chat.thinkingOwner = newerOwner;
  chat.pending = true;
  gdz.resolve(false);
  assert.equal(await starting, false);
  assert.equal(chat.pending, true);
  assert.equal(chat.pendingOwner, newerOwner);
  assert.equal(chat.thinkingOwner, newerOwner);
  assert.equal(sends.length, 0, 'stale discovery must not auto-send the task');
}

// The normal path hands ownership into exactly one solve and releases it there.
{
  const { context, gdz, sends } = createStartupHarness(false);
  const chat = {
    key: 'lesson-1',
    task: 'Решить 2 + 2',
    history: [],
    started: false,
    pending: false,
    pendingOwner: null,
    thinkingOwner: null,
    rowToken: 'row-1',
    scanId: 'scan-1',
  };
  const starting = context.__startupApi.startLesson(chat);
  assert.equal(chat.pending, true);
  gdz.resolve(false);
  assert.equal(await starting, true);
  assert.equal(sends.length, 1);
  assert.equal(chat.pending, false);
  assert.equal(chat.pendingOwner, null);
  assert.equal(chat.thinkingOwner, null);
}
assert.match(
  sourceSection(dashboardSource, 'async function sendFromComposer()', "document.getElementById('send').onclick"),
  /if \(!chat \|\| chat\.pending \|\| composerPreparingChats\.has\(chat\)\) return;/,
  'the composer must honor the pending state owned by startup discovery'
);

const replaySource = sourceSection(
  dashboardSource,
  'const MAX_REPLAY_MESSAGES =',
  'function sameMeshRow('
);
const solveOperationSource = sourceSection(
  dashboardSource,
  'function stopThinking(',
  '/** Re-render the whole chat'
);
const runSolveSource = sourceSection(
  dashboardSource,
  'function runSolveAttempt(',
  '/**\n * Send a new message'
);

function createSolveHarness({ autoDone = true } = {}) {
  const posted = [];
  let onMessage = null;
  let onDisconnect = null;
  let budgetFiles = null;
  const port = {
    onMessage: { addListener(callback) { onMessage = callback; } },
    onDisconnect: { addListener(callback) { onDisconnect = callback; } },
    postMessage(message) {
      posted.push(message);
      if (autoDone) queueMicrotask(() => onMessage({
        type: 'done',
        result: { answer: 'ok', sessionId: 'session-new' },
      }));
    },
    disconnect() { onDisconnect?.(); },
  };
  const context = {
    Promise,
    Symbol,
    queueMicrotask,
    performance,
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame: () => 1,
    chrome: { runtime: { connect: () => port } },
    deduplicateRequestFiles(files, history) {
      const historyFiles = history.flatMap((message) => message.files || []);
      return { files, history, allFiles: [...files, ...historyFiles] };
    },
    validateRequestFileBudget(files) {
      budgetFiles = files;
      return { ok: true };
    },
    isPdfFile: () => false,
    activeKey: null,
    answerMode: 'brief',
    solveEngine: 'auto',
    renderSidebar() {},
    showToast() {},
    bubble() {},
    retryLastTurn() {},
    thinkingBubble() {},
    assistantShell() {},
    mdToHtml: String,
    appendStreamCaret() {},
    copyButton() {},
    retryButton() {},
    chatEl: { scrollTop: 0, scrollHeight: 0 },
  };
  vm.runInNewContext(
    `${replaySource}
     ${solveOperationSource}
     ${runSolveSource}
     globalThis.__solveApi = { runSolveAttempt, replayableHistory };`,
    context,
    { filename: 'dashboard-replay-boundary.js' }
  );
  return {
    context,
    posted,
    emit: (message) => onMessage(message),
    budgetFiles: () => budgetFiles,
  };
}

// Only the same last-eight tail accepted by the worker is allowed into either
// attachment budgeting or the privileged payload. Attachments on discarded old
// turns therefore cannot falsely block a future solve.
{
  const { context, posted, budgetFiles } = createSolveHarness();
  const oldFiles = Array.from({ length: 4 }, (_, index) => ({ name: `old-${index}.png` }));
  const history = [
    ...oldFiles.map((file, index) => ({ role: 'user', content: `old-${index}`, files: [file] })),
    ...Array.from({ length: 108 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `discarded-${index}`,
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `recent-${index}`,
    })),
    { role: 'assistant', content: 'upload gate', needsUpload: true },
    { role: 'assistant', content: 'interrupted answer', error: true },
  ];
  const currentFile = { name: 'current.png' };
  const chat = {
    key: 'lesson-1',
    subject: 'Алгебра',
    sessionId: 'session-old',
    history: [],
    pending: false,
    pendingOwner: null,
    thinkingOwner: null,
  };
  assert.equal(await context.__solveApi.runSolveAttempt(
    chat,
    'Новый вопрос',
    [currentFile],
    history
  ), true);
  assert.equal(posted.length, 1);
  assert.deepEqual(
    Array.from(posted[0].payload.history, (message) => message.content),
    Array.from({ length: 8 }, (_, index) => `recent-${index}`)
  );
  assert.deepEqual(budgetFiles(), [currentFile],
    'files on history that will not be replayed must not count against the request');
  assert.equal(chat.sessionId, 'session-new');
  assert.equal(chat.pending, false);
}

// A late port result that has lost ownership is discarded completely: it cannot
// replace the current session or enter future replay history.
{
  const { context, emit } = createSolveHarness({ autoDone: false });
  const chat = {
    key: 'lesson-1',
    subject: 'Алгебра',
    sessionId: 'session-current',
    history: [{ role: 'user', content: 'current turn' }],
    pending: false,
    pendingOwner: null,
    thinkingOwner: null,
  };
  const solving = context.__solveApi.runSolveAttempt(chat, 'old task', [], []);
  const newerOwner = Symbol('newer-operation');
  chat.pendingOwner = newerOwner;
  chat.pending = true;
  emit({ type: 'done', result: { answer: 'stale answer', sessionId: 'stale-session' } });
  assert.equal(await solving, false);
  assert.equal(chat.sessionId, 'session-current');
  assert.equal(chat.history.length, 1);
  assert.equal(chat.pendingOwner, newerOwner);
  assert.equal(chat.pending, true);
}

console.log('extension UI ownership regressions passed');
