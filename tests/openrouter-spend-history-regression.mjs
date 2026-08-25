import assert from 'node:assert/strict';

const store = {
  openrouterApiKey: 'sk-current-account-secret',
  rateLimits: { openrouter: 20 },
  rateUsage: {},
  rateAttempts: {},
  rateHistory: {},
  rateReservations: {}
};

function readKeys(keys) {
  if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store[key]]));
  if (typeof keys === 'string') return { [keys]: store[keys] };
  return { ...store };
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { return readKeys(keys); },
      async set(values) { Object.assign(store, values); },
      async remove(keys) {
        for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key];
      }
    }
  }
};

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const CREDITS_URL = 'https://openrouter.ai/api/v1/credits';
const COST = 0.0123;
const SSE =
  'data: {"model":"google/gemini-2.5-flash","choices":[{"delta":{"content":"готово"}}]}\n\n' +
  `data: {"model":"google/gemini-2.5-flash","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":${COST}}}\n\n` +
  'data: [DONE]\n\n';

let resolveCredits = null;
globalThis.fetch = async (url) => {
  if (url === CHAT_URL) {
    return new Response(SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (url === CREDITS_URL) {
    return new Promise((resolve) => { resolveCredits = resolve; });
  }
  throw new Error(`unexpected URL: ${url}`);
};

const { askOpenRouter, fetchOpenRouterCredits, getSpendHistory } =
  await import('../src/lib/openrouter.js');

// Exact cost comes from a clean stream's terminal usage frame. Concurrent
// completions must serialize their read-modify-write rather than lose a charge.
const answers = await Promise.all([
  askOpenRouter('system', 'first'),
  askOpenRouter('system', 'second')
]);
assert.deepEqual(answers, ['готово', 'готово']);
let history = await getSpendHistory();
assert.ok(Math.abs(history.at(-1).spend - COST * 2) < 1e-12,
  'completed-call usage.cost values must accumulate exactly for the current account/day');
assert.equal(JSON.stringify(store.orUsageSnap).includes(store.openrouterApiKey), false,
  'the raw OpenRouter key must never be persisted beside spend history');

// Start a credits read under account A, switch back to current account B while
// it is in flight, then deliver A's result. It must neither be returned as a
// valid current balance nor alter B's exact/account-scoped history.
const currentKey = store.openrouterApiKey;
store.openrouterApiKey = 'sk-old-request-account';
const delayedCredits = fetchOpenRouterCredits();
for (let i = 0; i < 20 && !resolveCredits; i++) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
assert.equal(typeof resolveCredits, 'function', 'credits request must be in flight');
store.openrouterApiKey = currentKey;
const beforeDelayedResult = structuredClone(store.orUsageSnap);
resolveCredits(new Response(JSON.stringify({
  data: { total_credits: 100, total_usage: 25 }
}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
const stale = await delayedCredits;
assert.deepEqual(stale, { ok: false, reason: 'stale_key' });
assert.deepEqual(store.orUsageSnap, beforeDelayedResult,
  'an old-key credits response must not overwrite current-account spend data');

// Reads fail closed when the current key does not own the stored account, and
// also when no key exists. Switching back restores only that account's bars.
store.openrouterApiKey = 'sk-different-account';
history = await getSpendHistory();
assert.ok(history.every((row) => row.spend === 0),
  'a different current key must not see the prior account history');
delete store.openrouterApiKey;
history = await getSpendHistory();
assert.ok(history.every((row) => row.spend === 0),
  'history must fail closed when the current key is missing');
store.openrouterApiKey = currentKey;
history = await getSpendHistory();
assert.ok(Math.abs(history.at(-1).spend - COST * 2) < 1e-12,
  'switching back may recover only the matching fingerprint-scoped account');

// A key switch during the asynchronous fingerprint/read path must also fail
// closed rather than returning the account that was current only at entry.
const stableGet = chrome.storage.local.get;
chrome.storage.local.get = async (keys) => {
  const result = readKeys(keys);
  if (Array.isArray(keys) && keys.includes('orUsageSnap')) {
    store.openrouterApiKey = 'sk-switched-during-history-read';
  }
  return result;
};
history = await getSpendHistory();
assert.ok(history.every((row) => row.spend === 0),
  'history must recheck the current key before returning rows');
chrome.storage.local.get = stableGet;
store.openrouterApiKey = currentKey;

// Legacy cumulative snapshots are visit observations, not defensible daily
// costs. Preserve/migrate them internally, but never fabricate daily bars.
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(currentKey));
const currentKeyId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
  .join('').slice(0, 16);
const today = history.at(-1).day;
store.orUsageSnap = { keyId: currentKeyId, days: { [today]: 999 } };
history = await getSpendHistory();
assert.ok(history.every((row) => row.spend === 0),
  'a lifetime cumulative reading must not be presented as observed per-day spend');

console.log('OpenRouter account-bound exact spend history regressions passed');
