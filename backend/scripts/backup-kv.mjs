#!/usr/bin/env node

// Complete, restore-ready Workers KV export. Wrangler's bulk-get command
// requires a positional JSON key list and the remote API accepts at most 100
// keys per request; this script lists, chunks, verifies, and combines every
// value while preserving expiration/metadata from the listing.
import { spawnSync } from 'node:child_process';
import {
  chmod, mkdir, readFile, readdir, writeFile
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const wrangler = process.env.SMESH_BACKUP_WRANGLER_PATH ||
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const requested = process.argv[2] || path.join(
  'backups',
  `kv-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
const outputDir = path.resolve(backendDir, requested);

await mkdir(outputDir, { recursive: true, mode: 0o700 });
if ((await readdir(outputDir)).length !== 0) {
  throw new Error(`refusing to overwrite non-empty backup directory: ${outputDir}`);
}
// `mkdir({ recursive: true, mode })` does not repair an existing directory.
// D1 exports contain bearer license keys and customer contact data, so an
// operator-provided empty 0755 directory must not make the later d1.sql
// world-readable even when the shell's default umask is permissive.
await chmod(outputDir, 0o700);

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: backendDir,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.join(' ')} failed (${result.status}):\n${result.stderr || result.stdout}`
    );
  }
  return result.stdout;
}

async function writeNew(filename, value) {
  await writeFile(path.join(outputDir, filename), value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

const listedText = runWrangler(['kv', 'key', 'list', '--binding', 'LICENSES', '--remote']);
const listed = JSON.parse(listedText);
if (!Array.isArray(listed) || listed.some((item) => typeof item?.name !== 'string')) {
  throw new Error('wrangler returned an invalid KV key listing');
}
await writeNew('index.json', `${JSON.stringify(listed, null, 2)}\n`);

const allValues = Object.create(null);
for (let offset = 0; offset < listed.length; offset += 100) {
  const chunkNumber = String(offset / 100 + 1).padStart(5, '0');
  const keys = listed.slice(offset, offset + 100).map((item) => item.name);
  const keysFile = `keys-${chunkNumber}.json`;
  await writeNew(keysFile, `${JSON.stringify(keys, null, 2)}\n`);
  const valuesText = runWrangler([
    'kv', 'bulk', 'get', path.join(outputDir, keysFile),
    '--binding', 'LICENSES', '--remote'
  ]);
  const values = JSON.parse(valuesText);
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`wrangler returned an invalid value batch for ${keysFile}`);
  }
  const missing = keys.filter((key) =>
    !Object.hasOwn(values, key) || typeof values[key] !== 'string'
  );
  if (missing.length) {
    throw new Error(`partial KV export in ${keysFile}; missing ${missing.length} key(s)`);
  }
  Object.assign(allValues, values);
  await writeNew(`values-${chunkNumber}.json`, `${JSON.stringify(values, null, 2)}\n`);
}

const restore = listed.map((item) => ({
  key: item.name,
  value: allValues[item.name],
  ...(Number.isSafeInteger(item.expiration) ? { expiration: item.expiration } : {}),
  ...(item.metadata !== undefined ? { metadata: item.metadata } : {})
}));
await writeNew('restore.json', `${JSON.stringify(restore, null, 2)}\n`);

// Re-read the artifact instead of trusting the in-memory object: a successful
// exit certifies that the exact on-disk restore file is complete and parseable.
const verified = JSON.parse(await readFile(path.join(outputDir, 'restore.json'), 'utf8'));
if (!Array.isArray(verified) || verified.length !== listed.length) {
  throw new Error('on-disk KV backup verification failed');
}

process.stdout.write(`KV backup complete: ${verified.length} keys in ${outputDir}\n`);
