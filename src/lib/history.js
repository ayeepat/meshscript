/**
 * Local solve-history store, backed by chrome.storage.local.
 * Replaces the previous Supabase-backed store so the extension needs no
 * external account or shared anon key to ship publicly. History is per-device
 * (was already scoped by anonymous device_id) with a 7-day TTL enforced on
 * read.
 *
 * Storage layout:
 *   meshHistory: { sessions: Session[], messages: { [sessionId]: Message[] } }
 *
 * Session = { id, subject, task_text, created_at }
 * Message = { id, session_id, role, content, created_at }
 */

const STORAGE_KEY = 'meshHistory';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
let stateQueue = Promise.resolve();
let deviceIdPromise = null;

async function load() {
  const { [STORAGE_KEY]: data } = await chrome.storage.local.get(STORAGE_KEY);
  return data && typeof data === 'object'
    ? { sessions: data.sessions || [], messages: data.messages || {} }
    : { sessions: [], messages: {} };
}

async function save(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// Storage writes are read-modify-write operations. One queue prevents parallel
// dashboard solves from losing a session or message when the last writer wins.
function mutateState(mutator) {
  const run = stateQueue.then(async () => {
    const state = prune(await load());
    const result = await mutator(state);
    await save(state);
    return result;
  });
  stateQueue = run.catch(() => {});
  return run;
}

// Drop anything older than TTL_MS. Returns a fresh state with stale sessions
// and their messages removed. Called on every read so expired entries
// disappear without a background sweep.
function prune(state) {
  const cutoff = Date.now() - TTL_MS;
  const sessions = state.sessions.filter((s) => Date.parse(s.created_at) >= cutoff);
  const keep = new Set(sessions.map((s) => s.id));
  const messages = {};
  for (const sid of Object.keys(state.messages)) {
    if (keep.has(sid)) messages[sid] = state.messages[sid];
  }
  return { sessions, messages };
}

export async function getDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      let { deviceId } = await chrome.storage.local.get('deviceId');
      if (!deviceId) {
        deviceId = crypto.randomUUID();
        await chrome.storage.local.set({ deviceId });
      }
      return deviceId;
    })().catch((e) => {
      deviceIdPromise = null;
      throw e;
    });
  }
  return deviceIdPromise;
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

export async function listSessions() {
  return mutateState((state) =>
    [...state.sessions].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  );
}

export async function listMessages(sessionId) {
  return mutateState((state) => {
    const msgs = state.messages[sessionId] || [];
    return [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  });
}

/* ---------------------- scheduled retention sweep ---------------------- */

// prune() only runs when someone touches the history. A student who stops
// using the extension would keep week scans and (base64-heavy) pendingUpload
// handoffs plus lookup caches forever — so the service worker also calls this
// on an alarm.
const WEEK_HOMEWORK_TTL_MS = 24 * 60 * 60 * 1000;
const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;
const USER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// These storage-owned shapes avoid imports from their feature modules:
// taskClassCache and gdzTaskCache both map opaque keys to {v:<value>,at:number}.
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
    const { weekHomework, pendingUpload, taskClassCache, gdzTaskCache } =
      await chrome.storage.local.get(['weekHomework', 'pendingUpload', 'taskClassCache', 'gdzTaskCache']);
    const stale = [];
    const updates = {};
    const age = (ts) => (Number.isFinite(ts) ? Date.now() - ts : Infinity);
    if (weekHomework && age(weekHomework.scannedAt) > WEEK_HOMEWORK_TTL_MS) stale.push('weekHomework');
    // pendingUpload is a one-use popup→dashboard handoff carrying base64 file
    // bodies; anything older than its TTL is an orphan (the dashboard deletes
    // it on read).
    if (pendingUpload && age(pendingUpload.ts) > PENDING_UPLOAD_TTL_MS) stale.push('pendingUpload');
    const cacheCutoff = Date.now() - USER_CACHE_TTL_MS;
    for (const [key, cache] of [['taskClassCache', taskClassCache], ['gdzTaskCache', gdzTaskCache]]) {
      if (cache == null) continue;
      const fresh = pruneTimestampedCache(cache, cacheCutoff);
      if (fresh) updates[key] = fresh;
      else stale.push(key); // malformed storage is no more usable than a legacy entry
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch { /* storage hiccup — next sweep retries */ }
}

/**
 * The settings «Удалить все локальные данные» button. Wipes everything the
 * extension accumulated about the student's usage; deliberately KEEPS the
 * license key, API keys, consent record and preferences — those are settings,
 * not collected data. Public GDZ catalog/link metadata is also kept because it
 * describes books, not which exercises the student looked up.
 */
export async function deleteAllLocalData() {
  await chrome.storage.local.remove([
    STORAGE_KEY, 'weekHomework', 'pendingUpload', 'taskClassCache', 'gdzTaskCache', 'tmLastHb'
  ]);
}
