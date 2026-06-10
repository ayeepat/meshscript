/**
 * Minimal Supabase REST client (no supabase-js dependency, MV3-friendly).
 * STORAGE ONLY, NO AUTH. Rows are scoped by an anonymous device_id stored
 * in chrome.storage.local. Trade-off: with the anon key and permissive RLS,
 * anyone with the anon key could read/write; acceptable for a 2-3 user
 * personal app. Documented in schema.sql.
 */

async function cfg() {
  const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get([
    'supabaseUrl',
    'supabaseAnonKey'
  ]);
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL / anon key not set. Open Settings.');
  }
  return { url: supabaseUrl.replace(/\/$/, ''), key: supabaseAnonKey };
}

export async function getDeviceId() {
  let { deviceId } = await chrome.storage.local.get('deviceId');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId });
  }
  return deviceId;
}

async function rest(path, options = {}) {
  const { url, key } = await cfg();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

export async function createSession(subject, taskText) {
  const device_id = await getDeviceId();
  const rows = await rest('sessions', {
    method: 'POST',
    body: JSON.stringify([{ device_id, subject, task_text: taskText }])
  });
  return rows[0];
}

export async function addMessage(sessionId, role, content) {
  const device_id = await getDeviceId();
  const rows = await rest('messages', {
    method: 'POST',
    body: JSON.stringify([{ session_id: sessionId, device_id, role, content }])
  });
  return rows[0];
}

export async function listSessions() {
  const device_id = await getDeviceId();
  return rest(`sessions?device_id=eq.${device_id}&order=created_at.desc`);
}

export async function listMessages(sessionId) {
  return rest(`messages?session_id=eq.${sessionId}&order=created_at.asc`);
}
