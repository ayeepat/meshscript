import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildExtensionZip,
  collectExtensionEntries,
  createExtensionZip,
  inspectExtensionZip,
  verifyExtensionArchive,
  writeExtensionArchive,
} from '../scripts/extension-package.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceEntries = await collectExtensionEntries(repoRoot);
const first = await buildExtensionZip(repoRoot);
const second = await buildExtensionZip(repoRoot);

assert.ok(first.equals(second), 'identical source trees must produce byte-identical extension ZIPs');

const archived = inspectExtensionZip(first);
assert.deepEqual(
  archived.map((entry) => entry.name),
  sourceEntries.map((entry) => entry.name),
  'the archive must contain exactly the sorted, allowlisted extension runtime files'
);
assert.equal(archived[0].name, 'assets/fonts/manrope-cyrillic-ext.woff2');
assert.ok(archived.some((entry) => entry.name === 'manifest.json'));
assert.ok(archived.some((entry) => entry.name === 'src/background/service-worker.js'));
assert.ok(archived.some((entry) => entry.name === 'src/lib/test-autopilot.js'));
assert.equal(archived.some((entry) => /(^|\/)(?:backend|tests|motion|node_modules)(?:\/|$)/.test(entry.name)), false);
assert.equal(archived.some((entry) => /(?:^|\/)\.(?:env|dev\.vars)/.test(entry.name)), false);

for (let index = 0; index < archived.length; index += 1) {
  assert.ok(
    archived[index].data.equals(sourceEntries[index].data),
    `${archived[index].name} must be packaged without modification`
  );
  const source = await readFile(path.join(repoRoot, ...archived[index].name.split('/')));
  assert.ok(archived[index].data.equals(source));
}

const tampered = Buffer.from(first);
const manifest = archived.find((entry) => entry.name === 'manifest.json');
tampered[manifest.dataOffset] ^= 0x01;
assert.throws(
  () => inspectExtensionZip(tampered),
  /CRC/,
  'package verification must reject an archive whose payload was modified'
);
assert.throws(
  () => createExtensionZip([{ name: '../secret.env', data: Buffer.from('secret') }]),
  /unsafe extension archive path/,
  'the packager must reject path traversal'
);
assert.throws(
  () => createExtensionZip([
    { name: 'manifest.json', data: Buffer.from('{}') },
    { name: 'manifest.json', data: Buffer.from('{}') },
  ]),
  /duplicate extension package path/,
  'the packager must reject duplicate paths'
);
await assert.rejects(
  () => writeExtensionArchive(path.join(repoRoot, 'src', 'do-not-overwrite.zip'), repoRoot),
  /refusing to overwrite extension source/,
  'an output flag must never be able to replace an extension source file'
);

// A structurally valid ZIP built from yesterday's source must fail the actual
// verifier. This mutation witness prevents a disabled actual.equals(expected)
// branch from leaving both the package unit test and verify:package green.
const staleEntries = sourceEntries.map((entry) => entry.name === 'manifest.json'
  ? { ...entry, data: Buffer.concat([entry.data, Buffer.from('\n')]) }
  : entry
);
const staleArchivePath = path.join(tmpdir(), 'smesh-stale-extension-regression.zip');
await writeFile(staleArchivePath, createExtensionZip(staleEntries));
await assert.rejects(
  () => verifyExtensionArchive(staleArchivePath, repoRoot),
  /stale or non-reproducible/,
  'verifyExtensionArchive must compare the archive bytes with a fresh source build'
);

console.log(`extension packaging regression passed (${archived.length} deterministic files)`);
