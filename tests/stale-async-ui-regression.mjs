import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const scraperSource = readFileSync(
  new URL('../src/content/scraper.js', import.meta.url),
  'utf8'
);
const dashboardSource = readFileSync(
  new URL('../src/dashboard/dashboard.js', import.meta.url),
  'utf8'
);
const settingsSource = readFileSync(
  new URL('../src/settings/settings.js', import.meta.url),
  'utf8'
);
const themeControllerSource = readFileSync(
  new URL('../src/common/theme.js', import.meta.url),
  'utf8'
);
const providerBadgeSource = readFileSync(
  new URL('../src/common/provider-badge.js', import.meta.url),
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

// The provider badge has the same live-setting race as the theme controller:
// a change delivered while the initial storage snapshot is pending must win.
{
  const initialRead = deferred();
  let storageListener = null;
  const badge = { textContent: '', title: '', hidden: true };
  const context = {
    Promise,
    // The badge is switched off in production (config.SHOW_PROVIDER_UI), but the
    // code stays for when the flag is flipped back — so pin it on here and keep
    // covering the race it was written for.
    SHOW_PROVIDER_UI: true,
    DEFAULT_PROVIDER: 'deepseek',
    document: { getElementById: () => badge },
    chrome: {
      storage: {
        local: { get: () => initialRead.promise },
        onChanged: { addListener(callback) { storageListener = callback; } }
      }
    }
  };
  vm.runInNewContext(
    `${providerBadgeSource.replace(/^import .*$/gm, '').replace(/\bexport\s+/g, '')}\n` +
    'globalThis.__mountProviderBadge = mountProviderBadge;',
    context,
    { filename: 'provider-badge.js' }
  );
  const mounting = context.__mountProviderBadge('badge');
  assert.equal(typeof storageListener, 'function',
    'provider changes must be observed before the initial storage read settles');
  storageListener({ aiProvider: { newValue: 'deepseek' } }, 'local');
  initialRead.resolve({ aiProvider: 'groq' });
  await mounting;
  assert.equal(badge.textContent, 'DSK', 'a stale initial provider snapshot must not repaint the badge');
  assert.match(badge.title, /DeepSeek/);
}

// The shared theme controller must subscribe before its initial storage read;
// otherwise a live preference change can be overwritten by that older snapshot
// on every extension surface, even if the Settings buttons themselves are safe.
{
  const initialRead = deferred();
  let storageListener = null;
  const paints = [];
  const document = {
    documentElement: { dataset: {} },
    dispatchEvent(event) { paints.push(event.detail); }
  };
  const context = {
    Promise,
    document,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    CustomEvent: class { constructor(_type, init) { this.detail = init.detail; } },
    chrome: {
      storage: {
        local: {
          get: () => initialRead.promise,
          async set() {}
        },
        onChanged: { addListener(callback) { storageListener = callback; } }
      }
    }
  };
  vm.runInNewContext(
    `${themeControllerSource.replace(/\bexport\s+/g, '')}\n` +
    'globalThis.__themeController = { initTheme, setThemePref };',
    context,
    { filename: 'shared-theme-controller.js' }
  );
  const initializing = context.__themeController.initTheme();
  assert.equal(typeof storageListener, 'function', 'theme storage listener must be wired before initial read settles');
  storageListener({ theme: { newValue: 'dark' } }, 'local');
  initialRead.resolve({ theme: 'light' });
  await initializing;
  assert.equal(document.documentElement.dataset.theme, 'dark',
    'a stale initial snapshot must not repaint a newer live theme');
  assert.deepEqual(paints, ['dark']);
}

// Settings initialization must never repaint a checkbox or segmented theme
// after the user has already made a newer choice.
{
  const themeSource = sourceSection(
    settingsSource,
    'const segButtons =',
    '/* ---------- Reveal'
  );
  const initialThemeRead = deferred();
  const listeners = {};
  const buttons = ['system', 'light', 'dark'].map((pref) => ({
    dataset: { pref },
    active: false,
    classList: { toggle(_name, on) { this.owner.active = on; }, owner: null }
  }));
  for (const button of buttons) button.classList.owner = button;
  const context = {
    Promise,
    document: {
      querySelectorAll: () => buttons,
      addEventListener(type, callback) { listeners[type] = callback; }
    },
    getThemePref: () => initialThemeRead.promise,
    async setThemePref() {}
  };
  vm.runInNewContext(`${themeSource}\nglobalThis.__themeButtons = segButtons;`, context,
    { filename: 'settings-theme-section.js' });
  await buttons[2].onclick();
  initialThemeRead.resolve('light');
  await initialThemeRead.promise;
  await Promise.resolve();
  assert.equal(buttons[2].active, true, 'a late initial theme read must not replace a newer click');
  assert.equal(buttons[1].active, false);

  const firstWrite = deferred();
  const secondWrite = deferred();
  let writesStarted = 0;
  context.setThemePref = () => (++writesStarted === 1 ? firstWrite.promise : secondWrite.promise);
  const selectingSystem = buttons[0].onclick();
  const selectingLight = buttons[1].onclick();
  await Promise.resolve();
  assert.equal(writesStarted, 1, 'rapid theme writes must be serialized in click order');
  assert.equal(buttons[1].active, true, 'the newest click must remain painted while an older write is pending');
  firstWrite.resolve();
  await selectingSystem;
  await Promise.resolve();
  assert.equal(writesStarted, 2);
  assert.equal(buttons[1].active, true, 'completion of an older write must not repaint its preference');
  secondWrite.resolve();
  await Promise.all([selectingSystem, selectingLight]);
  assert.equal(buttons[1].active, true);
}

{
  const consentSource = sourceSection(
    settingsSource,
    'let consentUiGeneration =',
    '/* ---------- Privacy: statistics'
  );
  const consentRead = deferred();
  const consentToggle = { id: 'consentToggle', checked: true, onchange: null };
  const touchedControls = new Set();
  const renders = [];
  const context = {
    Promise,
    touchedControls,
    document: { getElementById: () => consentToggle },
    hasConsent: () => consentRead.promise,
    async setConsent() {},
    setCheckedUnlessTouched(id, checked) {
      if (!touchedControls.has(id)) consentToggle.checked = !!checked;
    },
    renderConsentStatus(value) { renders.push(value); }
  };
  vm.runInNewContext(
    `${consentSource}\nglobalThis.__consentApi = { loadConsentUi, wireConsent };`,
    context,
    { filename: 'settings-consent-section.js' }
  );
  const loading = context.__consentApi.loadConsentUi();
  context.__consentApi.wireConsent();
  touchedControls.add('consentToggle');
  consentToggle.checked = true;
  await consentToggle.onchange({ target: consentToggle });
  consentRead.resolve(false);
  await loading;
  assert.equal(consentToggle.checked, true, 'a stale consent snapshot must not undo a user toggle');
  assert.deepEqual(renders, [true], 'only the current user consent state may paint status');

  renders.length = 0;
  const firstWrite = deferred();
  const secondWrite = deferred();
  const consentWrites = [];
  context.setConsent = (value) => {
    consentWrites.push(value);
    return consentWrites.length === 1 ? firstWrite.promise : secondWrite.promise;
  };
  consentToggle.checked = false;
  const selectingFalse = consentToggle.onchange({ target: consentToggle });
  consentToggle.checked = true;
  const selectingTrue = consentToggle.onchange({ target: consentToggle });
  await Promise.resolve();
  assert.deepEqual(consentWrites, [false], 'consent writes must start in click order, one at a time');
  firstWrite.resolve();
  await selectingFalse;
  await Promise.resolve();
  assert.deepEqual(consentWrites, [false, true]);
  assert.deepEqual(renders, [], 'an older completed consent write must not repaint');
  secondWrite.resolve();
  await selectingTrue;
  assert.deepEqual(renders, [true]);
}

{
  const licenseSource = sourceSection(
    settingsSource,
    'let licenseUiGeneration =',
    '\nfunction renderLicenseStatus'
  );
  const licenseRead = deferred();
  const touchedControls = new Set();
  const rendered = [];
  const context = {
    touchedControls,
    getLicenseStatus: () => licenseRead.promise,
    setFieldUnlessTouched() {},
    renderLicenseStatus(status) { rendered.push(status); }
  };
  vm.runInNewContext(`${licenseSource}\nglobalThis.__loadLicenseUi = loadLicenseUi;`, context,
    { filename: 'settings-license-section.js' });
  const loading = context.__loadLicenseUi();
  touchedControls.add('licenseKey');
  licenseRead.resolve({ key: 'OLD-LICENSE', ok: true });
  await loading;
  assert.deepEqual(rendered, [], 'a late license snapshot must not repaint status after key editing');
}

{
  const privacySource = sourceSection(
    settingsSource,
    'let telemetryUiGeneration =',
    '\nfunction privacyFlash'
  );
  const privacyRead = deferred();
  const telemetryToggle = { id: 'telemetryToggle', checked: true };
  const touchedControls = new Set(['telemetryToggle']);
  const writes = [];
  const context = {
    touchedControls,
    chrome: { storage: { local: {
      get: () => privacyRead.promise,
      set(value) { writes.push(value.telemetryEnabled); return Promise.resolve(); }
    } } },
    setCheckedUnlessTouched(id, checked) {
      if (!touchedControls.has(id)) telemetryToggle.checked = !!checked;
    }
  };
  vm.runInNewContext(
    `${privacySource}\nglobalThis.__privacyApi = { loadPrivacyUi, enqueueTelemetryPreference };`,
    context,
    { filename: 'settings-privacy-section.js' });
  const loading = context.__privacyApi.loadPrivacyUi();
  privacyRead.resolve({ telemetryEnabled: false });
  await loading;
  assert.equal(telemetryToggle.checked, true, 'a stale telemetry snapshot must not undo a user toggle');

  const first = context.__privacyApi.enqueueTelemetryPreference(true);
  const second = context.__privacyApi.enqueueTelemetryPreference(false);
  await Promise.all([first.write, second.write]);
  assert.deepEqual(writes, [true, false], 'telemetry writes must persist in user-action order');
}

// General Settings saves serialize the entire storage/license pipeline, so a
// slower earlier click cannot persist after a newer save.
{
  const queueDeclaration = settingsSource.match(
    /let settingsSaveQueue = Promise\.resolve\(\);/
  )?.[0];
  const queueFunction = sourceSection(
    settingsSource,
    'function save(intent)',
    '\nasync function saveOnce('
  );
  assert.ok(queueDeclaration, 'settings save queue declaration must be extractable');
  const first = deferred();
  const second = deferred();
  let started = 0;
  const context = {
    Promise,
    saveOnce() { return ++started === 1 ? first.promise : second.promise; }
  };
  vm.runInNewContext(
    `${queueDeclaration}\n${queueFunction}\nglobalThis.__save = save;`,
    context,
    { filename: 'settings-save-queue.js' });
  const saveA = context.__save();
  const saveB = context.__save();
  await Promise.resolve();
  assert.equal(started, 1);
  first.resolve();
  await saveA;
  await Promise.resolve();
  assert.equal(started, 2, 'the newer save must start only after the older pipeline settles');
  second.resolve();
  await saveB;
}

// A user selection made before the storage snapshot resolves owns both
// segmented controls and the variables carried by the next SOLVE request.
{
  const togglesSource = sourceSection(
    dashboardSource,
    '/* ---------- Answer-mode toggle',
    '/* ---------- Init: load week'
  );
  const modeRead = deferred();
  const engineRead = deferred();
  const listeners = {};
  const buttons = {
    modeSeg: ['brief', 'explain'].map((mode) => ({
      dataset: { mode }, classList: { toggle() {} }
    })),
    engineSeg: ['auto', 'think'].map((engine) => ({
      dataset: { engine }, classList: { toggle() {} }
    }))
  };
  const segments = Object.fromEntries(Object.entries(buttons).map(([id, items]) => [id, {
    querySelectorAll() { return items; },
    addEventListener(type, callback) { listeners[`${id}:${type}`] = callback; }
  }]));
  const context = {
    Promise,
    document: { getElementById: (id) => segments[id] },
    chrome: { storage: { local: {
      get(key) { return key === 'answerMode' ? modeRead.promise : engineRead.promise; },
      set() {}
    } } },
    paintEngineBadge() {}
  };
  vm.runInNewContext(
    `let answerMode = 'brief'; let solveEngine = 'auto';\n${togglesSource}\n` +
    `globalThis.__toggleState = { mode: () => answerMode, engine: () => solveEngine };`,
    context,
    { filename: 'dashboard-mode-engine-section.js' }
  );
  listeners['modeSeg:click']({ target: { closest: () => buttons.modeSeg[1] } });
  listeners['engineSeg:click']({ target: { closest: () => buttons.engineSeg[1] } });
  modeRead.resolve({ answerMode: 'brief' });
  engineRead.resolve({ solveEngine: 'auto' });
  await Promise.all([modeRead.promise, engineRead.promise]);
  await Promise.resolve();
  assert.equal(context.__toggleState.mode(), 'explain',
    'a late saved answer mode must not overwrite a newer click');
  assert.equal(context.__toggleState.engine(), 'think',
    'a late saved solve engine must not overwrite a newer click');
}

// A matching question is complete only when every dropdown row succeeds. The
// failing row must not stop later rows from making useful partial progress.
{
  const clickSafetySource = sourceSection(
    scraperSource,
    'function isUnsafeInteractiveActivator(el)',
    '\n// Open a dropdown'
  );
  const fillSource = sourceSection(
    scraperSource,
    'function interactiveRadioIsSelected(element)',
    '\n/**\n * Async fill pass'
  );
  const calls = [];
  const context = {
    document: { documentElement: { contains: () => true } },
    distributeInteractiveValues: () => ['one', 'two'],
    normalizeForMatch: (value) => String(value || '').toLowerCase(),
    controlLabelText: (el) => el.textContent || '',
    chooseOption: (_answer, opts) => opts[0]?.el || null,
    isDisabledControl: () => false,
    interactiveGuardCurrent: () => true,
    interactiveGuardAccept: () => true,
    __smeshSleep: async () => {},
    parseChoiceIndices: () => [],
    async fillOneDropdown(el) {
      calls.push(el.id);
      if (el.id === 'first') throw new Error('simulated row failure');
      return true;
    }
  };
  vm.runInNewContext(
    `${clickSafetySource}\n${fillSource}\nglobalThis.__fillInteractiveUnit = fillInteractiveUnit;`,
    context,
    { filename: 'scraper-fill-interactive-unit.js' }
  );
  const result = await context.__fillInteractiveUnit(
    { type: 'dropdown', els: [{ id: 'first' }, { id: 'second' }] },
    { answer: 'matching answer', choice: null }
  );
  assert.equal(result, false, 'one failed matching row must make the whole unit incomplete');
  assert.deepEqual(calls, ['first', 'second'], 'a failed row must not prevent later dropdown attempts');

  const ariaRadio = {
    textContent: 'Вариант А',
    checked: undefined,
    getAttribute: () => null,
    click() { /* page ignored the click and exposed no selected state */ }
  };
  assert.equal(await context.__fillInteractiveUnit(
    { type: 'aria-radio', els: [ariaRadio] },
    { answer: 'Вариант А', choice: null }
  ), false, 'an ARIA radio with no verifiable checked state must not report success');

  const nativeRadio = {
    textContent: 'Вариант А',
    checked: false,
    getAttribute: () => null,
    click() { this.checked = true; }
  };
  assert.equal(await context.__fillInteractiveUnit(
    { type: 'aria-radio', els: [nativeRadio] },
    { answer: 'Вариант А', choice: null }
  ), true, 'a native checked fallback is acceptable when aria-checked is absent');

  const ariaToggle = {
    textContent: 'Вариант А',
    getAttribute: () => null,
    click() { /* malformed widget never exposes aria-pressed */ }
  };
  assert.equal(await context.__fillInteractiveUnit(
    { type: 'toggle', els: [ariaToggle] },
    { answer: 'Вариант А', choice: null }
  ), false, 'a toggle with no verifiable aria-pressed state must not report success');
}

const attachmentSource = sourceSection(
  dashboardSource,
  '// Held as an already-inlined file',
  '/* ---------- Microphone capture'
);

function fakeElement() {
  const classes = new Set();
  return {
    hidden: true,
    value: '',
    files: [],
    textContent: '',
    click() {},
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); }
    }
  };
}

function createAttachmentHarness(reads) {
  const fileInput = fakeElement();
  const fileChip = fakeElement();
  const fileName = fakeElement();
  const attach = fakeElement();
  const clearFile = fakeElement();
  const listeners = new Map();

  class FakeFile {
    constructor(_parts, name, { type } = {}) {
      this.name = name;
      this.type = type || '';
    }
  }

  const context = {
    Promise,
    Date,
    File: FakeFile,
    document: {
      getElementById(id) {
        if (id === 'attach') return attach;
        if (id === 'clearfile') return clearFile;
        return fakeElement();
      },
      addEventListener(type, callback) { listeners.set(type, callback); }
    },
    fileToInline(file) {
      const read = reads.get(file.name);
      assert.ok(read, `missing read for ${file.name}`);
      return read.promise;
    },
    showToast() {}
  };
  Object.assign(context, {
    __fileInput: fileInput,
    __fileChip: fileChip,
    __fileName: fileName
  });

  const prelude = `
    const fileInput = globalThis.__fileInput;
    const fileChip = globalThis.__fileChip;
    const fileNameEl = globalThis.__fileName;
    let micSession = null;
    function cancelMicSession() {}
  `;
  vm.runInNewContext(
    `${prelude}\n${attachmentSource}\n` +
    `globalThis.__attachmentApi = {
      select(file) { fileInput.files = [file]; return fileInput.onchange(); },
      clearAttachment,
      pendingFile: () => pendingFile,
      pendingRead: () => pendingFileRead,
      chipHidden: () => fileChip.hidden,
      shownName: () => fileNameEl.textContent
    };`,
    context,
    { filename: 'dashboard-attachment-section.js' }
  );
  return context.__attachmentApi;
}

// Clearing while FileReader is pending is final: its late completion cannot
// attach itself to the next composer message.
{
  const oldRead = deferred();
  const api = createAttachmentHarness(new Map([['old.png', oldRead]]));
  const selecting = api.select({ name: 'old.png', type: 'image/png' });
  api.clearAttachment();
  oldRead.resolve({ name: 'old.png', mimeType: 'image/png', dataBase64: 'old' });
  await selecting;
  assert.equal(api.pendingFile(), null, 'a cleared read must not resurrect pendingFile');
  assert.equal(api.chipHidden(), true, 'a cleared read must not restore the attachment chip');
  assert.equal(api.pendingRead(), null);
}

// Selection order, not FileReader completion order, owns the attachment slot.
{
  const oldRead = deferred();
  const newRead = deferred();
  const api = createAttachmentHarness(new Map([
    ['old.png', oldRead],
    ['new.png', newRead]
  ]));
  const selectingOld = api.select({ name: 'old.png', type: 'image/png' });
  const selectingNew = api.select({ name: 'new.png', type: 'image/png' });
  newRead.resolve({ name: 'new.png', mimeType: 'image/png', dataBase64: 'new' });
  await selectingNew;
  oldRead.resolve({ name: 'old.png', mimeType: 'image/png', dataBase64: 'old' });
  await selectingOld;
  assert.equal(api.pendingFile()?.name, 'new.png', 'an older slow read must not overwrite the newer selection');
  assert.equal(api.shownName(), 'new.png', 'stale completion must not repaint the chip label');
  assert.equal(api.pendingRead(), null);
}

console.log('stale async UI regressions passed');
