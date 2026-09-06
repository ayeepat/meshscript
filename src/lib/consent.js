/** Purpose-specific choices. Required choices gate AI; statistics are optional. */

import { BACKEND_URL } from './config.js';

const KEY = 'aiConsent';
const PENDING_RECEIPT_KEY = 'consentReceiptPending';
const ENTITLEMENT_TOKEN_RE = /^et1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
let consentAbortController = new AbortController();
let receiptQueue = Promise.resolve();

function cleanRecord(rec) {
  if (!rec || rec.version !== CONSENT_VERSION) {
    return {
      version: CONSENT_VERSION, terms: false, ai_processing: false,
      telemetry: false, eligibility: false, at: null, receipt_id: null
    };
  }
  return {
    version: CONSENT_VERSION,
    terms: rec.terms === true,
    ai_processing: rec.ai_processing === true,
    telemetry: rec.telemetry === true,
    eligibility: rec.eligibility === true,
    at: typeof rec.at === 'string' ? rec.at : null,
    receipt_id: typeof rec.receipt_id === 'string' ? rec.receipt_id : null
  };
}

function acceptedRecord(rec) {
  const value = cleanRecord(rec);
  return value.terms && value.ai_processing && value.eligibility;
}

function updateConsentAbortState(rec) {
  if (!acceptedRecord(rec)) {
    if (!consentAbortController.signal.aborted) consentAbortController.abort('consent_withdrawn');
  } else if (consentAbortController.signal.aborted) {
    consentAbortController = new AbortController();
  }
}

// A settings page can withdraw consent while the service worker is preparing
// files or while a provider request is in flight. Abort the shared generation
// immediately; final network gates below also re-read storage to close the
// pre-fetch race.
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && Object.hasOwn(changes, KEY)) {
      updateConsentAbortState(changes[KEY]?.newValue);
    }
  });
} catch { /* tests or non-extension import */ }

export const CONSENT_VERSION = 4;

// Surfaced verbatim by the service-worker backstop when an AI call is attempted
// without consent (the popup onboarding normally collects it long before this).
export const CONSENT_REQUIRED_MESSAGE =
  'Чтобы решать задания, подтвердите условия, обработку задания облачным ИИ и право пользоваться сервисом.';

export async function getConsent() {
  const { [KEY]: rec } = await chrome.storage.local.get(KEY);
  return cleanRecord(rec);
}

/** True only when the CURRENT consent version has been accepted. */
export async function hasConsent() {
  const rec = await getConsent();
  return acceptedRecord(rec);
}

/**
 * Re-check consent at the network boundary and return a signal that aborts
 * when either the caller cancels or consent is withdrawn.
 */
export async function consentNetworkSignal(callerSignal = null) {
  const rec = await getConsent();
  updateConsentAbortState(rec);
  if (!acceptedRecord(rec)) throw new Error(CONSENT_REQUIRED_MESSAGE);
  const consentSignal = consentAbortController.signal;
  if (!callerSignal || callerSignal === consentSignal) return consentSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, consentSignal]);
  const combined = new AbortController();
  const abort = () => combined.abort();
  if (callerSignal.aborted || consentSignal.aborted) abort();
  else {
    callerSignal.addEventListener('abort', abort, { once: true });
    consentSignal.addEventListener('abort', abort, { once: true });
  }
  return combined.signal;
}

async function postPendingReceipt() {
  const stored = await chrome.storage.local.get([PENDING_RECEIPT_KEY, 'licenseStatus']);
  const pending = cleanRecord(stored[PENDING_RECEIPT_KEY]);
  const status = stored.licenseStatus;
  if (!pending.receipt_id || !ENTITLEMENT_TOKEN_RE.test(status?.entitlement_token || '') ||
      Number(status?.entitlement_token_expires_at) <= Date.now()) return false;
  const response = await fetch(new URL('/consent/receipt', BACKEND_URL).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entitlement_token: status.entitlement_token,
      receipt_id: pending.receipt_id,
      version: pending.version,
      terms: pending.terms,
      ai_processing: pending.ai_processing,
      telemetry: pending.telemetry,
      eligibility: pending.eligibility,
      client_at: pending.at
    }),
    cache: 'no-store',
    redirect: 'error'
  });
  if (!response.ok) return false;
  const latest = await chrome.storage.local.get(PENDING_RECEIPT_KEY);
  if (latest[PENDING_RECEIPT_KEY]?.receipt_id === pending.receipt_id) {
    await chrome.storage.local.remove(PENDING_RECEIPT_KEY);
  }
  return true;
}

export function flushPendingConsentReceipt() {
  const run = receiptQueue.then(postPendingReceipt);
  receiptQueue = run.catch(() => false);
  return run.catch(() => false);
}

export async function setConsentChoices(choices) {
  const rec = {
    version: CONSENT_VERSION,
    terms: choices?.terms === true,
    ai_processing: choices?.ai_processing === true,
    telemetry: choices?.telemetry === true,
    eligibility: choices?.eligibility === true,
    at: new Date().toISOString(),
    receipt_id: crypto.randomUUID()
  };
  await chrome.storage.local.set({
    [KEY]: rec,
    telemetryEnabled: rec.telemetry,
    [PENDING_RECEIPT_KEY]: rec
  });
  updateConsentAbortState(rec);
  void flushPendingConsentReceipt();
  return rec;
}

/** Compatibility for internal callers; telemetry remains a separate opt-in. */
export async function setConsent(accepted) {
  if (!accepted) {
    return setConsentChoices({
      terms: false, ai_processing: false, eligibility: false, telemetry: false
    });
  }
  const current = await getConsent();
  return setConsentChoices({
    terms: true,
    ai_processing: true,
    eligibility: true,
    telemetry: current.telemetry
  });
}
