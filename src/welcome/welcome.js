/**
 * The one-time onboarding tour.
 *
 * Six steps ship in the markup; this file reveals exactly one at a time and
 * records how the tour ended. It does NOT decide whether the tour may appear —
 * that is settled before this page exists, by the claim in lib/onboarding.js
 * (see the service worker). Reaching the last step counts as completing it, and
 * the ✕ asks for confirmation first, because on this device there is no second
 * chance to see any of it.
 */
import { initTheme } from '../common/theme.js';
import { getLicenseStatus, isUsableLicenseStatus } from '../lib/license.js';
import { markTourFinished } from '../lib/onboarding.js';

const DIARY_URL = 'https://school.mos.ru/diary/';

void initTheme().catch(() => { /* system colors from CSS remain usable */ });

const stage = document.getElementById('stage');
const steps = [...document.querySelectorAll('.step')];
const segments = [...document.querySelectorAll('.progress-seg')];
const counter = document.getElementById('counter');
const backBtn = document.getElementById('backBtn');
const nextBtn = document.getElementById('nextBtn');
const nextLabel = document.getElementById('nextLabel');
const closeBtn = document.getElementById('closeTour');
const skipBtn = document.getElementById('skipTour');
const skipDialog = document.getElementById('skipDialog');

const lastIndex = steps.length - 1;
let index = 0;
// Whether the tour has already been written off as completed or skipped. The
// first outcome is the real one; markTourFinished() keeps the same rule in
// storage, this flag just stops the page from asking again.
let settled = false;

async function finish(outcome) {
  if (settled) return;
  settled = true;
  try {
    await markTourFinished(outcome);
  } catch { /* the claim already closed the door; the record is bookkeeping */ }
}

async function closeTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch { /* fall through to the window close below */ }
  window.close();
}

function show(next) {
  index = Math.min(Math.max(next, 0), lastIndex);
  const isLast = index === lastIndex;

  steps.forEach((step, position) => { step.hidden = position !== index; });
  segments.forEach((segment, position) => {
    segment.classList.toggle('is-current', position === index);
    segment.classList.toggle('is-done', position < index);
  });

  counter.textContent = `${index + 1} / ${steps.length}`;
  backBtn.hidden = index === 0;
  closeBtn.hidden = !isLast;
  nextLabel.textContent = isLast ? 'Открыть дневник' : 'Далее';

  stage.scrollTop = 0;
  steps[index].querySelector('h1')?.focus({ preventScroll: true });

  // Seeing the final screen IS finishing the tour: nothing after it is
  // required, and a student who reads the last step and closes the tab should
  // not be recorded as having skipped.
  if (isLast) void finish('completed');
}

/**
 * A returning student — the whole point of the one-time backfill — already owns
 * a key, so «Купить лицензию» would be the wrong next action for them. Show the
 * live state instead and turn the button into the renewal it actually is.
 */
async function renderLicenseState() {
  let status = null;
  try {
    status = await getLicenseStatus();
  } catch {
    return; // storage unavailable: the neutral purchase copy is still correct
  }
  if (!isUsableLicenseStatus(status)) return;

  const expiresAt = status?.expires_at ? Date.parse(status.expires_at) : NaN;
  const state = document.getElementById('licenseState');
  state.textContent = Number.isFinite(expiresAt)
    ? `Лицензия активна до ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(expiresAt)}`
    : 'Лицензия активна';
  state.hidden = false;

  document.getElementById('buyLabel').textContent = 'Продлить лицензию';
  document.getElementById('openSettings').hidden = true;
}

nextBtn.addEventListener('click', async () => {
  if (index < lastIndex) { show(index + 1); return; }
  await finish('completed');
  location.assign(DIARY_URL);
});

backBtn.addEventListener('click', () => show(index - 1));

closeBtn.addEventListener('click', async () => {
  await finish('completed');
  await closeTab();
});

document.getElementById('openSettings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

skipBtn.addEventListener('click', () => {
  // Nothing left to skip once the tour is finished — the ✕ is just "close".
  if (settled) { void closeTab(); return; }
  skipDialog.showModal();
});

document.getElementById('skipCancel').addEventListener('click', () => skipDialog.close());

document.getElementById('skipConfirm').addEventListener('click', async () => {
  skipDialog.close();
  await finish('skipped');
  await closeTab();
});

document.addEventListener('keydown', (event) => {
  if (skipDialog.open) return; // Esc there means "keep the tour", handled by <dialog>
  if (event.key === 'ArrowRight' && index < lastIndex) { show(index + 1); }
  else if (event.key === 'ArrowLeft' && index > 0) { show(index - 1); }
  else if (event.key === 'Escape') { skipBtn.click(); }
});

show(0);
void renderLicenseState();
