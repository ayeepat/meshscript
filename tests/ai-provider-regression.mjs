import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = {};

function pick(keys) {
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.map((k) => [k, store[k]]));
  }
  if (typeof keys === 'string') return { [keys]: store[keys] };
  if (keys && typeof keys === 'object') {
    return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, store[k] ?? v]));
  }
  return { ...store };
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) { return pick(keys); },
      async set(data) { Object.assign(store, data); },
      async remove(keys) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      }
    }
  }
};

const { askAI, normalizeAIProvider } = await import('../src/lib/ai.js');

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function assertContains(path, needle) {
  const text = source(path);
  assert.ok(text.includes(needle), `${path} should include: ${needle}`);
}

async function expectQwenPath(label, fn) {
  try {
    await fn();
    assert.fail(`${label}: expected the proxy/license path to reject without a license`);
  } catch (e) {
    const msg = String(e?.message || e);
    assert.equal(
      msg.includes('OpenRouter'),
      false,
      `${label}: routed to OpenRouter instead of Qwen: ${msg}`
    );
    assert.match(msg, /Qwen|DeepSeek|СМЭШ|лиценз/i);
  }
}

store.aiProvider = 'qwen';
delete store.openrouterApiKey;
delete store.licenseStatus;
await expectQwenPath('stored qwen provider', () =>
  askAI('system', 'user', [], [], { responseFormat: 'json_object' })
);

store.aiProvider = 'openrouter';
delete store.openrouterApiKey;
delete store.licenseStatus;
await expectQwenPath('explicit qwen provider override', () =>
  askAI('system', 'user', [], [], { provider: 'qwen', responseFormat: 'json_object' })
);

assert.equal(normalizeAIProvider('qwen'), 'qwen');
assert.equal(normalizeAIProvider('deepseek'), 'deepseek');
assert.equal(normalizeAIProvider('nararouter'), 'openrouter');
assert.equal(normalizeAIProvider('nararouter', null), null);

assertContains('../src/popup/popup.js', "const provider = PROVIDER_ABBR[aiProvider] ? aiProvider : undefined;");
assertContains('../src/popup/popup.js', "payload: { text: pageText, screenshot, tabId, provider }");

assertContains('../src/content/test-pill.js', "let providerId = 'openrouter';");
assertContains('../src/content/test-pill.js', "payload: { provider: providerId }");

assertContains('../src/background/service-worker.js', 'async function solveTest({ text, screenshot, provider } = {})');
assertContains('../src/background/service-worker.js', 'const providerOverride = normalizeAIProvider(provider, null);');
assertContains('../src/background/service-worker.js', 'if (providerOverride) askOpts.provider = providerOverride;');

console.log('ai-provider regression passed');
