// Node's SQLite binding preserves comments and has no D1-owned tables, so it
// cannot by itself prove that the adoption guard accepts the schema product
// users actually get from Wrangler. Exercise the repository-pinned local D1
// runtime as a compatibility gate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = fileURLToPath(new URL('../backend/', import.meta.url));
const packageJson = JSON.parse(await readFile(
  new URL('../backend/package.json', import.meta.url),
  'utf8'
));
assert.equal(packageJson.devDependencies?.wrangler, '4.114.0',
  'the D1 compatibility gate must remain pinned to the reviewed Wrangler runtime');

const wrangler = path.join(
  backendDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'
);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'smesh-d1-adoption-'));
const snapshotPersistence = path.join(temporary, 'snapshot-state');
const migrationPersistence = path.join(temporary, 'migration-state');
const rejectionPersistence = path.join(temporary, 'rejection-state');
// Each Wrangler invocation pays a workerd cold start, and `migrations apply`
// now replays nine files. 30s was marginal enough to flake when the rest of the
// suite is competing for CPU — a timeout here is a slow machine, not a schema
// defect, and a false red on a schema gate is expensive to chase.
const WRANGLER_TIMEOUT_MS = 120_000;

function terminateProcessTree(child) {
  if (!Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', [
      '/PID', String(child.pid), '/T', '/F'
    ], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    });
    return;
  }
  process.kill(-child.pid, 'SIGKILL');
}

async function runWrangler(args, { expectFailure = false } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(wrangler, args, {
      cwd: backendDir,
      // Wrangler may spawn workerd. Give the command its own POSIX process
      // group so a timeout cannot strand the runtime after killing only the
      // CLI parent.
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        WRANGLER_LOG: 'error',
        WRANGLER_LOG_PATH: path.join(temporary, 'wrangler.log'),
        WRANGLER_SEND_METRICS: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutError = null;
    const command = `${wrangler} ${args.join(' ')}`;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      timeoutError = new Error(
        `Wrangler D1 command timed out after ${WRANGLER_TIMEOUT_MS} ms: ${command}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
      );
      try {
        terminateProcessTree(child);
      } catch {
        // The process may have exited between the timer firing and the kill;
        // the close handler below remains the single settlement point.
      }
    }, WRANGLER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => settle(reject, error));
    child.once('close', (code, signal) => {
      if (timeoutError) settle(reject, timeoutError);
      else settle(resolve, { code, signal, stdout, stderr });
    });
  });
  const detail = `Wrangler D1 command ${expectFailure ? 'unexpectedly succeeded' : 'failed'}` +
    `${result.signal ? ` (${result.signal})` : ''}:\n${result.stdout}\n${result.stderr}`;
  if (expectFailure) assert.notEqual(result.code, 0, detail);
  else assert.equal(result.code, 0, detail);
}

await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', snapshotPersistence, '--file', 'schema.sql'
]);
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', snapshotPersistence,
  '--file', 'scripts/adopt-current-schema.sql'
]);

await runWrangler([
  'd1', 'migrations', 'apply', 'smesh-analytics',
  '--local', '--persist-to', migrationPersistence
]);
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', migrationPersistence,
  '--file', 'scripts/adopt-current-schema.sql'
]);

// Exercise the rejection and rollback contract in D1 itself, not only Node's
// SQLite savepoint model. A pre-existing fence table with its authority row
// missing must fail adoption. The subsequent manual seed and successful rerun
// prove the failed file left neither its seed nor any helper/ledger object.
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', rejectionPersistence, '--file', 'schema.sql'
]);
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', rejectionPersistence,
  '--command', 'DELETE FROM runtime_write_fence'
]);
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', rejectionPersistence,
  '--file', 'scripts/adopt-current-schema.sql'
], { expectFailure: true });
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', rejectionPersistence,
  '--command', "INSERT INTO runtime_write_fence VALUES (1, 1, 1, unixepoch('subsec') * 1000)"
]);
await runWrangler([
  'd1', 'execute', 'smesh-analytics',
  '--local', '--persist-to', rejectionPersistence,
  '--file', 'scripts/adopt-current-schema.sql'
]);

console.log('pinned Wrangler local-D1 schema adoption regression passed');
