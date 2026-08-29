import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: undefined };
        return {};
      }
    }
  }
};

const { routeVisionPreferredProvider } = await import('../src/lib/ai.js');
assert.equal(routeVisionPreferredProvider('deepseek', true), 'deepseek',
  'licensed Auto images must stay on the multimodal live route');
assert.equal(routeVisionPreferredProvider('deepseek', true, true), 'qwen',
  'only hidden BYO DeepSeek images may upgrade to BYO Qwen');

const autoWrapper = readFileSync(new URL('../src/lib/deepseek.js', import.meta.url), 'utf8');
assert.match(autoWrapper, /if \(allowImages && isImageFile\(f\)\)/,
  'the licensed Auto wrapper must serialize image attachments');
assert.match(autoWrapper, /type: 'image_url'/);
assert.match(autoWrapper, /allowImages: !key/,
  'direct BYO DeepSeek must remain text-only');

const worker = readFileSync(new URL('../src/background/service-worker.js', import.meta.url), 'utf8');
const effortStart = worker.indexOf('const askOpts =');
const effortEnd = worker.indexOf('const answer = await askAI', effortStart);
assert.ok(effortStart >= 0 && effortEnd > effortStart, 'Auto effort policy section missing');
const effortPolicy = worker.slice(effortStart, effortEnd);
assert.doesNotMatch(effortPolicy, /lowEffortReason\s*=\s*['"]engine_auto['"]/,
  'new extension builds must not force the owner-controlled Auto route to low effort');

console.log('Auto route model regression passed');
