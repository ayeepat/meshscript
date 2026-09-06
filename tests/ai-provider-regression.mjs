import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parse as parseHtml } from 'parse5';

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

const {
  askAI,
  normalizeAIProvider,
  resolveStoredProvider,
  routeVisionPreferredProvider,
} = await import('../src/lib/ai.js');
const { getUsage } = await import('../src/lib/rate-limit.js');
const { httpError } = await import('../src/lib/http.js');
const { DEFAULT_PROVIDER, SHOW_PROVIDER_UI } = await import('../src/lib/config.js');

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

await expectQwenPath('explicit keyless legacy BYO override', () =>
  askAI('system', 'user', [], [], { provider: 'openrouter', responseFormat: 'json_object' })
);

if (!SHOW_PROVIDER_UI) {
  const message = httpError(
    'DeepSeek',
    400,
    JSON.stringify({ error: { message: 'DeepSeek rejected model deepseek-v4-flash' } })
  ).message;
  assert.doesNotMatch(message, /DeepSeek|deepseek/i,
    'raw upstream errors must not leak a hidden vendor name to the student');
}

assert.equal(normalizeAIProvider('qwen'), 'qwen');
assert.equal(normalizeAIProvider('deepseek'), 'deepseek');
assert.equal(normalizeAIProvider('nararouter'), DEFAULT_PROVIDER);
assert.equal(normalizeAIProvider('nararouter', null), null);
assert.equal(routeVisionPreferredProvider('deepseek', true), 'deepseek',
  'licensed Auto must keep visual test work on its multimodal live route');
assert.equal(routeVisionPreferredProvider('deepseek', true, true), 'deepseek',
  'legacy BYO flags must not change the licensed route');
assert.equal(routeVisionPreferredProvider('deepseek', false), 'deepseek',
  'text homework must keep the stable Auto route');
assert.equal(routeVisionPreferredProvider('groq', true), DEFAULT_PROVIDER,
  'a legacy BYO provider id must collapse to the licensed default');

// Generic-page screenshot re-solves must stay on the licensed Auto proxy even
// on an old install that still carries the hidden Alibaba key. Without both
// proxyOnly gates this attempts a direct Qwen/DeepSeek network request.
{
  const previousFetch = globalThis.fetch;
  let directFetches = 0;
  globalThis.fetch = async () => {
    directFetches++;
    throw new Error('unexpected direct BYO request');
  };
  store.qwenApiKey = 'sk-test-hidden-byo';
  delete store.licenseStatus;
  try {
    await expectQwenPath('proxy-only generic vision route', () =>
      askAI('system', 'user', [], [], {
        provider: 'deepseek', proxyOnly: true, visionPreferred: true,
      })
    );
    assert.equal(directFetches, 0,
      'proxyOnly must prevent a hidden BYO key from making a direct request');
  } finally {
    delete store.qwenApiKey;
    globalThis.fetch = previousFetch;
  }
}

// The default has to be a provider the СМЭШ license can actually reach. With
// the picker hidden there is no way to enter a BYO key, so defaulting to one
// would dead-end every fresh install on «ключ не задан».
assert.ok(
  SHOW_PROVIDER_UI || DEFAULT_PROVIDER === 'qwen' || DEFAULT_PROVIDER === 'deepseek',
  'DEFAULT_PROVIDER must be a licensed provider while the provider picker is hidden'
);

// Legacy provider selections and keys never resurrect direct provider egress.
{
  const saved = { ...store };
  store.aiProvider = 'openrouter';
  store.openrouterApiKey = 'sk-or-v1-test';
  assert.equal(await resolveStoredProvider('openrouter'), DEFAULT_PROVIDER);

  delete store.openrouterApiKey;
  assert.equal(
    await resolveStoredProvider('openrouter'),
    DEFAULT_PROVIDER,
    'a keyless BYO provider must fall back to the licensed default'
  );

  store.groqApiKey = 'gsk_test';
  assert.equal(await resolveStoredProvider('groq'), DEFAULT_PROVIDER);
  delete store.groqApiKey;
  assert.equal(await resolveStoredProvider('groq'), DEFAULT_PROVIDER);

  // Licensed providers are never rerouted, and neither is an unset value.
  assert.equal(await resolveStoredProvider('qwen'), 'qwen');
  assert.equal(await resolveStoredProvider(undefined), DEFAULT_PROVIDER);

  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, saved);
}

assertContains('../src/popup/popup.js', "const provider = PROVIDER_ABBR[aiProvider] ? aiProvider : undefined;");
assertContains('../src/popup/popup.js',
  "payload: { text: pageText, screenshot, hasVisualMedia, tabId, provider, capture }");
assertContains('../src/popup/popup.js', 'function requireMeshTestTab(tab)');
assertContains('../src/popup/popup.js', 'Другие вкладки расширение не снимает и не отправляет ИИ.');

const popupSource = source('../src/popup/popup.js');
const serviceWorkerSource = source('../src/background/service-worker.js');

// The shipped licensed path has no transcription credential. Its missing-input
// message must not promise that attaching audio will be auto-transcribed; that
// remains true only for a grandfathered install that still has its BYO key.
{
  const gateSource = sourceSection(
    serviceWorkerSource,
    'function missingInputGate(',
    '/**\n * Last-ditch material fetch'
  );
  const context = {
    isReadableFile: () => false,
    classifyTask: () => ({ kind: 'attachment' }),
    needsAudio: () => true,
    isAudioFile: () => false,
    isBareTextbookRef: () => false,
    PROMPT_CATEGORIES: { RUSSIAN_FULL: 'russian' }
  };
  vm.runInNewContext(
    `${gateSource}\nglobalThis.__missingInputGate = missingInputGate;`,
    context,
    { filename: 'missing-input-provider-regression.js' }
  );
  const licensedMessage = context.__missingInputGate('other', 'аудирование', [], {
    canTranscribe: false
  });
  assert.match(licensedMessage, /готовую расшифровку/);
  assert.doesNotMatch(licensedMessage, /я (его )?расшифрую/,
    'the licensed path must not promise unavailable audio transcription');
  const grandfatheredMessage = context.__missingInputGate('other', 'аудирование', [], {
    canTranscribe: true
  });
  assert.match(grandfatheredMessage, /я (его )?расшифрую/);
}

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

// `showProviderUi` defaults to TRUE so the BYO-key branch below stays covered:
// it is hidden in production, not deleted, and must still work if the flag in
// config.js is flipped back. The hidden-picker behaviour is asserted separately
// at the end of this file.
function createOnboardingHarness({
  typed = 'gsk_test', existing = '', verdict = { ok: true }, throwVerification = false,
  showProviderUi = true, defaultProvider = 'deepseek', provider = 'groq',
  licenseStatus = {
    key: 'SMESH-2345-6789-ABCD', ok: true, expires_at: null,
    activation_token: 'a'.repeat(43)
  }
} = {}) {
  const providerButtons = [element({ dataset: { p: 'groq' } }), element({ dataset: { p: 'openrouter' } })];
  const elements = {
    obTerms: element({ checked: true }),
    obAiProcessing: element({ checked: true }),
    obTelemetry: element({ checked: false }),
    obEligibility: element({ checked: true }),
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
    // Module-scope imports the extracted section closes over.
    SHOW_PROVIDER_UI: showProviderUi,
    DEFAULT_PROVIDER: defaultProvider,
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
    async setConsentChoices(value) { consentWrites.push(value); },
    async setLicenseKey() { return licenseStatus; },
    async getLicenseStatus() { return licenseStatus; },
    isUsableLicenseStatus: (status) => !!status?.key && status.ok === true &&
      /^[A-Za-z0-9_-]{43}$/.test(status.activation_token || ''),
    licenseUsabilityReason: (status) => status?.reason ||
      (status?.ok ? 'bad_activation' : 'no_key'),
    reasonMessage: (reason) => String(reason || ''),
    showTab: (name) => tabs.push(name),
    scanHomework: () => { scans += 1; }
  };
  vm.runInNewContext(
    `${onboardingSource}\nglobalThis.__onboarding = { finishOnboarding, setObProvider };`,
    context,
    { filename: 'popup-onboarding-regression.js' }
  );
  // Mirrors init(): the stored provider is applied before onboarding is shown.
  // setObProvider is what pins the selection to the licensed default when the
  // picker is hidden, so route through it rather than reaching past it.
  context.__onboarding.setObProvider(provider);
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
  assert.deepEqual(JSON.parse(JSON.stringify(harness.consentWrites)), [{
    terms: true, ai_processing: true, telemetry: false, eligibility: true
  }]);
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
  assert.deepEqual(JSON.parse(JSON.stringify(harness.consentWrites)), [{
    terms: true, ai_processing: true, telemetry: false, eligibility: true
  }]);
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

// The pill is a classic content script and cannot import lib/config.js, so it
// inlines both values. Drift here silently paints a vendor tag back onto the
// Mesh page (or routes the pill at a provider nobody can supply a key for).
{
  const pill = source('../src/content/test-pill.js');
  assert.ok(
    pill.includes(`const SHOW_PROVIDER_UI = ${SHOW_PROVIDER_UI};`),
    'test-pill.js SHOW_PROVIDER_UI must mirror lib/config.js'
  );
  assert.ok(
    pill.includes(`let providerId = '${DEFAULT_PROVIDER}';`),
    'test-pill.js providerId default must mirror config.DEFAULT_PROVIDER'
  );
}
// The pill also names each run (opId) so closing it can cancel the worker's
// long-running solve/autopilot — see test-pill-lifecycle-regression.
assertContains('../src/content/test-pill.js', "payload: { provider: providerId, opId }");

// solveTest also takes the pill's cancellation signal and hands it to askAI, so
// closing the pill stops the PAID provider call — see test-pill-lifecycle.
// `pageUrl` is diagnostics-only (owner-gated dev traces) and never reaches the
// provider; the signal contract this line exists to pin is unchanged.
assertContains('../src/background/service-worker.js',
  'async function solveTest({ text, screenshot, hasVisualMedia = false, provider, signal = null, pageUrl = null } = {})');
assertContains('../src/background/service-worker.js', 'const providerOverride = normalizeAIProvider(provider, null);');
assertContains('../src/background/service-worker.js', 'if (providerOverride) askOpts.provider = providerOverride;');
assertContains('../src/background/service-worker.js', 'visionPreferred: hasVisualMedia === true,');
assertContains('../src/lib/deepseek.js', 'if (isImageFile(f))');
assertContains('../src/lib/deepseek.js', "type: 'image_url'");
assert.doesNotMatch(source('../src/lib/deepseek.js'), /dashscope-intl|qwenApiKey|Authorization:\s*`Bearer/,
  'Auto route must have no direct vendor credential path');
assert.doesNotMatch(source('../src/lib/qwen.js'), /dashscope-intl|qwenApiKey|Authorization:\s*`Bearer/,
  'Think route must have no direct vendor credential path');
assertContains('../src/lib/smesh-proxy.js', 'const UPLOAD_TICKET_URL = `${AI_BACKEND_URL}/ai/upload-ticket`;');
assertContains('../src/lib/smesh-proxy.js', 'upload_token: uploadToken');

// ---- Hidden provider picker (the shipped configuration) -------------------
// With SHOW_PROVIDER_UI false the only credential onboarding may collect is the
// СМЭШ license. A stored BYO provider must NOT resurrect the "paste your API
// key" step, because there is no longer any control that can supply one.
{
  const harness = createOnboardingHarness({
    showProviderUi: false, provider: 'groq', typed: ''
  });
  await harness.context.__onboarding.finishOnboarding();
  assert.equal(harness.verifications.length, 0,
    'the hidden-picker path must never run a BYO API-key verification');
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0].aiProvider, 'deepseek',
    'a stored BYO provider must not survive onboarding while the picker is hidden');
  assert.equal(harness.writes[0].groqApiKey, undefined,
    'the hidden-picker path must not persist an API key');
  assert.deepEqual(JSON.parse(JSON.stringify(harness.consentWrites)), [{
    terms: true, ai_processing: true, telemetry: false, eligibility: true
  }]);
  assert.equal(harness.scans(), 1);
}

// A bare positive verdict is not enough for the licensed route: without the
// per-installation bearer token the first proxy request is guaranteed to fail.
{
  const harness = createOnboardingHarness({
    showProviderUi: false,
    provider: 'groq',
    typed: '',
    licenseStatus: { key: 'SMESH-2345-6789-ABCD', ok: true }
  });
  await harness.context.__onboarding.finishOnboarding();
  assert.equal(harness.writes.length, 0,
    'onboarding must not accept a license the proxy cannot authenticate');
  assert.equal(harness.consentWrites.length, 0);
  assert.equal(harness.scans(), 0);
  assert.equal(harness.elements.obError.hidden, false);
}

// No vendor name may reach a student surface while the picker is hidden.
//
// Walks the parsed document and skips any subtree carrying `hidden`, so markup
// that merely survives behind the flag doesn't trip it — only text or an
// attribute a student can actually read does. A grep can't tell those apart.
if (!SHOW_PROVIDER_UI) {
  const VENDORS = /OpenRouter|Groq|Qwen|DeepSeek|GRQ|OPR|QWN|DSK/i;
  // Visible attributes only: an id/for/data-* value naming a provider is a
  // code identifier, not something rendered.
  const VISIBLE_ATTRS = new Set(['title', 'placeholder', 'alt', 'aria-label', 'value', 'label']);

  const walk = (node, file, out) => {
    if (node.nodeName === '#comment') return;
    const attrs = node.attrs || [];
    if (attrs.some((a) => a.name === 'hidden')) return;
    if (node.nodeName === '#text') {
      if (VENDORS.test(node.value)) out.push(`text ${JSON.stringify(node.value.trim().slice(0, 90))}`);
      return;
    }
    for (const a of attrs) {
      if (VISIBLE_ATTRS.has(a.name) && VENDORS.test(a.value)) {
        out.push(`<${node.nodeName} ${a.name}="${a.value}">`);
      }
    }
    for (const child of node.childNodes || []) walk(child, file, out);
  };

  for (const file of [
    '../src/popup/popup.html',
    '../src/settings/settings.html',
    '../src/dashboard/dashboard.html'
  ]) {
    const found = [];
    walk(parseHtml(source(file)), file, found);
    assert.deepEqual(found, [],
      `${file} shows a provider name on a visible, student-facing surface`);
  }
}

console.log('ai-provider regression passed');
