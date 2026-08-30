/**
 * Referral client. Talks to the license backend's /referral/* endpoints.
 *
 * Dormant while config.REFERRALS_ENABLED is false: Settings shows a «Скоро»
 * card without calling any of this, the service worker stops queueing pointer
 * syncs, and the backend refuses the routes anyway. Nothing below changes for
 * the flip — it is kept whole so the programme can launch with a flag.
 *
 * The extension only plays the REFERRER role: this device mints one stable
 * invite code and shows its stats in Settings. The reward is earned entirely
 * at the friend's CHECKOUT — the friend types the code into the pay page
 * (smeshai.xyz), and the Robokassa webhook credits this device — so the
 * extension needs no "I was referred" tracking, no solve hook, nothing on the
 * hot path.
 *
 * Local state (chrome.storage.local.referralState): { code, auth }. `auth` is
 * a 256-bit capability used independently of the device id; it prevents anyone
 * who learns that reused pseudonymous id from reading the reward license or
 * changing where future reward days land. storage.local is trusted-only.
 */

import { BACKEND_URL } from './config.js';
import { getDeviceId } from './history.js';
import { getLicenseStatus, isUsableLicenseStatus } from './license.js';
import { fetchTextBounded } from './http.js';

const STORAGE_KEY = 'referralState';
let authPromise = null;
let referralSyncQueue = Promise.resolve();

// Matches license.js / history.js exactly. The protocol check is what keeps a
// content script (which also has a document and chrome.runtime) from being
// treated as an extension page.
function isExtensionPageContext() {
  try {
    return typeof document !== 'undefined' && location.protocol === 'chrome-extension:' &&
      typeof chrome?.runtime?.sendMessage === 'function';
  } catch {
    return false;
  }
}

async function loadState() {
  const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY);
  return state || {};
}

async function saveState(patch) {
  const state = { ...(await loadState()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

function randomReferralAuth() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function getReferralAuth() {
  if (!authPromise) {
    authPromise = (async () => {
      const state = await loadState();
      if (/^[A-Za-z0-9_-]{43}$/.test(state.auth || '')) return state.auth;
      const auth = randomReferralAuth();
      await saveState({ auth });
      return auth;
    })().catch((error) => { authPromise = null; throw error; });
  }
  return authPromise;
}

async function api(path, { method = 'GET', body, params } = {}) {
  const url = new URL(path, BACKEND_URL);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const { ok, status, text } = await fetchTextBounded(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error'
  });
  // The backend answers a refusal as a JSON verdict ({ ok:false, reason }),
  // which callers translate — so a parseable body is returned whatever the
  // status. An infrastructure error page is NOT a verdict: parsing it used to
  // throw a raw SyntaxError that callers mistook for a malformed reply.
  let json = null;
  try { json = JSON.parse(text || 'null'); } catch { json = null; }
  if (json && typeof json === 'object') return json;
  throw new Error(ok ? 'referral: malformed response' : `referral http ${status}`);
}

/**
 * This device's own invite code — created server-side on first call, cached
 * locally after. Sends the current license key along so the backend can land
 * rewards directly on an active subscription of ours. `sync: true` re-POSTs
 * even when cached, refreshing that license pointer (Settings does this once
 * per open, in case the user activated a subscription since).
 */
async function getMyReferralCodeOnce({ sync = false } = {}) {
  const state = await loadState();
  if (state.code && !sync) return state.code;
  const deviceId = await getDeviceId();
  const referralAuth = await getReferralAuth();
  const lic = await getLicenseStatus();
  let result;
  try {
    result = await api('/referral/code', {
      method: 'POST',
      body: {
        device_id: deviceId,
        license_key: isUsableLicenseStatus(lic) ? lic.key : null,
        referral_auth: referralAuth,
        known_code: state.code || null
      }
    });
  } catch {
    // A sync request is a state-changing pointer refresh, not a cache read.
    // Returning the cached code here would falsely report success while the
    // server still targets an older license. Non-sync callers already return
    // the cached code before reaching the network.
    throw new Error('network');
  }
  if (!result?.ok || !result.code) {
    throw new Error(result?.reason || 'network');
  }
  await saveState({ code: result.code });
  return result.code;
}

export async function getMyReferralCode({ sync = false } = {}) {
  // Settings and popup are separate JS realms. Route every production pointer
  // refresh through the service worker so they share one authoritative queue.
  if (sync && isExtensionPageContext()) {
    const response = await chrome.runtime.sendMessage({ type: 'SYNC_REFERRAL_POINTER' });
    if (!response?.ok || !response.code) throw new Error(response?.error || 'network');
    return response.code;
  }
  if (!sync) return getMyReferralCodeOnce({ sync: false });
  // Pointer refreshes are ordered by intent. Without serialization, an older
  // slow request carrying license A can finish after a newer request carrying
  // license B and move future referral rewards back to A on the server.
  const run = referralSyncQueue.then(() => getMyReferralCodeOnce({ sync: true }));
  referralSyncQueue = run.catch(() => {});
  return run;
}

/** Stats + reward key for the Settings card. Throws on network failure. */
export async function fetchReferralStatus() {
  const deviceId = await getDeviceId();
  const result = await api('/referral/status', {
    method: 'POST',
    body: { device_id: deviceId, referral_auth: await getReferralAuth() }
  });
  if (!result?.ok) throw new Error(result?.reason || 'network');
  if (result.code) await saveState({ code: result.code });
  return result;
}
