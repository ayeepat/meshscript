import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      const result = await requestOnce(`${base}/health`, {}, 500);
      if (result.status === 200) return;
      lastError = new Error(`health returned ${result.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  throw lastError || new Error('proxy did not become live');
}

function requestOnce(url, headers = {}, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(url, { agent: false, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
      res.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function pollUrl(base, job) {
  return `${base}/ai/poll?job=${encodeURIComponent(job.job_id)}&cursor=0`;
}

function pollHeaders(job, ip) {
  return {
    'X-Job-Token': job.job_token,
    'X-Forwarded-For': ip,
    Connection: 'close'
  };
}

function openHeldPoll(base, job, ip) {
  let settled = false;
  let aborted = false;
  let settle;
  const outcome = new Promise((resolve) => { settle = resolve; });
  const req = http.get(pollUrl(base, job), {
    agent: false,
    headers: pollHeaders(job, ip)
  }, (res) => {
    res.resume();
    res.once('end', () => {
      if (settled) return;
      settled = true;
      settle({ kind: 'response', status: res.statusCode });
    });
    res.once('error', (error) => {
      if (settled) return;
      settled = true;
      settle({ kind: aborted ? 'aborted' : 'error', error });
    });
  });
  req.once('error', (error) => {
    if (settled) return;
    settled = true;
    settle({ kind: aborted ? 'aborted' : 'error', error });
  });
  return {
    outcome,
    abort() {
      if (settled || aborted) return;
      aborted = true;
      req.destroy();
    }
  };
}

async function assertAllPending(polls, waitMs, message) {
  const first = await Promise.race([
    ...polls.map((poll) => poll.outcome.then((outcome) => ({ outcome }))),
    delay(waitMs).then(() => null)
  ]);
  assert.equal(first, null, `${message}: ${JSON.stringify(first?.outcome || null)}`);
}

async function waitForOutcomes(polls, timeoutMs, message) {
  const timeout = delay(timeoutMs).then(() => {
    throw new Error(`${message} after ${timeoutMs} ms`);
  });
  return Promise.race([Promise.all(polls.map((poll) => poll.outcome)), timeout]);
}

async function expectPendingPoll(base, job, ip, waitMs, message) {
  const held = openHeldPoll(base, job, ip);
  const outcome = await Promise.race([
    held.outcome,
    delay(waitMs).then(() => null)
  ]);
  assert.equal(outcome, null, `${message}: ${JSON.stringify(outcome)}`);
  held.abort();
  await held.outcome;
}

async function expectLimited(base, job, ip, status, message) {
  const result = await requestOnce(pollUrl(base, job), pollHeaders(job, ip));
  assert.equal(result.status, status, `${message}: ${result.body}`);
  assert.equal(result.headers['retry-after'], '1', `${message}: Retry-After must be explicit`);
}

async function startJob(base, index) {
  const response = await fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.0.0.${index + 1}`
    },
    body: JSON.stringify({
      provider: 'qwen',
      license_key: `SMESH-POLL-${String(index + 1).padStart(2, '0')}-TEST`,
      device_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      activation_token: 'a'.repeat(43),
      messages: [{ role: 'user', content: `held poll ${index + 1}` }]
    })
  });
  assert.equal(response.status, 200, await response.clone().text());
  const job = await response.json();
  assert.match(job.job_id, /^[0-9a-f-]{36}$/i);
  assert.match(job.job_token, /^[0-9a-f-]{36}$/i);
  return job;
}

const upstreamResponses = new Set();
const mock = http.createServer((req, res) => {
  if (req.url === '/verify' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    upstreamResponses.add(res);
    res.once('close', () => upstreamResponses.delete(res));
    return;
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = await unusedPort();
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-vps-poll-admission-'));
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, [serverPath], {
  cwd: repoRoot,
  env: {
    ...process.env,
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
const heldPolls = new Set();

function hold(job, ip) {
  const poll = openHeldPoll(base, job, ip);
  heldPolls.add(poll);
  poll.outcome.finally(() => heldPolls.delete(poll));
  return poll;
}

try {
  await waitForHealth(base);

  const jobs = [];
  for (let index = 0; index < 17; index += 1) jobs.push(await startJob(base, index));

  // A natural long-poll heartbeat must release both job/token reservations.
  const timeoutIp = '198.51.100.1';
  const expiring = [hold(jobs[0], timeoutIp), hold(jobs[0], timeoutIp)];
  await assertAllPending(expiring, 250, 'two polls for one job should be admitted');
  await expectLimited(base, jobs[0], timeoutIp, 429, 'a third poll for one job/token must be rejected');
  const expired = await waitForOutcomes(expiring, 5500, 'natural poll heartbeats did not finish');
  assert.deepEqual(expired.map((item) => item.status), [200, 200]);
  await expectPendingPoll(base, jobs[0], timeoutIp, 300,
    'natural response completion must release the job/token reservation');

  // An aborted socket must release immediately rather than waiting four seconds.
  const aborted = [hold(jobs[0], timeoutIp), hold(jobs[0], timeoutIp)];
  await assertAllPending(aborted, 250, 'two replacement polls should be admitted');
  await expectLimited(base, jobs[0], timeoutIp, 429, 'the per-job cap must remain strict');
  aborted[0].abort();
  await aborted[0].outcome;
  await delay(100);
  await expectPendingPoll(base, jobs[0], timeoutIp, 300,
    'an aborted poll must release its reservation immediately');
  aborted[1].abort();
  await aborted[1].outcome;
  await delay(100);

  // Six polls from one origin are allowed; the seventh is rejected even when
  // it targets a fourth valid job that is below its own limit.
  const sharedIp = '198.51.100.10';
  const sharedIpPolls = [];
  for (let index = 0; index < 3; index += 1) {
    sharedIpPolls.push(hold(jobs[index], sharedIp), hold(jobs[index], sharedIp));
  }
  await assertAllPending(sharedIpPolls, 350, 'the first six polls from an IP should be admitted');
  await expectLimited(base, jobs[3], sharedIp, 429, 'the seventh poll from one IP must be rejected');

  // Fill the remaining 26 global slots with valid capabilities on distinct
  // origins. A fresh job and IP must then receive overload without consuming
  // one of the listener slots for the four-second hold.
  const globalPolls = [...sharedIpPolls];
  for (let index = 3; index <= 15; index += 1) {
    const ip = `203.0.113.${index + 1}`;
    globalPolls.push(hold(jobs[index], ip), hold(jobs[index], ip));
  }
  assert.equal(globalPolls.length, 32);
  await assertAllPending(globalPolls, 500, 'all 32 global poll slots should be admitted');
  await expectLimited(base, jobs[16], '192.0.2.77', 503,
    'a fresh user must be rejected at the global poll ceiling');

  const healthStarted = Date.now();
  const health = await requestOnce(`${base}/health`, { Connection: 'close' }, 1200);
  assert.equal(health.status, 200, health.body);
  assert.ok(Date.now() - healthStarted < 1200,
    'poll saturation must leave listener capacity for liveness checks');

  for (const poll of globalPolls) poll.abort();
  await waitForOutcomes(globalPolls, 1500, 'aborted saturated polls did not close');
  await delay(150);
  await expectPendingPoll(base, jobs[16], '192.0.2.77', 300,
    'disconnect cleanup must reopen global admission for another user');

  assert.equal(stderr.includes('uncaughtException'), false, stderr);
  console.log('backend-vps poll admission and teardown regression passed');
} finally {
  for (const poll of heldPolls) poll.abort();
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), delay(2000)]);
  for (const res of upstreamResponses) res.destroy();
  mock.closeAllConnections?.();
  mock.close();
}
