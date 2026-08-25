import assert from 'node:assert/strict';

const store = {};
const sessionStore = {};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
let failNextSet = false;
let failNextSessionRemove = false;
let pauseNextHistoryGenRead = false;
let markHistoryGenRead;
let releaseHistoryGenRead;

function readStore(area, keys) {
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, area[key]]));
  if (typeof keys === 'string') return { [keys]: area[keys] };
  return { ...area };
}

function removeStore(area, keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) delete area[key];
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        await pause();
        if (keys === 'meshHistoryGen' && pauseNextHistoryGenRead) {
          pauseNextHistoryGenRead = false;
          markHistoryGenRead();
          await new Promise((resolve) => { releaseHistoryGenRead = resolve; });
        }
        return readStore(store, keys);
      },
      async set(data) {
        await pause();
        if (failNextSet) { failNextSet = false; throw new Error('simulated storage failure'); }
        Object.assign(store, data);
      },
      async remove(keys) {
        await pause();
        removeStore(store, keys);
      }
    },
    session: {
      async get(keys) {
        await pause();
        return readStore(sessionStore, keys);
      },
      async set(data) {
        await pause();
        Object.assign(sessionStore, data);
      },
      async remove(keys) {
        await pause();
        if (failNextSessionRemove) {
          failNextSessionRemove = false;
          throw new Error('simulated session-storage failure');
        }
        removeStore(sessionStore, keys);
      }
    }
  }
};

const { reserveOne, commitOne, cancelOne, getUsage } = await import('../src/lib/rate-limit.js');
const {
  createSession,
  addMessage,
  appendSolveTurn,
  listMessages
} = await import('../src/lib/history.js');
const { assertUploadAllowed, MAX_STANDARD_UPLOAD_BYTES, MAX_AUDIO_UPLOAD_BYTES } = await import('../src/lib/upload-limits.js');
const { verifyKey, setLicenseKey } = await import('../src/lib/license.js');

const reservations = await Promise.all(Array.from({ length: 8 }, () => reserveOne('openrouter')));
assert.equal((await getUsage()).openrouter.used, 0, 'reservations must not count as successful usage');
await Promise.all(reservations.map(commitOne));
assert.equal((await getUsage()).openrouter.used, 8, 'parallel charges must all persist');

/**
 * Storage TTL pruning must not turn a completed long stream into an error;
 * the live worker-local reservation still charges the delivered answer.
 */
const longStream = await reserveOne('openrouter');
const longStreamDay = store.rateReservations[longStream].day;
delete store.rateReservations[longStream];
await assert.doesNotReject(commitOne(longStream));
assert.equal((await getUsage()).openrouter.used, 9);
assert.equal(store.rateHistory[longStreamDay].openrouter, 9,
  'the local fallback must preserve usage history accounting');

// Once a provider has returned an answer, local UX-counter persistence is
// best-effort. A quota-storage failure must not convert the completed/paid
// answer into an error that invites a duplicate provider request.
const deliveredWithBrokenCounter = await reserveOne('openrouter');
failNextSet = true;
await assert.doesNotReject(commitOne(deliveredWithBrokenCounter));
assert.equal((await getUsage()).openrouter.used, 9,
  'failed post-success bookkeeping may undercount but must not invent usage');
await cancelOne(deliveredWithBrokenCounter);

store.rateLimits = { ...(store.rateLimits || {}), deepseek: 1 };
const livePastStorageTtl = await reserveOne('deepseek');
delete store.rateReservations[livePastStorageTtl];
await assert.rejects(
  reserveOne('deepseek'),
  /Дневной лимит DeepSeek исчерпан/,
  'a still-live worker reservation must continue occupying budget after storage pruning'
);
await cancelOne(livePastStorageTtl);

const failed = await reserveOne('openrouter');
await cancelOne(failed);
assert.equal((await getUsage()).openrouter.used, 9, 'cancelled calls must never become usage');

const orphanedFailure = await reserveOne('openrouter');
failNextSet = true;
await assert.rejects(cancelOne(orphanedFailure), /simulated storage failure/);
assert.equal((await getUsage()).openrouter.used, 9,
  'a cleanup storage failure may leave a reservation, but must not leave a charge');

const [first, second] = await Promise.all([
  createSession('Алгебра', 'A'),
  createSession('Физика', 'B')
]);
assert.equal(store.meshHistory.sessions.length, 2, 'parallel sessions must not overwrite each other');

await Promise.all([
  addMessage(first.id, 'user', 'one'),
  addMessage(first.id, 'assistant', 'two'),
  addMessage(second.id, 'user', 'three')
]);
assert.equal((await listMessages(first.id)).length, 2, 'parallel messages must not overwrite each other');

// A completed solve is one logical history transaction. If its sole storage
// commit fails, neither a newly created orphan session nor half of the
// user/assistant pair may become visible.
{
  const sessionsBefore = structuredClone(store.meshHistory.sessions);
  const messagesBefore = structuredClone(store.meshHistory.messages);
  failNextSet = true;
  await assert.rejects(
    appendSolveTurn({
      subject: 'Геометрия',
      taskText: 'Новая задача',
      userContent: 'Условие',
      assistantContent: 'Ответ'
    }),
    /simulated storage failure/
  );
  assert.deepEqual(store.meshHistory.sessions, sessionsBefore,
    'a failed solve-history commit must not leave an orphan session');
  assert.deepEqual(store.meshHistory.messages, messagesBefore,
    'a failed solve-history commit must not leave a half-conversation');

  const existingBefore = structuredClone(await listMessages(first.id));
  failNextSet = true;
  await assert.rejects(
    appendSolveTurn({
      sessionId: first.id,
      subject: 'Алгебра',
      taskText: 'A',
      userContent: 'new user turn',
      assistantContent: 'new assistant turn'
    }),
    /simulated storage failure/
  );
  assert.deepEqual(await listMessages(first.id), existingBefore,
    'a failed append to an existing session must publish neither message');
}

assert.doesNotThrow(() => assertUploadAllowed({ name: 'sheet.pdf', type: 'application/pdf', size: MAX_STANDARD_UPLOAD_BYTES }));
assert.throws(() => assertUploadAllowed({ name: 'sheet.pdf', type: 'application/pdf', size: MAX_STANDARD_UPLOAD_BYTES + 1 }));
assert.doesNotThrow(() => assertUploadAllowed({ name: 'listening.mp3', type: 'audio/mpeg', size: MAX_AUDIO_UPLOAD_BYTES }));

// A writer that loaded pre-wipe history must see the flipped generation,
// reload the empty state, and apply only its own still-valid mutation.
{
  const deletedSession = {
    id: 'private-session', subject: 'История', task_text: 'секрет', created_at: new Date().toISOString()
  };
  Object.assign(store, {
    meshHistory: {
      sessions: [deletedSession],
      messages: { [deletedSession.id]: [{ id: 'private-message', content: 'секрет' }] }
    },
    meshHistoryGen: 'before-wipe',
    weekHomework: { private: true },
    pendingUpload: { private: true },
    taskClassCache: { private: true },
    gdzTaskCache: { private: true },
    tmLastHb: 1,
    rateAttempts: { private: true },
    rateUsage: { private: true },
    rateHistory: { private: true },
    rateReservations: { private: true },
    orUsageSnap: { private: true },
    smeshTranscriptCache: {
      privateAudio: { text: 'личная расшифровка', at: Date.now() }
    },
    deviceId: 'kept-device',
    gdzHumanRefs: { public: true },
    gdzCatalog: { public: true },
    dashLaunchKeys: { launch: { key: 'secret', expiresAt: Date.now() + 60_000 } }
  });
  sessionStore.dashLaunches = {
    launch: { ciphertext: 'secret', iv: 'secret', expiresAt: store.dashLaunchKeys.launch.expiresAt }
  };
  sessionStore.smeshTranscriptCache = {
    privateAudio: { text: 'личная расшифровка', at: Date.now() }
  };

  let historyGenReadStarted;
  historyGenReadStarted = new Promise((resolve) => { markHistoryGenRead = resolve; });
  pauseNextHistoryGenRead = true;
  const writer = await import('../src/lib/history.js?ctx=wipe-writer');
  const wiper = await import('../src/lib/history.js?ctx=wipe-owner');
  const pendingWrite = writer.createSession('Алгебра', 'новая задача');
  await historyGenReadStarted;
  await wiper.deleteAllLocalData();
  releaseHistoryGenRead();
  const created = await pendingWrite;

  assert.equal(store.meshHistory.sessions.some((session) => session.id === deletedSession.id), false,
    'a delayed writer must not resurrect a session deleted by another context');
  assert.deepEqual(store.meshHistory.sessions.map((session) => session.id), [created.id],
    'the delayed mutation must be re-applied to fresh post-wipe history');
  for (const key of [
    'weekHomework', 'pendingUpload', 'taskClassCache', 'gdzTaskCache', 'tmLastHb',
    'rateAttempts', 'rateUsage', 'rateHistory', 'rateReservations', 'orUsageSnap'
  ]) {
    assert.equal(Object.hasOwn(store, key), false, `${key} must be removed by the local-data wipe`);
  }
  assert.equal(Object.hasOwn(store, 'dashLaunchKeys'), false,
    'the local dashboard launch key/attachment half must be wiped');
  assert.equal(Object.hasOwn(sessionStore, 'dashLaunches'), false,
    'the session dashboard launch ciphertext half must be wiped');
  assert.equal(Object.hasOwn(sessionStore, 'smeshTranscriptCache'), false,
    'the legacy session transcript cache must be wiped with other local student data');
  assert.equal(Object.hasOwn(store, 'smeshTranscriptCache'), false,
    'the trusted local transcript cache must be wiped with other student data');
  assert.equal(store.deviceId, 'kept-device', 'wiping data must not consume another license device slot');
  assert.deepEqual(store.gdzHumanRefs, { public: true });
  assert.deepEqual(store.gdzCatalog, { public: true });

  // A dashboard-session failure must surface only after the independent local
  // removal has finished, so rate/spend data is never retained by early abort.
  store.rateAttempts = { private: true };
  store.orUsageSnap = { private: true };
  store.dashLaunchKeys = { launch: { key: 'secret', expiresAt: Date.now() + 60_000 } };
  sessionStore.dashLaunches = {
    launch: { ciphertext: 'secret', iv: 'secret', expiresAt: store.dashLaunchKeys.launch.expiresAt }
  };
  failNextSessionRemove = true;
  await assert.rejects(wiper.deleteAllLocalData(), /simulated session-storage failure/);
  assert.equal(Object.hasOwn(store, 'rateAttempts'), false);
  assert.equal(Object.hasOwn(store, 'orUsageSnap'), false);
}

// With two first-use contexts, force A.set(X), B.set(Y), then let both re-read.
// Both callers must converge on Y, the value that actually persisted.
{
  const regularLocal = chrome.storage.local;
  const invalidStore = { deviceId: 'student@example.com' };
  chrome.storage.local = {
    async get(keys) { return readStore(invalidStore, keys); },
    async set(values) { Object.assign(invalidStore, values); },
    async remove(keys) { removeStore(invalidStore, keys); }
  };
  try {
    const repairedModule = await import('../src/lib/history.js?ctx=invalid-device');
    const repaired = await repairedModule.getDeviceId();
    assert.match(repaired,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      'an invalid legacy identifier must self-heal to the server UUIDv4 contract');
    assert.equal(invalidStore.deviceId, repaired);
    assert.equal(repaired.includes('@'), false,
      'content-bearing legacy identifiers must not survive local repair');
  } finally {
    chrome.storage.local = regularLocal;
  }
}

{
  const regularLocal = chrome.storage.local;
  const deviceStore = {};
  const candidates = [];
  let initialReads = 0;
  let releaseInitialReads;
  const bothInitialReads = new Promise((resolve) => { releaseInitialReads = resolve; });
  let markSecondSet;
  const secondSetDone = new Promise((resolve) => { markSecondSet = resolve; });
  chrome.storage.local = {
    async get(key) {
      if (key === 'deviceId' && initialReads < 2) {
        const snapshot = deviceStore.deviceId;
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await bothInitialReads;
        return { deviceId: snapshot };
      }
      return { deviceId: deviceStore.deviceId };
    },
    async set({ deviceId }) {
      candidates.push(deviceId);
      deviceStore.deviceId = deviceId;
      if (candidates.length === 1) await secondSetDone;
      else markSecondSet();
    },
    async remove() {}
  };
  try {
    const deviceA = await import('../src/lib/history.js?ctx=device-a');
    const deviceB = await import('../src/lib/history.js?ctx=device-b');
    const [idA, idB] = await Promise.all([deviceA.getDeviceId(), deviceB.getDeviceId()]);
    assert.equal(candidates.length, 2, 'both racing contexts must generate a first-use candidate');
    assert.notEqual(candidates[0], candidates[1]);
    assert.equal(idA, candidates[1]);
    assert.equal(idB, candidates[1]);
    assert.equal(deviceStore.deviceId, candidates[1], 'both callers must return the persisted winner');
  } finally {
    chrome.storage.local = regularLocal;
  }
}

// Clearing the field while /verify is in flight must be final: the delayed
// response belongs to an obsolete key and cannot recreate licenseStatus.
{
  const key = 'SMESH-RACE-OLD1-KEY2';
  store.licenseStatus = {
    key, ok: true, checkedAt: Date.now(), lastVerifiedAt: Date.now(),
    activation_token: 'A'.repeat(43)
  };
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const fetchReleased = new Promise((resolve) => { releaseFetch = resolve; });
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/deactivate')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    markFetchStarted();
    await fetchReleased;
    return new Response(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const pending = verifyKey(key, { onlyIfCurrent: true });
  await fetchStarted;
  await setLicenseKey('');
  releaseFetch();
  const staleVerdict = await pending;
  assert.equal(staleVerdict.ok, false,
    'a stale verifier caller must not retain authorization after the key was cleared');
  assert.equal(staleVerdict.reason, 'no_key');
  assert.equal(Object.hasOwn(store, 'licenseStatus'), false,
    'a cleared license must stay absent after an older verification resolves');
}

// The generation guard must also cover DIRECT overlapping setLicenseKey()
// calls — user mutations, not only the background onlyIfCurrent revalidation.
// A slow /verify for the key saved first must never overwrite what the user
// did afterwards (clear or replace).
function keyedSlowFetch(slowKey) {
  let releaseSlow;
  const released = new Promise((resolve) => { releaseSlow = resolve; });
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/deactivate')) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    const body = JSON.parse(init.body);
    if (body.key === slowKey) { markStarted(); await released; }
    return new Response(JSON.stringify({
      ok: true, type: 'lifetime', expires_at: null, activation_token: 'B'.repeat(43)
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  return { started, releaseSlow: () => releaseSlow() };
}

{
  const oldKey = 'SMESH-GENA-OLD1-KEY3';
  const slow = keyedSlowFetch(oldKey);
  const pendingOld = setLicenseKey(oldKey);
  await slow.started;
  const pendingClear = setLicenseKey(''); // queued behind the older worker-owned mutation
  slow.releaseSlow();
  await Promise.all([pendingOld, pendingClear]);
  assert.equal(Object.hasOwn(store, 'licenseStatus'), false,
    'a slow direct save must not resurrect a key the user cleared afterwards');
}

{
  const oldKey = 'SMESH-GENB-OLD1-KEY4';
  const newKey = 'SMESH-GENB-NEW1-KEY5';
  const slow = keyedSlowFetch(oldKey);
  const pendingOld = setLicenseKey(oldKey);
  await slow.started;
  const pendingFresh = setLicenseKey(newKey); // queued in user-intent order by the worker
  slow.releaseSlow();
  await pendingOld;
  await assert.rejects(pendingFresh, /Сначала деактивируйте текущий ключ/,
    'switching keys must require an authenticated release of device №1');
  assert.equal(store.licenseStatus?.key, oldKey);
  await setLicenseKey('');
  const fresh = await setLicenseKey(newKey);
  assert.equal(fresh.key, newKey);
  assert.equal(store.licenseStatus?.key, newKey,
    'after explicit deactivation, the replacement key becomes current');
}

console.log('storage race regression passed');
