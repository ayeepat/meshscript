/**
 * The per-license daily cap must apply to EVERY admitted job.
 *
 * `PROVIDERS[body.provider]` also resolved Object.prototype members, so
 * `provider:"constructor"` passed the unknown-provider gate with an object that
 * has no `cap`. chargeQuota then evaluated `mine > provider.cap` as
 * `1 > undefined` — false — so the request was admitted with NO per-license
 * limit, charging only the shared global breaker. With a PDF part this was not
 * merely a wasted counter: modelChoices() short-circuits on hasPdfs and routes
 * to the Gemini chain regardless of provider, so the request really ran and
 * really cost money, unbounded by the license's own cap.
 *
 * Also covers the reservation release: an admitted job whose upstream stream
 * never opens must not consume the student's day.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const LICENSE = 'SMESH-CAPS-TEST-0001';
const DEVICE = '00000000-0000-4000-8000-0000000000aa';
const ACTIVATION_TOKEN = 'A'.repeat(43);
// A one-request cap makes "the cap is enforced at all" unambiguous.
const PER_LICENSE_CAP = 1;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function waitFor(url) {
  let last;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = new Error(`health returned ${res.status}`);
    } catch (e) { last = e; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last || new Error('proxy did not start');
}

async function post(url, body, headers = {}) {
  const authenticatedBody = body?.license_key && body.activation_token == null
    ? { ...body, activation_token: ACTIVATION_TOKEN }
    : body;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(authenticatedBody)
  });
}

let upstreamCalls = 0;
// 'ok' streams an answer; 'ambiguous' is a bare 5xx (the provider may already
// have done paid work we never got to read); 'refused' is an explicit
// non-billable rejection.
let upstreamMode = 'ok';
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    upstreamCalls += 1;
    if (upstreamMode === 'ambiguous') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'upstream down' } }));
    }
    if (upstreamMode === 'refused') {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'payment required' } }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  }
  res.writeHead(404).end();
});

// A minimal, canonically-padded one-page PDF data URI — enough to make
// sanitizeMessages classify the request as a PDF job (the routing that turns
// the missing cap into real spend).
const PDF_DATA_URI = 'data:application/pdf;base64,JVBERi0xLjQK';

function pdfMessages() {
  return [{
    role: 'user',
    content: [
      { type: 'text', text: 'solve this' },
      { type: 'file', file: { filename: 'hw.pdf', file_data: PDF_DATA_URI } }
    ]
  }];
}

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-cap-test-'));
const quotaFile = path.join(temp, 'quota.json');
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_PROXY_API_KEY: 'test-key',
    PROXY_QWEN_DAILY: String(PER_LICENSE_CAP),
    PROXY_DEEPSEEK_DAILY: String(PER_LICENSE_CAP),
    QUOTA_FILE: quotaFile
  },
  stdio: 'pipe'
});

async function quotaCounts() {
  try { return JSON.parse(await readFile(quotaFile, 'utf8')).counts; }
  catch { return {}; }
}

function globalCount(counts) {
  return counts['*|all'] || 0;
}

// Poll a job until its runner has settled. Every quota assertion below depends
// on the background runner having finished — otherwise a still-connecting job
// can release its slot after the assertion reads the file.
async function drain(job) {
  for (let i = 0; i < 100; i++) {
    const poll = await fetch(
      `${base}/ai/poll?job=${encodeURIComponent(job.job_id)}&cursor=0`,
      { headers: { 'X-Job-Token': job.job_token } }
    );
    if (poll.status === 404) return; // already garbage collected
    if ((await poll.json()).done === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('job did not settle');
}

try {
  await waitFor(`${base}/health`);

  /* --- a prototype member is not a provider, with or without a PDF --- */
  for (const provider of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const callsBefore = upstreamCalls;
    const response = await post(`${base}/ai/start`, {
      provider,
      license_key: LICENSE,
      device_id: DEVICE,
      messages: pdfMessages()
    });
    assert.equal(response.status, 400,
      `provider="${provider}" must be rejected as unknown`);
    assert.equal((await response.json()).error.message, 'Неизвестный провайдер.');
    assert.equal(upstreamCalls, callsBefore,
      `provider="${provider}" must not reach the paid upstream`);
    assert.equal(globalCount(await quotaCounts()), 0,
      `provider="${provider}" must not consume the global daily breaker`);
  }

  /* ------- the real provider is capped, and the cap actually bites ------- */
  const first = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: LICENSE, device_id: DEVICE,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(globalCount(await quotaCounts()), 1,
    'an admitted job must durably reserve one slot before responding');
  // Let it finish against a healthy upstream: a job that produced an answer
  // keeps its slot, which is what makes the next assertion meaningful.
  await drain(await first.json());
  assert.equal(globalCount(await quotaCounts()), 1,
    'a job that really streamed an answer must keep its reservation');

  const overCap = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: LICENSE, device_id: DEVICE,
    messages: [{ role: 'user', content: 'again' }]
  });
  assert.equal(overCap.status, 429, 'the per-license daily cap must reject the next job');
  assert.match((await overCap.json()).error.message, /Дневной лимит/);

  /* ------ an AMBIGUOUS upstream failure keeps its reservation ------- */
  // Same license, a different provider so the qwen cap is not what rejects it.
  // "No stream opened" is NOT proof of zero spend: the request body reached the
  // provider, so a bare 5xx may follow completed paid work. Refunding it let a
  // caller buy unbounded ambiguous work under a cap of one.
  upstreamMode = 'ambiguous';
  const beforeAmbiguous = globalCount(await quotaCounts());
  const ambiguous = await post(`${base}/ai/start`, {
    provider: 'deepseek', license_key: LICENSE, device_id: DEVICE,
    messages: [{ role: 'user', content: 'upstream will fail' }]
  });
  assert.equal(ambiguous.status, 200, 'the job is admitted; the failure happens in the runner');
  await drain(await ambiguous.json());
  assert.equal(globalCount(await quotaCounts()), beforeAmbiguous + 1,
    'an ambiguous upstream failure must keep consuming the daily allowance');

  // And the cap therefore actually bites: the deepseek allowance is spent.
  const overCapAfterAmbiguous = await post(`${base}/ai/start`, {
    provider: 'deepseek', license_key: LICENSE, device_id: DEVICE,
    messages: [{ role: 'user', content: 'again' }]
  });
  assert.equal(overCapAfterAmbiguous.status, 429,
    'ambiguous provider work must still exhaust the per-license cap');

  console.log('vps provider cap bypass regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
