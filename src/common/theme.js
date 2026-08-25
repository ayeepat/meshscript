/**
 * Theme controller. Preference ('system' | 'light' | 'dark') is stored in
 * chrome.storage.local, so every extension page stays in sync — including
 * pages already open (via the storage listener). The resolved theme lands
 * on <html data-theme="..."> and a 'themechange' event fires on document.
 */
const KEY = 'theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
let themeGeneration = 0;
let controllerWired = false;

function resolve(pref) {
  return pref === 'light' || pref === 'dark' ? pref : (media.matches ? 'dark' : 'light');
}

function apply(pref) {
  const resolved = resolve(pref);
  document.documentElement.dataset.theme = resolved;
  document.dispatchEvent(new CustomEvent('themechange', { detail: resolved }));
}

export async function getThemePref() {
  const { [KEY]: pref } = await chrome.storage.local.get(KEY);
  return pref || 'system';
}

export async function setThemePref(pref) {
  const generation = ++themeGeneration;
  try {
    await chrome.storage.local.set({ [KEY]: pref });
    if (generation === themeGeneration) apply(pref);
  } catch (error) {
    // The attempted write still invalidated any older initialization snapshot.
    // Repaint from durable state, then preserve the storage failure for callers.
    const recoveryGeneration = ++themeGeneration;
    try {
      const stored = await getThemePref();
      if (recoveryGeneration === themeGeneration) apply(stored);
    } catch { /* storage remains unavailable */ }
    throw error;
  }
}

/** Flip between light and dark (an explicit choice overrides 'system'). */
export async function toggleTheme() {
  const next = resolve(await getThemePref()) === 'dark' ? 'light' : 'dark';
  await setThemePref(next);
  return next;
}

export async function initTheme() {
  // Wire live changes BEFORE the asynchronous initial read. Otherwise a user
  // selection/storage event can land during that await and then be repainted by
  // the older snapshot when it finally resolves.
  if (!controllerWired) {
    controllerWired = true;
    media.addEventListener('change', async () => {
      const generation = themeGeneration;
      const pref = await getThemePref();
      if (generation === themeGeneration) apply(pref);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[KEY]) {
        themeGeneration++;
        apply(changes[KEY].newValue || 'system');
      }
    });
  }
  const generation = themeGeneration;
  const pref = await getThemePref();
  if (generation === themeGeneration) apply(pref);
}
