/**
 * License verification client.
 *
 * The user pastes a key into Settings; we cache the backend's verdict in
 * chrome.storage.local for 24h so verifying is free on the hot path. The
 * service worker calls `ensureLicensed()` before every AI request; the gate
 * activates automatically at the configured launch instant.
 *
 * Cache shape (chrome.storage.local.licenseStatus):
 *   { key, ok, type, expires_at, reason, checkedAt, lastVerifiedAt,
 *     activation_token,
 *     telemetry_token, telemetry_token_expires_at, softError, generation }
 *
 * `reason` is set only when `ok === false`. We surface its Russian translation
 * in Settings and in the gate error.
 */

import {
  BACKEND_URL, isLicenseEnforced, LICENSE_OFFLINE_GRACE_MS, VERIFY_CACHE_MS
} from './config.js';
import { getDeviceId } from './history.js';
import { readResponseTextBounded } from './http.js';

const STORAGE_KEY = 'licenseStatus';
const GENERATION_KEY = 'licenseGeneration';
const ERASURE_CAPABILITY_KEY = 'telemetryErasureCapability';
let licenseMutationQueue = Promise.resolve();

function isExtensionPageContext() {
  try {
    return typeof document !== 'undefined' && location.protocol === 'chrome-extension:' &&
      typeof chrome?.runtime?.sendMessage === 'function';
  } catch {
    return false;
  }
}

/**
 * expires_at is the backend's ISO timestamp (null = lifetime). A cached ok
 * verdict stops being usable the moment it passes, even inside VERIFY_CACHE_MS;
 * the re-verify below lets the server issue the authoritative verdict (for
 * example, for a renewed subscription).
 */
function statusNotExpired(status, now) {
  if (!status?.expires_at) return true;
  const t = Date.parse(status.expires_at);
  return Number.isFinite(t) && t > now;
}

export const REASON_MESSAGES = {
  not_found: 'Ключ не найден. Проверьте, нет ли опечатки.',
  expired: 'Срок действия ключа истёк.',
  revoked: 'Этот ключ был отозван. Напишите в поддержку.',
  device_in_use: 'Этот ключ уже используется на устройстве №1. Сначала нажмите «Деактивировать ключ» на устройстве №1, затем активируйте его здесь.',
  device_limit: 'Этот ключ уже используется на устройстве №1. Сначала деактивируйте его там.',
  bad_device: 'Не удалось подтвердить устройство. Переустановите расширение и попробуйте снова.',
  bad_activation: 'Не удалось подтвердить активацию этого устройства. Деактивируйте ключ или напишите в поддержку.',
  activation_mismatch: 'Ключ активирован на другом устройстве. Сначала деактивируйте его на устройстве №1.',
  service_unavailable: 'Сервер лицензий временно недоступен. Попробуйте ещё раз позже.',
  network: 'Не удалось связаться с сервером. Проверьте подключение.',
  no_key: 'Лицензия не активирована.'
};

export function reasonMessage(reason) {
  return REASON_MESSAGES[reason] || 'Лицензия не активирована.';
}

async function loadStatus() {
  const { [STORAGE_KEY]: status, [GENERATION_KEY]: generation } =
    await chrome.storage.local.get([STORAGE_KEY, GENERATION_KEY]);
  // A stale verifier may win the tiny generation-check→save gap. Its embedded
  // generation makes that row dead on arrival and license enforcement fails
  // closed; legacy rows without the field remain readable.
  const current = typeof generation === 'string' ? generation : '';
  if (typeof status?.generation === 'string' && status.generation !== current) return null;
  return status || null;
}

async function saveStatus(status, generation) {
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...status, generation } });
}

async function clearStatus() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

// Every USER mutation (saving or clearing a key in Settings/popup) writes a
// fresh generation token before touching the cache. An in-flight /verify
// captures the generation it started under and drops its verdict if ANY
// mutation happened meanwhile — so a slow response for an old key can never
// resurrect a key the user has since cleared or replaced, including when two
// setLicenseKey() calls overlap directly. Bumping BEFORE mutation invalidates
// an older row immediately; embedding the captured generation in every saved
// verdict makes a stale row fail closed even if it lands in the remaining
// generation-check→save window.
async function currentGeneration() {
  const { [GENERATION_KEY]: generation } = await chrome.storage.local.get(GENERATION_KEY);
  return typeof generation === 'string' ? generation : '';
}

async function bumpGeneration() {
  const generation = crypto.randomUUID();
  await chrome.storage.local.set({ [GENERATION_KEY]: generation });
  return generation;
}

/**
 * Hit /verify and persist the result. Returns the same shape we cache.
 * Network errors don't clobber an existing valid cache — we keep the last
 * known-good status with a `softError: 'network'` flag. Crucially, only a real
 * 200 JSON verdict advances lastVerifiedAt; failed attempts cannot renew the
 * entitlement's absolute offline grace.
 */
export async function verifyKey(key, { onlyIfCurrent = false, generation = null } = {}) {
  // The generation this verify runs under: passed in by setLicenseKey (which
  // just bumped it), captured here for background revalidation.
  const startedUnder = generation ?? await currentGeneration();
  const saveIfCurrent = async (status) => {
    // Any user mutation since this verify started makes its verdict stale —
    // saving it would overwrite the newer key or resurrect a cleared one.
    if ((await currentGeneration()) !== startedUnder) return false;
    if (onlyIfCurrent) {
      const current = await loadStatus();
      // The user may replace OR clear the key while /verify is in flight. In
      // both cases the delayed verdict is stale and must not resurrect it.
      if (!current?.key || current.key !== status.key) return false;
    }
    await saveStatus(status, startedUnder);
    return true;
  };
  const currentOrNoKey = async (status) => {
    if (await saveIfCurrent(status)) return status;
    return (await loadStatus()) || { key: '', ok: false, reason: 'no_key', checkedAt: Date.now() };
  };
  const trimmed = (key || '').trim().toUpperCase();
  if (!trimmed) {
    const status = { key: '', ok: false, reason: 'no_key', checkedAt: Date.now() };
    return currentOrNoKey(status);
  }
  const deviceId = await getDeviceId();
  const priorBeforeRequest = await loadStatus();
  const priorActivationToken = priorBeforeRequest?.key === trimmed &&
    typeof priorBeforeRequest.activation_token === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(priorBeforeRequest.activation_token)
    ? priorBeforeRequest.activation_token
    : '';
  let result;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const url = new URL('/verify', BACKEND_URL);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: trimmed,
        device_id: deviceId,
        ...(priorActivationToken ? { activation_token: priorActivationToken } : {})
      }),
      cache: 'no-store',
      redirect: 'error',
      signal: ctrl.signal
    });
    // /verify always answers 200 with a JSON verdict (ok:false rides a 200).
    // A non-200 is worker/network infrastructure trouble, NOT a verdict on the
    // key — and its body may still be JSON (the worker's error responses are),
    // so without this check an outage would be cached as «ключ не найден».
    // Throwing routes it to the soft-failure path below, same as the VPS does.
    if (!res.ok) throw new Error(`verify http ${res.status}`);
    result = JSON.parse(await readResponseTextBounded(res) || 'null');
    const verdictAt = Date.now();
    const telemetryToken = typeof result?.telemetry_token === 'string' &&
      /^tm1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.telemetry_token) &&
      result.telemetry_token.length <= 1024
      ? result.telemetry_token
      : null;
    const telemetryExpiresAt = Number(result?.telemetry_token_expires_at);
    const erasureToken = typeof result?.erasure_token === 'string' &&
      /^te1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.erasure_token) &&
      result.erasure_token.length <= 1024 ? result.erasure_token : null;
    const erasureExpiresAt = Number(result?.erasure_token_expires_at);
    const returnedActivationToken = typeof result?.activation_token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(result.activation_token)
      ? result.activation_token
      : '';
    const status = {
      key: trimmed,
      ok: !!result.ok,
      type: result.type || null,
      expires_at: result.expires_at || null,
      reason: result.ok ? null : (result.reason || 'not_found'),
      checkedAt: verdictAt,
      lastVerifiedAt: verdictAt
    };
    if (status.ok && (returnedActivationToken || priorActivationToken)) {
      status.activation_token = returnedActivationToken || priorActivationToken;
    }
    // The capability is deliberately coupled to a fresh successful verify.
    // Never cache a malformed, expired, or error-response token, and never
    // carry an older token across a new authoritative verdict.
    if (
      status.ok &&
      telemetryToken &&
      Number.isSafeInteger(telemetryExpiresAt) &&
      telemetryExpiresAt > verdictAt
    ) {
      status.telemetry_token = telemetryToken;
      status.telemetry_token_expires_at = telemetryExpiresAt;
    }
    if (status.ok && erasureToken && Number.isSafeInteger(erasureExpiresAt) &&
        erasureExpiresAt > verdictAt) {
      // Deliberately separate from licenseStatus: signing out must not remove
      // the user's ability to erase analytics already associated with this
      // installation.
      await chrome.storage.local.set({
        [ERASURE_CAPABILITY_KEY]: {
          token: erasureToken,
          expires_at: erasureExpiresAt,
          device_id: deviceId
        }
      });
    }
    return currentOrNoKey(status);
  } catch (e) {
    // Soft failure: leave the prior status in place if we had one,
    // surface a network reason in the UI.
    const prior = await loadStatus();
    if (prior && prior.ok && prior.key === trimmed) {
      const stale = { ...prior, checkedAt: Date.now(), softError: 'network' };
      // saveIfCurrent embeds startedUnder. Never carry the prior row's
      // generation forward as if it described this verification attempt.
      delete stale.generation;
      return currentOrNoKey(stale);
    }
    const status = { key: trimmed, ok: false, reason: 'network', checkedAt: Date.now() };
    return currentOrNoKey(status);
  } finally {
    clearTimeout(timer);
  }
}

async function setLicenseKeyHere(key) {
  const requested = String(key || '').trim().toUpperCase();
  const current = await loadStatus();
  if (!requested) return deactivateLicenseHere();
  if (current?.key && current.key !== requested) {
    throw new Error('Сначала деактивируйте текущий ключ на этом устройстве, затем введите другой.');
  }
  // Bump BEFORE mutating so every verify already in flight (background
  // revalidation or an earlier overlapping save) drops its stale verdict.
  const generation = await bumpGeneration();
  return verifyKey(requested, { generation });
}

async function deactivateLicenseHere() {
  const status = await loadStatus();
  if (!status?.key) {
    await bumpGeneration();
    await clearStatus();
    return { key: '', ok: false, reason: 'no_key', checkedAt: Date.now() };
  }
  const token = typeof status.activation_token === 'string' ? status.activation_token : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    // A pre-migration cache must first exchange its historical device binding
    // for the server-issued capability; never clear locally and strand the key.
    const refreshed = await verifyKey(status.key, { onlyIfCurrent: true });
    if (!refreshed.ok || !/^[A-Za-z0-9_-]{43}$/.test(refreshed.activation_token || '')) {
      throw new Error(reasonMessage(refreshed.reason || 'bad_activation'));
    }
    return deactivateLicenseHere();
  }
  const deviceId = await getDeviceId();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(new URL('/deactivate', BACKEND_URL).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: status.key, device_id: deviceId, activation_token: token }),
      cache: 'no-store',
      redirect: 'error',
      signal: ctrl.signal
    });
    let result = null;
    try { result = JSON.parse(await readResponseTextBounded(res) || 'null'); } catch { /* malformed */ }
    if (!res.ok || !result?.ok) {
      throw new Error(reasonMessage(result?.reason || (res.status >= 500 ? 'service_unavailable' : 'activation_mismatch')));
    }
    await bumpGeneration();
    await clearStatus();
    return { key: '', ok: false, reason: 'no_key', checkedAt: Date.now() };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(reasonMessage('network'));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Settings/popup call this on field save; the user typed a new key. */
export async function setLicenseKey(key) {
  if (isExtensionPageContext()) {
    const response = await chrome.runtime.sendMessage({
      type: 'SET_LICENSE_KEY',
      payload: { key: String(key || '') },
    });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось сохранить ключ лицензии.');
    return response.status;
  }
  // The worker is the single production writer. Serialize its user mutations
  // so an older delayed save cannot bump generation after a later clear.
  const run = licenseMutationQueue.then(() => setLicenseKeyHere(key));
  licenseMutationQueue = run.catch(() => {});
  return run;
}

/** Explicitly release device №1 so this key can activate elsewhere. */
export async function deactivateCurrentLicense() {
  if (isExtensionPageContext()) {
    const response = await chrome.runtime.sendMessage({ type: 'DEACTIVATE_LICENSE' });
    if (!response?.ok) throw new Error(response?.error || 'Не удалось деактивировать ключ.');
    return response.status;
  }
  const run = licenseMutationQueue.then(() => deactivateLicenseHere());
  licenseMutationQueue = run.catch(() => {});
  return run;
}

export async function getLicenseStatus() {
  return loadStatus();
}

/**
 * Gate called from the service worker before each AI call. No-op before the
 * configured launch instant so preorder testers aren't blocked.
 *
 * When enforced: a recent server-confirmed entitlement is hot-path cached.
 * Otherwise we re-verify inline and accept an outage only inside the absolute
 * offline grace measured from lastVerifiedAt (never from an attempt time).
 */
export async function ensureLicensed() {
  if (!isLicenseEnforced()) return;
  let status = await loadStatus();
  if (!status || !status.key) {
    throw new Error(
      'Лицензия не активирована. Откройте настройки расширения и вставьте ключ доступа.'
    );
  }
  const now = Date.now();
  const lastVerifiedAt = Number(status.lastVerifiedAt) || 0;
  const hasActivation = /^[A-Za-z0-9_-]{43}$/.test(status.activation_token || '');
  if (status.ok && hasActivation && statusNotExpired(status, now) && now - lastVerifiedAt < VERIFY_CACHE_MS) return;

  const prior = status;
  status = await verifyKey(status.key, { onlyIfCurrent: true });
  if (status.softError !== 'network') {
    if (status.ok) return;
    throw new Error(reasonMessage(status.reason));
  }

  // Legacy rows deliberately have lastVerifiedAt=0: checkedAt was renewed by
  // the old fail-open path and is not trustworthy migration evidence.
  const priorVerifiedAt = Number(prior.lastVerifiedAt) || 0;
  if (prior.ok && /^[A-Za-z0-9_-]{43}$/.test(prior.activation_token || '') &&
      statusNotExpired(prior, Date.now()) && Date.now() - priorVerifiedAt < LICENSE_OFFLINE_GRACE_MS) return;
  throw new Error(reasonMessage('network'));
}
