/**
 * smesh-proxy learned-chunk persistence is BEST-EFFORT — a rejected
 * chrome.storage.session.set() must never throw out of the caller nor surface
 * as an unhandledRejection (MV3 storage can reject on quota / teardown), and
 * the in-memory learned size must apply regardless of whether the write lands.
 *
 * Runs the real rememberLearnedChunkChars() source (extracted, so a future
 * edit that drops the `.catch` is caught) against a mock chrome whose write
 * rejects, and against one whose storage.session is missing entirely.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/lib/smesh-proxy.js', import.meta.url), 'utf8');
const fn = src.match(/function rememberLearnedChunkChars\(size\) \{[\s\S]*?\n\}/);
assert.ok(fn, 'rememberLearnedChunkChars source not found — did the function move/rename?');

let unhandled = null;
process.on('unhandledRejection', (e) => { unhandled = e; });

const context = {
  LEARNED_CHUNK_KEY: 'smeshLearnedChunkChars',
  learnedChunkChars: null,
  chrome: { storage: { session: { set: () => Promise.reject(new Error('quota exceeded')) } } }
};
vm.createContext(context);

// 1) async rejection — the write returns a rejected promise.
vm.runInContext(`${fn[0]}\nrememberLearnedChunkChars(8192);`, context);
assert.equal(context.learnedChunkChars, 8192, 'in-memory value applies even when the write rejects');

// 2) synchronous throw — storage.session missing entirely.
context.chrome = { storage: {} };
vm.runInContext('rememberLearnedChunkChars(131072);', context);
assert.equal(context.learnedChunkChars, 131072, 'in-memory value applies even when storage.session is absent');

// Give any (mis)handled rejection a tick to surface before asserting none did.
await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(unhandled, null, 'a rejected best-effort write must not surface as an unhandledRejection');

console.log('smesh-proxy session persistence regression passed');
