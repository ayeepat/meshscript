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

async function load() {
  const { [STORAGE_KEY]: data } = await chrome.storage.local.get(STORAGE_KEY);
  return data && typeof data === 'object'
    ? { sessions: data.sessions || [], messages: data.messages || {} }
    : { sessions: [], messages: {} };
}

async function save(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
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
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  return deviceId;
}

export async function createSession(subject, taskText) {
  const state = prune(await load());
  const session = {
    id: crypto.randomUUID(),
    subject,
    task_text: taskText,
    created_at: new Date().toISOString()
  };
  state.sessions.unshift(session);
  state.messages[session.id] = [];
  await save(state);
  return session;
}

export async function addMessage(sessionId, role, content) {
  const state = prune(await load());
  const msg = {
    id: crypto.randomUUID(),
    session_id: sessionId,
    role,
    content,
    created_at: new Date().toISOString()
  };
  if (!state.messages[sessionId]) state.messages[sessionId] = [];
  state.messages[sessionId].push(msg);
  await save(state);
  return msg;
}

export async function listSessions() {
  const state = prune(await load());
  await save(state);
  return [...state.sessions].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export async function listMessages(sessionId) {
  const state = prune(await load());
  const msgs = state.messages[sessionId] || [];
  return [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}
