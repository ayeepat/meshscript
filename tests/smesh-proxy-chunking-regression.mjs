import assert from 'node:assert/strict';

const session = {};
globalThis.chrome = {
  storage: {
    local: {},
    session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (values) => { Object.assign(session, values); }
    }
  }
};

const { isUploadToken, splitChunks, uploadBlob } = await import('../src/lib/smesh-proxy.js');

assert.equal(
  isUploadToken('gB8G5SPfSHXyY0z_9SNDbYWhKS9xVYHso6IxNj3l4Uo'),
  true,
  'the client accepts the 32-byte base64url upload capability emitted by the VPS'
);
assert.equal(
  isUploadToken('5fa85f64-5717-4562-b3fc-2c963f66afa6'),
  false,
  'upload capabilities must not be confused with UUID blob/job identifiers'
);
assert.equal(isUploadToken('A'.repeat(42)), false, 'truncated upload capabilities are rejected');
assert.equal(isUploadToken('A'.repeat(42) + '='), false, 'padded upload capabilities are rejected');

const serializedBytes = (chunk) =>
  new TextEncoder().encode(JSON.stringify(chunk)).byteLength - 2;

const cyrillic = 'я'.repeat(20000);
const cyrillicChunks = splitChunks(cyrillic, 8192);
assert.ok(cyrillicChunks.length > 1);
assert.ok(
  cyrillicChunks.every((chunk) => chunk.length > 0 && serializedBytes(chunk) <= 8192),
  'every Cyrillic chunk must fit the serialized UTF-8 byte budget'
);
assert.equal(cyrillicChunks.join(''), cyrillic, 'byte splitting must preserve the original Cyrillic string');

const ascii = 'A'.repeat(8192 * 2 + 17);
const asciiChunks = splitChunks(ascii, 8192);
assert.deepEqual(
  asciiChunks.map((chunk) => chunk.length),
  [8192, 8192, 17],
  'ASCII/base64 payloads keep full byteBudget-character fast-path chunks'
);
assert.equal(asciiChunks.join(''), ascii, 'byte splitting must preserve the original ASCII string');

const escaped = ('😀"\\\n').repeat(4000);
const escapedChunks = splitChunks(escaped, 8192);
assert.ok(
  escapedChunks.every((chunk) => serializedBytes(chunk) <= 8192),
  'emoji and JSON escapes are measured from their exact serialized representation'
);
assert.equal(escapedChunks.join(''), escaped, 'surrogate/escape boundaries round-trip by concatenation');

const uploadCalls = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  uploadCalls.push(body);
  // Model the RU clamp: the full 128 KiB probe chunk never passes, but its
  // one-character tail does. Every 8 KiB safe-budget chunk succeeds.
  if (serializedBytes(body.chunk) > 8192) return new Response('', { status: 408 });
  return new Response('{}', { status: 200 });
};

const blobId = await uploadBlob('A'.repeat(131072 + 1), 'application/json', 'messages', {
  blobId: 'blob-chunking-regression',
  uploadToken: 'upload-token',
  dbg: () => {}
});
assert.equal(blobId, 'blob-chunking-regression');
assert.ok(
  uploadCalls.some((call) => call.total === 2 && call.seq === 1 && call.chunk === 'A'),
  'the short probe remainder succeeds in the constructed clamp scenario'
);
assert.ok(
  uploadCalls.filter((call) => call.total === 2).every((call) => call.generation === 0),
  'every probe request is explicitly bound to upload generation zero'
);
assert.ok(
  uploadCalls.some((call) => call.total > 2 && call.seq === 0),
  'a successful short remainder must not suppress re-chunking at the safe budget'
);
assert.ok(
  uploadCalls.filter((call) => call.total > 2).every((call) => call.generation === 1),
  'the safe-size retry advances the generation so delayed probe requests cannot overwrite it'
);
assert.ok(
  uploadCalls.filter((call) => call.total > 2).every((call) => serializedBytes(call.chunk) <= 8192),
  'fallback upload chunks all obey the safe serialized-byte budget'
);
assert.equal(session.smeshLearnedChunkChars, 8192, 'the legacy session key persists the learned safe byte budget');

console.log('smesh-proxy byte-chunking regressions passed');
