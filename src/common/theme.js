/**
 * Theme controller. Preference ('system' | 'light' | 'dark') is stored in
 * chrome.storage.local, so every extension page stays in sync — including
 * pages already open (via the storage listener). The resolved theme lands
 * on <html data-theme="..."> and a 'themechange' event fires on document.
 */
const KEY = 'theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

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
  await chrome.storage.local.set({ [KEY]: pref });
  apply(pref);
}

/** Flip between light and dark (an explicit choice overrides 'system'). */
export async function toggleTheme() {
  const next = resolve(await getThemePref()) === 'dark' ? 'light' : 'dark';
  await setThemePref(next);
  return next;
}

export async function initTheme() {
  apply(await getThemePref());
  media.addEventListener('change', async () => apply(await getThemePref()));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) apply(changes[KEY].newValue || 'system');
  });
}
