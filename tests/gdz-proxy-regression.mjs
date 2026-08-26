/**
 * GDZ moved from the extension to the Worker so `declarativeNetRequest` could
 * be dropped from the store listing. This pins the three things that would
 * quietly undo that:
 *
 *   1. the permission and the GDZ host permissions stay OUT of the manifest,
 *      and no extension source reaches for the DNR API again;
 *   2. the Worker's host allowlist — now the only real boundary, since the
 *      client's copy can be bypassed by anything that speaks HTTP;
 *   3. the User-Agent strings, which are the entire reason the hop moved: a
 *      browser UA on the mobile API gets a DDoS-Guard challenge instead of
 *      data, and okhttp on the public site gets the same in reverse.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

/* ---------- 1. The permission is gone and stays gone ---------- */

const manifest = JSON.parse(source('../manifest.json'));

assert.ok(
  !manifest.permissions.includes('declarativeNetRequest'),
  'declarativeNetRequest must stay out of the manifest — GDZ fetching lives on the Worker now'
);
assert.ok(
  !Object.hasOwn(manifest, 'declarative_net_request'),
  'no static DNR rule resource may be reintroduced either'
);

for (const host of manifest.host_permissions) {
  assert.doesNotMatch(
    host,
    /gdz/i,
    `the extension must not request a GDZ host permission (${host}) — the proxy fetches for it`
  );
}

// The API surface, not just the manifest entry: a call would throw at runtime
// without the permission, which is a worse failure than a red test.
for (const name of readdirSync(new URL('../src/lib/', import.meta.url))) {
  if (!name.endsWith('.js')) continue;
  assert.doesNotMatch(
    source(`../src/lib/${name}`),
    /chrome\.declarativeNetRequest/,
    `src/lib/${name} must not use chrome.declarativeNetRequest`
  );
}
for (const dir of ['background', 'content', 'settings', 'popup', 'dashboard', 'common']) {
  for (const name of readdirSync(new URL(`../src/${dir}/`, import.meta.url))) {
    if (!name.endsWith('.js')) continue;
    assert.doesNotMatch(
      source(`../src/${dir}/${name}`),
      /chrome\.declarativeNetRequest/,
      `src/${dir}/${name} must not use chrome.declarativeNetRequest`
    );
  }
}

/* ---------- 2. The Worker's allowlist is the security boundary ---------- */

const { __test, handleGdzFetch } = await import('../backend/src/gdz.js');
const { verifyLicense } = await import('../backend/src/licenses.js');
const {
  gdzApiUrl, gdzHumanUrl, gdzCoverUrl, isCatalogUrl, fetchUpstream, fetchGdzHumanRef,
  GDZ_API_UA, GDZ_HUMAN_UA
} = __test;

for (const good of [
  'https://gdz-ru.com/full-book-list?country_id=1',
  'https://img.gdz-ru.com/answer.png',
  'https://deep.sub.gdz-ru.com/x.jpg'
]) {
  assert.equal(gdzApiUrl(good), good, `${good} must be allowed`);
}

for (const bad of [
  // Lookalikes: a suffix match without the dot boundary would accept the first
  // two, and a naive "contains" check would accept the third.
  'https://evilgdz-ru.com/x',
  'https://gdz-ru.com.evil.com/x',
  'https://evil.com/?x=gdz-ru.com',
  'http://gdz-ru.com/x',                    // plaintext
  'https://user:pass@gdz-ru.com/x',         // credentials hide the real target
  'https://gdz-ru.com:8443/x',              // different origin
  'https://gdz.ru/po-algebre/',             // right family, wrong allowlist
  'file:///etc/passwd',
  'not a url',
  '',
  null,
  undefined,
  12345,
  {}
]) {
  assert.equal(gdzApiUrl(bad), '', `${String(bad)} must be rejected by the API allowlist`);
}

assert.equal(gdzHumanUrl('https://gdz.ru/po-algebre/'), 'https://gdz.ru/po-algebre/');
assert.equal(gdzHumanUrl('https://gdz-ru.com/x'), '', 'the human allowlist must not accept the API host');
assert.equal(gdzHumanUrl('https://notgdz.ru/x'), '');

// Covers are the one asset served from either host.
assert.ok(gdzCoverUrl('https://gdz-ru.com/cover.jpg'));
assert.ok(gdzCoverUrl('https://gdz.ru/cover.jpg'));
assert.equal(gdzCoverUrl('https://evil.com/cover.jpg'), '');

// The fragment is dropped before the URL reaches fetch(), so two spellings of
// the same document can't split the catalog cache.
assert.equal(gdzApiUrl('https://gdz-ru.com/x#frag'), 'https://gdz-ru.com/x');

/* ---------- 3. Catalog cache scoping ---------- */

// Only the one catalog representation the extension requests gets the larger
// ceiling and a persistent edge-cache entry. Treating arbitrary query strings
// as catalogs lets a scripted licensed caller create hundreds of distinct
// 24 MB cache entries in one day.
assert.ok(isCatalogUrl('https://gdz-ru.com/full-book-list?country_id=1'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list?anything=else'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list?country_id=1&nonce=attacker'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list?country_id=1&country_id=1'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list?country_id=%31'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list?country_id=1&'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/full-book-list/extra'));
assert.ok(!isCatalogUrl('https://gdz-ru.com/po-algebre/book'));

// Regression: matching on pathname ALONE let any allowlisted subdomain claim
// the catalog's 24 MB ceiling (6× the normal JSON budget) and write to the
// shared edge cache under a caller-chosen key.
assert.ok(!isCatalogUrl('https://img.gdz-ru.com/full-book-list'),
  'only the exact API origin may be treated as the catalog');
assert.ok(!isCatalogUrl('https://img.gdz-ru.com/full-book-list?x=1'));
assert.ok(!isCatalogUrl('https://gdz.ru/full-book-list'));

/* ---------- 3b. Covers are metered apart from answers ---------- */

// Regression: covers and answer lookups shared one daily counter, so browsing
// the textbook picker — dozens of thumbnails per search — could spend the day's
// allowance and leave «Решить» with no ГДЗ at all.
{
  const gdzSource = source('../backend/src/gdz.js');
  assert.match(gdzSource, /scope: 'gdz_cover'/,
    'cover requests must charge a separate budget scope');
  assert.match(gdzSource, /releaseDailyBudget/,
    'a failed upstream must return the reserved slot — the cap bounds scraping, not a bill');
}

/* ---------- 4. Redirect handling (moved here from the extension) ---------- */

// These cases used to live in gdz-image-safety-regression.mjs, against the
// extension's own fetchBounded. The hop moved, so the guard has to be proven
// where the hop now is.
{
  const realFetch = globalThis.fetch;
  let requested = [];
  const stubFetch = (responder) => {
    requested = [];
    globalThis.fetch = async (url, init) => {
      requested.push(url);
      return responder(url, init);
    };
  };

  // An open redirect must not walk the Worker onto a LAN address, and the
  // blocked target must receive no request at all.
  stubFetch(() => new Response(null, {
    status: 302,
    headers: { location: 'http://127.0.0.1:8080/internal' }
  }));
  let result = await fetchUpstream('https://gdz-ru.com/open-redirect', {
    userAgent: GDZ_API_UA, maxBytes: 1024, allow: gdzApiUrl, accept: 'image/*'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'redirect_off_allowlist');
  assert.deepEqual(requested, ['https://gdz-ru.com/open-redirect'],
    'the rejected redirect target must never be fetched');

  // A redirect that stays on the allowlist IS followed, so a legitimate CDN
  // hop still works.
  stubFetch((url) => (url === 'https://gdz-ru.com/a'
    ? new Response(null, { status: 302, headers: { location: 'https://img.gdz-ru.com/b' } })
    : new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } })));
  result = await fetchUpstream('https://gdz-ru.com/a', {
    userAgent: GDZ_API_UA, maxBytes: 1024, allow: gdzApiUrl, accept: 'application/json'
  });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://img.gdz-ru.com/b');
  assert.deepEqual(requested, ['https://gdz-ru.com/a', 'https://img.gdz-ru.com/b']);

  // A redirect loop is bounded rather than spinning until the platform kills
  // the invocation.
  stubFetch(() => new Response(null, {
    status: 302, headers: { location: 'https://gdz-ru.com/loop' }
  }));
  result = await fetchUpstream('https://gdz-ru.com/loop', {
    userAgent: GDZ_API_UA, maxBytes: 1024, allow: gdzApiUrl, accept: '*/*'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_many_redirects');
  assert.ok(requested.length <= 5, 'a redirect loop must be bounded');

  // The User-Agent is the entire reason this indirection exists — assert it is
  // actually on the wire, not merely defined.
  stubFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  let sentHeaders = null;
  globalThis.fetch = async (url, init) => {
    sentHeaders = init.headers;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await fetchUpstream('https://gdz-ru.com/x', {
    userAgent: GDZ_API_UA, maxBytes: 1024, allow: gdzApiUrl, accept: 'application/json'
  });
  assert.equal(sentHeaders['User-Agent'], 'okhttp/4.9.1',
    'the okhttp User-Agent must reach the request — without it DDoS-Guard returns a challenge');

  // A body over the ceiling is refused instead of buffered.
  globalThis.fetch = async () => new Response('x'.repeat(5000), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  result = await fetchUpstream('https://gdz-ru.com/big', {
    userAgent: GDZ_API_UA, maxBytes: 100, allow: gdzApiUrl, accept: 'application/json'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too_large');

  // A failed human-page fetch is not a real "no suffix" verdict. Returning an
  // empty success here makes the client cache the outage for seven days and
  // also prevents the route from refunding the reserved daily-budget slot.
  globalThis.fetch = async () => { throw new TypeError('connection reset'); };
  result = await fetchGdzHumanRef('https://gdz.ru/test-book/');
  assert.equal(result.ok, false,
    'a human-page transport failure must propagate so it is neither cached nor charged');
  assert.equal(result.reason, 'network');

  // An off-allowlist start URL never reaches fetch().
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}'); };
  result = await fetchUpstream('https://evil.example/x', {
    userAgent: GDZ_API_UA, maxBytes: 1024, allow: gdzApiUrl, accept: '*/*'
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'bad_host');
  assert.equal(called, false, 'a rejected host must not be fetched');

  globalThis.fetch = realFetch;
}

/* ---------- 4b. Cache failures degrade; thrown work refunds admission ---------- */

// Cache access is an optimization, so its failure must fall through to the
// live upstream. A genuine exception after reserveDailyBudget must still
// refund the slot instead of turning one platform problem into a day-long GDZ
// outage.
{
  class FakeKV {
    store = new Map();
    async get(key) { return this.store.get(key) ?? null; }
    async put(key, value) { this.store.set(key, value); }
  }
  class SqliteD1 {
    constructor(db) { this.db = db; }
    prepare(sql) {
      const db = this.db;
      const statement = (args = []) => ({
        bind: (...bound) => statement(bound),
        async first(column) {
          const row = db.prepare(sql).get(...args) || null;
          return column ? row?.[column] ?? null : row;
        },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async run() {
          const result = db.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes) || 0 } };
        }
      });
      return statement();
    }
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    }
  }

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(source('../backend/schema.sql'));
  const licenses = new FakeKV();
  const key = 'SMESH-GDZ-TEST';
  const deviceId = '00000000-0000-4000-8000-000000000001';
  licenses.store.set(key, JSON.stringify({
    key, type: 'lifetime', status: 'active', expires_at: null, device_ids: []
  }));
  const env = {
    LICENSES: licenses,
    DB: new SqliteD1(sqlite),
    DEVICE_LIMIT: '1',
    GDZ_DAILY_LIMIT: '3'
  };
  const activation = await verifyLicense(env, key, deviceId);
  assert.equal(activation.ok, true, 'the route fixture must own a valid activation');

  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;
  const realBtoa = globalThis.btoa;
  globalThis.caches = { default: {
    async match() { throw new Error('simulated Cache API outage'); },
    async put() {}
  } };
  try {
    globalThis.fetch = async () => new Response('{"success":true,"books":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
    let response = await handleGdzFetch(new Request('https://smeshapi.site/gdz/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        license_key: key,
        device_id: deviceId,
        activation_token: activation.activation_token,
        kind: 'json',
        url: 'https://gdz-ru.com/full-book-list?country_id=1'
      })
    }), env, { waitUntil() {} });
    assert.equal(response.status, 200,
      'a Cache API read failure must degrade to the live upstream');
    let budget = sqlite.prepare(
      "SELECT count FROM telemetry_budget WHERE scope = 'gdz'"
    ).get();
    assert.equal(budget?.count, 1, 'the successful live request remains charged');

    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    });
    globalThis.btoa = () => { throw new Error('simulated base64 encoder failure'); };
    response = await handleGdzFetch(new Request('https://smeshapi.site/gdz/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        license_key: key,
        device_id: deviceId,
        activation_token: activation.activation_token,
        kind: 'image',
        url: 'https://gdz-ru.com/answer.png'
      })
    }), env, { waitUntil() {} });
    assert.equal(response.status, 503, 'the injected encoder exception must reach the failure path');
    budget = sqlite.prepare(
      "SELECT count FROM telemetry_budget WHERE scope = 'gdz'"
    ).get();
    assert.equal(budget?.count, 1,
      'a thrown post-reservation failure must refund its daily-budget slot');
  } finally {
    if (realCaches === undefined) delete globalThis.caches;
    else globalThis.caches = realCaches;
    globalThis.fetch = realFetch;
    globalThis.btoa = realBtoa;
    sqlite.close();
  }
}

/* ---------- 5. The User-Agents that make this work at all ---------- */

assert.equal(GDZ_API_UA, 'okhttp/4.9.1',
  'DDoS-Guard allowlists this exact UA on the mobile API — a browser UA gets 403');
assert.match(GDZ_HUMAN_UA, /^Mozilla\/5\.0 /,
  'the public SEO site wants a browser UA; okhttp gets a challenge page there');

/* ---------- 6. Server and client image ceilings agree ---------- */

// If the proxy allowed a bigger image than the client accepts, the difference
// would be fetched, base64-encoded and shipped only to be discarded.
{
  const gdzBackendSource = source('../backend/src/gdz.js');
  const serverLimit = gdzBackendSource.match(/const IMAGE_MAX_BYTES = (\d+) \* 1024 \* 1024;/);
  const clientLimit = source('../src/lib/upload-limits.js')
    .match(/MAX_STANDARD_UPLOAD_BYTES = (\d+) \* 1024 \* 1024;/);
  assert.ok(serverLimit && clientLimit, 'both image ceilings must stay greppable');
  assert.equal(serverLimit[1], clientLimit[1],
    'the proxy must not fetch an image larger than the extension will accept');
}

/* ---------- 7. The client still validates what comes back ---------- */

// The proxy checks the content type, but the extension is the process that
// decodes the image and hands it to a model, so it must not delegate the gate
// protecting its own decoder.
const gdzApiSource = source('../src/lib/gdz-api.js');
assert.match(gdzApiSource, /imageDimensions\(bytes\)/,
  'the client must still measure a proxied image before any decoder sees it');
assert.match(gdzApiSource, /GDZ_IMAGE_MAX_PIXELS/,
  'the decompression-bomb ceiling must remain enforced client-side');
assert.match(gdzApiSource, /MAX_STANDARD_UPLOAD_BYTES/,
  'the client must still bound the size of a proxied image');

console.log('GDZ proxy migration regression passed');
