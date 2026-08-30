/**
 * Owner-only developer mode.
 *
 * Unlocks the Settings → «Диагностика» tab, which shows the EXACT material each
 * test solve sent to the model (the scraped page text), the model's private
 * reasoning stream, and its raw reply — the three things you need to tell a bad
 * answer caused by bad scraping apart from a bad answer caused by the model.
 *
 * Everything in src/ ships to the Chrome Web Store and is readable by anyone
 * who unpacks the extension. Even a hash of the owner licence is an offline
 * verifier for that bearer credential, so owner recognition happens only on
 * the backend and arrives here as a strict boolean in the verified status.
 */

/**
 * Whether THIS install runs under an owner key right now.
 *
 * Deliberately reads only the server-issued marker — not `ok`/`expires_at`.
 * Diagnostics must keep working while a licence problem is exactly what is
 * being diagnosed, and the tab grants no entitlement: every paid path still
 * runs its own ensureLicensed() gate. Any storage failure means "not a
 * developer".
 */
export async function isDevModeActive() {
  try {
    const { licenseStatus } = await chrome.storage.local.get('licenseStatus');
    return licenseStatus?.developer_mode === true;
  } catch {
    return false;
  }
}
