import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const localStore = {};
const sessionStore = {};
const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
const failures = {
  local: { set: 0, remove: 0 },
  session: { set: 0, remove: 0 }
};
const area = (store, name) => ({
  async get(key) {
    await pause();
    if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, store[item]]));
    return { [key]: store[key] };
  },
  async set(values) {
    await pause();
    if (failures[name].set > 0) {
      failures[name].set--;
      throw new Error(`simulated ${name} set failure`);
    }
    Object.assign(store, values);
  },
  async remove(key) {
    await pause();
    if (failures[name].remove > 0) {
      failures[name].remove--;
      throw new Error(`simulated ${name} remove failure`);
    }
    for (const item of (Array.isArray(key) ? key : [key])) delete store[item];
  }
});

globalThis.chrome = {
  storage: {
    local: area(localStore, 'local'),
    session: area(sessionStore, 'session')
  }
};

const { storeDashboardLaunch, consumeDashboardLaunch, cleanupDashboardLaunches } =
  await import('../src/lib/dashboard-launch.js');

const [launchA, launchB] = await Promise.all([
  storeDashboardLaunch({
    subject: 'Алгебра', rowToken: 'row-a',
    files: [{ name: 'a.pdf', mimeType: 'application/pdf', dataBase64: 'QQ==' }]
  }),
  storeDashboardLaunch({
    subject: 'Физика', rowToken: 'row-b',
    files: [{ name: 'b.pdf', mimeType: 'application/pdf', dataBase64: 'Qg==' }]
  })
]);
assert.equal(Object.keys(localStore.dashLaunchKeys).length, 2,
  'successive dashboard launches must retain separate attachment slots');
assert.equal(JSON.stringify(sessionStore).includes('a.pdf'), false,
  'attachment metadata and bodies must not enter content-readable storage.session');

const [payloadA, payloadB] = await Promise.all([
  consumeDashboardLaunch(launchA),
  consumeDashboardLaunch(launchB)
]);
assert.equal(payloadA.rowToken, 'row-a');
assert.equal(payloadA.files[0].name, 'a.pdf');
assert.equal(payloadB.rowToken, 'row-b');
assert.equal(payloadB.files[0].name, 'b.pdf');
assert.equal(localStore.dashLaunchKeys, undefined,
  'consuming both launches must remove both trusted attachment entries');

const retryLaunch = await storeDashboardLaunch({ subject: 'Химия', rowToken: 'retry-row' });
failures.local.remove = 1;
await assert.rejects(consumeDashboardLaunch(retryLaunch), /simulated local remove failure/);
assert.equal((await consumeDashboardLaunch(retryLaunch)).rowToken, 'retry-row',
  'a failed consume cleanup must not report success or lose the retryable launch');

const committedLaunch = await storeDashboardLaunch({ subject: 'История', rowToken: 'committed-row' });
failures.session.remove = 1;
assert.equal((await consumeDashboardLaunch(committedLaunch)).rowToken, 'committed-row',
  'trusted deletion must commit delivery even if session-orphan cleanup fails afterward');
assert.equal(await consumeDashboardLaunch(committedLaunch), null,
  'a launch committed by trusted deletion must not be consumable twice');
await cleanupDashboardLaunches();
assert.equal(sessionStore.dashLaunches, undefined,
  'the next sweep must remove ciphertext orphaned after a committed consume');

failures.session.set = 1;
await assert.rejects(
  storeDashboardLaunch({ subject: 'Биология', rowToken: 'orphan-row' }),
  /simulated session set failure/
);
assert.ok(localStore.dashLaunchKeys,
  'a session-write failure may temporarily leave only the trusted half');
await cleanupDashboardLaunches();
assert.equal(localStore.dashLaunchKeys, undefined,
  'the next launch sweep must remove a trusted orphan left by partial storage failure');

const { addGdzBook, removeGdzBook } = await import('../src/lib/gdz-books.js');
const book = (id, url) => ({ subject_id: id, subjectId: id, url, title: url });
await assert.rejects(addGdzBook(book('not-a-subject', 'https://gdz-ru.com/bad')), /invalid GDZ book/);
failures.local.set = 1;
await assert.rejects(
  addGdzBook(book(1, 'https://gdz-ru.com/failed-write')),
  /simulated local set failure/
);
await Promise.all([
  addGdzBook(book(1, 'https://gdz-ru.com/a')),
  addGdzBook(book(2, 'https://gdz-ru.com/b'))
]);
assert.equal(localStore.gdzBooks['1'][0].url, 'https://gdz-ru.com/a');
assert.equal(localStore.gdzBooks['2'][0].url, 'https://gdz-ru.com/b');
await Promise.all([
  removeGdzBook(1, 'https://gdz-ru.com/a'),
  addGdzBook(book(2, 'https://gdz-ru.com/c'))
]);
assert.equal(localStore.gdzBooks['1'], undefined);
assert.deepEqual(localStore.gdzBooks['2'].map((item) => item.url), [
  'https://gdz-ru.com/b', 'https://gdz-ru.com/c'
]);
assert.equal(
  Object.values(localStore.gdzBooks).flat().some((item) => item.url.endsWith('/failed-write')),
  false,
  'a failed GDZ write must not leak into the next successful mutation'
);
await Promise.all(Array.from({ length: 20 }, (_, index) =>
  addGdzBook(book(3, `https://gdz-ru.com/concurrent-${index}`))
));
assert.equal(localStore.gdzBooks['3'].length, 20,
  'a burst of parallel Settings writes must preserve every distinct book');

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const popup = source('../src/popup/popup.js');
const dashboard = source('../src/dashboard/dashboard.js');
const worker = source('../src/background/service-worker.js');
const scraper = source('../src/content/scraper.js');
const settings = source('../src/settings/settings.js');

assert.doesNotMatch(popup, /pendingUpload/,
  'popup must not use one global attachment handoff key');
assert.doesNotMatch(dashboard, /storage\.local\.get\('pendingUpload'\)/,
  'dashboard must receive files from its own consumed launch');
assert.match(popup, /if \(cardObj\.launching \|\| cardObj\.launched\) return;/,
  'solve launch must reject re-entry before its first await');
assert.match(popup, /const fillState = classifyAutopilotFill\(questions, fill\?\.summary\);/,
  'popup solved count must require exact completion of the captured question set');
assert.match(worker, /const fillState = classifyAutopilotFill\(questions, summary\);/,
  'pill solved count must require exact completion of the captured question set');

const popupLoop = popup.slice(popup.indexOf('async function solveAllPages'));
assert.ok(
  popupLoop.indexOf('inspectOnly: true') <
    popupLoop.indexOf('const nav = await advancePage'),
  'popup must inspect the page cap without clicking next'
);
const pillLoop = worker.slice(worker.indexOf('async function pillSolveAllPages'));
assert.ok(
  pillLoop.indexOf("testNextPage(navigationCapture, { click: false })") <
    pillLoop.indexOf('const nav = await advancePillPage'),
  'pill must inspect the page cap without clicking next'
);
assert.match(worker, /if \(!click\) return 'next';/,
  'read-only next-page discovery must return before the click injection');

assert.match(scraper, /option\.value === '' \|\| !normalizeForMatch\(option\.textContent\)/,
  'a first native-select option with an empty value must count as a placeholder');
assert.match(settings, /const generation = \+\+bookSearchGeneration;[\s\S]*?await gdzSend\('GDZ_SEARCH'[\s\S]*?generation !== bookSearchGeneration/,
  'catalog search must discard responses from older request generations');
assert.match(settings, /chrome\.storage\.onChanged\.addListener[\s\S]*?changes\.gdzBooks/,
  'settings tabs must reconcile GDZ book changes made by another tab');
assert.match(settings, /generation === bookMutationGeneration[\s\S]*?renderGdzState/,
  'an older Settings mutation response must not repaint over newer storage state');
assert.match(settings, /async function loadGdz\(\)[\s\S]*?generation === bookMutationGeneration[\s\S]*?renderGdzState\(stored\)/,
  'an older initial Settings read must not repaint over newer cross-tab storage state');
assert.match(worker, /'GDZ_BOOK_ADD', 'GDZ_BOOK_REMOVE'/,
  'GDZ writes must route through the service-worker serialization boundary');

console.log('verified findings regressions passed');
