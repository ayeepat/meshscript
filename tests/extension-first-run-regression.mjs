import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const worker = source('../src/background/service-worker.js');

function sourceSection(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section missing: ${startMarker}`);
  return text.slice(start, end);
}

const installSource = sourceSection(
  worker,
  "const WELCOME_PAGE = 'src/welcome/welcome.html';",
  '// Remove provider secrets from legacy builds.'
);

// One shared claim stands in for lib/onboarding.js: granted once, refused for
// the rest of the device's life. tests/onboarding-tour-regression.mjs exercises
// the real implementation; here it only has to be the same shape.
let claims = 0;
const opened = [];
const tracked = [];
let migrations = 0;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const context = {
  track: (event, data) => tracked.push({ event, data }),
  migrateNararouter: async () => { migrations += 1; },
  claimTour: async (source) => (claims++ === 0 ? { source } : null),
  releaseTourClaim: async () => { claims = 0; return true; },
  chrome: {
    runtime: {
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      onInstalled: { addListener(listener) { context.listener = listener; } },
    },
    tabs: {
      create(details) {
        opened.push(details);
        return Promise.resolve();
      },
    },
  },
};

vm.runInNewContext(installSource, context, { filename: 'extension-first-run.js' });
assert.equal(typeof context.listener, 'function');

context.listener({ reason: 'install' });
await settle();
assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{
  url: 'chrome-extension://extension-id/src/welcome/welcome.html',
}], 'a fresh install must open the packaged Russian onboarding tour exactly once');
assert.deepEqual(tracked.map(({ event }) => event), ['install']);

// Updates carry the one-time backfill for students who installed before the
// tour existed, so the update branch must ASK. The claim — not this branch — is
// what makes it happen at most once, which is why the second update below opens
// nothing even though it asks again.
context.listener({ reason: 'update', previousVersion: '0.5.2' });
await settle();
assert.equal(opened.length, 1,
  'a device that already holds an onboarding record must never be interrupted again');
assert.deepEqual(tracked.map(({ event }) => event), ['install', 'update']);
assert.equal(migrations, 1);

context.listener({ reason: 'update', previousVersion: '1.0.0' });
await settle();
assert.equal(opened.length, 1, 'every later update must stay silent');

const welcome = source('../src/welcome/welcome.html');
assert.match(welcome, /<html lang="ru">/);
assert.match(welcome, /Привет! Я СМЭШ AI\./);
assert.match(welcome, /href="https:\/\/smeshai\.xyz\/"/);
assert.match(welcome, /Без него текст заданий, скриншоты и файлы никуда не отправляются/);
assert.doesNotMatch(welcome, /<script(?![^>]*src=)/,
  'the welcome page must not contain inline script blocked by the extension CSP');

const manifest = JSON.parse(source('../manifest.json'));
assert.equal(manifest.version, '1.0.0');
assert.equal(manifest.homepage_url, 'https://smeshai.xyz/');
assert.ok(manifest.host_permissions.includes('https://smeshai.xyz/*'));
assert.ok(!manifest.host_permissions.includes('https://*.smeshai.xyz/*'),
  'runtime config access must not request every brand-domain subdomain');

// Every in-product link must point at the apex too. `www.` 301s there, so a
// `www.` href costs the student an extra hop and splits the brand across two
// origins for no benefit. remote-config.js is exempt: its NOTICE_ORIGINS set is
// an accept-list for signed config, where tolerating both spellings is correct.
for (const page of ['../src/popup/popup.html', '../src/settings/settings.html',
  '../src/welcome/welcome.html', '../src/popup/popup.js', '../src/settings/settings.js']) {
  assert.doesNotMatch(source(page), /www\.smeshai\.xyz/,
    `${page} must link to the apex brand host, not the redirecting www. host`);
}

// The greeting is the first and often only place a student is told this is not
// an official product of whatever diary they are using. Losing it silently is
// exactly the kind of omission a store reviewer treats as an affiliation claim,
// and it is the whole reason the product may describe compatibility at all.
// The wording deliberately names no journal by trademark any more; what it must
// never lose is the independence statement itself.
const DISCLAIMER = /Независимый сервис\. Не связан ни с одним электронным журналом\./;
assert.match(welcome, DISCLAIMER, 'the welcome tour must disclaim affiliation');
assert.match(source('../src/popup/popup.html'), DISCLAIMER,
  'the popup footer must disclaim affiliation');

// The trademark was scrubbed from every surface a user or reviewer reads. A
// re-introduction is a business decision, not a copy tweak, so it fails here.
for (const page of ['../src/popup/popup.html', '../src/popup/popup.js',
  '../src/welcome/welcome.html', '../src/welcome/welcome.js',
  '../src/settings/settings.html', '../manifest.json']) {
  const text = source(page).replace(/^\s*(\/\/|\*|<!--).*$/gm, '');
  assert.doesNotMatch(text, /(?<!С)МЭШ/,
    `${page} must describe the diary generically, not by trademark`);
}

console.log('extension first-run and launch metadata regression passed');
