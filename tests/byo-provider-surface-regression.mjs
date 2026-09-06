/**
 * Release AI transport is gateway-only. Legacy UI markup may remain hidden for
 * a separate developer build, but release code cannot dispatch homework or
 * audio directly to vendor hosts and does not request their permissions.
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

assert.equal(providerUiShown, false, 'the release must not expose the legacy BYO surface');
assert.deepEqual(granted, [],
  'gateway-only release must not request direct AI-vendor host permissions');

const releaseTransport = [
  source('../src/lib/ai.js'),
  source('../src/lib/qwen.js'),
  source('../src/lib/deepseek.js'),
  source('../src/background/service-worker.js')
].join('\n');
assert.doesNotMatch(releaseTransport, /https:\/\/(?:openrouter\.ai|api\.groq\.com|dashscope-intl\.aliyuncs\.com)/,
  'active dispatcher and adapters must not contain direct vendor endpoints');
assert.doesNotMatch(source('../src/background/service-worker.js'), /transcribeAudioFiles\(/,
  'release solve flow must not send audio to a hidden BYO transcription path');
assert.doesNotMatch(source('../src/background/service-worker.js'), /chrome\.storage\.local\.get\(['"]groqApiKey['"]\)/,
  'a dormant vendor key must not bypass the deterministic missing-audio gate');
assert.match(source('../src/settings/settings.js'),
  /const KEY_FIELDS = SHOW_PROVIDER_UI \? \['openrouterApiKey', 'groqApiKey'\] : \[\];/,
  'hidden vendor secret fields must not be read or persisted in the release');

// Whatever the flag says, the licensed transport is not optional.
for (const host of ['https://ai.smeshapi.site/*', 'https://smeshapi.site/*']) {
  assert.ok(manifest.host_permissions.includes(host), `${host} must stay granted`);
}

// The listing must not promise a capability the shipped build cannot deliver.
// Transcription is BYO-Groq-only (src/lib/transcribe.js -> src/lib/groq.js
// getKey), so with the picker hidden an audio clip can never be transcribed.
if (!providerUiShown) {
  const listing = source('../docs/CHROME-WEB-STORE.md');
  const descriptionStart = listing.indexOf('Detailed description:');
  const descriptionEnd = listing.indexOf('## URLs', descriptionStart);
  assert.ok(descriptionStart >= 0 && descriptionEnd > descriptionStart,
    'the store listing description section must exist');
  const description = listing.slice(descriptionStart, descriptionEnd);
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
