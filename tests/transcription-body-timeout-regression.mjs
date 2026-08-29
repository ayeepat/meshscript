import assert from 'node:assert/strict';

const store = {
  groqApiKey: 'gsk_test_key',
  aiConsent: { accepted: true, version: 3, at: new Date().toISOString() }
};
const readStore = (keys) => {
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
  if (typeof keys === 'string') return { [keys]: store[keys] };
  return { ...store };
};

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { return readStore(keys); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      }
    }
  }
};

const { transcribeAudio } = await import('../src/lib/groq.js');

let bodyAbortObserved = false;
globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
  start(controller) {
    init.signal.addEventListener('abort', () => {
      bodyAbortObserved = true;
      controller.error(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

// Keep the production 90-second constant intact while making this constructed
// stalled-body case complete quickly in the regression process.
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) =>
  nativeSetTimeout(callback, delay === 90_000 ? 5 : delay, ...args);
try {
  await assert.rejects(
    transcribeAudio({ name: 'listening.mp3', mimeType: 'audio/mpeg', dataBase64: 'AA==' }),
    /превышено время ожидания/,
    'HTTP 200 headers followed by a stalled transcription body must be a timeout, not empty success'
  );
} finally {
  globalThis.setTimeout = nativeSetTimeout;
}

assert.equal(bodyAbortObserved, true, 'the body stream must be aborted at its deadline');
assert.equal(store.rateUsage?.groq?.count || 0, 0,
  'a timed-out transcription must not consume successful-use quota');
assert.equal(Object.keys(store.rateReservations || {}).length, 0,
  'the failed transcription reservation must be released');

console.log('transcription body-timeout regression passed');
