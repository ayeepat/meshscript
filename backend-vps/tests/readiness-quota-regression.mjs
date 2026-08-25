import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const serverSource = await readFile(serverPath, 'utf8');

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `source section not found: ${startMarker}`);
  return source.slice(start, end);
}

// A size check before fs.readFileSync is not a read bound: the same inode can
// grow between fstat and the whole-file helper, which then allocates past the
// configured maximum. Exercise the production bounded descriptor reader with
// a fake inode that supplies one sentinel byte beyond its checked size.
{
  const boundedReadSource = sourceSection(
    serverSource,
    'function readQuotaBytesBounded',
    '\n\n// Read through one no-follow file descriptor'
  );
  let payload = Buffer.alloc(0);
  let cursor = 0;
  let largestRequestedRead = 0;
  const context = {
    Buffer,
    fs: {
      readSync(_fd, output, offset, length) {
        largestRequestedRead = Math.max(largestRequestedRead, length);
        if (cursor >= payload.length) return 0;
        const take = Math.min(length, payload.length - cursor);
        payload.copy(output, offset, cursor, cursor + take);
        cursor += take;
        return take;
      }
    },
    quotaStoreError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    }
  };
  vm.runInNewContext(
    `${boundedReadSource}\nglobalThis.__readQuotaBytesBounded = readQuotaBytesBounded;`,
    context,
    { filename: 'quota-bounded-descriptor-read.js' }
  );

  payload = Buffer.from('{}');
  cursor = 0;
  assert.equal(context.__readQuotaBytesBounded(1, 2n), '{}');

  payload = Buffer.from('xy');
  cursor = 0;
  largestRequestedRead = 0;
  assert.throws(
    () => context.__readQuotaBytesBounded(1, 1n),
    (error) => error?.code === 'EQUOTARACE',
    'growth beyond the fstat size must be rejected after reading one bounded sentinel byte'
  );
  assert.equal(largestRequestedRead, 2,
    'a one-byte checked file must never cause an unbounded whole-file allocation');
}

// The quota acknowledgement contract includes durability of the directory
// entry, not only the temporary file's contents. Inject a directory-fsync EIO
// and prove both the real write and the first-run probe fail closed.
{
  const writeSource = sourceSection(
    serverSource,
    'function writeQuotaNow()',
    '\n\nfunction persistCurrentQuota()'
  );
  const probeSource = sourceSection(
    serverSource,
    'function probeQuotaStore()',
    '\n\nfunction recoverQuotaPersistence'
  );
  let fsyncCalls = 0;
  const fakeFs = {
    mkdirSync() {},
    openSync(value) { return value === '/quota' ? 2 : 1; },
    writeFileSync() {},
    fsyncSync(fd) {
      fsyncCalls += 1;
      if (fd === 2) {
        const error = new Error('directory fsync failed');
        error.code = 'EIO';
        throw error;
      }
    },
    closeSync() {},
    renameSync() {},
    unlinkSync() {}
  };
  const context = {
    Buffer,
    JSON,
    fs: fakeFs,
    path,
    crypto: { randomUUID: () => 'test-nonce' },
    process: { pid: 1 },
    performance: { now: () => 1 },
    QUOTA_FILE: '/quota/quota.json',
    MAX_QUOTA_FILE_BYTES: 2 * 1024 * 1024,
    quota: { day: '2026-08-09', counts: {} },
    quotaDirty: true,
    quotaLoadBlocked: false,
    quotaPersistenceHealthy: true,
    quotaLastStoreProofAt: 0,
    quotaLastWriteCommitted: false,
    quotaFileLoaded: false,
    quotaAuthoritativeTarget: '',
    quotaLastReadinessTarget: '',
    quotaFailureFingerprint: '',
    quotaNeedsPrivacyRewrite: false,
    parseQuotaFile: (raw) => JSON.parse(raw),
    readQuotaTarget: () => ({
      snapshot: { day: '2026-08-09', counts: {} },
      fingerprint: 'committed'
    }),
    inspectQuotaTarget: () => ({ target: null, fingerprint: 'missing' }),
    quotaStoreError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    },
    markQuotaFailure() { context.quotaPersistenceHealthy = false; }
  };
  vm.runInNewContext(
    `${writeSource}\n${probeSource}\n` +
      'globalThis.__quotaIo = { writeQuotaNow, probeQuotaStore };',
    context,
    { filename: 'quota-directory-fsync-failure.js' }
  );

  assert.equal(context.__quotaIo.writeQuotaNow(), false,
    'a committed rename without directory fsync must not acknowledge quota durability');
  assert.equal(context.quotaLastWriteCommitted, true);
  assert.equal(context.quotaLoadBlocked, true,
    'post-rename durability uncertainty must latch paid admissions down');
  assert.equal(context.quotaPersistenceHealthy, false);

  fsyncCalls = 0;
  context.quotaLoadBlocked = false;
  context.quotaPersistenceHealthy = true;
  assert.equal(context.__quotaIo.probeQuotaStore(), false,
    'a first-run sibling probe must not report writable durability after directory fsync fails');
  assert.equal(context.quotaPersistenceHealthy, false);
  assert.equal(fsyncCalls, 2, 'the injected failure must occur on the directory fsync');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function unusedPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(base) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error('proxy did not become live');
}

async function startProxy({ quotaPath, upstreamKey, mockPort, deepProbeMs }) {
  const port = await unusedPort();
  const proc = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      AI_PROXY_API_KEY: upstreamKey,
      AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
      LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
      QUOTA_FILE: quotaPath,
      QUOTA_READINESS_DEEP_PROBE_MS: String(deepProbeMs || 60_000)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
  } catch (error) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    throw error;
  }
  return { proc, base, stderr: () => stderr };
}

async function stopProxy(proc, signal = 'SIGTERM') {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill(signal);
  await Promise.race([
    once(proc, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('proxy did not stop')), 4000))
  ]);
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

function solveBody(label) {
  return JSON.stringify({
    provider: 'qwen',
    license_key: `SMESH-READY-${label}`,
    device_id: '00000000-0000-4000-8000-000000000071',
    activation_token: 'a'.repeat(43),
    messages: [{ role: 'user', content: label }]
  });
}

function mskDay() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

async function startSolve(base, label) {
  return fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: solveBody(label)
  });
}

let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url === '/verify' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    upstreamCalls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-vps-readiness-'));
const processes = new Set();

try {
  const missingKey = await startProxy({
    quotaPath: path.join(temp, 'missing-key.json'),
    upstreamKey: '',
    mockPort
  });
  processes.add(missingKey.proc);
  assert.deepEqual(await json(await fetch(`${missingKey.base}/health`)), {
    status: 200,
    body: { ok: true }
  }, 'liveness must stay available for process supervision');
  assert.deepEqual(await json(await fetch(`${missingKey.base}/ready`)), {
    status: 503,
    body: { ok: false, checks: { upstream_key: false, quota_config: true, quota_store: true } }
  }, 'readiness must reject an instance without its paid-provider key');
  await stopProxy(missingKey.proc);
  processes.delete(missingKey.proc);

  const healthyPath = path.join(temp, 'healthy.json');
  const healthy = await startProxy({
    quotaPath: healthyPath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(healthy.proc);
  assert.deepEqual(await json(await fetch(`${healthy.base}/ready`)), {
    status: 200,
    body: { ok: true, checks: { upstream_key: true, quota_config: true, quota_store: true } }
  });
  await assert.rejects(access(healthyPath), { code: 'ENOENT' },
    'a readiness probe must not create authoritative quota state before admission');
  await mkdir(healthyPath);
  assert.deepEqual(await json(await fetch(`${healthy.base}/ready`)), {
    status: 503,
    body: { ok: false, checks: { upstream_key: true, quota_config: true, quota_store: false } }
  }, 'readiness must detect post-start loss of the exact quota target before admission');
  const healthyBlocker = path.join(temp, 'healthy-target-blocker');
  await rename(healthyPath, healthyBlocker);
  assert.deepEqual(await json(await fetch(`${healthy.base}/ready`)), {
    status: 200,
    body: { ok: true, checks: { upstream_key: true, quota_config: true, quota_store: true } }
  }, 'an unused quota store may recover without inventing authoritative state');
  await assert.rejects(access(healthyPath), { code: 'ENOENT' });
  await stopProxy(healthy.proc);
  processes.delete(healthy.proc);

  const corruptPath = path.join(temp, 'corrupt.json');
  await writeFile(corruptPath, '{"day":', { mode: 0o600 });
  const corrupt = await startProxy({
    quotaPath: corruptPath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(corrupt.proc);
  assert.deepEqual(await json(await fetch(`${corrupt.base}/ready`)), {
    status: 503,
    body: { ok: false, checks: { upstream_key: true, quota_config: true, quota_store: false } }
  }, 'corrupt persisted accounting must never be replaced with empty counters');
  const callsBeforeBlockedStart = upstreamCalls;
  const blockedStart = await startSolve(corrupt.base, 'CORRUPT');
  assert.equal(blockedStart.status, 503, await blockedStart.clone().text());
  assert.equal(upstreamCalls, callsBeforeBlockedStart,
    'quota uncertainty must stop paid upstream work');
  assert.doesNotMatch(corrupt.stderr(), /SMESH-READY-CORRUPT/,
    'quota error logging must not echo license-shaped input');

  await writeFile(corruptPath, JSON.stringify({ day: '2026-07-26', counts: {} }), { mode: 0o600 });
  assert.deepEqual(await json(await fetch(`${corrupt.base}/ready`)), {
    status: 200,
    body: { ok: true, checks: { upstream_key: true, quota_config: true, quota_store: true } }
  }, 'readiness should recover only after a valid durable quota store is restored');
  const recoveredStart = await startSolve(corrupt.base, 'RECOVERED');
  assert.equal(recoveredStart.status, 200, await recoveredStart.clone().text());
  await stopProxy(corrupt.proc);
  processes.delete(corrupt.proc);

  const malformedStatePath = path.join(temp, 'malformed-state.json');
  await writeFile(malformedStatePath, JSON.stringify({
    day: '2026-07-26',
    counts: { '*|all': 'not-a-counter' }
  }), { mode: 0o600 });
  const malformedState = await startProxy({
    quotaPath: malformedStatePath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(malformedState.proc);
  assert.equal((await fetch(`${malformedState.base}/ready`)).status, 503,
    'semantic quota corruption must not be normalized into lower counters');
  const malformedBlocked = await startSolve(malformedState.base, 'MALFORMED-STATE');
  assert.equal(malformedBlocked.status, 503, await malformedBlocked.clone().text());
  await stopProxy(malformedState.proc);
  processes.delete(malformedState.proc);

  const understatedGlobalPath = path.join(temp, 'understated-global.json');
  await writeFile(understatedGlobalPath, JSON.stringify({
    day: mskDay(),
    counts: {
      [`h:${'a'.repeat(64)}|qwen`]: 1,
      '*|all': 0
    }
  }), { mode: 0o600 });
  const understatedGlobal = await startProxy({
    quotaPath: understatedGlobalPath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(understatedGlobal.proc);
  assert.equal((await fetch(`${understatedGlobal.base}/ready`)).status, 503,
    'readiness must reject quota state whose global total understates provider reservations');
  const callsBeforeUnderstatedGlobal = upstreamCalls;
  const understatedGlobalBlocked = await startSolve(understatedGlobal.base, 'UNDERSTATED-GLOBAL');
  assert.equal(understatedGlobalBlocked.status, 503,
    await understatedGlobalBlocked.clone().text());
  assert.equal(upstreamCalls, callsBeforeUnderstatedGlobal,
    'an understated global counter must stop admission before paid upstream work');
  await stopProxy(understatedGlobal.proc);
  processes.delete(understatedGlobal.proc);

  const legacyMismatchedPath = path.join(temp, 'legacy-mismatched-total.json');
  await writeFile(legacyMismatchedPath, JSON.stringify({
    day: mskDay(),
    counts: { 'SMESH-LEGACY-OVER-CAP|qwen': 2, '*|all': 1 }
  }), { mode: 0o600 });
  const legacyMismatched = await startProxy({
    quotaPath: legacyMismatchedPath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(legacyMismatched.proc);
  assert.equal((await fetch(`${legacyMismatched.base}/ready`)).status, 200,
    'a plaintext store from the pre-hash counter order must migrate conservatively');
  await stopProxy(legacyMismatched.proc);
  processes.delete(legacyMismatched.proc);
  const migratedLegacyQuota = JSON.parse(await readFile(legacyMismatchedPath, 'utf8'));
  assert.equal(migratedLegacyQuota.counts['*|all'], 2,
    'legacy migration must raise the global breaker to the provider total');
  assert.deepEqual(
    Object.entries(migratedLegacyQuota.counts)
      .filter(([key]) => /^h:[a-f0-9]{64}\|qwen$/.test(key))
      .map(([, value]) => value),
    [2]
  );
  assert.doesNotMatch(JSON.stringify(migratedLegacyQuota), /SMESH-LEGACY-OVER-CAP/,
    'legacy migration must still remove plaintext bearer keys');

  // A backup/restore can replace the file while this process has a disjoint
  // same-day reservation. Per-key maxima alone produce provider totals greater
  // than *|all, which the next restart rejects. Recovery must raise the global
  // breaker before durably writing the merged snapshot.
  const disjointMergePath = path.join(temp, 'disjoint-merge.json');
  await writeFile(disjointMergePath, JSON.stringify({
    day: mskDay(),
    counts: { [`h:${'b'.repeat(64)}|qwen`]: 1, '*|all': 1 }
  }), { mode: 0o600 });
  const disjointMerge = await startProxy({
    quotaPath: disjointMergePath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(disjointMerge.proc);
  assert.equal((await fetch(`${disjointMerge.base}/ready`)).status, 200);
  await writeFile(disjointMergePath, JSON.stringify({
    day: mskDay(),
    counts: { [`h:${'c'.repeat(64)}|groq`]: 1, '*|all': 1 }
  }), { mode: 0o600 });
  assert.equal((await fetch(`${disjointMerge.base}/ready`)).status, 200,
    'a valid disjoint restore must merge without latching readiness down');
  await stopProxy(disjointMerge.proc);
  processes.delete(disjointMerge.proc);
  const disjointMerged = JSON.parse(await readFile(disjointMergePath, 'utf8'));
  assert.equal(disjointMerged.counts['*|all'], 2,
    'merged global accounting must cover the sum of disjoint provider counters');
  assert.equal(disjointMerged.counts[`h:${'b'.repeat(64)}|qwen`], 1);
  assert.equal(disjointMerged.counts[`h:${'c'.repeat(64)}|groq`], 1);

  const directoryTarget = path.join(temp, 'quota-is-directory');
  await mkdir(directoryTarget);
  const unwritable = await startProxy({
    quotaPath: directoryTarget,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(unwritable.proc);
  assert.equal((await fetch(`${unwritable.base}/ready`)).status, 503);
  const blockedDirectoryStart = await startSolve(unwritable.base, 'DIRECTORY');
  assert.equal(blockedDirectoryStart.status, 503, await blockedDirectoryStart.clone().text());
  await stopProxy(unwritable.proc);
  processes.delete(unwritable.proc);

  const symlinkBacking = path.join(temp, 'quota-symlink-backing.json');
  const symlinkPath = path.join(temp, 'quota-symlink.json');
  const symlinkSnapshot = JSON.stringify({ day: mskDay(), counts: {} });
  await writeFile(symlinkBacking, symlinkSnapshot, { mode: 0o600 });
  await symlink(symlinkBacking, symlinkPath);
  const symlinked = await startProxy({
    quotaPath: symlinkPath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(symlinked.proc);
  assert.equal((await fetch(`${symlinked.base}/ready`)).status, 503,
    'the authoritative quota pathname must never be accepted through a symlink');
  const callsBeforeSymlinkStart = upstreamCalls;
  const symlinkBlocked = await startSolve(symlinked.base, 'SYMLINK');
  assert.equal(symlinkBlocked.status, 503, await symlinkBlocked.clone().text());
  assert.equal(upstreamCalls, callsBeforeSymlinkStart);
  assert.equal(await readFile(symlinkBacking, 'utf8'), symlinkSnapshot,
    'a rejected quota symlink must not rewrite its target');
  await stopProxy(symlinked.proc);
  processes.delete(symlinked.proc);

  const writeFailurePath = path.join(temp, 'write-failure.json');
  await writeFile(writeFailurePath, JSON.stringify({ day: '2026-07-26', counts: {} }), { mode: 0o600 });
  const writeFailure = await startProxy({
    quotaPath: writeFailurePath,
    upstreamKey: 'test-key',
    mockPort
  });
  processes.add(writeFailure.proc);
  assert.equal((await fetch(`${writeFailure.base}/ready`)).status, 200);
  const savedQuotaPath = path.join(temp, 'write-failure.saved.json');
  await rename(writeFailurePath, savedQuotaPath);
  await mkdir(writeFailurePath);
  const callsBeforeWriteFailure = upstreamCalls;
  const writeBlocked = await startSolve(writeFailure.base, 'WRITE-FAILURE');
  assert.equal(writeBlocked.status, 503, await writeBlocked.clone().text());
  assert.equal(upstreamCalls, callsBeforeWriteFailure,
    'an atomic-write failure must roll back memory and stop paid upstream work');
  assert.equal((await fetch(`${writeFailure.base}/ready`)).status, 503,
    'a failed admission write must latch readiness down');
  await rename(writeFailurePath, path.join(temp, 'write-failure.blocker'));
  await rename(savedQuotaPath, writeFailurePath);
  assert.equal((await fetch(`${writeFailure.base}/ready`)).status, 200,
    'the write-failure latch must clear only after a successful atomic retry');
  const afterWriteRecovery = await startSolve(writeFailure.base, 'WRITE-RECOVERED');
  assert.equal(afterWriteRecovery.status, 200, await afterWriteRecovery.clone().text());
  await stopProxy(writeFailure.proc);
  processes.delete(writeFailure.proc);
  const recoveredQuota = JSON.parse(await readFile(writeFailurePath, 'utf8'));
  assert.equal(recoveredQuota.counts['*|all'], 1,
    'the failed reservation must not survive in memory or on disk');

  const durablePath = path.join(temp, 'durable.json');
  const durable = await startProxy({
    quotaPath: durablePath,
    upstreamKey: 'test-key',
    mockPort,
    deepProbeMs: 2000
  });
  processes.add(durable.proc);
  assert.equal((await fetch(`${durable.base}/ready`)).status, 200);
  const admitted = await startSolve(durable.base, 'DURABLE');
  assert.equal(admitted.status, 200, await admitted.clone().text());
  const inodeBeforeReadyFlood = await stat(durablePath);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await fetch(`${durable.base}/ready`)).status, 200);
  }
  const inodeAfterReadyFlood = await stat(durablePath);
  assert.equal(inodeAfterReadyFlood.ino, inodeBeforeReadyFlood.ino,
    'public readiness polling must not atomically rewrite healthy quota state per request');
  assert.equal(inodeAfterReadyFlood.mtimeMs, inodeBeforeReadyFlood.mtimeMs,
    'public readiness polling must not create synchronous quota-file write amplification');

  await new Promise((resolve) => setTimeout(resolve, 2100));
  const inodeBeforeBoundedDeepProbe = await stat(durablePath);
  assert.equal((await fetch(`${durable.base}/ready`)).status, 200);
  const inodeAfterBoundedDeepProbe = await stat(durablePath);
  assert.notEqual(inodeAfterBoundedDeepProbe.ino, inodeBeforeBoundedDeepProbe.ino,
    'a due deep probe must exercise replacement of the exact authoritative target');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await fetch(`${durable.base}/ready`)).status, 200);
  }
  assert.equal((await stat(durablePath)).ino, inodeAfterBoundedDeepProbe.ino,
    'one successful deep probe must rate-limit the remaining public readiness flood');

  // A valid-looking regular pathname can still contain corrupt or restored
  // accounting. Admission must inspect its fingerprint directly rather than
  // relying on whether /ready happened to run between the external change and
  // a paid request.
  await writeFile(durablePath, '{"day":', { mode: 0o600 });
  const callsBeforeChangedTarget = upstreamCalls;
  const changedTargetStart = await startSolve(durable.base, 'TARGET-CHANGED');
  assert.equal(changedTargetStart.status, 503, await changedTargetStart.clone().text());
  assert.equal(upstreamCalls, callsBeforeChangedTarget,
    'a corrupt regular-file replacement must be rejected before paid upstream work');
  assert.equal((await fetch(`${durable.base}/ready`)).status, 503,
    'the corrupt replacement must keep readiness latched down');

  // Repair with a valid but lower same-day snapshot. Recovery must merge with
  // the already acknowledged in-memory reservation instead of rolling quota
  // backwards, then exact-write the merged state once.
  await writeFile(durablePath, JSON.stringify({ day: mskDay(), counts: {} }), { mode: 0o600 });
  assert.equal((await fetch(`${durable.base}/ready`)).status, 200,
    'a changed, valid regular target should recover without restarting the proxy');
  const mergedAfterRepair = JSON.parse(await readFile(durablePath, 'utf8'));
  assert.equal(mergedAfterRepair.counts['*|all'], 1,
    'same-day recovery must never discard an acknowledged in-memory reservation');
  await stopProxy(durable.proc, 'SIGKILL');
  processes.delete(durable.proc);

  const persisted = JSON.parse(await readFile(durablePath, 'utf8'));
  assert.equal(persisted.counts['*|all'], 1,
    'an acknowledged start must survive an immediate ungraceful process death');
  const providerEntries = Object.entries(persisted.counts)
    .filter(([key]) => /^h:[a-f0-9]{64}\|qwen$/.test(key));
  assert.deepEqual(providerEntries.map(([, value]) => value), [1]);
  assert.doesNotMatch(JSON.stringify(persisted), /SMESH-READY-DURABLE/,
    'durable accounting must store only one-way license references');

  console.log('backend-vps readiness and durable quota regression passed');
} finally {
  for (const proc of processes) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  mock.close();
}
