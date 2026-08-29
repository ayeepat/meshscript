/**
 * One-time acceptance of the terms of use and the privacy policy.
 *
 * This tool sends homework content — task text, page screenshots and the files
 * the user attaches (or that we auto-pull from the diary) — to third-party AI
 * providers (OpenRouter, Groq, Qwen/Alibaba Model Studio, DeepSeek — the last
 * two also via the licensed СМЭШ proxy at ai.smeshapi.site) to get an answer,
 * plus audio transcription of listening tasks (Groq Whisper). Since v3 it ALSO
 * covers usage statistics: the separate «Анонимная статистика» checkbox was
 * removed at the owner's request, so accepting here writes `telemetryEnabled`
 * too. What is actually sent is described in the linked terms and privacy
 * policy rather than in the checkbox itself.
 *
 * ⚠️ The in-product surface therefore no longer discloses the data flows —
 * only the linked documents do. Those documents are now load-bearing: if
 * smeshai.xyz/terms and /privacy do not describe the AI recipients AND the
 * usage statistics, nothing in the product does, and Chrome Web Store review
 * treats undisclosed analytics as a User Data Policy violation.
 *
 * telemetry.js still enforces BOTH flags at flush time, so Settings →
 * «Удалить статистику и отключить сбор» remains a working opt-out.
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
// v3 (2026-08): the statistics checkbox was folded into this one acceptance.
// That ADDS a data flow to what a single tick authorizes, so it must re-prompt
// — silently turning statistics on for someone who deliberately left the old
// checkbox unticked is exactly what a version bump exists to prevent.
export const CONSENT_VERSION = 3;

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

/**
 * Record (or withdraw) acceptance for the current version.
 *
 * Statistics ride along: there is no separate checkbox any more, so the single
 * tick is what turns `telemetryEnabled` on, and withdrawing turns it off.
 * Written in the same call so the two can never disagree — telemetry.js reads
 * both and refuses to send unless both are true.
 */
export async function setConsent(accepted) {
  const rec = { accepted: !!accepted, version: CONSENT_VERSION, at: new Date().toISOString() };
  await chrome.storage.local.set({ [KEY]: rec, telemetryEnabled: !!accepted });
  updateConsentAbortState(rec);
  return rec;
}
