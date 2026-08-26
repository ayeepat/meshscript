import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, store[key]]));
        }
        if (typeof keys === 'string') return { [keys]: store[keys] };
        return { ...store };
      },
      async set(values) { Object.assign(store, values); }
    }
  }
};

// GDZ fetching runs on the Worker now, so the only real request is one POST to
// the proxy. The stub unwraps it and dispatches on the upstream URL, which is
// what every assertion below is actually about.
const { installGdzProxyStub } = await import('./helpers/gdz-proxy-stub.mjs');
const proxyRequests = installGdzProxyStub({
  store,
  upstream(kind, url) {
    if (kind === 'human') return { ref: { base: url, suffix: null } };
    if (url === 'https://gdz-ru.com/full-book-list?country_id=1') {
      return {
        data: {
          success: true,
          subjects: [],
          classes: [],
          books: [{
            id: 1,
            subject_id: 4,
            title: 'Алгебра',
            subtype: 'Учебник',
            classes: [7],
            url: '/po-algebre/7-klass/makarychev/'
          }]
        }
      };
    }
    if (url === 'https://gdz-ru.com/po-algebre/7-klass/makarychev/') {
      return {
        data: {
          structure: [{
            title: 'Упражнения',
            tasks: [{ title: '25', url: '/task/25/' }]
          }]
        }
      };
    }
    if (url === 'https://gdz-ru.com/task/25/') {
      return { data: { editions: [{ images: [{ url: 'https://img.gdz-ru.com/answer-25.png' }] }] } };
    }
    throw new Error(`unexpected upstream ${url}`);
  }
});
// The URL the extension ASKED the proxy for is what these assertions are about.
const upstreamUrls = () => proxyRequests.map((request) => request.url);

const {
  getCatalog,
  listTasks,
  normalizeGdzApiUrl,
  resolveTask,
  searchBooks
} = await import('../src/lib/gdz-api.js');

const bookPath = '/po-algebre/7-klass/makarychev/';
const bookUrl = `https://gdz-ru.com${bookPath}`;

assert.equal(normalizeGdzApiUrl(bookPath), bookUrl);
assert.equal(normalizeGdzApiUrl(bookUrl), bookUrl);
assert.equal(normalizeGdzApiUrl(`${bookUrl}#catalog-row`), bookUrl,
  'fragments must not create different book identities');
assert.equal(normalizeGdzApiUrl('https://gdz.ru/po-algebre/7-klass/makarychev/'), '');
assert.equal(normalizeGdzApiUrl('https://gdz-ru.com.evil.example/book/'), '');
assert.equal(normalizeGdzApiUrl('https://img.gdz-ru.com/book/'), '',
  'the API normalizer must reject an otherwise allowlisted subdomain: fetches use the exact origin');
assert.equal(normalizeGdzApiUrl('https://user:pass@gdz-ru.com/book/'), '');
assert.equal(normalizeGdzApiUrl('gdz.ru/book/'), '',
  'ambiguous bare relative strings must not be reinterpreted as trusted API paths');

const fresh = await getCatalog({ force: true });
assert.equal(fresh.books[0].url, bookUrl,
  'fresh catalog entries must cross the worker boundary as canonical absolute API URLs');

store.gdzCatalog = {
  fetchedAt: Date.now(),
  subjects: [],
  classes: [],
  books: [{
    subject_id: 4,
    subtype: 'Учебник',
    classes: [7],
    search_keywords: 'макарычев',
    url: bookPath
  }]
};
const cached = await getCatalog();
assert.equal(cached.books[0].url, bookUrl,
  'a pre-upgrade cached catalog with relative URLs must be normalized on read');
assert.equal(searchBooks(store.gdzCatalog, {
  grade: 7,
  subjectId: 4,
  query: 'макарычев'
})[0].url, bookUrl,
  'searchBooks must preserve the canonical URL contract for caller-supplied legacy catalogs');

const relativeTasks = await listTasks(bookPath);
const absoluteTasks = await listTasks(bookUrl);
assert.deepEqual(relativeTasks, absoluteTasks,
  'relative and absolute stored book URLs must share one task-list cache identity');
assert.equal(relativeTasks[0].url, 'https://gdz-ru.com/task/25/');
assert.equal(
  upstreamUrls().filter((url) => url === bookUrl).length,
  1,
  'relative and absolute forms must resolve with one canonical book request'
);

const resolved = await resolveTask(bookUrl, '25');
assert.equal(resolved.taskUrl, 'https://gdz-ru.com/task/25/');
assert.equal(resolved.images[0], 'https://img.gdz-ru.com/answer-25.png');
assert.equal(
  upstreamUrls().some((url) => url.includes('https://gdz-ru.comhttps://')),
  false,
  'resolution must never concatenate BASE onto an absolute URL'
);

const requestCount = proxyRequests.length;
const resolvedLegacy = await resolveTask(bookPath, '25');
assert.deepEqual(resolvedLegacy, resolved,
  'relative and absolute book forms must share the resolved-task cache identity');
assert.equal(proxyRequests.length, requestCount);

store.gdzTaskCache[`v2|${bookPath}|page|25`] = {
  v: {
    taskUrl: '/task/25/',
    section: 'Страницы',
    images: ['https://img.gdz-ru.com/answer-25.png'],
    link: 'https://gdz.ru/book/'
  },
  at: Date.now()
};
const migratedCacheHit = await resolveTask(bookUrl, '25', { mode: 'page' });
assert.equal(migratedCacheHit.taskUrl, 'https://gdz-ru.com/task/25/',
  'legacy relative resolved-task cache entries must remain readable and return canonical URLs');
assert.equal(proxyRequests.length, requestCount,
  'reading a compatible legacy cache entry must not trigger a network request');

await assert.rejects(
  listTasks('https://evil.example/book/'),
  /invalid API URL/,
  'normalization must fail closed before a foreign-origin fetch'
);

const { addGdzBook, normalizeGdzBooks, removeGdzBook } = await import('../src/lib/gdz-books.js');
const legacyBooks = {
  4: [
    { subject_id: 4, url: bookPath, title: 'legacy relative' },
    { subject_id: 4, url: bookUrl, title: 'duplicate absolute' },
  ],
};
assert.deepEqual(
  normalizeGdzBooks(legacyBooks)[4].map((book) => book.url),
  [bookUrl],
  'stored relative/absolute duplicates must collapse to one canonical identity',
);

store.gdzBooks = legacyBooks;
await addGdzBook({ subject_id: 4, url: bookUrl, title: 'same catalog row' });
assert.equal(store.gdzBooks[4].length, 1,
  'adding an absolute catalog row must not duplicate a legacy relative book');
await removeGdzBook(4, bookUrl);
assert.equal(store.gdzBooks[4], undefined,
  'removing the canonical URL must also remove a pre-upgrade relative record');

console.log('GDZ book URL normalization regressions passed');
