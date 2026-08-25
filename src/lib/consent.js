/**
 * One-time data-processing consent.
 *
 * This tool sends homework content — task text, page screenshots and the files
 * the user attaches (or that we auto-pull from Mesh) — to third-party AI
 * providers (OpenRouter, Groq, Qwen/Alibaba Model Studio, DeepSeek — the last
 * two also via the licensed СМЭШ proxy at ai.smeshapi.site) to get an answer.
 * The same consent covers the auxiliary AI feature that rides the same data:
 * audio transcription of listening tasks (Groq Whisper). Anonymous usage statistics
 * are a SEPARATE, additional opt-in (`telemetryEnabled`, see telemetry.js) —
 * consent alone never turns them on. Because the audience is schoolchildren,
 * all of that has to be disclosed plainly and accepted EXPLICITLY before the
 * first AI call, not buried in a footer link.
 *
 * The record is stored in chrome.storage.local so it syncs nowhere and never
 * leaves the device. Bumping CONSENT_VERSION re-prompts everyone (use it if the
 * disclosure materially changes — e.g. a new provider or data type).
 *
 * Shape (chrome.storage.local.aiConsent):
 *   { accepted: boolean, version: number, at: ISOString }
 */

const KEY = 'aiConsent';
let consentAbortController = new AbortController();

function acceptedRecord(rec) {
  return !!(rec && rec.accepted && rec.version >= CONSENT_VERSION);
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

// Bump when the disclosure materially changes to force a re-acceptance.
// v2 (2026-07): named all four providers + the licensed proxy, remote
// classification, audio transcription and the separate statistics opt-in.
// NOT bumped when remote task classification was removed: dropping a data flow
// leaves the accepted disclosure broader than what actually happens, so the
// existing consent still covers it and nobody needs to re-accept.
export const CONSENT_VERSION = 2;

// Surfaced verbatim by the service-worker backstop when an AI call is attempted
// without consent (the popup onboarding normally collects it long before this).
export const CONSENT_REQUIRED_MESSAGE =
  'Чтобы решать задания, нужно один раз подтвердить согласие на обработку данных. ' +
  'Откройте расширение (или его настройки) и примите условия.';

export async function getConsent() {
  const { [KEY]: rec } = await chrome.storage.local.get(KEY);
  return rec || null;
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

/** Record (or withdraw) consent for the current version. */
export async function setConsent(accepted) {
  const rec = { accepted: !!accepted, version: CONSENT_VERSION, at: new Date().toISOString() };
  await chrome.storage.local.set({ [KEY]: rec });
  updateConsentAbortState(rec);
  return rec;
}
