import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const store = {
  aiConsent: { accepted: true, version: 2, at: new Date().toISOString() }
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

const { askAI, normalizeAIProvider } = await import('../src/lib/ai.js');
const { getUsage } = await import('../src/lib/rate-limit.js');

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function assertContains(path, needle) {
  const text = source(path);
  assert.ok(text.includes(needle), `${path} should include: ${needle}`);
}

function sourceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

async function expectQwenPath(label, fn) {
  try {
    await fn();
    assert.fail(`${label}: expected the proxy/license path to reject without a license`);
  } catch (e) {
    const msg = String(e?.message || e);
    assert.equal(
      msg.includes('OpenRouter'),
      false,
      `${label}: routed to OpenRouter instead of Qwen: ${msg}`
    );
    assert.match(msg, /Qwen|DeepSeek|СМЭШ|лиценз/i);
  }
}

store.aiProvider = 'qwen';
delete store.openrouterApiKey;
delete store.licenseStatus;
await expectQwenPath('stored qwen provider', () =>
  askAI('system', 'user', [], [], { responseFormat: 'json_object' })
);
assert.equal((await getUsage()).qwen.used, 0, 'a missing proxy license must not consume the Qwen local quota');

store.aiProvider = 'openrouter';
delete store.openrouterApiKey;
delete store.licenseStatus;
await expectQwenPath('explicit qwen provider override', () =>
  askAI('system', 'user', [], [], { provider: 'qwen', responseFormat: 'json_object' })
);
assert.equal((await getUsage()).qwen.used, 0, 'rejected proxy requests must leave the local quota unchanged');

assert.equal(normalizeAIProvider('qwen'), 'qwen');
assert.equal(normalizeAIProvider('deepseek'), 'deepseek');
assert.equal(normalizeAIProvider('nararouter'), 'openrouter');
assert.equal(normalizeAIProvider('nararouter', null), null);

assertContains('../src/popup/popup.js', "const provider = PROVIDER_ABBR[aiProvider] ? aiProvider : undefined;");
assertContains('../src/popup/popup.js', "payload: { text: pageText, screenshot, tabId, provider, capture }");
assertContains('../src/popup/popup.js', 'function requireMeshTestTab(tab)');
assertContains('../src/popup/popup.js', 'Другие вкладки расширение не снимает и не отправляет ИИ.');

const popupSource = source('../src/popup/popup.js');
const onboardingSource = sourceSection(
  popupSource,
  "const OB_PROVIDERS =",
  'function wireOnboarding()'
);

function element(properties = {}) {
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    value: '',
    checked: false,
    placeholder: '',
    href: '',
    dataset: {},
    classList: { toggle() {} },
    ...properties
  };
}

function createOnboardingHarness({
  typed = 'gsk_test', existing = '', verdict = { ok: true }, throwVerification = false
} = {}) {
  const providerButtons = [element({ dataset: { p: 'groq' } }), element({ dataset: { p: 'openrouter' } })];
  const elements = {
    obConsent: element({ checked: true }),
    obKey: element({ value: typed }),
    obStart: element(),
    obError: element({ hidden: true }),
    obKeyLink: element(),
    onboardView: element(),
    hwView: element(),
    testView: element()
  };
  const nav = element();
  const writes = [];
  const verifications = [];
  const consentWrites = [];
  const tabs = [];
  let scans = 0;
  const context = {
    Promise,
    document: {
      getElementById: (id) => elements[id],
      querySelectorAll: (selector) => selector === '#obProvider button' ? providerButtons : [],
      querySelector: (selector) => selector === 'nav.tabs' ? nav : null
    },
    chrome: {
      storage: {
        local: {
          async get(field) { return { [field]: existing }; },
          async set(data) { writes.push({ ...data }); }
        }
      }
    },
    async sendToBackground(message) {
      verifications.push(message);
      if (throwVerification) throw new Error('simulated transport failure');
      return verdict;
    },
    async setConsent(value) { consentWrites.push(value); },
    async setLicenseKey() { return { ok: true }; },
    async getLicenseStatus() { return { ok: true }; },
    reasonMessage: (reason) => String(reason || ''),
    showTab: (name) => tabs.push(name),
    scanHomework: () => { scans += 1; }
  };
  vm.runInNewContext(
    `${onboardingSource}\nglobalThis.__onboarding = { finishOnboarding, setObProvider };`,
    context,
    { filename: 'popup-onboarding-regression.js' }
  );
  return {
    context, elements, providerButtons, writes, verifications, consentWrites, tabs,
    scans: () => scans
  };
}

// Exercise the production onboarding function, not just its source spelling.
// Success and an explicitly ambiguous outage may persist; rejected, malformed,
// missing, and thrown verification outcomes must remain fail-closed.
{
  const harness = createOnboardingHarness();
  await harness.context.__onboarding.finishOnboarding();
  assert.equal(harness.verifications.length, 1);
  assert.equal(harness.verifications[0].payload.provider, 'groq');
  assert.equal(harness.verifications[0].payload.apiKey, 'gsk_test');
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].aiProvider, 'groq');
  assert.equal(harness.writes[0].groqApiKey, 'gsk_test');
  assert.deepEqual(harness.consentWrites, [true]);
  assert.equal(harness.scans(), 1);
  assert.equal(harness.elements.onboardView.hidden, true);
  assert.ok(harness.providerButtons.every((button) => button.disabled === false));
}

for (const testCase of [
  { label: 'bad key', verdict: { ok: false, reason: 'bad_key' } },
  { label: 'malformed response', verdict: {} },
  { label: 'missing response', verdict: null },
  { label: 'transport rejection', throwVerification: true }
]) {
  const harness = createOnboardingHarness(testCase);
  await harness.context.__onboarding.finishOnboarding();
  assert.equal(harness.writes.length, 0, `${testCase.label} must not persist a provider or key`);
  assert.equal(harness.consentWrites.length, 0, `${testCase.label} must not persist consent`);
  assert.equal(harness.scans(), 0, `${testCase.label} must not leave onboarding`);
  assert.equal(harness.elements.obError.hidden, false, `${testCase.label} must show a recoverable error`);
  assert.ok(harness.providerButtons.every((button) => button.disabled === false),
    `${testCase.label} must re-enable provider controls`);
}

{
  const harness = createOnboardingHarness({ verdict: { ok: false, reason: 'unreachable' } });
  await harness.context.__onboarding.finishOnboarding();
  assert.equal(harness.writes.length, 1, 'an ambiguous network outage may not reject a potentially valid key');
  assert.deepEqual(harness.consentWrites, [true]);
  assert.equal(harness.scans(), 1);
}

{
  const harness = createOnboardingHarness({ typed: '', existing: 'gsk_existing' });
  await harness.context.__onboarding.finishOnboarding();
  assert.equal(harness.verifications[0].payload.apiKey, 'gsk_existing');
  assert.equal(harness.writes[0].groqApiKey, undefined,
    'using an existing credential must not overwrite it with an empty value');
}

const answerFormattingSource = sourceSection(
  popupSource,
  'function extractFinalAnswers',
  '/** Minimal render:'
);
{
  const context = {};
  vm.runInNewContext(
    `${answerFormattingSource}\nglobalThis.__formatTestAnswers = formatTestAnswers;`,
    context,
    { filename: 'popup-answer-formatting-regression.js' }
  );
  const formatted = context.__formatTestAnswers(JSON.stringify({
    answers: [
      { n: 1, a: { text: 'Paris', confidence: 0.9 } },
      { n: '2', a: ['A', 'C'] },
      { n: 3, a: 0 },
      { n: 4, a: false },
      { n: '', a: 'must be ignored' },
      { a: 'must also be ignored' }
    ]
  }));
  assert.equal(
    formatted,
    '№1: {"text":"Paris","confidence":0.9}\n№2: ["A","C"]\n№3: 0\n№4: false'
  );
  assert.doesNotMatch(formatted, /\[object Object\]|№undefined/);
}

assertContains('../src/content/test-pill.js', "let providerId = 'openrouter';");
// The pill also names each run (opId) so closing it can cancel the worker's
// long-running solve/autopilot — see test-pill-lifecycle-regression.
assertContains('../src/content/test-pill.js', "payload: { provider: providerId, opId }");

// solveTest also takes the pill's cancellation signal and hands it to askAI, so
// closing the pill stops the PAID provider call — see test-pill-lifecycle.
assertContains('../src/background/service-worker.js',
  'async function solveTest({ text, screenshot, provider, signal = null } = {})');
assertContains('../src/background/service-worker.js', 'const providerOverride = normalizeAIProvider(provider, null);');
assertContains('../src/background/service-worker.js', 'if (providerOverride) askOpts.provider = providerOverride;');
assertContains('../src/lib/smesh-proxy.js', 'const UPLOAD_TICKET_URL = `${AI_BACKEND_URL}/ai/upload-ticket`;');
assertContains('../src/lib/smesh-proxy.js', 'upload_token: uploadToken');

console.log('ai-provider regression passed');
