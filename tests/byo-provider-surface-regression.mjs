/**
 * The bring-your-own-key provider surface and the manifest must agree.
 *
 * `SHOW_PROVIDER_UI = false` is what makes the direct-to-vendor adapters
 * unreachable, so the Chrome Web Store build drops their host permissions
 * rather than asking for access it can never use. The two facts are only safe
 * together: flipping the flag back without restoring the hosts would leave
 * every BYO request failing at fetch() with an opaque CORS error instead of the
 * adapter's own message — and it would do so silently, because nothing in the
 * product surfaces a missing host permission.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const manifest = JSON.parse(source('../manifest.json'));
const config = source('../src/lib/config.js');

const BYO_HOSTS = [
  'https://openrouter.ai/*',
  'https://api.groq.com/*',
  'https://dashscope-intl.aliyuncs.com/*',
];

const flag = /export const SHOW_PROVIDER_UI = (true|false);/.exec(config);
assert.ok(flag, 'SHOW_PROVIDER_UI must stay a plain boolean literal in config.js');
const providerUiShown = flag[1] === 'true';

const granted = BYO_HOSTS.filter((host) => manifest.host_permissions.includes(host));

if (providerUiShown) {
  assert.deepEqual(granted, BYO_HOSTS,
    'SHOW_PROVIDER_UI is on, so the BYO provider host permissions must be restored ' +
    'in manifest.json — otherwise every pasted key dead-ends on a CORS error');
} else {
  assert.deepEqual(granted, [],
    'no shipped UI path can reach a BYO provider while SHOW_PROVIDER_UI is off; ' +
    'an unreachable host permission is a Chrome Web Store review risk');
}

// Whatever the flag says, the licensed transport is not optional.
for (const host of ['https://ai.smeshapi.site/*', 'https://smeshapi.site/*']) {
  assert.ok(manifest.host_permissions.includes(host), `${host} must stay granted`);
}

// The listing must not promise a capability the shipped build cannot deliver.
// Transcription is BYO-Groq-only (src/lib/transcribe.js -> src/lib/groq.js
// getKey), so with the picker hidden an audio clip can never be transcribed.
if (!providerUiShown) {
  const listing = source('../docs/CHROME-WEB-STORE.md');
  const description = listing.slice(
    listing.indexOf('**Detailed description:**'),
    listing.indexOf('## Graphic assets'),
  );
  assert.ok(description, 'the store listing description section must exist');
  assert.doesNotMatch(description, /изображениями, PDF и аудио/,
    'the store description must not advertise audio solving while transcription needs a BYO key');

  // …and the prompt must not send the student after a file that cannot help.
  const router = source('../src/lib/subject-router.js');
  assert.doesNotMatch(router, /пришлите аудиофайл или расшифровку/,
    'the context guard must ask for a text transcript, not an audio file it cannot process');
  assert.match(router, /пришлите расшифровку/,
    'the context guard must still tell the student what to send instead');

  // The consent copy is a statement about what actually leaves the device.
  // Audio does not: the adapters replace an unreadable attachment with a text
  // note (deepseek.js fileToContentPart) and never upload the bytes.
  for (const page of ['../src/popup/popup.html', '../src/settings/settings.html']) {
    assert.doesNotMatch(source(page), /включая аудио для расшифровки/,
      `${page} must not disclose an audio transfer that cannot happen`);
  }
}

console.log('BYO provider surface regression passed');
