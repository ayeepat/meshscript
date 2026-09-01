import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

const FORBIDDEN_PLATFORM_COPY = /school\.mos\.ru|uchebnik\.mos\.ru|(?<![Сс])МЭШ|(?<![Ss])Mesh/iu;

async function collectTextFiles(root, extensions) {
  const found = [];
  for (const entry of await readdir(root, {withFileTypes: true})) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await collectTextFiles(absolute, extensions));
    else if (extensions.has(path.extname(entry.name))) found.push(absolute);
  }
  return found;
}

const publicFiles = [
  'README.md',
  ...await collectTextFiles('docs', new Set(['.md', '.txt'])),
  ...await collectTextFiles('store-assets-launch-2026', new Set(['.md', '.txt'])),
  ...await collectTextFiles('src', new Set(['.html'])),
  'motion/src/SmeshAd.jsx',
  'motion/store-listing-2026/index.jsx',
];

for (const file of publicFiles) {
  const source = await readFile(file, 'utf8');
  assert.doesNotMatch(source, FORBIDDEN_PLATFORM_COPY, `${file} exposes platform-specific copy`);
}

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert.doesNotMatch(manifest.description, FORBIDDEN_PLATFORM_COPY);
assert.match(manifest.description, /электронного журнала/u);

const popup = await readFile('src/popup/popup.js', 'utf8');
const worker = await readFile('src/background/service-worker.js', 'utf8');
const prompts = await readFile('src/lib/prompts.js', 'utf8');

assert.doesNotMatch(popup, /Для решения теста откройте тест на school\.mos\.ru/u);
assert.match(popup, /Для решения теста откройте его в электронном журнале/u);
assert.doesNotMatch(worker, /Для решения теста откройте тест на school\.mos\.ru/u);
assert.match(worker, /Для решения теста откройте его в электронном журнале/u);
assert.match(prompts, /онлайн-тест в электронном журнале/u);
assert.doesNotMatch(prompts, /онлайн-тест МЭШ|\(не МЭШ\)/u);

console.log('user-facing journal copy regression passed');
