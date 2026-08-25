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
  declarativeNetRequest: { async updateSessionRules() {} },
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

function response(body, url, contentType) {
  const value = typeof body === 'string' ? body : JSON.stringify(body);
  const result = new Response(value, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(Buffer.byteLength(value)),
    },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

let releaseHumanRequests;
const bothHumanRequestsStarted = new Promise((resolve) => { releaseHumanRequests = resolve; });
let humanRequestCount = 0;

globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.origin === 'https://gdz-ru.com' && /^\/parallel-[a-d]\/$/.test(url.pathname)) {
    const id = url.pathname.match(/parallel-([a-d])/)[1];
    return response({
      structure: [{
        title: 'Упражнения',
        tasks: [{ title: '1', url: `https://gdz-ru.com/task-${id}/` }],
      }],
    }, url.href, 'application/json');
  }
  if (url.origin === 'https://gdz-ru.com' && /^\/task-[a-d]\/$/.test(url.pathname)) {
    const id = url.pathname.match(/task-([a-d])/)[1];
    return response({
      editions: [{ images: [{ url: `https://img.gdz-ru.com/answer-${id}.png` }] }],
    }, url.href, 'application/json');
  }
  if (url.origin === 'https://gdz.ru' && /^\/parallel-[a-d]\/$/.test(url.pathname)) {
    humanRequestCount += 1;
    if (/^\/parallel-[ab]\/$/.test(url.pathname)) {
      if (humanRequestCount === bookUrls.length) releaseHumanRequests();
      await bothHumanRequestsStarted;
    }
    return response(
      `<a href="${url.pathname}1-task/">answer</a>`,
      url.href,
      'text/html',
    );
  }
  throw new Error(`unexpected fetch ${url.href}`);
};

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
