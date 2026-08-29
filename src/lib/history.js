/**
 * Local solve-history store, backed by chrome.storage.local.
 * Replaces the previous Supabase-backed store so the extension needs no
 * external account or shared anon key to ship publicly. History is per-device
 * (was already scoped by anonymous device_id) with a 7-day TTL enforced on
 * read.
 *
 * Storage layout:
 *   meshHistory: { sessions: Session[], messages: { [sessionId]: Message[] } }
 *   meshHistoryGen: UUID changed with every whole-history write
 *
 * Session = { id, subject, task_text, lesson_key, created_at }
 * Message = { id, session_id, role, content, created_at }
 *
 * `lesson_key` (see lib/lesson-key.js) is what lets the dashboard reopen a
 * lesson it already solved and replay the stored conversation instead of
 * spending another completion. Sessions written by older builds simply have
 * no key and never match, so they keep behaving as before.
 */

import { TEST_ANSWER_CACHE_KEY, TEST_ANSWER_CACHE_TTL_MS } from './test-answer-cache.js';
import { wipeDashboardLaunches } from './dashboard-launch.js';

const STORAGE_KEY = 'meshHistory';
const GEN_KEY = 'meshHistoryGen';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
let stateQueue = Promise.resolve();
let deviceIdPromise = null;
const DEVICE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isExtensionPageContext() {
  try {
    return typeof document !== 'undefined' && location.protocol === 'chrome-extension:' &&
      typeof chrome?.runtime?.sendMessage === 'function';
  } catch {
    return false;
  }
}

async function workerCommand(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, ...(payload === undefined ? {} : { payload }) });
  if (!response?.ok) throw new Error(response?.error || 'Фоновый процесс расширения не ответил.');
  return response;
}

function stateFromStored(data) {
  return data && typeof data === 'object'
    ? { sessions: data.sessions || [], messages: data.messages || {} }
    : { sessions: [], messages: {} };
}

// The local queue serializes one extension context. A generation recheck also
// catches another context's write and reapplies this re-runnable mutator to its
// fresh state instead of restoring the stale whole object.
function mutateState(mutator) {
  const run = stateQueue.then(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const stored = await chrome.storage.local.get([STORAGE_KEY, GEN_KEY]);
      const startedUnder = stored[GEN_KEY];
      const state = prune(stateFromStored(stored[STORAGE_KEY]));
      const result = await mutator(state);
      const { [GEN_KEY]: current } = await chrome.storage.local.get(GEN_KEY);
      if (current !== startedUnder) {
        if (attempt < 4) continue;
        // Five consecutive cross-context collisions are pathological. Save the
        // fifth freshly loaded mutation without another retry/recheck: a
        // student's answer degrades to today's last-writer-wins instead of
        // failing mid-solve.
      }
      // Normally the residual recheck→set window is only one storage microtask;
      // resurrection after a wipe now requires the wipe to land inside it.
      await chrome.storage.local.set({
        [STORAGE_KEY]: state,
        [GEN_KEY]: crypto.randomUUID()
      });
      return result;
    }
  });
  stateQueue = run.catch(() => {});
  return run;
}

// A pure read: load, apply the TTL in memory, answer. Deliberately NOT
// mutateState — that rewrites the whole history object and mints a new
// generation on every call, so merely opening a lesson (findLessonSession runs
// before every dashboard lesson) or listing Settings history would churn the
// store and invalidate any writer mid-recheck. The 7-day prune is still
// PERSISTED by every real mutation and by the retention alarm's
// cleanupLocalData(); doing it here as well only affects what this caller sees,
// which is the part that has to be correct.
async function readState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return prune(stateFromStored(stored[STORAGE_KEY]));
}

// Drop anything older than TTL_MS. Returns a fresh state with stale sessions
// and their messages removed. Called on every read so expired entries
// disappear without a background sweep.
function prune(state) {
  const cutoff = Date.now() - TTL_MS;
  // Work on detached records. chrome.storage returns structured clones in
  // production, but keeping that isolation explicit prevents a failed commit
  // from leaking in-memory mutations through alternate/mock storage adapters.
  const sessions = state.sessions
    .filter((s) => Date.parse(s.created_at) >= cutoff)
    .map((session) => ({ ...session }));
  const keep = new Set(sessions.map((s) => s.id));
  const messages = {};
  for (const sid of Object.keys(state.messages)) {
    if (keep.has(sid)) {
      messages[sid] = Array.isArray(state.messages[sid])
        ? state.messages[sid].map((message) => ({ ...message }))
        : [];
    }
  }
  return { sessions, messages };
}

async function getDeviceIdHere() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      let { deviceId } = await chrome.storage.local.get('deviceId');
      if (typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId)) {
        const canonical = deviceId.toLowerCase();
        if (canonical !== deviceId) await chrome.storage.local.set({ deviceId: canonical });
        return canonical;
      }
      // The public backend now accepts only the UUIDv4 shape this extension has
      // always generated. Repair corrupt/hand-edited/legacy loose identifiers
      // locally; preserving one would make every verify/referral/telemetry call
      // fail forever, while it cannot represent an accepted server device.
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = crypto.randomUUID();
        await chrome.storage.local.set({ deviceId: candidate });
        // chrome.storage has no CAS. Re-reading makes racers converge on the
        // persisted winner unless both sets land exactly between each other's
        // re-reads; every later call in every context returns persisted state.
        ({ deviceId } = await chrome.storage.local.get('deviceId'));
        const winner = deviceId || candidate;
        if (typeof winner === 'string' && DEVICE_ID_RE.test(winner)) {
          return winner.toLowerCase();
        }
      }
      throw new Error('Не удалось создать корректный идентификатор устройства.');
    })().catch((e) => {
      deviceIdPromise = null;
      throw e;
    });
  }
  return deviceIdPromise;
}

export async function getDeviceId() {
  // Popup/Settings must not race a separately imported history module against
  // the service worker on first use. The trusted worker is the only production
  // writer; internal worker callers and non-browser tests use the local path.
  if (isExtensionPageContext()) return (await workerCommand('GET_DEVICE_ID')).deviceId;
  return getDeviceIdHere();
}

export async function createSession(subject, taskText) {
  return mutateState((state) => {
    const session = {
      id: crypto.randomUUID(),
      subject,
      task_text: taskText,
      created_at: new Date().toISOString()
    };
    state.sessions.unshift(session);
    state.messages[session.id] = [];
    return session;
  });
}

export async function addMessage(sessionId, role, content) {
  return mutateState((state) => {
    const msg = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      role,
      content,
      created_at: new Date().toISOString()
    };
    if (!state.messages[sessionId]) state.messages[sessionId] = [];
    state.messages[sessionId].push(msg);
    return msg;
  });
}

/**
 * Persist one completed solve as a single history mutation. Creating a session
 * and appending the user/assistant messages in three separate storage writes
 * can leave an orphan or half-conversation when quota/storage fails between
 * them. This transaction either commits the complete turn or leaves the
 * previous state untouched.
 */
export async function appendSolveTurn({
  sessionId = null,
  subject,
  taskText,
  userContent,
  assistantContent,
  lessonKey = '',
}) {
  const key = typeof lessonKey === 'string' ? lessonKey : '';
  return mutateState((state) => {
    let session = sessionId
      ? state.sessions.find((candidate) => candidate.id === sessionId)
      : null;
    if (!session) {
      session = {
        id: crypto.randomUUID(),
        subject,
        task_text: taskText,
        lesson_key: key,
        created_at: new Date().toISOString()
      };
      state.sessions.unshift(session);
      state.messages[session.id] = [];
    } else if (!Array.isArray(state.messages[session.id])) {
      state.messages[session.id] = [];
    }

    const makeMessage = (role, content) => ({
      id: crypto.randomUUID(),
      session_id: session.id,
      role,
      content,
      created_at: new Date().toISOString()
    });
    const userMessage = makeMessage('user', userContent);
    const assistantMessage = makeMessage('assistant', assistantContent);
    state.messages[session.id].push(userMessage, assistantMessage);
    return { sessionId: session.id, userMessage, assistantMessage };
  });
}

/**
 * The stored conversation for a lesson the student already solved, or null.
 *
 * Returns the NEWEST session carrying this key that actually reached a real
 * answer — an assistant turn with text. That last condition is what keeps the
 * reuse honest: a lesson whose only stored turn is a half-written or empty
 * reply is worth re-solving, not replaying.
 *
 * Messages come back as plain {role, content}. Attachments are deliberately not
 * part of history (every read/write of this store serializes the whole object,
 * so base64 photos and PDFs in it would make the dashboard's own history slow
 * for everyone), so a replayed lesson carries its text, not its files.
 */
export async function findLessonSession(lessonKey) {
  if (typeof lessonKey !== 'string' || !lessonKey) return null;
  const state = await readState();
  const candidates = state.sessions
    .filter((session) => session.lesson_key === lessonKey)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const session of candidates) {
    const messages = [...(state.messages[session.id] || [])]
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const answered = messages.some((message) =>
      message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
    if (!answered) continue;
    return {
      sessionId: session.id,
      subject: session.subject || '',
      createdAt: session.created_at,
      messages: messages.map((message) => ({
        role: message.role,
        content: typeof message.content === 'string' ? message.content : ''
      }))
    };
  }
  return null;
}

export async function listSessions() {
  const state = await readState();
  return [...state.sessions].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export async function listMessages(sessionId) {
  const state = await readState();
  const msgs = state.messages[sessionId] || [];
  return [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/* ---------------------- scheduled retention sweep ---------------------- */

// prune() only runs when someone touches the history. A student who stops
// using the extension would keep week scans, legacy base64-heavy pendingUpload
// handoffs from older builds, and lookup caches forever — so the service worker
// also calls this on an alarm.
const WEEK_HOMEWORK_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;
const USER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// These storage-owned shapes avoid imports from their feature modules:
// taskClassCache, gdzTaskCache and testAnswerCache all map opaque keys to
// {v:<value>,at:number}.
// Bare legacy values have no defensible age, so the sweep deliberately drops them.
function pruneTimestampedCache(cache, cutoff) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return null;
  const fresh = {};
  for (const [key, entry] of Object.entries(cache)) {
    if (entry && typeof entry === 'object' && Number.isFinite(entry.at) && entry.at >= cutoff) {
      fresh[key] = entry;
    }
  }
  return fresh;
}

export async function cleanupLocalData() {
  // Rewriting the history object through the mutation queue applies the 7-day
  // prune even when nothing else reads it.
  await mutateState(() => null).catch(() => {});
  try {
    const {
      weekHomework, pendingUpload, taskClassCache, gdzTaskCache, smeshTranscriptCache,
      [TEST_ANSWER_CACHE_KEY]: testAnswerCache
    } = await chrome.storage.local.get([
      'weekHomework', 'pendingUpload', 'taskClassCache', 'gdzTaskCache',
      'smeshTranscriptCache', TEST_ANSWER_CACHE_KEY
    ]);
    const stale = [];
    const updates = {};
    const age = (ts) => (Number.isFinite(ts) ? Date.now() - ts : Infinity);
    if (weekHomework && age(weekHomework.scannedAt) > WEEK_HOMEWORK_TTL_MS) stale.push('weekHomework');
    // Old builds used pendingUpload for popup→dashboard base64 handoffs. New
    // launches are id-keyed elsewhere, but clean up any upgrade-era orphan.
    if (pendingUpload && age(pendingUpload.ts) > PENDING_UPLOAD_TTL_MS) stale.push('pendingUpload');
    const cacheCutoff = Date.now() - USER_CACHE_TTL_MS;
    for (const [key, cache] of [['taskClassCache', taskClassCache], ['gdzTaskCache', gdzTaskCache]]) {
      if (cache == null) continue;
      const fresh = pruneTimestampedCache(cache, cacheCutoff);
      if (fresh) updates[key] = fresh;
      else stale.push(key); // malformed storage is no more usable than a legacy entry
    }
    if (smeshTranscriptCache != null) {
      const fresh = pruneTimestampedCache(
        smeshTranscriptCache,
        Date.now() - TRANSCRIPT_CACHE_TTL_MS
      );
      if (fresh && Object.keys(fresh).length) updates.smeshTranscriptCache = fresh;
      else stale.push('smeshTranscriptCache');
    }
    // Solved test pages share the history TTL: reusing an answer the student
    // can no longer see in their own history would be surprising.
    if (testAnswerCache != null) {
      const fresh = pruneTimestampedCache(testAnswerCache, Date.now() - TEST_ANSWER_CACHE_TTL_MS);
      if (fresh && Object.keys(fresh).length) updates[TEST_ANSWER_CACHE_KEY] = fresh;
      else stale.push(TEST_ANSWER_CACHE_KEY);
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch { /* storage hiccup — next sweep retries */ }
}

/**
 * The settings «Удалить все локальные данные» button. Wipes everything the
 * extension accumulated about the student's usage; deliberately KEEPS the
 * deviceId, license key, API keys, consent record and preferences — those are
 * identity/settings, not collected data, and replacing deviceId would consume
 * another license device slot. Public GDZ catalog/link metadata (gdzHumanRefs
 * and gdzCatalog) is also kept because it describes books, not which exercises
 * the student looked up.
 */
async function deleteAllLocalDataHere() {
  const run = stateQueue.then(async () => {
    // Flip the generation together with an empty state before the real removal.
    // Any writer that has not passed its generation recheck observes this wipe
    // and retries onto empty history; the only residual is the microtask-wide
    // recheck→set gap documented in mutateState().
    await chrome.storage.local.set({
      [STORAGE_KEY]: { sessions: [], messages: {} },
      [GEN_KEY]: crypto.randomUUID()
    });
    const results = await Promise.allSettled([
      chrome.storage.local.remove([
        STORAGE_KEY, 'weekHomework', 'pendingUpload', 'taskClassCache', 'gdzTaskCache', 'tmLastHb',
        'rateAttempts', 'rateUsage', 'rateHistory', 'rateReservations', 'orUsageSnap',
        'smeshTranscriptCache', TEST_ANSWER_CACHE_KEY
      ]),
      // Upgrade cleanup: old builds briefly kept transcripts in session.
      // Current builds use trusted-only local storage (removed above), but the
      // legacy copy must also disappear on an explicit local-data wipe.
      Promise.resolve().then(() => chrome.storage.session.remove('smeshTranscriptCache')),
      wipeDashboardLaunches()
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) throw new AggregateError(
      failures.map((failure) => failure.reason),
      'Не удалось полностью удалить локальные данные'
    );
  });
  stateQueue = run.catch(() => {});
  return run;
}

export async function deleteAllLocalData() {
  // Settings delegates the wipe to the same history module/queue that owns all
  // production writes. This removes the cross-context recheck→set resurrection
  // window instead of trying to emulate compare-and-swap in chrome.storage.
  if (isExtensionPageContext()) {
    await workerCommand('DELETE_LOCAL_DATA');
    return;
  }
  return deleteAllLocalDataHere();
}
