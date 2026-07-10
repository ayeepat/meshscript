/**
 * License verification client.
 *
 * The user pastes a key into Settings; we cache the backend's verdict in
 * chrome.storage.local for 24h so verifying is free on the hot path. The
 * service worker calls `ensureLicensed()` before every AI request when
 * LICENSE_ENFORCED is on; while off, it's a no-op so dev usage is free.
 *
 * Cache shape (chrome.storage.local.licenseStatus):
 *   { key, ok, type, expires_at, reason, checkedAt }
 *
 * `reason` is set only when `ok === false`. We surface its Russian translation
 * in Settings and in the gate error.
 */

import { BACKEND_URL, LICENSE_ENFORCED, VERIFY_CACHE_MS } from './config.js';
import { getDeviceId } from './history.js';

const STORAGE_KEY = 'licenseStatus';

export const REASON_MESSAGES = {
  not_found: 'Ключ не найден. Проверьте, нет ли опечатки.',
  expired: 'Срок действия ключа истёк.',
  revoked: 'Этот ключ был отозван. Напишите в поддержку.',
  device_limit: 'Достигнут лимит устройств для этого ключа.',
  bad_device: 'Не удалось подтвердить устройство. Переустановите расширение и попробуйте снова.',
  network: 'Не удалось связаться с сервером. Проверьте подключение.',
  no_key: 'Лицензия не активирована.'
};

export function reasonMessage(reason) {
  return REASON_MESSAGES[reason] || 'Лицензия не активирована.';
}

async function loadStatus() {
  const { [STORAGE_KEY]: status } = await chrome.storage.local.get(STORAGE_KEY);
  return status || null;
}

async function saveStatus(status) {
  await chrome.storage.local.set({ [STORAGE_KEY]: status });
}

async function clearStatus() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * Hit /verify and persist the result. Returns the same shape we cache.
 * Network errors don't clobber an existing valid cache — we keep the last
 * known-good status with a `reason: 'network'` flag so a brief Cloudflare
 * blip doesn't lock the user out mid-solve.
 */
export async function verifyKey(key) {
  const trimmed = (key || '').trim().toUpperCase();
  if (!trimmed) {
    const status = { key: '', ok: false, reason: 'no_key', checkedAt: Date.now() };
    await saveStatus(status);
    return status;
  }
  const deviceId = await getDeviceId();
  let result;
  try {
    const url = new URL('/verify', BACKEND_URL);
    url.searchParams.set('key', trimmed);
    url.searchParams.set('device_id', deviceId);
    const res = await fetch(url.toString(), { method: 'GET' });
    result = await res.json();
  } catch (e) {
    // Soft failure: leave the prior status in place if we had one,
    // surface a network reason in the UI.
    const prior = await loadStatus();
    if (prior && prior.ok && prior.key === trimmed) {
      const stale = { ...prior, checkedAt: Date.now(), softError: 'network' };
      await saveStatus(stale);
      return stale;
    }
    const status = { key: trimmed, ok: false, reason: 'network', checkedAt: Date.now() };
    await saveStatus(status);
    return status;
  }
  const status = {
    key: trimmed,
    ok: !!result.ok,
    type: result.type || null,
    expires_at: result.expires_at || null,
    reason: result.ok ? null : (result.reason || 'not_found'),
    checkedAt: Date.now()
  };
  await saveStatus(status);
  return status;
}

/** Settings calls this on field save; the user typed a new key. */
export async function setLicenseKey(key) {
  if (!key) {
    await clearStatus();
    return { key: '', ok: false, reason: 'no_key', checkedAt: Date.now() };
  }
  return verifyKey(key);
}

export async function getLicenseStatus() {
  return loadStatus();
}

/**
 * Gate called from the service worker before each AI call. No-op while
 * LICENSE_ENFORCED is false so devs and preorder testers aren't blocked.
 *
 * When enforced: uses the cached verdict if it's fresh, otherwise re-verifies
 * inline. On a stale-but-network-failed cache the user gets a clear Russian
 * error instead of a silent hang.
 */
export async function ensureLicensed() {
  if (!LICENSE_ENFORCED) return;
  let status = await loadStatus();
  if (!status || !status.key) {
    throw new Error(
      'Лицензия не активирована. Откройте настройки расширения и вставьте ключ доступа.'
    );
  }
  const fresh = Date.now() - (status.checkedAt || 0) < VERIFY_CACHE_MS;
  if (!fresh) status = await verifyKey(status.key);
  if (!status.ok) {
    throw new Error(reasonMessage(status.reason));
  }
}
