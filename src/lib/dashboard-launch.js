/** Short-lived, encrypted, consume-once popup -> dashboard launch handoff. */

const SESSION_KEY = 'dashLaunches';
const LOCAL_KEY = 'dashLaunchKeys';
export const DASHBOARD_LAUNCH_TTL_MS = 2 * 60 * 1000;

// storage.session is readable by content scripts in this extension so panel UI
// state can work. Launch data is therefore AES-GCM ciphertext there; the random
// key is kept separately in trusted-only storage.local. Neither area contains a
// usable plaintext payload, and both halves are removed on consume/expiry.
let launchQueue = Promise.resolve();

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch { return null; }
}

async function mutateLaunches(mutator, { commitAfterTrustedWrite = false } = {}) {
  const run = launchQueue.then(async () => {
    const [{ [SESSION_KEY]: storedLaunches = {} }, { [LOCAL_KEY]: storedKeys = {} }] = await Promise.all([
      chrome.storage.session.get(SESSION_KEY),
      chrome.storage.local.get(LOCAL_KEY)
    ]);
    const now = Date.now();
    const launches = {};
    const keys = {};
    for (const [id, entry] of Object.entries(storedLaunches || {})) {
      const keyEntry = storedKeys?.[id];
      if (entry && keyEntry && Number.isFinite(entry.expiresAt) && entry.expiresAt > now &&
          keyEntry.expiresAt === entry.expiresAt) {
        launches[id] = entry;
        keys[id] = keyEntry;
      }
    }
    const result = await mutator(launches, keys, now);

    // Write/remove the trusted key half first. A partial failure can leave an
    // unusable orphan, never plaintext or a decryptable untrusted-session blob.
    if (Object.keys(keys).length) await chrome.storage.local.set({ [LOCAL_KEY]: keys });
    else await chrome.storage.local.remove(LOCAL_KEY);
    try {
      if (Object.keys(launches).length) await chrome.storage.session.set({ [SESSION_KEY]: launches });
      else await chrome.storage.session.remove(SESSION_KEY);
    } catch (error) {
      // During consume, removing the trusted key is the irreversible commit:
      // the old session ciphertext can no longer be decrypted or consumed
      // again. Deliver the already-decrypted payload and let the next sweep
      // remove that harmless orphan. Stores/cleanup still fail loudly.
      if (!commitAfterTrustedWrite) throw error;
    }
    return result;
  });
  launchQueue = run.catch(() => {});
  return run;
}

export function storeDashboardLaunch(payload) {
  const id = crypto.randomUUID();
  return mutateLaunches(async (launches, keys, now) => {
    const cleanPayload = {
      subject: payload?.subject || '',
      task: payload?.task || '',
      day: payload?.day || '',
      homeworkId: payload?.homeworkId || '',
      homeworkItemId: payload?.homeworkItemId || '',
      rowToken: payload?.rowToken || '',
      scanId: payload?.scanId || '',
      principal: payload?.principal || null,
      principalError: payload?.principalError || null
    };
    // Attachment bodies are already base64 and can approach the storage.session
    // quota after another base64 encryption layer. Keep them beside the AES key
    // in trusted-only storage.local, keyed by this launch id. The dashboard only
    // receives them when it consumes the matching one-time capability.
    const files = Array.isArray(payload?.files)
      ? payload.files.map((file) => ({
        mimeType: file?.mimeType || '',
        dataBase64: file?.dataBase64 || '',
        name: file?.name || ''
      }))
      : [];
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(cleanPayload));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
    const expiresAt = now + DASHBOARD_LAUNCH_TTL_MS;
    launches[id] = {
      ciphertext: encodeBase64Url(ciphertext),
      iv: encodeBase64Url(iv),
      expiresAt
    };
    keys[id] = { key: encodeBase64Url(rawKey), expiresAt, files };
    return id;
  });
}

export function consumeDashboardLaunch(id) {
  return mutateLaunches(async (launches, keys) => {
    if (typeof id !== 'string' || !Object.hasOwn(launches, id) || !Object.hasOwn(keys, id)) return null;
    const entry = launches[id];
    const keyEntry = keys[id];
    delete launches[id];
    delete keys[id];
    try {
      const rawKey = decodeBase64Url(keyEntry.key);
      const iv = decodeBase64Url(entry.iv);
      const ciphertext = decodeBase64Url(entry.ciphertext);
      if (!rawKey || rawKey.byteLength !== 32 || !iv || iv.byteLength !== 12 || !ciphertext) return null;
      const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...payload, files: Array.isArray(keyEntry.files) ? keyEntry.files : [] }
        : null;
    } catch { return null; }
  }, { commitAfterTrustedWrite: true });
}

export function cleanupDashboardLaunches() {
  return mutateLaunches(() => undefined);
}

/** Wipe every pending dashboard launch and its trusted key/attachment half. */
export function wipeDashboardLaunches() {
  return mutateLaunches((launches, keys) => {
    for (const id of Object.keys(launches)) delete launches[id];
    for (const id of Object.keys(keys)) delete keys[id];
  });
}
