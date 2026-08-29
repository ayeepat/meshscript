/**
 * The onboarding tour is a once-per-device, once-per-lifetime event: there is no
 * "show it again" and no way for a student to ask for it back. Everything here
 * defends that promise from both sides — it must happen exactly once, and it
 * must never happen twice.
 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/* ---------- the guard itself ---------- */

const store = new Map();
const failures = { get: false, set: false };
// Every storage call resolves on a later macrotask so an unserialized
// read→write would genuinely interleave and hand out two claims.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        await tick();
        if (failures.get) throw new Error('storage unavailable');
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
        return { [keys]: store.get(keys) };
      },
      async set(entries) {
        await tick();
        if (failures.set) throw new Error('storage unavailable');
        for (const [key, value] of Object.entries(entries)) store.set(key, value);
      },
      async remove(key) {
        await tick();
        store.delete(key);
      },
    },
  },
};

const {
  claimTour, getTourRecord, hasSeenTour, markTourFinished, releaseTourClaim,
} = await import('../src/lib/onboarding.js');

const reset = () => { store.clear(); failures.get = false; failures.set = false; };

// A virgin device is claimed exactly once, and the record exists BEFORE the tab
// does — that ordering is what survives a crash mid-tour.
{
  reset();
  const first = await claimTour('install');
  assert.ok(first, 'the first claim on a fresh device must be granted');
  assert.equal(first.source, 'install');
  assert.ok(Number.isFinite(first.openedAt));
  assert.deepEqual(await getTourRecord(), first, 'the claim must be persisted, not just returned');

  assert.equal(await claimTour('update'), null, 'the update backfill must not re-show the tour');
  assert.equal(await claimTour('popup'), null, 'the popup hand-off must not re-show the tour');
}

// Two entry points firing at once must still produce one tour.
{
  reset();
  const [a, b, c] = await Promise.all([
    claimTour('install'), claimTour('update'), claimTour('popup'),
  ]);
  assert.equal([a, b, c].filter(Boolean).length, 1,
    'concurrent claims must be serialized into a single showing');
}

// Any stored record counts as "already seen" — including shapes this release
// has never written. Bumping the record version must not resurrect the tour for
// someone who already went through it.
for (const legacy of [{}, { version: 99, openedAt: 1 }, { seen: true }, { version: 0 },
  true, false, 0, 'shown', []]) {
  reset();
  store.set('onboardingTour', legacy);
  assert.equal(hasSeenTour(legacy), true, `${JSON.stringify(legacy)} must count as seen`);
  assert.equal(await claimTour('install'), null,
    `an existing ${JSON.stringify(legacy)} record must block the tour forever`);
}

// Storage that cannot answer fails CLOSED: a second showing is worse than none.
{
  reset();
  failures.get = true;
  assert.equal(await claimTour('install'), null, 'an unreadable record must block the tour');
  failures.get = false;
  failures.set = true;
  assert.equal(await claimTour('install'), null, 'an unwritable claim must block the tour');
  assert.equal(store.has('onboardingTour'), false);
}

// A claim whose tab never opened is given back — but only while it is still the
// untouched claim we wrote.
{
  reset();
  const claim = await claimTour('install');
  assert.equal(await releaseTourClaim(claim), true);
  assert.equal(await getTourRecord(), null, 'a released claim must leave no record behind');
  assert.ok(await claimTour('install'), 'the tour is available again after a released claim');

  const started = await getTourRecord();
  await markTourFinished('completed');
  assert.equal(await releaseTourClaim(started), false,
    'a tour that already ran must never be released back into the "unseen" state');
  assert.equal(await releaseTourClaim(null), false);
  assert.equal(await releaseTourClaim({ source: 'install', openedAt: 1 }), false,
    'releasing must match the exact claim, never just any record');
}

// The first outcome is the real one, and finishing without a claim still settles
// the device (the page can be opened by hand).
{
  reset();
  await claimTour('install');
  const skipped = await markTourFinished('skipped');
  assert.equal(skipped.outcome, 'skipped');
  assert.ok(Number.isFinite(skipped.finishedAt));
  assert.equal(skipped.source, 'install', 'finishing must not rewrite how the tour started');
  const again = await markTourFinished('completed');
  assert.equal(again.outcome, 'skipped', 'the first outcome wins');

  reset();
  const manual = await markTourFinished('completed');
  assert.equal(manual.outcome, 'completed');
  assert.equal(await claimTour('install'), null,
    'a hand-opened tour must also close the automatic showing');

  reset();
  assert.equal((await markTourFinished('nonsense')).outcome, 'completed',
    'an unknown outcome must degrade to a settled record, never to an unsettled one');
}

/* ---------- the record must survive everything except uninstalling ---------- */

const history = source('../src/lib/history.js');
const wipeList = history.slice(
  history.indexOf('async function deleteAllLocalDataHere()'),
  history.indexOf('export async function deleteAllLocalData()'),
);
assert.ok(wipeList.includes("'weekHomework'"), 'the local-data wipe list must be extractable');
assert.ok(!wipeList.includes('onboardingTour'),
  '«Удалить локальные данные» must not resurrect onboarding: the tour is a device fact, ' +
  'not user content, and a student who clears their history has still seen it');

/* ---------- worker wiring ---------- */

const worker = source('../src/background/service-worker.js');
assert.match(worker, /import \{ claimTour, releaseTourClaim \} from '\.\.\/lib\/onboarding\.js';/);
assert.match(worker, /const claim = await claimTour\(source\);\n\s+if \(!claim\) return false;/,
  'the tour tab may only open behind a granted claim');
assert.ok(
  worker.indexOf('await claimTour(source)') < worker.indexOf('chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE) })'),
  'the record must be written before the tab exists, never after',
);
for (const trigger of ["openOnboardingTour('install')", "openOnboardingTour('update')"]) {
  assert.ok(worker.includes(trigger), `the ${trigger} entry point must stay wired`);
}
assert.match(worker, /case 'OPEN_ONBOARDING':/);
assert.match(worker, /OPEN_ONBOARDING: noPayload,/);

const popup = source('../src/popup/popup.js');
assert.match(popup, /type: 'OPEN_ONBOARDING'/,
  'the popup hand-off must ask the worker instead of opening a tab itself');
assert.doesNotMatch(popup, /chrome\.tabs\.create/,
  'only the worker may open the tour, or two entry points become two tabs');
assert.match(popup, /if \(hasSeenTour\(record\)\) return false;/);

/* ---------- the tour page ---------- */

const tour = source('../src/welcome/welcome.html');
const steps = [...tour.matchAll(/<section class="step" data-step="(\d+)"/g)].map((m) => m[1]);
assert.deepEqual(steps, ['1', '2', '3', '4', '5', '6'],
  'the tour ships six steps: install, license, homework, tests, files, ГДЗ');
assert.equal((tour.match(/class="progress-seg"/g) || []).length, steps.length,
  'the progress bar must have exactly one segment per step');
assert.ok(steps.slice(1).every((step) => tour.includes(`data-step="${step}" aria-labelledby="step${step}-title" hidden`)),
  'every step after the first must ship hidden so nothing flashes before welcome.js runs');

// The price is a public offer: it has to be here, and it has to point at the
// place where the authoritative version lives.
assert.match(tour, /149 ₽ в месяц/);
assert.match(tour, /Актуальная цена, способы оплаты и условия — на smeshai\.xyz\./);
assert.match(tour, /href="https:\/\/smeshai\.xyz\/"/);
assert.doesNotMatch(tour, /www\.smeshai\.xyz/);

// Skipping is one-way, so it must be confirmed and must say so.
assert.match(tour, /aria-label="Пропустить знакомство"/);
assert.match(tour, /Точно пропустить знакомство\?/);
assert.match(tour, /больше не откроется/,
  'the skip dialog must tell the student the tour will not come back');
assert.match(tour, /<dialog id="skipDialog"/);

assert.match(tour, /Независимый сервис\. Не связан ни с одним электронным журналом\./);
assert.doesNotMatch(tour, /<script(?![^>]*src=)/,
  'the tour must not contain inline script blocked by the extension CSP');

// Screenshots must be bundled, present, and actually shown — a tour of four
// features with three pictures is the failure this pins.
const shots = ['homework', 'test', 'pdf', 'gdz'];
for (const shot of shots) {
  assert.match(tour, new RegExp(`src="\\.\\./\\.\\./assets/onboarding/${shot}\\.jpg"`),
    `the tour must show assets/onboarding/${shot}.jpg`);
  const file = new URL(`../assets/onboarding/${shot}.jpg`, import.meta.url);
  assert.ok(statSync(file).size > 1024, `assets/onboarding/${shot}.jpg must be a real image`);
  assert.equal(readFileSync(file).subarray(6, 10).toString('ascii'), 'JFIF',
    `assets/onboarding/${shot}.jpg must be a JPEG`);
}
for (const [, alt] of tour.matchAll(/<img src="\.\.\/\.\.\/assets\/onboarding\/[a-z]+\.jpg" alt="([^"]*)"/g)) {
  assert.ok(alt.length > 30, `onboarding screenshots need descriptive alt text, got ${JSON.stringify(alt)}`);
}

const packaging = source('../scripts/extension-package.mjs');
assert.match(packaging, /\{ directory: 'assets\/onboarding', extensions: new Set\(\['\.jpg'\]\) \}/,
  'the tour screenshots must ship inside the extension archive');

const { collectExtensionEntries } = await import('../scripts/extension-package.mjs');
const packaged = new Set((await collectExtensionEntries()).map((entry) => entry.name));
for (const shot of shots) {
  assert.ok(packaged.has(`assets/onboarding/${shot}.jpg`),
    `assets/onboarding/${shot}.jpg is missing from the packaged extension`);
}
assert.ok(packaged.has('src/lib/onboarding.js') && packaged.has('src/welcome/welcome.js'));

/* ---------- the controller ---------- */

const controller = source('../src/welcome/welcome.js');
assert.match(controller, /await markTourFinished\(outcome\);/,
  'the page must record the outcome through the shared guard');
assert.match(controller, /await finish\('skipped'\);/,
  'confirming the skip must be recorded as a skip');
assert.match(controller, /await finish\('completed'\);/);
assert.match(controller, /skipDialog\.showModal\(\)/,
  'the ✕ must confirm before discarding the only showing of the tour');
assert.match(controller, /if \(isLast\) void finish\('completed'\)/,
  'reaching the last step is completing the tour, not skipping it');

console.log('onboarding tour regression passed');
