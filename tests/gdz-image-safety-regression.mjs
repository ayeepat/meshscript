import assert from 'node:assert/strict';

/**
 * The extension's half of the GDZ safety story.
 *
 * Transport-level checks (host allowlist, redirect re-validation) moved to the
 * Worker with the fetch itself and are covered by gdz-proxy-regression.mjs.
 * What stays HERE is everything the client must still enforce on bytes it did
 * not fetch: image dimensions, the answer-image fanout cap, and the bounds on a
 * third-party book structure.
 */
const storage = {};
globalThis.chrome = {
  runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
  storage: { local: {
    async get(keys) {
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      return { [keys]: storage[keys] };
    },
    async set(entries) { Object.assign(storage, entries); }
  } }
};

// Minimal IHDR-shaped fixture for adversarial dimensions. The production guard
// intentionally rejects from container metadata before any decoder sees IDAT.
const pngHeader = (w, h) => {
  const bytes = new Uint8Array(32);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0x89504e47);
  dv.setUint32(4, 0x0d0a1a0a);
  dv.setUint32(8, 13);
  dv.setUint32(12, 0x49484452);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  return bytes;
};

// A complete, decodable 1x1 PNG verifies that the legitimate control is not
// merely another synthetic header accepted by the parser.
const validPng = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
));

const { installGdzProxyStub, proxyImage } = await import('./helpers/gdz-proxy-stub.mjs');

// Each case below swaps in its own upstream fixture; the stub itself (and the
// license credential it seeds) is installed once.
let upstream = () => { throw new Error('no upstream fixture installed'); };
installGdzProxyStub({ store: storage, upstream: (kind, url) => upstream(kind, url) });

const {
  fetchTaskImage, fetchCoverImage, listTasks, resolveTask, GDZ_IMAGE_MAX_PIXELS, MAX_ANSWER_IMAGES,
  GDZ_MAX_TASKS
} = await import('../src/lib/gdz-api.js');
const { imageDimensions, MAX_DECODE_PIXELS, MAX_DECODE_SIDE } = await import('../src/lib/image-compress.js');
assert.ok(MAX_DECODE_PIXELS <= 16_000_000,
  'one decoded image must stay within the service-worker memory budget');
assert.ok(MAX_DECODE_SIDE <= 8_192, 'extreme single-axis images must be rejected before decode');

assert.deepEqual(imageDimensions(validPng), { w: 1, h: 1 }, 'complete PNG control must parse');

upstream = () => proxyImage(validPng);
const safe = await fetchTaskImage('https://gdz-ru.com/answer.png');
assert.equal(safe.mimeType, 'image/png');

// A foreign host is refused before the request is even made — the client checks
// its own argument rather than relying on the proxy to have refused it.
await assert.rejects(
  fetchTaskImage('https://evil.example/answer.png'),
  /bad host/,
  'the client must fail closed on a non-GDZ image URL without calling the proxy'
);

// The proxy is ours, but its answer is still remote input. A content type the
// client cannot safely decode is rejected no matter what the proxy claimed.
upstream = () => ({ image: { mimeType: 'text/html', dataBase64: 'PGh0bWw+' } });
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/answer.png'),
  /unsupported content type/,
  'a non-image content type must be rejected even when the proxy returned ok'
);

upstream = () => ({ image: { mimeType: 'image/png', dataBase64: '' } });
await assert.rejects(fetchTaskImage('https://gdz-ru.com/answer.png'), /empty body/);

// The decompression-bomb gate stays client-side: this process is the one that
// decodes the image and hands it to a model, so it measures the container
// itself instead of trusting the fetcher.
const tooWide = Math.floor(GDZ_IMAGE_MAX_PIXELS / 1000) + 1;
upstream = () => proxyImage(pngHeader(tooWide, 1000));
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/bomb.png'),
  /unsafe dimensions/
);

// Covers are decoded by the Settings page rather than sent to the model, but
// that still makes the extension process their pixels. The new cover proxy
// path must apply the same local container/size gate as answer images.
upstream = () => proxyImage(pngHeader(tooWide, 1000));
assert.equal(
  await fetchCoverImage('https://gdz-ru.com/bomb-cover.png'),
  null,
  'an oversized cover must remain a placeholder instead of reaching <img>'
);

const bookUrl = 'https://gdz-ru.com/test-book';
const taskUrl = 'https://gdz-ru.com/test-task';
const upstreamImages = Array.from({ length: 50 }, (_, i) => ({
  url: `https://img.gdz-ru.com/answer-${i}.png`
}));
upstream = (kind, url) => {
  if (url === bookUrl) {
    return { data: { structure: [{ title: 'Упражнения', tasks: [{ title: '1', url: taskUrl }] }] } };
  }
  if (url === taskUrl) return { data: { editions: [{ images: upstreamImages }] } };
  throw new Error('unavailable');
};
const resolved = await resolveTask(bookUrl, '1');
assert.ok(resolved);
assert.equal(resolved.images.length, MAX_ANSWER_IMAGES,
  'third-party task payloads must be capped before image fetch fanout');

const deepBookUrl = 'https://gdz-ru.com/deep-book';
const deepTaskUrl = 'https://gdz-ru.com/deep-task';
const depth = 5000;
const deeplyNested = '{"structure":[' +
  '{"title":"deep","topics":['.repeat(depth) +
  `{"tasks":[{"title":"1","url":"${deepTaskUrl}"}]}` +
  ']}'.repeat(depth) +
  ']}';
upstream = (kind, url) => {
  // rawData, not data: the fixture is too deep for JSON.stringify to re-encode.
  if (url === deepBookUrl) return { rawData: deeplyNested };
  throw new Error('not found');
};
assert.equal((await listTasks(deepBookUrl)).length, 1,
  'deep third-party topic trees must be traversed iteratively without stack overflow');

const hugeBookUrl = 'https://gdz-ru.com/huge-book';
const hugeTasks = Array.from({ length: GDZ_MAX_TASKS + 1 }, (_, i) => ({
  title: String(i + 1),
  url: `https://gdz-ru.com/task-${i + 1}`,
}));
upstream = (kind, url) => {
  if (url === hugeBookUrl) return { data: { structure: [{ title: 'huge', tasks: hugeTasks }] } };
  throw new Error('not found');
};
await assert.rejects(listTasks(hugeBookUrl), /слишком много заданий/,
  'a third-party book must not create an unbounded task list/cache');

console.log('GDZ image safety regressions passed');
