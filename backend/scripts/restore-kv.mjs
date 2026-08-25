#!/usr/bin/env node

// Restore one validated backup-kv.mjs artifact into an EMPTY KV namespace.
// The script refuses overwrite, chunks the remote writes, and reads every
// value back before reporting success. Chunk files remain beside the backup as
// an audit trail of exactly what was submitted.
import { spawnSync } from 'node:child_process';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const wrangler = process.env.SMESH_RESTORE_WRANGLER_PATH ||
  fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const requested = process.argv[2];
if (!requested) throw new Error('usage: node scripts/restore-kv.mjs <backup/restore.json>');
const restorePath = path.resolve(backendDir, requested);
const restoreDir = path.dirname(restorePath);
const restoreStat = await stat(restorePath);
if (!restoreStat.isFile()) throw new Error('restore artifact must be a regular file');
await chmod(restoreDir, 0o700);

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

function parseRestore(text) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows) || rows.some((row) =>
    !row || typeof row.key !== 'string' || !row.key ||
    typeof row.value !== 'string' ||
    (row.expiration !== undefined && !Number.isSafeInteger(row.expiration)))) {
    throw new Error('invalid KV restore artifact');
  }
  if (new Set(rows.map((row) => row.key)).size !== rows.length) {
    throw new Error('duplicate key in KV restore artifact');
  }
  return rows;
}

const rows = parseRestore(await readFile(restorePath, 'utf8'));
const before = JSON.parse(runWrangler(['kv', 'key', 'list', '--binding', 'LICENSES', '--remote']));
if (!Array.isArray(before)) throw new Error('invalid target KV listing');
if (before.length !== 0) throw new Error('refusing to restore into a non-empty KV namespace');

const chunkSize = 5_000;
for (let offset = 0; offset < rows.length; offset += chunkSize) {
  const number = String(offset / chunkSize + 1).padStart(5, '0');
  const chunk = rows.slice(offset, offset + chunkSize);
  const chunkPath = path.join(restoreDir, `restore-put-${number}.json`);
  await writeFile(chunkPath, `${JSON.stringify(chunk, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
  runWrangler(['kv', 'bulk', 'put', chunkPath, '--binding', 'LICENSES', '--remote']);
}

const after = JSON.parse(runWrangler(['kv', 'key', 'list', '--binding', 'LICENSES', '--remote']));
const afterByName = new Map(Array.isArray(after) ? after.map((row) => [row?.name, row]) : []);
if (!Array.isArray(after) || after.length !== rows.length || rows.some((row) => {
  const listed = afterByName.get(row.key);
  return !listed ||
    (row.expiration ?? null) !== (listed.expiration ?? null) ||
    JSON.stringify(row.metadata ?? null) !== JSON.stringify(listed.metadata ?? null);
})) {
  throw new Error('restored KV key listing does not match the backup');
}

for (let offset = 0; offset < rows.length; offset += 100) {
  const chunk = rows.slice(offset, offset + 100);
  const number = String(offset / 100 + 1).padStart(5, '0');
  const keysPath = path.join(restoreDir, `restore-check-${number}.json`);
  await writeFile(keysPath, `${JSON.stringify(chunk.map((row) => row.key), null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
  const values = JSON.parse(runWrangler([
    'kv', 'bulk', 'get', keysPath, '--binding', 'LICENSES', '--remote'
  ]));
  for (const row of chunk) {
    if (!Object.hasOwn(values, row.key) || values[row.key] !== row.value) {
      throw new Error(`KV read-back mismatch for ${row.key}`);
    }
  }
}

process.stdout.write(`KV restore verified: ${rows.length} keys from ${restorePath}\n`);
