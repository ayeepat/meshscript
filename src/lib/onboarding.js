/**
 * One-time onboarding tour state.
 *
 * The tour is the full-screen page in src/welcome/. It opens automatically
 * EXACTLY ONCE per device — on a fresh install, and once more as a backfill for
 * everyone who installed before the tour existed (see the `update` branch in
 * the service worker). After that it never opens by itself again, whatever
 * happens to the license: licenses renew monthly and are per-key, the tour is
 * per-device and permanent.
 *
 * Shape (chrome.storage.local.onboardingTour):
 *   { version, source, openedAt, finishedAt: number|null, outcome: string|null }
 *
 * The guarantees this module is responsible for:
 *
 *  1. THE RECORD IS WRITTEN BEFORE THE TAB EXISTS. claimTour() persists first
 *     and the caller opens the tab only if the claim was granted, so a crash,
 *     a closed tab or a machine that loses power mid-tour can never produce a
 *     second showing. "Shown" is defined as "handed to the user", not "read".
 *  2. ANY EXISTING RECORD COUNTS AS SEEN. The `version` field is forensic only
 *     and is deliberately NOT part of the guard: bumping it (or shipping a
 *     record shape from a future release) must never re-open onboarding for a
 *     device that already went through it.
 *  3. STORAGE FAILURES FAIL CLOSED. If we cannot read or write the record we
 *     decline the claim rather than risk showing the tour twice.
 *  4. A LOCAL-DATA WIPE DOES NOT RESURRECT IT. history.js deleteAllLocalData()
 *     removes an explicit key list; `onboardingTour` is deliberately not on it,
 *     and tests/onboarding-tour-regression.mjs pins that.
 *
 * claimTour() is only ever called from the service worker (extension pages ask
 * for it with the OPEN_ONBOARDING message) so the mutation queue below is the
 * single writer, and the read→write gap cannot interleave across contexts.
 */

const KEY = 'onboardingTour';

// Forensics only — see guarantee 2 above. Bumping this does NOT re-show the
// tour; a second tour would need its own storage key and its own decision.
export const TOUR_VERSION = 1;

export const TOUR_SOURCES = Object.freeze(['install', 'update', 'popup', 'manual']);
export const TOUR_OUTCOMES = Object.freeze(['completed', 'skipped']);

let claimQueue = Promise.resolve();

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * True when this device has already been handed the tour. ANY stored value
 * counts — a malformed record, a newer shape, a bare `true` written by some
 * future release. The only safe reading of "there is something under this key"
 * is "onboarding already happened".
 */
export function hasSeenTour(record) {
  return record != null;
}

export async function getTourRecord() {
  const { [KEY]: record } = await chrome.storage.local.get(KEY);
  return record ?? null;
}

/**
 * Reserve the one and only automatic showing of the tour.
 *
 * @returns the persisted record when the caller may open the tour, or null when
 *   this device has already seen it (or storage refused to answer).
 */
export function claimTour(source) {
  const run = claimQueue.then(() => claimTourHere(source));
  claimQueue = run.then(() => {}, () => {});
  return run;
}

async function claimTourHere(source) {
  let existing;
  try {
    existing = await getTourRecord();
  } catch {
    return null; // fail closed: an unreadable record is treated as "seen"
  }
  if (hasSeenTour(existing)) return null;

  const record = {
    version: TOUR_VERSION,
    source: TOUR_SOURCES.includes(source) ? source : 'manual',
    openedAt: Date.now(),
    finishedAt: null,
    outcome: null,
  };
  try {
    await chrome.storage.local.set({ [KEY]: record });
  } catch {
    return null;
  }
  return record;
}

/**
 * Undo a claim whose tab never opened (chrome.tabs.create rejected). Without
 * this the student would silently lose onboarding to a transient tab failure.
 * The stored record must still be the untouched claim we wrote, so a tour that
 * has meanwhile started — or a second claim — can never be erased.
 */
export async function releaseTourClaim(claim) {
  if (!isRecord(claim)) return false;
  const run = claimQueue.then(async () => {
    const stored = await getTourRecord();
    if (!stored || stored.openedAt !== claim.openedAt || stored.source !== claim.source ||
        stored.finishedAt != null || stored.outcome != null) {
      return false;
    }
    await chrome.storage.local.remove(KEY);
    return true;
  });
  claimQueue = run.then(() => {}, () => {});
  return run;
}

/**
 * Record how the tour ended. Called from the tour page itself, so it may run
 * without a claim (someone opened the page by hand) — in that case it writes a
 * settled record, which keeps the automatic opening closed either way. The
 * first outcome wins; re-finishing never rewrites history.
 */
export async function markTourFinished(outcome) {
  const settled = TOUR_OUTCOMES.includes(outcome) ? outcome : 'completed';
  const stored = await getTourRecord();
  if (stored?.finishedAt != null) return stored;
  const record = {
    version: TOUR_VERSION,
    source: 'manual',
    openedAt: Date.now(),
    ...(isRecord(stored) ? stored : {}),
    finishedAt: Date.now(),
    outcome: settled,
  };
  await chrome.storage.local.set({ [KEY]: record });
  return record;
}
