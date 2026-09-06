import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entitlementBody, TEST_VPS_SECURITY_ENV } from '../../tests/helpers/vps-entitlement.mjs';

/* Idempotent /ai/start must never hand back a job that no longer exists.
 * handleAiCancel and the job GC delete jobs without touching the idempotency
 * entries (whose TTL outlives JOB_LINGER_MS), so a lost-response retry after a
 * cancel used to receive a job_id that every /ai/poll would 404 on until the
 * entry itself expired. The replay branch must re-check the recorded job and
 * fall through to a fresh start when it is gone. */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    await delay(25);
  }
  throw lastError || new Error('proxy did not become live');
}

async function waitForUpstreamCalls(count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (upstreamCalls >= count) return;
    await delay(25);
  }
  throw new Error(`only ${upstreamCalls} upstream calls after ${timeoutMs} ms, expected ${count}`);
}

let upstreamCalls = 0;
const upstreamResponses = new Set();
const mock = http.createServer((req, res) => {
  if (req.url === '/verify' && req.method === 'POST') {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    upstreamCalls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    upstreamResponses.add(res);
    res.once('close', () => upstreamResponses.delete(res));
    return;
  }
  req.resume();
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = await unusedPort();
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-vps-idem-replay-'));
// Exercise the real GC seam without making the regression wait 90 seconds.
// Only this temporary server copy gets accelerated timers; production constants
// and every other behavior remain byte-for-byte canonical.
const canonicalServer = await readFile(serverPath, 'utf8');
assert.match(canonicalServer, /const JOB_ABANDON_MS = 90 \* 1000;/);
assert.match(canonicalServer, /const JOB_GC_INTERVAL_MS = 30 \* 1000;/);
const acceleratedServer = canonicalServer
  .replace('const JOB_ABANDON_MS = 90 * 1000;', 'const JOB_ABANDON_MS = 500;')
  .replace('const JOB_GC_INTERVAL_MS = 30 * 1000;', 'const JOB_GC_INTERVAL_MS = 25;');
const acceleratedServerPath = path.join(temp, 'server.js');
await writeFile(acceleratedServerPath, acceleratedServer);
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, [acceleratedServerPath], {
  cwd: repoRoot,
  env: {
    ...process.env,
    ...TEST_VPS_SECURITY_ENV,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    AI_PROXY_API_KEY: 'test-key',
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
proc.stderr.on('data', (chunk) => { stderr += chunk; });

// One frozen body string: an idempotent retry must resend the exact bytes.
const identity = {
  licenseKey: 'SMESH-IDEM-01-TEST',
  deviceId: '00000000-0000-4000-8000-000000000001'
};
const startBody = JSON.stringify({
  provider: 'qwen',
  ...entitlementBody(identity),
  idempotency_key: 'idem-replay-key-01',
  messages: [{ role: 'user', content: 'idempotent replay probe' }]
});
const start = async (body, ip = '198.51.100.20') => {
  const response = await fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body
  });
  return { status: response.status, json: await response.json() };
};

try {
  await waitForHealth(base);

  const first = await start(startBody);
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const jobA = first.json;
  assert.match(jobA.job_id, /^[0-9a-f-]{36}$/i);
  await waitForUpstreamCalls(1, 3000);

  // An identical retry while the job lives still replays the original job —
  // the mechanism's whole point (no second paid upstream call).
  const replay = await start(startBody);
  assert.equal(replay.status, 200, JSON.stringify(replay.json));
  assert.equal(replay.json.job_id, jobA.job_id,
    'a live job must still be recoverable by an identical retry');
  assert.equal(replay.json.job_token, jobA.job_token);
  await waitForUpstreamCalls(1, 1000);
  assert.equal(upstreamCalls, 1, 'a replay must not start a second upstream job');

  // Let the accelerated abandonment sweep delete the job WITHOUT deleting its
  // idempotency entry. This is the seam that requires jobs.has(existing.jobId)
  // in the replay branch; cancel cleanup alone cannot make this pass.
  await delay(900);
  const deadPoll = await fetch(`${base}/ai/poll?job=${encodeURIComponent(jobA.job_id)}&cursor=0`, {
    headers: { 'X-Job-Token': jobA.job_token }
  });
  assert.equal(deadPoll.status, 404, 'the abandoned job must be gone');

  // The exact lost-response retry: identical bytes, same idempotency key. It
  // must NOT receive the dead job_id back — that answer 404s on every poll
  // until the entry expires. It must start a fresh, reachable job instead.
  const afterAbandon = await start(startBody);
  assert.equal(afterAbandon.status, 200, JSON.stringify(afterAbandon.json));
  const jobB = afterAbandon.json;
  assert.notEqual(jobB.job_id, jobA.job_id,
    'a retry after abandonment must never resolve to the deleted job');
  await waitForUpstreamCalls(2, 3000);

  // The digest binding stays strict: same key with different content is a
  // conflict, not a silent wrong-job answer.
  const divergent = await start(JSON.stringify({
    provider: 'qwen',
    ...entitlementBody(identity),
    idempotency_key: 'idem-replay-key-01',
    messages: [{ role: 'user', content: 'different content entirely' }]
  }));
  assert.equal(divergent.status, 409,
    'reusing a key for different request bytes must stay a conflict');

  // The fresh job is real: cancelling it with ITS token works, and cancel must
  // remove only this job's entry so another identical start can proceed.
  const cancelB = await fetch(`${base}/ai/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Job-Token': jobB.job_token },
    body: JSON.stringify({ job: jobB.job_id })
  });
  assert.equal(cancelB.status, 200);
  const afterExplicitCancel = await start(startBody);
  assert.equal(afterExplicitCancel.status, 200, JSON.stringify(afterExplicitCancel.json));
  const jobC = afterExplicitCancel.json;
  assert.notEqual(jobC.job_id, jobB.job_id);
  await waitForUpstreamCalls(3, 3000);
  const cancelC = await fetch(`${base}/ai/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Job-Token': jobC.job_token },
    body: JSON.stringify({ job: jobC.job_id })
  });
  assert.equal(cancelC.status, 200);

  assert.equal(stderr.includes('uncaughtException'), false, stderr);
  console.log('backend-vps start idempotency replay regression passed');
} finally {
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), delay(2000)]);
  for (const res of upstreamResponses) res.destroy();
  mock.closeAllConnections?.();
  mock.close();
}
