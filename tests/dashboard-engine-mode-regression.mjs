/**
 * Dashboard engine toggle regression — the «Авто» / «Думать» segment must
 * actually decide which model answers a dashboard solve:
 *   - «Авто»   → the live Auto route (Qwen 3.7 Plus by default);
 *   - «Думать» → Qwen (reasons by default; no effort knob to downgrade).
 * The toggle is DASHBOARD-ONLY: it rides the SOLVE port payload through the
 * validated privileged boundary and must never leak into popup / pill flows.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const store = {
  aiConsent: {
    version: 4, terms: true, ai_processing: true,
    telemetry: false, eligibility: true, at: new Date().toISOString(), receipt_id: 'test-consent'
  }
};

function pick(keys) {
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((k) => [k, store[k]]));
  }
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, store[k] ?? v]));
  }
  return { ...store };
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { return pick(keys); },
      async set(data) { Object.assign(store, data); },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      }
    }
  }
};

const { askAI } = await import('../src/lib/ai.js');

const source = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const dashboardSource = source('../src/dashboard/dashboard.js');
const dashboardHtml = source('../src/dashboard/dashboard.html');
const workerSource = source('../src/background/service-worker.js');

function sourceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

// --- behavioral: an opts.provider override (what the engine mapping emits)
// wins over the stored aiProvider setting, landing on the proxy/license path
// rather than the user's configured OpenRouter. Without a license the proxy
// path rejects with its own message — an OpenRouter key error here would mean
// the override was ignored.
async function expectProxyPath(label, fn) {
  try {
    await fn();
    assert.fail(`${label}: expected the proxy/license path to reject without a license`);
  } catch (e) {
    const msg = String(e?.message || e);
    assert.equal(msg.includes('OpenRouter'), false,
      `${label}: routed to OpenRouter instead of the proxy: ${msg}`);
    assert.match(msg, /Qwen|DeepSeek|СМЭШ|лиценз/i);
  }
}

store.aiProvider = 'openrouter';
delete store.openrouterApiKey;
delete store.licenseStatus;
await expectProxyPath('engine auto → deepseek override', () =>
  askAI('system', 'user', [], [], { provider: 'deepseek' })
);
await expectProxyPath('engine think → qwen override', () =>
  askAI('system', 'user', [], [], { provider: 'qwen' })
);
// «Авто» with a photo stays on the multimodal licensed Auto route. Hidden BYO
// DeepSeek is covered separately by ai-provider-regression.
await expectProxyPath('engine auto + image stays on licensed auto', () =>
  askAI('system', 'user', [{ mimeType: 'image/png', dataBase64: 'aGk=', name: 'photo.png' }], [],
    { provider: 'deepseek' })
);

// Dashboard state defaults to fast mode. Execute the actual declaration block
// so a renamed/reformatted implementation remains free to change.
{
  const declarations = sourceSection(dashboardSource, 'const chats = new Map();', 'function taskPrefix');
  const context = { Map };
  vm.runInNewContext(
    `${declarations}\nglobalThis.__defaults = { answerMode, solveEngine };`,
    context,
    { filename: 'dashboard-engine-defaults.js' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__defaults)),
    { answerMode: 'brief', solveEngine: 'auto' }
  );
}

// The declarative UI offers exactly the two supported engine values, with auto
// selected initially. This is a markup contract; routing below is executable.
{
  const buttons = [...dashboardHtml.matchAll(
    /<button\b([^>]*\bdata-engine="([^"]+)"[^>]*)>/g
  )].map((match) => ({
    engine: match[2],
    active: /\bclass="[^"]*\bactive\b/.test(match[1]),
  }));
  assert.deepEqual(buttons, [
    { engine: 'auto', active: true },
    { engine: 'think', active: false },
  ]);
}

// Execute runSolveAttempt with a fake port. The assertion is on the posted
// message, not the source spelling of its object literal.
const runSolveAttemptSource = sourceSection(
  dashboardSource,
  'function runSolveAttempt(',
  '/**\n * Send a new message'
);
const replaySource = sourceSection(
  dashboardSource,
  'const MAX_REPLAY_MESSAGES =',
  'function sameMeshRow('
);
const operationSource = sourceSection(
  dashboardSource,
  'function beginChatOperation(',
  '/** Re-render the whole chat'
);

async function postedSolve(engine) {
  let onMessage = null;
  let onDisconnect = null;
  const posted = [];
  const port = {
    onMessage: { addListener(listener) { onMessage = listener; } },
    onDisconnect: { addListener(listener) { onDisconnect = listener; } },
    postMessage(message) {
      posted.push(message);
      queueMicrotask(() => onMessage({
        type: 'done',
        result: { answer: 'ok', sessionId: 'session-2' },
      }));
    },
    disconnect() { onDisconnect?.(); },
  };
  const context = {
    Promise,
    queueMicrotask,
    chrome: { runtime: { connect: () => port } },
    deduplicateRequestFiles(files, history) {
      return { files, history, allFiles: files };
    },
    validateRequestFileBudget: () => ({ ok: true }),
    isPdfFile: () => false,
    stopThinking(chat) { chat.thinkingOwner = null; },
    activeKey: null,
    answerMode: 'brief',
    solveEngine: engine,
    renderSidebar() {},
  };
  vm.runInNewContext(
    `${replaySource}\n${operationSource}\n${runSolveAttemptSource}\n` +
    'globalThis.__runSolveAttempt = runSolveAttempt;',
    context,
    { filename: 'dashboard-run-solve-attempt.js' }
  );
  const chat = {
    key: 'lesson-1',
    subject: 'Алгебра',
    sessionId: 'session-1',
    history: [],
    pending: false,
    pendingOwner: null,
    thinkingOwner: null,
  };
  await context.__runSolveAttempt(chat, '2 + 2', [], []);
  assert.equal(posted.length, 1);
  return JSON.parse(JSON.stringify(posted[0]));
}

assert.deepEqual((await postedSolve('auto')).payload, {
  subject: 'Алгебра',
  task: '2 + 2',
  files: [],
  sessionId: 'session-1',
  history: [],
  mode: 'brief',
  engine: 'auto',
  // The lesson's answer-reuse key rides every solve so the stored session can
  // be found again (empty here — this fixture chat has no Mesh row identity).
  lessonKey: '',
});
assert.equal((await postedSolve('think')).payload.engine, 'think');

// Execute the production mapping and reasoning-policy blocks with controlled
// inputs. These probes survive harmless reformatting and fail on behavior
// changes such as swapping the two models or downgrading explicit think mode.
{
  const mapping = sourceSection(workerSource, 'const engineProvider =', 'const provider = engineProvider');
  function mapEngine(engine) {
    const context = { engine };
    vm.runInNewContext(
      `${mapping}\nglobalThis.__engineProvider = engineProvider;`,
      context,
      { filename: 'worker-engine-mapping.js' }
    );
    return context.__engineProvider;
  }
  assert.equal(mapEngine('auto'), 'deepseek');
  assert.equal(mapEngine('think'), 'qwen');
  assert.equal(mapEngine('future-mode'), null);
  assert.equal(mapEngine(undefined), null);

  const effort = sourceSection(workerSource, 'const askOpts =', 'const answer = await askAI');
  const context = {
    isEasyTask: (task) => task === 'easy',
    isChatty: (task) => task === 'chatty',
    isLightFollowup: (task) => task === 'followup',
  };
  vm.runInNewContext(
    `globalThis.__effort = (input) => {
      const { engineProvider, files, history, task, provider } = input;
      const onDelta = null;
      const signal = null;
      let usage = null;
      let usedProvider = null;
      ${effort}
      return { lowEffortReason, reasoning: askOpts.reasoning };
    };`,
    context,
    { filename: 'worker-engine-effort.js' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__effort({
      engineProvider: 'deepseek', files: [{}], history: [], task: 'hard', provider: 'deepseek',
    }))),
    { lowEffortReason: null }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.__effort({
      engineProvider: 'qwen', files: [], history: [], task: 'easy', provider: 'qwen',
    }))),
    { lowEffortReason: null }
  );
}

// PDF routing uses the same licensed engine route; there is no BYO diversion.
{
  const solveBody = sourceSection(workerSource, 'async function solve(', 'async function solveTest(');
  assert.match(solveBody, /const provider = engineProvider \|\| undefined;/);
  assert.doesNotMatch(solveBody, /openrouterApiKey|getByoKey|provider\s*=\s*'openrouter'/,
    'PDF handling must not resurrect a direct OpenRouter route');
}

// This final source-level assertion is intentionally structural: validateMessage
// is private to the MV3 worker, so the test only pins that `engine` is bounded at
// the privileged boundary. Model selection itself is covered behaviorally above.
assert.match(
  workerSource,
  /SOLVE:[\s\S]*?payloadRecord\(msg,[\s\S]*?'engine'[\s\S]*?isOptionalString\(msg\.payload\.engine,\s*16\)/,
  'the SOLVE boundary must allow only a bounded engine string'
);

console.log('dashboard engine mode regression passed');
