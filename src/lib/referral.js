/**
 * Referral client. Talks to the license backend's /referral/* endpoints.
 *
 * The extension only plays the REFERRER role: this device mints one stable
 * invite code and shows its stats in Settings. The reward is earned entirely
 * at the friend's CHECKOUT — the friend types the code into the pay page
 * (smeshai.xyz), and the Robokassa webhook credits this device — so the
 * extension needs no "I was referred" tracking, no solve hook, nothing on the
 * hot path.
 *
 * Local state (chrome.storage.local.referralState): { code } — just a cache
 * of our own invite code so the card renders instantly / offline.
 */

import { BACKEND_URL } from './config.js';
import { getDeviceId } from './history.js';
import { getLicenseStatus } from './license.js';

const STORAGE_KEY = 'referralState';

async function loadState() {
  const { [STORAGE_KEY]: state } = await chrome.storage.local.get(STORAGE_KEY);
  return state || {};
}

async function saveState(patch) {
  const state = { ...(await loadState()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

async function api(path, { method = 'GET', body, params } = {}) {
  const url = new URL(path, BACKEND_URL);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

/**
 * This device's own invite code — created server-side on first call, cached
 * locally after. Sends the current license key along so the backend can land
 * rewards directly on an active subscription of ours. `sync: true` re-POSTs
 * even when cached, refreshing that license pointer (Settings does this once
 * per open, in case the user activated a subscription since).
 */
export async function getMyReferralCode({ sync = false } = {}) {
  const state = await loadState();
  if (state.code && !sync) return state.code;
  const deviceId = await getDeviceId();
  const lic = await getLicenseStatus();
  let result;
  try {
    result = await api('/referral/code', {
      method: 'POST',
      body: { device_id: deviceId, license_key: lic?.ok ? lic.key : null }
    });
  } catch {
    if (state.code) return state.code; // offline sync: cached code still valid
    throw new Error('network');
  }
  if (!result?.ok || !result.code) {
    if (state.code) return state.code;
    throw new Error(result?.reason || 'network');
  }
  await saveState({ code: result.code });
  return result.code;
}

/** Stats + reward key for the Settings card. Throws on network failure. */
export async function fetchReferralStatus() {
  const deviceId = await getDeviceId();
  const result = await api('/referral/status', { params: { device_id: deviceId } });
  if (!result?.ok) throw new Error(result?.reason || 'network');
  if (result.code) await saveState({ code: result.code });
  return result;
}
