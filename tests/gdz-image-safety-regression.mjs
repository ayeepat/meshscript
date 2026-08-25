import assert from 'node:assert/strict';

const storage = {};
globalThis.chrome = {
  runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
  declarativeNetRequest: { async updateSessionRules() {} },
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

function imageResponse(bytes, url) {
  const response = new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) }
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

const {
  fetchTaskImage, listTasks, resolveTask, GDZ_IMAGE_MAX_PIXELS, MAX_ANSWER_IMAGES,
  GDZ_MAX_TASKS
} = await import('../src/lib/gdz-api.js');
const { imageDimensions, MAX_DECODE_PIXELS, MAX_DECODE_SIDE } = await import('../src/lib/image-compress.js');
assert.ok(MAX_DECODE_PIXELS <= 16_000_000,
  'one decoded image must stay within the service-worker memory budget');
assert.ok(MAX_DECODE_SIDE <= 8_192, 'extreme single-axis images must be rejected before decode');

assert.deepEqual(imageDimensions(validPng), { w: 1, h: 1 }, 'complete PNG control must parse');

globalThis.fetch = async () => imageResponse(validPng, 'https://img.gdz-ru.com/answer.png');
const safe = await fetchTaskImage('https://gdz-ru.com/answer.png');
assert.equal(safe.mimeType, 'image/png');

globalThis.fetch = async () => imageResponse(validPng, 'https://evil.example/answer.png');
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/answer.png'),
  /allowlist/
);

let redirectCalls = 0;
globalThis.fetch = async () => {
  redirectCalls += 1;
  return new Response(null, {
    status: 302,
    headers: { location: 'http://127.0.0.1:8080/internal' }
  });
};
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/open-redirect'),
  /Redirect left allowlist/,
  'an upstream redirect must be rejected before the extension fetches a LAN target'
);
assert.equal(redirectCalls, 1, 'the blocked redirect target must receive no request');

const tooWide = Math.floor(GDZ_IMAGE_MAX_PIXELS / 1000) + 1;
globalThis.fetch = async () => imageResponse(pngHeader(tooWide, 1000), 'https://img.gdz-ru.com/bomb.png');
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/bomb.png'),
  /unsafe dimensions/
);

const bookUrl = 'https://gdz-ru.com/test-book';
const taskUrl = 'https://gdz-ru.com/test-task';
const upstreamImages = Array.from({ length: 50 }, (_, i) => ({
  url: `https://img.gdz-ru.com/answer-${i}.png`
}));
globalThis.fetch = async (url) => {
  if (url === bookUrl) {
    return new Response(JSON.stringify({
      structure: [{ title: 'Упражнения', tasks: [{ title: '1', url: taskUrl }] }]
    }), { status: 200 });
  }
  if (url === taskUrl) {
    return new Response(JSON.stringify({ editions: [{ images: upstreamImages }] }), { status: 200 });
  }
  return new Response('', { status: 503 });
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
globalThis.fetch = async (url) => {
  if (url === deepBookUrl) return new Response(deeplyNested, { status: 200 });
  return new Response('', { status: 404 });
};
assert.equal((await listTasks(deepBookUrl)).length, 1,
  'deep third-party topic trees must be traversed iteratively without stack overflow');

const hugeBookUrl = 'https://gdz-ru.com/huge-book';
const hugeTasks = Array.from({ length: GDZ_MAX_TASKS + 1 }, (_, i) => ({
  title: String(i + 1),
  url: `https://gdz-ru.com/task-${i + 1}`,
}));
globalThis.fetch = async (url) => {
  if (url === hugeBookUrl) {
    return new Response(JSON.stringify({ structure: [{ title: 'huge', tasks: hugeTasks }] }), { status: 200 });
  }
  return new Response('', { status: 404 });
};
await assert.rejects(listTasks(hugeBookUrl), /слишком много заданий/,
  'a third-party book must not create an unbounded task list/cache');

console.log('GDZ image safety regressions passed');
