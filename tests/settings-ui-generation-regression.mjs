import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const settingsSource = readFileSync(
  new URL('../src/settings/settings.js', import.meta.url),
  'utf8'
);
const settingsHtmlSource = readFileSync(
  new URL('../src/settings/settings.html', import.meta.url),
  'utf8'
);
const referralSource = readFileSync(
  new URL('../src/lib/referral.js', import.meta.url),
  'utf8'
);
const serviceWorkerSource = readFileSync(
  new URL('../src/background/service-worker.js', import.meta.url),
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

async function waitUntil(predicate, label) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`timed out waiting for ${label}`);
}

const usageSource = sourceSection(
  settingsSource,
  'let usagePaintGeneration =',
  '/* ---------- Usage & spend dashboard'
);

function usageSnapshot(value) {
  return Object.fromEntries(
    ['openrouter', 'groq', 'qwen', 'deepseek'].map((provider) => [
      provider,
      { used: value, limit: value * 10 }
    ])
  );
}

// General usage is refreshed both during initial load and after saves. Resolve
// two reads newest-first and prove the older completion cannot repaint any tile.
{
  const reads = [deferred(), deferred()];
  let readIndex = 0;
  const elements = Object.fromEntries(
    ['usageOpenrouter', 'usageGroq', 'usageQwen', 'usageDeepseek']
      .map((id) => [id, { textContent: '' }])
  );
  const context = {
    Promise,
    getUsage: () => reads[readIndex++].promise,
    document: { getElementById: (id) => elements[id] }
  };
  vm.runInNewContext(
    `${usageSource}\nglobalThis.__usageApi = { refreshUsage };`,
    context,
    { filename: 'settings-general-usage-generation.js' }
  );

  const oldRefresh = context.__usageApi.refreshUsage();
  const newRefresh = context.__usageApi.refreshUsage();
  reads[1].resolve(usageSnapshot(2));
  assert.equal(await newRefresh, true);
  assert.equal(elements.usageOpenrouter.textContent, '2 / 20 сегодня');

  reads[0].resolve(usageSnapshot(1));
  assert.equal(await oldRefresh, false);
  assert.equal(elements.usageOpenrouter.textContent, '2 / 20 сегодня');
  assert.equal(elements.usageDeepseek.textContent, '2 / 20 сегодня');
}

const historySource = sourceSection(
  settingsSource,
  'function loadHistory()',
  '/* ---------- Textbooks (GDZ)'
);
const privacyWireSource = sourceSection(
  settingsSource,
  'function wirePrivacy()',
  'let usagePaintGeneration ='
);

function fakeElement() {
  return {
    className: '',
    textContent: '',
    hidden: false,
    dataset: {},
    children: [],
    _html: '',
    set innerHTML(value) { this._html = value; this.children = []; },
    get innerHTML() { return this._html; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return fakeElement(); },
    scrollIntoView() {}
  };
}

function createHistoryHarness({ withPrivacy = false } = {}) {
  const callbacks = [];
  const history = fakeElement();
  const elements = {
    history,
    telemetryToggle: fakeElement(),
    deleteStats: fakeElement(),
    deleteLocal: fakeElement()
  };
  const wipe = deferred();
  const context = {
    Promise,
    Date,
    iconSvg: (name) => `<svg data-icon="${name}"></svg>`,
    historyMessageEl: () => fakeElement(),
    document: {
      getElementById: (id) => elements[id] || fakeElement(),
      createElement: () => fakeElement()
    },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(_message, callback) { callbacks.push(callback); }
      }
    },
    matchMedia: () => ({ matches: true }),
    window: { confirm: () => true },
    deleteAllLocalData: () => wipe.promise,
    privacyFlash() {},
    enqueueTelemetryPreference: () => ({ generation: 1, write: Promise.resolve() }),
    telemetryUiGeneration: 1,
    fetchTextBounded: async () => ({ text: '{"ok":true}' }),
    BACKEND_URL: 'https://example.invalid',
    getDeviceId: async () => 'device'
  };
  vm.runInNewContext(
    `let historyLoaded = true;
     let historyLoadGeneration = 0;
     let historyDeletePromise = null;
     ${withPrivacy ? privacyWireSource : ''}
     ${historySource}
     ${withPrivacy ? 'wirePrivacy();' : ''}
     globalThis.__historyApi = {
       loadHistory,
       loaded: () => historyLoaded,
       generation: () => historyLoadGeneration
     };`,
    context,
    { filename: 'settings-history-generation.js' }
  );
  return { context, callbacks, history, elements, wipe };
}

// Reload is latest-request-wins, including the error branch that previously
// overwrote a successful newer response.
{
  const { context, callbacks, history } = createHistoryHarness();
  context.__historyApi.loadHistory();
  context.__historyApi.loadHistory();
  callbacks[1]({ ok: true, sessions: [] });
  assert.match(history.innerHTML, /Пока пусто/);
  callbacks[0]({ ok: false, error: 'stale failure' });
  assert.match(history.innerHTML, /Пока пусто/);
  assert.doesNotMatch(history.innerHTML, /stale failure/);
}

// Corrupt local history is user-controlled persistence input. Render malformed
// timestamps as a stable placeholder while preserving normal date formatting.
{
  const malformed = createHistoryHarness();
  malformed.context.__historyApi.loadHistory();
  malformed.callbacks[0]({
    ok: true,
    sessions: [{ created_at: 'definitely-not-a-date', subject: 'Math', task_text: '2 + 2' }]
  });
  const malformedDate = malformed.history.children[0].children[0].children[0].children[1];
  assert.equal(malformedDate.textContent, '—');

  const valid = createHistoryHarness();
  valid.context.__historyApi.loadHistory();
  valid.callbacks[0]({
    ok: true,
    sessions: [{ created_at: '2026-08-22T10:00:00.000Z', subject: 'Math', task_text: '2 + 2' }]
  });
  const validDate = valid.history.children[0].children[0].children[0].children[1];
  assert.notEqual(validDate.textContent, '—');
  assert.doesNotMatch(validDate.textContent, /Invalid Date/);
}

// A confirmed local wipe takes ownership before awaiting storage. A pre-wipe
// LIST_SESSIONS callback is inert even while deletion itself is still pending.
{
  const { context, callbacks, history, elements, wipe } = createHistoryHarness({ withPrivacy: true });
  context.__historyApi.loadHistory();
  const deletion = elements.deleteLocal.onclick();
  callbacks[0]({ ok: false, error: 'stale during deletion' });
  assert.doesNotMatch(history.innerHTML, /stale during deletion/);
  assert.match(history.innerHTML, /Удаляю локальные данные/);
  wipe.resolve();
  await deletion;
  assert.equal(history.innerHTML, '');
  assert.equal(context.__historyApi.loaded(), false);

  callbacks[0]({ ok: true, sessions: [] });
  assert.equal(history.innerHTML, '', 'a pre-wipe response must stay inert after deletion');
}

// A reload clicked during deletion waits for the mutation before it issues its
// LIST_SESSIONS request, then becomes the newest owner of the post-wipe paint.
{
  const { context, callbacks, history, elements, wipe } = createHistoryHarness({ withPrivacy: true });
  context.__historyApi.loadHistory();
  const deletion = elements.deleteLocal.onclick();
  context.__historyApi.loadHistory();
  assert.equal(callbacks.length, 1,
    'a reload must not query pre-wipe history while deletion is in flight');
  wipe.resolve();
  await deletion;
  await waitUntil(() => callbacks.length === 2, 'deferred post-wipe history reload');
  callbacks[1]({ ok: true, sessions: [] });
  assert.match(history.innerHTML, /Пока пусто/);
}

// A failed wipe also releases mutation ownership and reloads the still-present
// history. The pre-wipe callback remains obsolete; only the recovery read paints.
{
  const { context, callbacks, history, elements, wipe } = createHistoryHarness({ withPrivacy: true });
  context.__historyApi.loadHistory();
  const deletion = elements.deleteLocal.onclick();
  wipe.reject(new Error('simulated storage failure'));
  await deletion;
  assert.equal(callbacks.length, 2, 'a failed wipe must issue one recovery read');
  callbacks[0]({ ok: false, error: 'obsolete pre-wipe failure' });
  assert.doesNotMatch(history.innerHTML, /obsolete pre-wipe failure/);
  callbacks[1]({ ok: true, sessions: [] });
  assert.match(history.innerHTML, /Пока пусто/);
}

const saveSource = sourceSection(
  settingsSource,
  'let settingsSaveQueue =',
  '/* ---------- History ----------'
);
const touchedFieldSource = sourceSection(
  settingsSource,
  'const touchedControls = new Set();',
  '/* ---------- Theme segmented control ---------- */'
);
const hydrateFormSource = sourceSection(
  settingsSource,
  'function syncProviderKeys()',
  'async function loadSecondaryUi()'
);
const loadLicenseSource = sourceSection(
  settingsSource,
  'let licenseUiGeneration = 0;',
  'function renderLicenseStatus(status)'
);

function classListHarness() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); }
  };
}

function createSaveHarness({ ready = true, hydration = Promise.resolve() } = {}) {
  const input = (value = '') => {
    const listeners = new Map();
    return {
      value,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(callback);
      },
      dispatch(type) {
        for (const callback of listeners.get(type) || []) callback({ target: this });
      }
    };
  };
  const fields = {
    openrouterApiKey: input(''),
    groqApiKey: input(''),
    aiProvider: input('deepseek'),
    limitOpenrouter: input('30'),
    limitGroq: input('30'),
    limitQwen: input('30'),
    limitDeepseek: input('30'),
    licenseKey: input(''),
    status: { innerHTML: '', textContent: '', dataset: {}, classList: classListHarness() },
    save: {
      disabled: true,
      title: '',
      attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); }
    },
    licStatus: { textContent: '', dataset: {} }
  };
  const licenseCalls = [];
  const licensePaints = [];
  const storageWrites = [];
  const timers = new Map();
  const clearedTimers = [];
  let nextTimer = 0;
  const context = {
    Promise,
    Math,
    Set,
    parseInt,
    KEY_FIELDS: ['openrouterApiKey', 'groqApiKey'],
    PROVIDER_OPTIONS: new Set(['openrouter', 'groq', 'qwen', 'deepseek']),
    DEFAULT_LIMITS: { openrouter: 30, groq: 30, qwen: 30, deepseek: 30 },
    MAX_DAILY_LIMIT: 1000,
    usageDashboardLoaded: false,
    document: { getElementById: (id) => fields[id] },
    chrome: { storage: { local: { set: async (data) => {
      storageWrites.push(JSON.parse(JSON.stringify(data)));
    } } } },
    refreshUsage: async () => true,
    refreshUsageDashboard: async () => true,
    hydrateSettingsForm: () => hydration,
    loadSecondaryUi: async () => {},
    getLicenseStatus: async () => ({ key: '', ok: false }),
    normalizeEnteredLicenseKey(raw) {
      let normalized = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
      const compact = /^SMESH-([23456789ABCDEFGHJKMNPQRSTVWXYZ]{12})$/.exec(normalized);
      if (compact) {
        normalized = `SMESH-${compact[1].slice(0, 4)}-${compact[1].slice(4, 8)}-${compact[1].slice(8)}`;
      }
      return normalized;
    },
    setLicenseKey(key) {
      const pending = deferred();
      licenseCalls.push({ key, ...pending });
      return pending.promise;
    },
    renderLicenseStatus(status) {
      licensePaints.push({ status, visibleKey: fields.licenseKey.value });
    },
    iconSvg: () => '<svg></svg>',
    setTimeout(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { clearedTimers.push(id); }
  };
  vm.runInNewContext(
    `let licenseUiGeneration = 0;
     ${saveSource}
     settingsFormReady = ${ready ? 'true' : 'false'};
     globalThis.__saveApi = {
       requestSettingsSave,
       initializeSettingsForm,
       generation: () => licenseUiGeneration,
       toastTimer: () => saveToastTimer
     };`,
    context,
    { filename: 'settings-save-generation.js' }
  );
  return {
    context, fields, licenseCalls, licensePaints, storageWrites, timers, clearedTimers
  };
}

// Exercise the production hydration path itself with storage and license reads
// held open. A real input event marks the license as touched; stored nondefault
// values must fill every untouched Save field without repainting that edit.
{
  const storageRead = deferred();
  const licenseRead = deferred();
  const listeners = new Map();
  const input = (value = '') => ({ value, checked: false });
  const fields = {
    openrouterApiKey: input(''),
    groqApiKey: input(''),
    aiProvider: input('openrouter'),
    limitOpenrouter: input('30'),
    limitGroq: input('30'),
    limitQwen: input('30'),
    limitDeepseek: input('30'),
    licenseKey: input(''),
    orKeyFields: { hidden: false },
    licenseKeyNote: { hidden: false }
  };
  let licenseReads = 0;
  let licensePaints = 0;
  const context = {
    Promise,
    Set,
    KEY_FIELDS: ['openrouterApiKey', 'groqApiKey'],
    PROVIDER_OPTIONS: new Set(['openrouter', 'groq', 'qwen', 'deepseek']),
    DEFAULT_LIMITS: { openrouter: 30, groq: 30, qwen: 30, deepseek: 30 },
    document: {
      getElementById: (id) => fields[id],
      addEventListener(type, callback) { listeners.set(type, callback); }
    },
    chrome: { storage: { local: { get: () => storageRead.promise } } },
    getLicenseStatus() { licenseReads += 1; return licenseRead.promise; },
    renderLicenseStatus() { licensePaints += 1; }
  };
  vm.runInNewContext(
    `${touchedFieldSource}\n${hydrateFormSource}\n${loadLicenseSource}\n` +
      'globalThis.__hydrate = hydrateSettingsForm;',
    context,
    { filename: 'settings-real-form-hydration.js' }
  );

  const hydrating = context.__hydrate();
  fields.licenseKey.value = 'license-during-load';
  listeners.get('input')({ target: { id: 'licenseKey' } });
  storageRead.resolve({
    openrouterApiKey: 'STORED-OPENROUTER',
    groqApiKey: 'STORED-GROQ',
    aiProvider: 'groq',
    rateLimits: { openrouter: 71, groq: 72, qwen: 73, deepseek: 74 }
  });
  await waitUntil(() => licenseReads === 1, 'hydration license read');
  licenseRead.resolve({ key: 'STORED-LICENSE', ok: true });
  await hydrating;

  assert.equal(fields.openrouterApiKey.value, 'STORED-OPENROUTER');
  assert.equal(fields.groqApiKey.value, 'STORED-GROQ');
  assert.equal(fields.aiProvider.value, 'groq');
  assert.deepEqual(
    ['limitOpenrouter', 'limitGroq', 'limitQwen', 'limitDeepseek'].map((id) => fields[id].value),
    [71, 72, 73, 74]
  );
  assert.equal(fields.licenseKey.value, 'license-during-load');
  assert.equal(licensePaints, 0,
    'the delayed stored license must not repaint a field edited during hydration');
}

// Referral pointer refreshes are serialized. A replacement-license refresh
// starts only after the older in-flight request settles, so its later server
// write is necessarily the final pointer state.
{
  const queueDeclaration = referralSource.match(/let referralSyncQueue = Promise\.resolve\(\);/)?.[0];
  const wrapper = referralSource.match(
    /export async function getMyReferralCode\(\{ sync = false \} = \{\}\) \{[\s\S]*?\n\}/
  )?.[0]?.replace(/^export /, '');
  assert.ok(queueDeclaration && wrapper, 'referral sync queue source must be extractable');
  const firstNetwork = deferred();
  const secondNetwork = deferred();
  const starts = [];
  let visibleLicense = 'LICENSE-A';
  const context = {
    Promise,
    isExtensionPageContext: () => false,
    getMyReferralCodeOnce: ({ sync }) => {
      starts.push({ sync, license: visibleLicense });
      return starts.length === 1 ? firstNetwork.promise : secondNetwork.promise;
    }
  };
  vm.runInNewContext(
    `${queueDeclaration}\n${wrapper}\n` +
      'globalThis.__syncCode = getMyReferralCode;',
    context,
    { filename: 'referral-pointer-sync-queue.js' }
  );
  const oldSync = context.__syncCode({ sync: true });
  await waitUntil(() => starts.length === 1, 'old referral pointer sync');
  visibleLicense = 'LICENSE-B';
  const replacementSync = context.__syncCode({ sync: true });
  assert.deepEqual(starts.map((entry) => entry.license), ['LICENSE-A']);
  firstNetwork.resolve('REF-TEST');
  await waitUntil(() => starts.length === 2, 'replacement referral pointer sync');
  assert.deepEqual(starts.map((entry) => entry.license), ['LICENSE-A', 'LICENSE-B']);
  secondNetwork.resolve('REF-TEST');
  await Promise.all([oldSync, replacementSync]);
  assert.match(referralSource,
    /if \(sync && isExtensionPageContext\(\)\)[\s\S]*SYNC_REFERRAL_POINTER/,
    'extension pages must route pointer refreshes through the service worker');
  assert.match(serviceWorkerSource,
    /case 'SET_LICENSE_KEY':[\s\S]*setLicenseKeyAndSyncReferral\(msg\.payload\.key\)/,
    'every centralized license writer must enqueue a referral correction');
  assert.match(serviceWorkerSource,
    /case 'SYNC_REFERRAL_POINTER':[\s\S]*syncReferralPointer\(\)/,
    'Settings-open refreshes must use the same worker-owned queue');
}

// A cached referral code is availability data, not proof that a requested
// server-side license-pointer mutation succeeded. Sync failures must remain
// observable so the worker can retain and retry its durable intent.
{
  const start = referralSource.indexOf('async function getMyReferralCodeOnce');
  const end = referralSource.indexOf('\n\nexport async function getMyReferralCode', start);
  assert.ok(start >= 0 && end > start, 'referral one-shot sync source must be extractable');
  const context = {
    Error,
    loadState: async () => ({ code: 'REF-CACHED-CODE' }),
    getDeviceId: async () => 'device',
    getReferralAuth: async () => 'auth',
    getLicenseStatus: async () => ({ ok: true, key: 'LICENSE-NEW' }),
    api: async () => { throw new Error('http 500'); },
    saveState: async () => {}
  };
  vm.runInNewContext(
    `${referralSource.slice(start, end)}\n` +
      'globalThis.__once = getMyReferralCodeOnce;',
    context,
    { filename: 'referral-pointer-failure.js' }
  );
  await assert.rejects(
    context.__once({ sync: true }),
    /network/,
    'a failed pointer POST must not resolve successfully from the cached code'
  );
}

// License activation persists a coalescing retry intent and returns without
// waiting for the referral network. Failures retain the intent; a later alarm
// clears it only after success; an older completion cannot erase newer work.
{
  const start = serviceWorkerSource.indexOf('const REFERRAL_POINTER_SYNC_KEY');
  const end = serviceWorkerSource.indexOf('\n// Follow-ups re-send prior context.', start);
  assert.ok(start >= 0 && end > start, 'worker referral retry source must be extractable');
  const store = new Map();
  const requests = [];
  const alarmCreates = [];
  const alarmClears = [];
  const activeAlarms = new Map();
  let nextId = 0;
  const context = {
    Promise,
    Date,
    crypto: { randomUUID: () => `intent-${++nextId}` },
    chrome: {
      storage: {
        local: {
          async get(key) {
            return store.has(key) ? { [key]: structuredClone(store.get(key)) } : {};
          },
          async set(values) {
            for (const [key, value] of Object.entries(values)) {
              store.set(key, structuredClone(value));
            }
          },
          async remove(key) { store.delete(key); }
        }
      },
      alarms: {
        create(name, options) {
          alarmCreates.push({ name, options });
          activeAlarms.set(name, structuredClone(options));
        },
        async clear(name) {
          alarmClears.push(name);
          return activeAlarms.delete(name);
        }
      }
    },
    setLicenseKey: async () => ({ ok: true, key: 'LICENSE-NEW' }),
    getMyReferralCode: () => {
      const request = deferred();
      requests.push(request);
      return request.promise;
    }
  };
  vm.runInNewContext(
    `${serviceWorkerSource.slice(start, end)}\n` +
      'globalThis.__retryApi = {' +
      'setLicenseKeyAndSyncReferral, retryPendingReferralPointer, ' +
      'queueReferralPointerSync, syncReferralPointer, ' +
      'restorePendingReferralPointerRetry};',
    context,
    { filename: 'referral-pointer-durable-retry.js' }
  );

  const activation = context.__retryApi.setLicenseKeyAndSyncReferral('LICENSE-NEW');
  const status = await activation;
  assert.equal(status.ok, true);
  assert.equal(requests.length, 1,
    'activation may launch an immediate best-effort attempt after persisting intent');
  assert.equal(store.get('referralPointerSyncPending')?.id, 'intent-1',
    'successful activation must durably record pointer work before replying');

  requests[0].reject(new Error('backend unavailable'));
  await waitUntil(
    () => store.get('referralPointerSyncPending')?.attempts === 1,
    'failed referral pointer retry persistence'
  );
  await waitUntil(() => alarmCreates.length >= 2, 'failed referral retry alarm');
  assert.ok(alarmCreates.length >= 2,
    'initial and failed attempts must both schedule durable alarm delivery');

  const retry = context.__retryApi.retryPendingReferralPointer();
  await waitUntil(() => requests.length === 2, 'alarm referral retry');
  requests[1].resolve('REF-TEST-CODE');
  assert.equal(await retry, undefined);
  assert.equal(store.has('referralPointerSyncPending'), false,
    'a confirmed pointer refresh must clear its durable intent');
  assert.deepEqual(alarmClears, ['smesh-referral-pointer-sync']);

  await context.__retryApi.queueReferralPointerSync();
  await waitUntil(() => requests.length === 3, 'older referral request');
  const olderId = store.get('referralPointerSyncPending').id;
  await context.__retryApi.queueReferralPointerSync();
  await waitUntil(() => requests.length === 4, 'newer referral request');
  const newerId = store.get('referralPointerSyncPending').id;
  assert.notEqual(olderId, newerId);
  requests[2].resolve('REF-TEST-CODE');
  await waitUntil(
    () => store.get('referralPointerSyncPending')?.id === newerId,
    'stale referral completion guard'
  );
  assert.equal(store.get('referralPointerSyncPending').id, newerId,
    'an older completion must not clear a newer license-pointer intent');
  requests[3].resolve('REF-TEST-CODE');
  await waitUntil(() => !store.has('referralPointerSyncPending'), 'newest referral completion');

  // A cold alarm wake evaluates the module recovery and then dispatches the
  // alarm event. Both admissions must share the exact same flight: one backend
  // request and one failure increment, not two serialized duplicates.
  const coldIntent = { id: 'cold-alarm-intent', requestedAt: Date.now(), attempts: 0 };
  store.set('referralPointerSyncPending', structuredClone(coldIntent));
  const coldRequestStart = requests.length;
  const coldAlarmStart = alarmCreates.length;
  const moduleRecovery = context.__retryApi.restorePendingReferralPointerRetry();
  await waitUntil(() => requests.length === coldRequestStart + 1, 'cold-start referral retry');
  const alarmRecovery = context.__retryApi.restorePendingReferralPointerRetry();
  assert.equal(alarmRecovery, moduleRecovery,
    'module startup and the delivered cold alarm must join one recovery flight');
  await Promise.resolve();
  assert.equal(requests.length, coldRequestStart + 1,
    'one durable intent must admit only one backend pointer request');
  requests[coldRequestStart].reject(new Error('cold alarm backend outage'));
  const coldResults = await Promise.allSettled([moduleRecovery, alarmRecovery]);
  assert.deepEqual(coldResults.map((result) => result.status), ['rejected', 'rejected']);
  assert.equal(store.get('referralPointerSyncPending')?.attempts, 1,
    'coalesced callers must record one failure/backoff transition');
  assert.deepEqual(
    alarmCreates.slice(coldAlarmStart).map((entry) => entry.options.delayInMinutes),
    [1, 2],
    'recovery creates one safety alarm, then one exponential retry after failure'
  );

  // Model a pre-Chrome-150 browser restart losing the one-shot alarm while the
  // durable storage intent survives. Startup recovery must recreate the named
  // alarm before the network settles, then clear both only after confirmation.
  activeAlarms.delete('smesh-referral-pointer-sync');
  assert.equal(activeAlarms.has('smesh-referral-pointer-sync'), false);
  const restartRequestStart = requests.length;
  const restartAlarmStart = alarmCreates.length;
  const restarted = context.__retryApi.restorePendingReferralPointerRetry();
  await waitUntil(() => requests.length === restartRequestStart + 1, 'browser-start referral retry');
  assert.equal(alarmCreates.length, restartAlarmStart + 1);
  assert.equal(
    activeAlarms.get('smesh-referral-pointer-sync')?.delayInMinutes,
    2,
    'startup must reconstruct the lost alarm using the persisted attempt count'
  );
  requests[restartRequestStart].resolve('REF-TEST-CODE');
  await restarted;
  assert.equal(store.has('referralPointerSyncPending'), false);
  assert.equal(activeAlarms.has('smesh-referral-pointer-sync'), false);
}

// Exercise the production lifecycle wiring as well as the helper above. A
// profile startup and a referral alarm must both enter the same reconstruction
// path that module evaluation invokes; unrelated alarms must not do so.
{
  const lifecycleSource = sourceSection(
    serviceWorkerSource,
    "try {\n  chrome.alarms.create('smesh-retention'",
    '// Warm the remote runtime config'
  );
  let startupListener = null;
  let alarmListener = null;
  let recoveries = 0;
  const context = {
    REFERRAL_POINTER_SYNC_ALARM: 'smesh-referral-pointer-sync',
    chrome: {
      alarms: {
        create() {},
        onAlarm: { addListener(callback) { alarmListener = callback; } },
      },
      runtime: {
        onStartup: { addListener(callback) { startupListener = callback; } },
      },
    },
    cleanupLocalData: async () => {},
    cleanupDashboardLaunches: async () => {},
    restorePendingReferralPointerRetry() {
      recoveries += 1;
      return Promise.resolve();
    },
  };
  vm.runInNewContext(lifecycleSource, context, {
    filename: 'referral-pointer-worker-lifecycle.js',
  });
  assert.equal(recoveries, 1, 'module evaluation must start one durable recovery');
  assert.equal(typeof startupListener, 'function');
  assert.equal(typeof alarmListener, 'function');
  startupListener();
  assert.equal(recoveries, 2, 'runtime.onStartup must invoke durable recovery');
  alarmListener({ name: 'smesh-retention' });
  assert.equal(recoveries, 2, 'unrelated alarms must not invoke referral recovery');
  alarmListener({ name: 'smesh-referral-pointer-sync' });
  assert.equal(recoveries, 3, 'the named alarm must invoke durable recovery');
}

// The Save control is inert from first paint through persisted-form hydration.
// An early invocation cannot snapshot document defaults; once hydration fills
// untouched fields, the same full-form transaction preserves them alongside a
// license value the user entered while storage was pending.
{
  assert.match(settingsHtmlSource, /<button id="save"[^>]*\bdisabled\b[^>]*aria-busy="true"/,
    'the Save button must start disabled in markup, before module evaluation');
  const hydration = deferred();
  const harness = createSaveHarness({ ready: false, hydration: hydration.promise });
  const initializing = harness.context.__saveApi.initializeSettingsForm(harness.fields.save);

  harness.fields.licenseKey.value = 'license-during-load';
  assert.equal(await harness.context.__saveApi.requestSettingsSave(), false);
  assert.deepEqual(harness.storageWrites, [],
    'a pre-hydration save attempt must not persist blank/default controls');
  assert.equal(harness.fields.save.disabled, true);

  // Model hydrateSettingsForm applying the real stored snapshot to untouched
  // fields while its touched-license guard preserves the user's edit.
  harness.fields.openrouterApiKey.value = 'STORED-OPENROUTER';
  harness.fields.groqApiKey.value = 'STORED-GROQ';
  harness.fields.aiProvider.value = 'groq';
  harness.fields.limitOpenrouter.value = '71';
  harness.fields.limitGroq.value = '72';
  harness.fields.limitQwen.value = '73';
  harness.fields.limitDeepseek.value = '74';
  hydration.resolve();
  assert.equal(await initializing, true);
  assert.equal(harness.fields.save.disabled, false);

  const saving = harness.context.__saveApi.requestSettingsSave();
  await waitUntil(() => harness.licenseCalls.length === 1,
    'post-hydration license verification');
  assert.deepEqual(harness.storageWrites[0], {
    openrouterApiKey: 'STORED-OPENROUTER',
    groqApiKey: 'STORED-GROQ',
    aiProvider: 'groq',
    rateLimits: { openrouter: 71, groq: 72, qwen: 73, deepseek: 74 }
  });
  assert.equal(harness.licenseCalls[0].key, 'LICENSE-DURING-LOAD');
  harness.licenseCalls[0].resolve({ key: 'LICENSE-DURING-LOAD', ok: true });
  await saving;
}

// The second click takes ownership immediately even though its write is queued.
// The first verification result is suppressed, and the queued request uses the
// key captured at its own click rather than a later unsaved edit.
{
  const harness = createSaveHarness();
  harness.fields.licenseKey.value = 'license-a';
  const first = harness.context.__saveApi.requestSettingsSave();
  await waitUntil(() => harness.licenseCalls.length === 1, 'first license verification');

  harness.fields.licenseKey.value = 'license-b';
  harness.fields.openrouterApiKey.value = 'KEY-AT-CLICK';
  harness.fields.aiProvider.value = 'groq';
  harness.fields.limitGroq.value = '41';
  const second = harness.context.__saveApi.requestSettingsSave();
  harness.fields.licenseKey.value = 'unsaved-c';
  harness.fields.openrouterApiKey.value = 'UNSAVED-LATER-EDIT';
  harness.fields.aiProvider.value = 'qwen';
  harness.fields.limitGroq.value = '99';
  assert.equal(harness.context.__saveApi.generation(), 2,
    'the queued click must own license UI before its writer starts');

  harness.licenseCalls[0].resolve({ key: 'LICENSE-A', ok: true });
  await first;
  assert.deepEqual(harness.licensePaints, [],
    'the first save must not paint after a newer save click');

  await waitUntil(() => harness.licenseCalls.length === 2, 'second license verification');
  assert.equal(harness.licenseCalls[1].key, 'LICENSE-B',
    'the queued request must verify the key captured at click time');
  assert.deepEqual(harness.storageWrites[1], {
    openrouterApiKey: 'KEY-AT-CLICK',
    groqApiKey: '',
    aiProvider: 'groq',
    rateLimits: { openrouter: 30, groq: 41, qwen: 30, deepseek: 30 }
  }, 'the queued request must persist the complete normalized click-time snapshot');
  harness.fields.licenseKey.value = 'LICENSE-B';
  harness.licenseCalls[1].resolve({ key: 'LICENSE-B', ok: true });
  await second;
  assert.deepEqual(
    harness.licensePaints.map(({ status }) => status.key),
    ['LICENSE-B']
  );
}

// Editing the license field while verification is pending revokes paint
// ownership immediately. A successful result for A must never appear beside
// the newer unsaved value B, nor claim that the visible form was saved.
{
  const harness = createSaveHarness();
  harness.fields.licenseKey.value = 'license-a';
  const saving = harness.context.__saveApi.requestSettingsSave();
  await waitUntil(() => harness.licenseCalls.length === 1, 'stale license paint save');
  harness.fields.licenseKey.value = 'unsaved-b';
  harness.fields.licenseKey.dispatch('input');
  harness.licenseCalls[0].resolve({ key: 'LICENSE-A', ok: true });
  await saving;
  assert.deepEqual(harness.licensePaints, []);
  assert.equal(harness.fields.licStatus.textContent, 'Изменено · сохраните');
  assert.equal(harness.fields.status.classList.contains('show'), false);
}

// Even if clearTimeout loses a race with an already-queued callback, an old
// owner's timer cannot remove the newer owner's visible save confirmation.
{
  const harness = createSaveHarness();
  harness.fields.licenseKey.value = 'license-a';
  const first = harness.context.__saveApi.requestSettingsSave();
  await waitUntil(() => harness.licenseCalls.length === 1, 'first toast save');
  harness.licenseCalls[0].resolve({ key: 'LICENSE-A', ok: true });
  await first;
  const oldTimer = harness.context.__saveApi.toastTimer();
  assert.equal(harness.fields.status.classList.contains('show'), true);

  harness.fields.licenseKey.value = 'license-b';
  const second = harness.context.__saveApi.requestSettingsSave();
  await waitUntil(() => harness.licenseCalls.length === 2, 'second toast save');
  harness.licenseCalls[1].resolve({ key: 'LICENSE-B', ok: true });
  await second;
  const newTimer = harness.context.__saveApi.toastTimer();
  assert.notEqual(newTimer, oldTimer);
  assert.ok(harness.clearedTimers.includes(oldTimer));
  assert.equal(harness.fields.status.classList.contains('show'), true);

  harness.timers.get(oldTimer)();
  assert.equal(harness.fields.status.classList.contains('show'), true,
    'an already-queued old timer must not hide the newer toast');
  harness.timers.get(newTimer)();
  assert.equal(harness.fields.status.classList.contains('show'), false);
}

console.log('settings UI generation regressions passed');
