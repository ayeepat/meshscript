import assert from 'node:assert/strict';

const records = new Map([
  ['aiProvider', 'openrouter'],
  ['openrouterApiKey', 'test-key'],
  ['groqApiKey', 'test-key'],
  ['aiConsent', { accepted: true, version: 2, at: new Date().toISOString() }],
]);
const changeListeners = new Set();
let consentBarrier = null;
let consentReadStarted = null;

function pick(keys) {
  if (keys == null) return Object.fromEntries(records);
  if (typeof keys === 'string') return { [keys]: records.get(keys) };
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((key) => [key, records.get(key)]));
  }
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
    key, records.has(key) ? records.get(key) : fallback,
  ]));
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === 'aiConsent' && consentBarrier) {
          consentReadStarted?.();
          await consentBarrier;
        }
        return pick(keys);
      },
      async set(entries) {
        const changes = {};
        for (const [key, newValue] of Object.entries(entries)) {
          changes[key] = { oldValue: records.get(key), newValue };
          records.set(key, newValue);
        }
        for (const listener of changeListeners) listener(changes, 'local');
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key);
      },
    },
    onChanged: {
      addListener(listener) { changeListeners.add(listener); },
    },
  },
};

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ text: 'must not be reached' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const { askAI } = await import('../src/lib/ai.js');
const { transcribeAudio } = await import('../src/lib/groq.js');
const { CONSENT_REQUIRED_MESSAGE, setConsent } = await import('../src/lib/consent.js');

function pauseNextConsentRead() {
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  consentBarrier = new Promise((resolve) => { release = resolve; });
  consentReadStarted = started;
  return {
    started: startedPromise,
    release() {
      const done = release;
      consentBarrier = null;
      consentReadStarted = null;
      done();
    },
  };
}

// askAI has already selected a provider when it reaches this barrier. Consent
// withdrawal must win before the provider dispatcher can call fetch.
{
  await setConsent(true);
  const barrier = pauseNextConsentRead();
  const pending = askAI('system', 'private assignment text');
  await barrier.started;
  await setConsent(false);
  barrier.release();
  await assert.rejects(pending, new RegExp(CONSENT_REQUIRED_MESSAGE.slice(0, 24)));
  assert.equal(fetchCalls, 0, 'no model request may start after consent withdrawal');
}

// Whisper performs key/quota/form preparation before its final check. Revoke
// in that exact window and prove the multipart upload never starts either.
{
  await setConsent(true);
  const barrier = pauseNextConsentRead();
  const pending = transcribeAudio({
    name: 'listening.mp3',
    mimeType: 'audio/mpeg',
    dataBase64: Buffer.from('not-real-audio').toString('base64'),
  });
  await barrier.started;
  await setConsent(false);
  barrier.release();
  await assert.rejects(pending, new RegExp(CONSENT_REQUIRED_MESSAGE.slice(0, 24)));
  assert.equal(fetchCalls, 0, 'no transcription request may start after consent withdrawal');
}

console.log('consent network-boundary regressions passed');
