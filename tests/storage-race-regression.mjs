import assert from 'node:assert/strict';

const store = {};
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
let failNextSet = false;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        await pause();
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
        if (typeof keys === 'string') return { [keys]: store[keys] };
        return { ...store };
      },
      async set(data) {
        await pause();
        if (failNextSet) { failNextSet = false; throw new Error('simulated storage failure'); }
        Object.assign(store, data);
      }
    }
  }
};

const { reserveOne, commitOne, cancelOne, getUsage } = await import('../src/lib/rate-limit.js');
const { createSession, addMessage, listMessages, getHistorySnapshot } = await import('../src/lib/history.js');
const { assertUploadAllowed, MAX_STANDARD_UPLOAD_BYTES, MAX_AUDIO_UPLOAD_BYTES } = await import('../src/lib/upload-limits.js');

const reservations = await Promise.all(Array.from({ length: 8 }, () => reserveOne('openrouter')));
assert.equal((await getUsage()).openrouter.used, 0, 'reservations must not count as successful usage');
await Promise.all(reservations.map(commitOne));
assert.equal((await getUsage()).openrouter.used, 8, 'parallel charges must all persist');

const failed = await reserveOne('openrouter');
await cancelOne(failed);
assert.equal((await getUsage()).openrouter.used, 8, 'cancelled calls must never become usage');

const orphanedFailure = await reserveOne('openrouter');
failNextSet = true;
await assert.rejects(cancelOne(orphanedFailure), /simulated storage failure/);
assert.equal((await getUsage()).openrouter.used, 8,
  'a cleanup storage failure may leave a reservation, but must not leave a charge');

const [first, second] = await Promise.all([
  createSession('Алгебра', 'A'),
  createSession('Физика', 'B')
]);
assert.equal(store.meshHistory.sessions.length, 2, 'parallel sessions must not overwrite each other');

await Promise.all([
  addMessage(first.id, 'user', 'one'),
  addMessage(first.id, 'assistant', 'two'),
  addMessage(second.id, 'user', 'three')
]);
assert.equal((await listMessages(first.id)).length, 2, 'parallel messages must not overwrite each other');
const snapshot = await getHistorySnapshot();
assert.equal(snapshot.sessions.length, 2, 'history dashboard snapshot must include every saved chat');
assert.equal(snapshot.messages[first.id].length, 2, 'history dashboard snapshot must include saved messages');

assert.doesNotThrow(() => assertUploadAllowed({ name: 'sheet.pdf', type: 'application/pdf', size: MAX_STANDARD_UPLOAD_BYTES }));
assert.throws(() => assertUploadAllowed({ name: 'sheet.pdf', type: 'application/pdf', size: MAX_STANDARD_UPLOAD_BYTES + 1 }));
assert.doesNotThrow(() => assertUploadAllowed({ name: 'listening.mp3', type: 'audio/mpeg', size: MAX_AUDIO_UPLOAD_BYTES }));

console.log('storage race regression passed');
