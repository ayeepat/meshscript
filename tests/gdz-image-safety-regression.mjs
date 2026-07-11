import assert from 'node:assert/strict';

globalThis.chrome = {
  runtime: { id: 'abcdefghijklmnopabcdefghijklmnop' },
  declarativeNetRequest: { async updateSessionRules() {} },
  storage: { local: { async get() { return {}; }, async set() {} } }
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

const { fetchTaskImage, GDZ_IMAGE_MAX_PIXELS } = await import('../src/lib/gdz-api.js');
const { imageDimensions } = await import('../src/lib/image-compress.js');

assert.deepEqual(imageDimensions(validPng), { w: 1, h: 1 }, 'complete PNG control must parse');

globalThis.fetch = async () => imageResponse(validPng, 'https://img.gdz-ru.com/answer.png');
const safe = await fetchTaskImage('https://gdz-ru.com/answer.png');
assert.equal(safe.mimeType, 'image/png');

globalThis.fetch = async () => imageResponse(validPng, 'https://evil.example/answer.png');
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/answer.png'),
  /redirect left allowlist/
);

const tooWide = Math.floor(GDZ_IMAGE_MAX_PIXELS / 1000) + 1;
globalThis.fetch = async () => imageResponse(pngHeader(tooWide, 1000), 'https://img.gdz-ru.com/bomb.png');
await assert.rejects(
  fetchTaskImage('https://gdz-ru.com/bomb.png'),
  /unsafe dimensions/
);

console.log('GDZ image safety regressions passed');
