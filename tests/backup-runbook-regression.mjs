// The backup runbook must do what Wrangler 4 actually requires: list keys,
// pass positional key-list files to bulk-get in <=100-key chunks, preserve
// expiration/metadata, and refuse to bless a partial or overwritten export.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const temp = await mkdtemp(path.join(tmpdir(), 'smesh-backup-test-'));
const fakeWrangler = path.join(temp, 'fake-wrangler.mjs');
const output = path.join(temp, 'complete');

await writeFile(fakeWrangler, `
  import { readFile } from 'node:fs/promises';
  const args = process.argv.slice(2);
  if (args.join(' ').startsWith('kv key list')) {
    const rows = Array.from({ length: 205 }, (_, i) => ({
      name: 'key-' + String(i).padStart(3, '0'),
      ...(i === 4 ? { expiration: 2000000000, metadata: { kind: 'license' } } : {})
    }));
    process.stdout.write(JSON.stringify(rows));
  } else if (args.slice(0, 3).join(' ') === 'kv bulk get') {
    const keys = JSON.parse(await readFile(args[3], 'utf8'));
    if (keys.length > 100) process.exit(9);
    process.stdout.write(JSON.stringify(Object.fromEntries(
      keys.map((key) => [key, 'value:' + key])
    )));
  } else {
    process.exit(8);
  }
`);

const script = fileURLToPath(new URL('../backend/scripts/backup-kv.mjs', import.meta.url));
await mkdir(output, { mode: 0o755 });
await chmod(output, 0o755);
assert.equal((await stat(output)).mode & 0o777, 0o755,
  'the regression must begin with a pre-existing, traversable backup directory');
const run = spawnSync(process.execPath, [script, output], {
  encoding: 'utf8',
  env: { ...process.env, SMESH_BACKUP_WRANGLER_PATH: fakeWrangler }
});
assert.equal(run.status, 0, run.stderr || run.stdout);
assert.match(run.stdout, /205 keys/);
assert.equal((await stat(output)).mode & 0o777, 0o700,
  'the backup script must repair an existing output directory to owner-only access');

const files = await readdir(output);
assert.deepEqual(
  files.filter((name) => name.startsWith('keys-')).sort(),
  ['keys-00001.json', 'keys-00002.json', 'keys-00003.json'],
  '205 keys must be split across the remote API\'s 100-key ceiling'
);
const restore = JSON.parse(await readFile(path.join(output, 'restore.json'), 'utf8'));
assert.equal(restore.length, 205);
assert.deepEqual(restore[4], {
  key: 'key-004',
  value: 'value:key-004',
  expiration: 2000000000,
  metadata: { kind: 'license' }
});

const overwrite = spawnSync(process.execPath, [script, output], {
  encoding: 'utf8',
  env: { ...process.env, SMESH_BACKUP_WRANGLER_PATH: fakeWrangler }
});
assert.notEqual(overwrite.status, 0,
  'a rerun must refuse to mix a new backup into an existing artifact');
assert.match(overwrite.stderr, /refusing to overwrite non-empty backup directory/);

// Restore is executable, not prose-only: it refuses a non-empty target,
// chunks puts and reads every restored value back from the fake remote.
const restoreWrangler = path.join(temp, 'fake-restore-wrangler.mjs');
const restoreState = path.join(temp, 'restore-state.json');
await writeFile(restoreState, '[]');
await writeFile(restoreWrangler, `
  import { readFile, writeFile } from 'node:fs/promises';
  const args = process.argv.slice(2);
  const statePath = process.env.FAKE_RESTORE_STATE;
  const rows = JSON.parse(await readFile(statePath, 'utf8'));
  if (args.slice(0, 3).join(' ') === 'kv key list') {
    process.stdout.write(JSON.stringify(rows.map((row) => ({
      name: row.key,
      ...(row.expiration !== undefined ? { expiration: row.expiration } : {}),
      ...(row.metadata !== undefined ? { metadata: row.metadata } : {})
    }))));
  } else if (args.slice(0, 3).join(' ') === 'kv bulk put') {
    const incoming = JSON.parse(await readFile(args[3], 'utf8'));
    await writeFile(statePath, JSON.stringify([...rows, ...incoming]));
  } else if (args.slice(0, 3).join(' ') === 'kv bulk get') {
    const keys = JSON.parse(await readFile(args[3], 'utf8'));
    process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key) => [
      key, rows.find((row) => row.key === key)?.value
    ]))));
  } else {
    process.exit(8);
  }
`);
const restoreScript = fileURLToPath(new URL('../backend/scripts/restore-kv.mjs', import.meta.url));
const restoreRun = spawnSync(process.execPath, [restoreScript, path.join(output, 'restore.json')], {
  encoding: 'utf8',
  env: {
    ...process.env,
    SMESH_RESTORE_WRANGLER_PATH: restoreWrangler,
    FAKE_RESTORE_STATE: restoreState
  }
});
assert.equal(restoreRun.status, 0, restoreRun.stderr || restoreRun.stdout);
assert.match(restoreRun.stdout, /KV restore verified: 205 keys/);
assert.equal(JSON.parse(await readFile(restoreState, 'utf8')).length, 205);
const restoreOverwrite = spawnSync(
  process.execPath, [restoreScript, path.join(output, 'restore.json')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SMESH_RESTORE_WRANGLER_PATH: restoreWrangler,
      FAKE_RESTORE_STATE: restoreState
    }
  }
);
assert.notEqual(restoreOverwrite.status, 0);
assert.match(restoreOverwrite.stderr, /refusing to restore into a non-empty KV namespace/);

const readme = await readFile(new URL('../backend/README.md', import.meta.url), 'utf8');
const wranglerConfig = await readFile(new URL('../backend/wrangler.toml', import.meta.url), 'utf8');
assert.match(wranglerConfig, /^keep_vars\s*=\s*true$/m,
  'ordinary deploys must preserve dashboard-managed production variables');
assert.doesNotMatch(wranglerConfig, /^RUNTIME_WRITE_EPOCH\s*=/m,
  'the operationally rotated epoch must not be reset by tracked config');
assert.doesNotMatch(readme, /https:\/\/api\.smesh\.app\/admin\/issue/,
  'the manual-issue runbook must use the deployed custom domain');
assert.match(readme, /wrangler deploy --keep-vars --var BACKUP_MAINTENANCE:true/,
  'the backup runbook must enable the server-enforced write gate');
assert.match(readme, /git status --porcelain --untracked-files=normal/,
  'maintenance deploys must begin from a clean production checkout');
assert.match(readme, /--keep-vars` is required/,
  'maintenance deploys must preserve dashboard-managed production overrides');
assert.match(readme, /checks\.backup_maintenance: false/,
  'the operator must confirm failed readiness proves the gate is active');
assert.match(readme, /UPDATE runtime_write_fence SET write_epoch = write_epoch \+ 1, writes_enabled = 0/,
  'maintenance must revoke and rotate durable write authority before deployment');
assert.match(readme, /--var RUNTIME_WRITE_EPOCH:"\$NEXT_EPOCH"/,
  'both maintenance deployments must bind the durable epoch they verify');
assert.match(readme, /checks\.write_fence: true/,
  'readiness must prove the durable fence state, not only entry admission');
assert.match(readme, /sleep 120/,
  'the short drain must cover only check-to-write completion and KV propagation');
assert.doesNotMatch(readme, /sleep 1020|17 full minutes/,
  'backup safety must not depend on a guessed maximum request-body lifetime');
assert.match(readme, /\(umask 077; npx wrangler d1 export/,
  'the D1 export must be created under a restrictive umask');
assert.match(readme, /chmod 600 "\$BACKUP_DIR\/d1\.sql"/,
  'the D1 dump mode must be repaired explicitly');
assert.match(readme, /DatabaseSync\(":memory:"\)/,
  'artifact validation must execute the D1 dump in an isolated SQLite database');
assert.match(readme, /wrangler deploy --keep-vars --var BACKUP_MAINTENANCE:false/,
  'the runbook must explicitly disable maintenance after artifact validation');
assert.match(readme, /SET writes_enabled = 1[\s\S]*write_epoch = \$NEXT_EPOCH/,
  'the runbook must reopen only the epoch used by the maintenance deployment');
assert.match(readme, /scripts\/restore-kv\.mjs/,
  'the disaster-recovery runbook must include the verified KV restore command');
assert.match(readme, /d1 execute [^\n]*--remote --file="\$BACKUP_DIR\/d1\.sql"/,
  'the disaster-recovery runbook must include an actual remote D1 import');

console.log('backup runbook regression passed');
