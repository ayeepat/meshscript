import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bytes = (path) => readFileSync(new URL(path, import.meta.url));
const text = (path) => bytes(path).toString('utf8');

function pngDimensions(path) {
  const data = bytes(path);
  assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG', `${path} must be PNG`);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

const manifest = JSON.parse(text('../manifest.json'));
assert.ok(manifest.description.length <= 132,
  'Chrome rejects manifest descriptions longer than 132 characters');
assert.deepEqual(pngDimensions('../assets/icons/icon128.png'), [128, 128]);

for (const name of [
  '01-homework-popup.png',
  '02-test-answers.png',
  '03-pdf-solution.png',
  '04-gdz-solution.png',
]) {
  assert.deepEqual(
    pngDimensions(`../store-assets/screenshots/${name}`),
    [1280, 800],
    `${name} must match the Chrome Web Store screenshot size`,
  );
}
assert.deepEqual(pngDimensions('../store-assets/promo/small-tile-440x280.png'), [440, 280]);
assert.deepEqual(pngDimensions('../store-assets/promo/marquee-1400x560.png'), [1400, 560]);

const listing = text('../docs/CHROME-WEB-STORE.md');
for (const required of [
  'Single purpose',
  'Permission justifications',
  'Data-use disclosures',
  'Reviewer instructions',
  'Final publisher checklist',
  'https://smeshai.xyz/privacy',
]) {
  assert.ok(listing.includes(required), `store submission guide is missing ${required}`);
}
assert.doesNotMatch(listing, /10,000\+|five[- ]star|5-star|лучшее расширение/i,
  'store materials must not ship fabricated scale, ratings, or superlatives');

const packageSource = text('../scripts/extension-package.mjs');
assert.match(packageSource, /smesh-ai-chrome-v\$\{manifest\.version\}\.zip/);
assert.doesNotMatch(packageSource, /smesh-ai-yandex/);

// The release workflow uploads the archive by glob with `if-no-files-found:
// error`. Renaming the archive without renaming the glob does not fail loudly
// at the packaging step — it fails at the very last step of every CI run, after
// the whole suite has already gone green.
const workflow = text('../.github/workflows/regressions.yml');
const uploadPath = /^\s+path:\s*(\S+)\s*$/m.exec(workflow);
assert.ok(uploadPath, 'the release workflow must upload the built archive by path');
const [prefix] = /^smesh-ai-[a-z]+-v/.exec(uploadPath[1]) || [];
assert.ok(prefix, `unrecognised archive glob in the workflow: ${uploadPath[1]}`);
assert.ok(packageSource.includes(prefix),
  `the workflow uploads "${uploadPath[1]}" but extension-package.mjs writes a ` +
  'different archive name — CI would fail with if-no-files-found: error');

console.log('Chrome Web Store listing and asset readiness regression passed');
