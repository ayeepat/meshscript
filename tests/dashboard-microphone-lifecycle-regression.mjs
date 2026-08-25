import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const dashboardSource = readFileSync(
  new URL('../src/dashboard/dashboard.js', import.meta.url),
  'utf8'
);

function sourceSection(startMarker, endMarker) {
  const start = dashboardSource.indexOf(startMarker);
  const end = dashboardSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `dashboard section missing: ${startMarker}`);
  return dashboardSource.slice(start, end);
}

const clearAttachmentSource = sourceSection(
  'function clearAttachmentPresentation()',
  "\ndocument.getElementById('attach').onclick"
);
const attachmentHandlersSource = sourceSection(
  'fileInput.onchange = async () =>',
  '/* ---------- Microphone capture'
);
const microphoneSource = sourceSection(
  '/* ---------- Microphone capture',
  '\nasync function sendFromComposer()'
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeElement() {
  const classes = new Set();
  return {
    hidden: true,
    title: '',
    textContent: '',
    value: '',
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); }
    }
  };
}

function fakeStream(label) {
  const track = {
    label,
    stopCalls: 0,
    stop() { this.stopCalls += 1; }
  };
  return { label, track, getTracks: () => [track] };
}

function createHarness({ getUserMedia, constructFails = false, startFails = false, fileToInline } = {}) {
  const mic = fakeElement();
  const fileChip = fakeElement();
  const fileName = fakeElement();
  const fileInput = fakeElement();
  const listeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const toasts = [];
  let timerId = 0;
  let getUserMediaCalls = 0;

  class FakeBlob {
    constructor(parts, { type } = {}) {
      this.parts = parts;
      this.type = type || '';
      this.size = parts.reduce((sum, part) => sum + Number(part?.size || 0), 0);
    }
  }

  class FakeFile extends FakeBlob {
    constructor(parts, name, { type } = {}) {
      super(parts, { type });
      this.name = name;
    }
  }

  class FakeMediaRecorder {
    static instances = [];
    static isTypeSupported() { return true; }

    constructor(stream, options = {}) {
      if (constructFails) throw new Error('constructor failed');
      this.stream = stream;
      this.mimeType = options.mimeType || 'audio/webm';
      this.state = 'inactive';
      FakeMediaRecorder.instances.push(this);
    }

    start() {
      if (startFails) throw new Error('start failed');
      this.state = 'recording';
    }

    stop() {
      if (this.state !== 'recording') throw new Error('not recording');
      this.state = 'inactive';
      const callback = this.onstop;
      queueMicrotask(() => callback?.());
    }

    emit(size, marker = '') {
      this.ondataavailable?.({ data: { size, marker } });
    }
  }

  const context = {
    console,
    Date,
    Promise,
    queueMicrotask,
    Blob: FakeBlob,
    File: FakeFile,
    MAX_AUDIO_UPLOAD_BYTES: 1000,
    navigator: {
      mediaDevices: {
        getUserMedia(constraints) {
          getUserMediaCalls += 1;
          return getUserMedia?.(constraints, getUserMediaCalls);
        }
      }
    },
    MediaRecorder: FakeMediaRecorder,
    document: {
      getElementById(id) {
        if (id === 'mic') return mic;
        if (id === 'filechip') return fileChip;
        if (id === 'filename') return fileName;
        return fakeElement();
      },
      addEventListener(type, callback) {
        const callbacks = listeners.get(type) || [];
        callbacks.push(callback);
        listeners.set(type, callbacks);
      }
    },
    window: {
      MediaRecorder: FakeMediaRecorder,
      addEventListener(type, callback) {
        const callbacks = listeners.get(type) || [];
        callbacks.push(callback);
        listeners.set(type, callbacks);
      }
    },
    setInterval(callback) {
      const id = ++timerId;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) {
      const id = ++timerId;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    showToast(message) { toasts.push(message); },
    async fileToInline(file) {
      if (fileToInline) return fileToInline(file);
      return { name: file.name, mimeType: file.type, dataBase64: 'recording' };
    }
  };

  const prelude = `
    const fileInput = globalThis.__fileInput;
    const fileChip = globalThis.__fileChip;
    const fileNameEl = globalThis.__fileName;
    let pendingFile = null;
    let fileReadGen = 0;
    let pendingFileRead = null;
    function showAttachment(name) {
      fileNameEl.textContent = name;
      fileChip.hidden = false;
    }
  `;
  Object.assign(context, {
    __fileInput: fileInput,
    __fileChip: fileChip,
    __fileName: fileName
  });
  vm.runInNewContext(
    `${prelude}\n${clearAttachmentSource}\n${attachmentHandlersSource}\n${microphoneSource}\n` +
    `globalThis.__micApi = {
      startRecording,
      clearAttachment,
      clickMic: () => micBtn.onclick(),
      selectFile: (file) => { fileInput.files = [file]; return fileInput.onchange(); },
      currentSession: () => micSession,
      pendingFile: () => pendingFile
    };`,
    context,
    { filename: 'dashboard-microphone-section.js' }
  );

  return {
    api: context.__micApi,
    FakeMediaRecorder,
    mic,
    fileChip,
    fileName,
    fileInput,
    toasts,
    getUserMediaCalls: () => getUserMediaCalls,
    dispatch(type) {
      for (const callback of listeners.get(type) || []) callback({ type });
    }
  };
}

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

// Startup is single-flight. Clearing while the permission prompt is pending
// invalidates that session, and a late stream is stopped before a recorder can
// be constructed.
{
  const permission = deferred();
  const stream = fakeStream('late-after-clear');
  const harness = createHarness({ getUserMedia: () => permission.promise });
  const first = harness.api.startRecording();
  const second = harness.api.startRecording();
  assert.equal(harness.getUserMediaCalls(), 1, 'concurrent starts must share one permission request');
  harness.api.clearAttachment();
  permission.resolve(stream);
  await Promise.all([first, second]);
  assert.equal(stream.track.stopCalls, 1, 'a stream resolving after clear must be stopped');
  assert.equal(harness.FakeMediaRecorder.instances.length, 0,
    'a cleared startup must not construct a recorder after permission resolves');
  assert.equal(harness.api.currentSession(), null);
}

// Page unload has the same guarantee while permission is still pending.
{
  const permission = deferred();
  const stream = fakeStream('late-after-pagehide');
  const harness = createHarness({ getUserMedia: () => permission.promise });
  const startup = harness.api.startRecording();
  harness.dispatch('pagehide');
  permission.resolve(stream);
  await startup;
  assert.equal(stream.track.stopCalls, 1, 'a stream resolving after pagehide must be stopped');
  assert.equal(harness.FakeMediaRecorder.instances.length, 0);
}

// Cancelling a permission request that never settles must release the
// single-flight slot immediately. A retry owns a fresh getUserMedia call, while
// a late first stream is still stopped without touching the new recording.
{
  const firstPermission = deferred();
  const secondStream = fakeStream('retry-after-cancel');
  const lateFirstStream = fakeStream('late-first-after-cancel');
  const harness = createHarness({
    getUserMedia: (_constraints, call) => call === 1
      ? firstPermission.promise
      : Promise.resolve(secondStream)
  });
  const first = harness.api.startRecording();
  harness.api.clickMic();
  await harness.api.startRecording();
  assert.equal(harness.getUserMediaCalls(), 2,
    'cancelled unresolved permission must not block a fresh microphone request');
  assert.equal(harness.api.currentSession()?.phase, 'recording');
  firstPermission.resolve(lateFirstStream);
  await first;
  assert.equal(lateFirstStream.track.stopCalls, 1);
  assert.equal(secondStream.track.stopCalls, 0,
    'the late cancelled continuation must not stop the retry stream');
}

// BFCache pagehide/pageshow is another cancellation boundary and must likewise
// permit a fresh permission request even if the hidden page's promise hangs.
{
  const hiddenPermission = deferred();
  const restoredStream = fakeStream('retry-after-pageshow');
  const lateHiddenStream = fakeStream('late-hidden');
  const harness = createHarness({
    getUserMedia: (_constraints, call) => call === 1
      ? hiddenPermission.promise
      : Promise.resolve(restoredStream)
  });
  const hiddenStart = harness.api.startRecording();
  harness.dispatch('pagehide');
  harness.dispatch('pageshow');
  await harness.api.startRecording();
  assert.equal(harness.getUserMediaCalls(), 2,
    'a restored page must not inherit the hidden page permission flight');
  hiddenPermission.resolve(lateHiddenStream);
  await hiddenStart;
  assert.equal(lateHiddenStream.track.stopCalls, 1);
  assert.equal(restoredStream.track.stopCalls, 0);
}

// Active capture is also synchronously released on clear and page unload.
{
  const clearStream = fakeStream('active-clear');
  const clearHarness = createHarness({ getUserMedia: async () => clearStream });
  await clearHarness.api.startRecording();
  clearHarness.api.clearAttachment();
  assert.equal(clearStream.track.stopCalls, 1);
  assert.equal(clearHarness.api.currentSession(), null);

  const unloadStream = fakeStream('active-pagehide');
  const unloadHarness = createHarness({ getUserMedia: async () => unloadStream });
  await unloadHarness.api.startRecording();
  unloadHarness.dispatch('pagehide');
  assert.equal(unloadStream.track.stopCalls, 1);
  assert.equal(unloadHarness.api.currentSession(), null);
}

// Both recorder construction failure and recorder.start() failure release the
// already-acquired microphone track.
{
  const constructStream = fakeStream('construct-failure');
  const constructHarness = createHarness({
    getUserMedia: async () => constructStream,
    constructFails: true
  });
  await constructHarness.api.startRecording();
  assert.equal(constructStream.track.stopCalls, 1);

  const startStream = fakeStream('start-failure');
  const startHarness = createHarness({
    getUserMedia: async () => startStream,
    startFails: true
  });
  await startHarness.api.startRecording();
  assert.equal(startStream.track.stopCalls, 1);
}

// Superseding an active recording stops its resources. Even if its captured
// callbacks arrive late, they may neither consume the newer session's chunks
// nor stop/overwrite the newer session.
{
  const oldStream = fakeStream('old');
  const newStream = fakeStream('new');
  const streams = [oldStream, newStream];
  const harness = createHarness({ getUserMedia: async () => streams.shift() });

  await harness.api.startRecording();
  const oldRecorder = harness.FakeMediaRecorder.instances[0];
  const staleData = oldRecorder.ondataavailable;
  const staleStop = oldRecorder.onstop;
  const staleError = oldRecorder.onerror;

  await harness.api.startRecording(); // direct start supersedes the old session
  const newRecorder = harness.FakeMediaRecorder.instances[1];
  assert.equal(oldStream.track.stopCalls, 1);
  assert.equal(newStream.track.stopCalls, 0);

  staleData?.({ data: { size: 400, marker: 'stale' } });
  await staleStop?.();
  staleError?.();
  assert.equal(newStream.track.stopCalls, 0, 'stale stop callback must not clean the new stream');
  assert.equal(harness.api.pendingFile(), null, 'stale chunks must not become an attachment');
  assert.equal(harness.mic.classList.contains('recording'), true,
    'a stale error callback must not reset the newer recording UI');

  newRecorder.emit(100, 'new');
  harness.api.clickMic();
  await flush();
  assert.equal(newStream.track.stopCalls, 1);
  assert.equal(harness.api.pendingFile()?.name, 'Запись с микрофона.webm',
    `new session did not attach: ${JSON.stringify({
      phase: harness.api.currentSession()?.phase,
      pending: harness.api.pendingFile(),
      toasts: harness.toasts
    })}`);
}

// Clearing while final file conversion is pending invalidates the result; the
// eventual completion cannot resurrect the discarded recording.
{
  const conversion = deferred();
  const stream = fakeStream('clear-during-conversion');
  const harness = createHarness({
    getUserMedia: async () => stream,
    fileToInline: () => conversion.promise
  });
  await harness.api.startRecording();
  harness.FakeMediaRecorder.instances[0].emit(100);
  harness.api.clickMic();
  await flush();
  harness.api.clearAttachment();
  conversion.resolve({ name: 'stale.webm', mimeType: 'audio/webm', dataBase64: 'stale' });
  await flush();
  assert.equal(harness.api.pendingFile(), null);
  assert.equal(harness.fileChip.hidden, true);
  assert.equal(stream.track.stopCalls, 1);
}

// A selected document supersedes even a microphone session whose recorder has
// stopped but whose final FileReader conversion is still pending. The stale
// audio conversion must lose ownership and cannot overwrite the newer file.
{
  const conversion = deferred();
  const picked = deferred();
  const stream = fakeStream('picker-during-mic-conversion');
  const harness = createHarness({
    getUserMedia: async () => stream,
    fileToInline: (file) => file.name.startsWith('Запись с микрофона')
      ? conversion.promise
      : picked.promise
  });
  await harness.api.startRecording();
  harness.FakeMediaRecorder.instances[0].emit(100);
  harness.api.clickMic();
  await flush();
  assert.equal(harness.api.currentSession()?.phase, 'processing');

  const selecting = harness.api.selectFile({ name: 'newer.pdf', type: 'application/pdf' });
  assert.equal(harness.api.currentSession(), null,
    'a valid picker replacement must synchronously revoke microphone ownership');
  conversion.resolve({ name: 'stale.webm', mimeType: 'audio/webm', dataBase64: 'stale-audio' });
  await flush();
  assert.notEqual(harness.api.pendingFile()?.name, 'stale.webm',
    'old audio must stay revoked while the newer picker read is still pending');
  picked.resolve({ name: 'newer.pdf', mimeType: 'application/pdf', dataBase64: 'new-document' });
  await selecting;
  assert.equal(harness.api.pendingFile()?.name, 'newer.pdf',
    'late microphone conversion must not overwrite the newer picked document');
  assert.equal(harness.fileName.textContent, 'newer.pdf');
}

console.log('dashboard microphone lifecycle regression passed');
