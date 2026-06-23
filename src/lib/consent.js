/**
 * One-time data-processing consent.
 *
 * This tool sends homework content — task text, page screenshots and the files
 * the user attaches (or that we auto-pull from Mesh) — to a third-party AI
 * provider (OpenRouter or Groq) to get an answer. Because the audience is
 * schoolchildren, that has to be disclosed plainly and accepted EXPLICITLY
 * before the first AI call, not buried in a footer link.
 *
 * The record is stored in chrome.storage.local so it syncs nowhere and never
 * leaves the device. Bumping CONSENT_VERSION re-prompts everyone (use it if the
 * disclosure materially changes — e.g. a new provider or data type).
 *
 * Shape (chrome.storage.local.aiConsent):
 *   { accepted: boolean, version: number, at: ISOString }
 */

const KEY = 'aiConsent';

// Bump when the disclosure materially changes to force a re-acceptance.
export const CONSENT_VERSION = 1;

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
  return !!(rec && rec.accepted && rec.version >= CONSENT_VERSION);
}

/** Record (or withdraw) consent for the current version. */
export async function setConsent(accepted) {
  const rec = { accepted: !!accepted, version: CONSENT_VERSION, at: new Date().toISOString() };
  await chrome.storage.local.set({ [KEY]: rec });
  return rec;
}
