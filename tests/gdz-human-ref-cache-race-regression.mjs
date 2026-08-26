import assert from 'node:assert/strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const liveBookUrl = 'https://gdz-ru.com/already-cached/';
const staleBookUrl = 'https://gdz-ru.com/expired/';
const bookUrls = [
  'https://gdz-ru.com/parallel-a/',
  'https://gdz-ru.com/parallel-b/',
];
let failNextHumanRefWrite = false;

const store = {
  gdzHumanRefs: {
    [liveBookUrl]: {
      base: 'https://gdz.ru/already-cached/',
      suffix: 'nom',
      at: Date.now(),
    },
    [staleBookUrl]: {
      base: 'https://gdz.ru/expired/',
      suffix: 'task',
      at: Date.now() - 8 * DAY_MS,
    },
  },
};

globalThis.chrome = {
  runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map((entry) => [entry, structuredClone(store[entry])]));
        }
        if (typeof key === 'string') return { [key]: structuredClone(store[key]) };
        return structuredClone(store);
      },
      async set(values) {
        if (failNextHumanRefWrite && Object.hasOwn(values, 'gdzHumanRefs')) {
          failNextHumanRefWrite = false;
          throw new Error('simulated human-reference storage failure');
        }
        Object.assign(store, structuredClone(values));
      },
    },
  },
};

let releaseHumanRequests;
const bothHumanRequestsStarted = new Promise((resolve) => { releaseHumanRequests = resolve; });
let humanRequestCount = 0;

// The link-suffix tally now runs on the Worker (it used to fetch 3 MB of SEO
// HTML to the client for one regex), so the fixture returns the derived ref
// instead of a page. What this regression is actually about — two overlapping
// uncached lookups sharing one serialized storage.local cache — is unchanged
// and still entirely client-side.
const { installGdzProxyStub } = await import('./helpers/gdz-proxy-stub.mjs');
installGdzProxyStub({
  store,
  async upstream(kind, input) {
    const url = new URL(input);
    if (kind === 'human' && /^\/parallel-[a-d]\/$/.test(url.pathname)) {
      humanRequestCount += 1;
      // Hold both parallel lookups open until each has started, so their cache
      // writes genuinely overlap rather than serializing by luck.
      if (/^\/parallel-[ab]\/$/.test(url.pathname)) {
        if (humanRequestCount === bookUrls.length) releaseHumanRequests();
        await bothHumanRequestsStarted;
      }
      return { ref: { base: url.href, suffix: 'task' } };
    }
    if (/^\/parallel-[a-d]\/$/.test(url.pathname)) {
      const id = url.pathname.match(/parallel-([a-d])/)[1];
      return {
        data: {
          structure: [{
            title: 'Упражнения',
            tasks: [{ title: '1', url: `https://gdz-ru.com/task-${id}/` }],
          }],
        },
      };
    }
    if (/^\/task-[a-d]\/$/.test(url.pathname)) {
      const id = url.pathname.match(/task-([a-d])/)[1];
      return { data: { editions: [{ images: [{ url: `https://img.gdz-ru.com/answer-${id}.png` }] }] } };
    }
    throw new Error(`unexpected upstream ${url.href}`);
  },
});

const { resolveTask } = await import('../src/lib/gdz-api.js');

const results = await Promise.all(bookUrls.map((bookUrl) => resolveTask(bookUrl, '1')));

assert.deepEqual(
  results.map((result) => result.link).sort(),
  [
    'https://gdz.ru/parallel-a/1-task/',
    'https://gdz.ru/parallel-b/1-task/',
  ],
  'both concurrent resolutions should derive an exact human link',
);
assert.equal(humanRequestCount, bookUrls.length,
  'the regression must exercise two overlapping uncached human-reference lookups');
assert.deepEqual(
  Object.keys(store.gdzHumanRefs).sort(),
  [liveBookUrl, ...bookUrls].sort(),
  'serialized mutations must retain both new entries and unrelated live entries while pruning expired data',
);

failNextHumanRefWrite = true;
await assert.rejects(
  resolveTask('https://gdz-ru.com/parallel-c/', '1'),
  /simulated human-reference storage failure/,
  'the queue must preserve the existing caller-visible storage failure behavior',
);
const recovered = await resolveTask('https://gdz-ru.com/parallel-d/', '1');
assert.equal(recovered.link, 'https://gdz.ru/parallel-d/1-task/');
assert.deepEqual(
  Object.keys(store.gdzHumanRefs).sort(),
  [liveBookUrl, ...bookUrls, 'https://gdz-ru.com/parallel-d/'].sort(),
  'one failed mutation must not poison later human-reference cache writes',
);

console.log('GDZ human-reference cache race regression passed');
