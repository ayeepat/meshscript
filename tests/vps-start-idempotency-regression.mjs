/**
 * M-3: a lost /ai/start response must not buy a second upstream job.
 *
 * The server launches the job from the response's `finish` event — the kernel
 * accepting the bytes, not the client receiving them. A probe that read zero
 * response bytes, destroyed the socket and retried produced TWO upstream calls
 * and quota usage of two. A client-generated idempotency key bound to the
 * principal and the request digest now returns the original job on retry.
 *
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { entitlementBody, TEST_VPS_SECURITY_ENV } from './helpers/vps-entitlement.mjs';

const LICENSE = 'SMESH-IDEMPOTENT-START';
const DEVICE = '11111111-1111-4111-8111-111111111111';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(url) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server never became ready: ${url}`);
}

let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url === '/v1/chat/completions') {
    upstreamCalls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-idem-test-'));
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...TEST_VPS_SECURITY_ENV,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_PROXY_API_KEY: 'test-key',
    PROXY_QWEN_DAILY: '5',
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});

const entitlementByPrincipal = new Map();
function authenticatedBody(body) {
  if (!body?.license_key) return body;
  const { license_key: licenseKey, device_id: deviceId, activation_token: _unused, ...rest } = body;
  const principal = `${licenseKey}\u0000${deviceId}`;
  let entitlement = entitlementByPrincipal.get(principal);
  if (!entitlement) {
    entitlement = entitlementBody({ licenseKey, deviceId });
    entitlementByPrincipal.set(principal, entitlement);
  }
  return { ...rest, ...entitlement };
}

const start = (body) => fetch(`${base}/ai/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(authenticatedBody(body))
});

async function drain(job) {
  for (let i = 0; i < 100; i++) {
    const poll = await fetch(
      `${base}/ai/poll?job=${encodeURIComponent(job.job_id)}&cursor=0`,
      { headers: { 'X-Job-Token': job.job_token } }
    );
    if (poll.status === 404) return;
    if ((await poll.json()).done === true) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('job did not settle');
}

try {
  await waitFor(`${base}/health`);

  /* ---- a repeated key returns the SAME job and buys nothing more ---- */
  const request = {
    provider: 'qwen',
    license_key: LICENSE,
    device_id: DEVICE,
    idempotency_key: 'retry-key-0001',
    messages: [{ role: 'user', content: 'hi' }]
  };
  const first = await start(request);
  assert.equal(first.status, 200, await first.clone().text());
  const firstJob = await first.json();

  const replay = await start(request);
  assert.equal(replay.status, 200);
  const replayJob = await replay.json();
  assert.equal(replayJob.job_id, firstJob.job_id,
    'a retry with the same key must resolve to the original job');
  assert.equal(replayJob.job_token, firstJob.job_token,
    'and to the original capability, so the client can actually read it');
  // The runner is launched asynchronously (on the response's finish event), so
  // count only once both jobs would have had their chance to dispatch.
  await drain(firstJob);
  await drain(replayJob);
  assert.equal(upstreamCalls, 1,
    'the retry must not create a second paid upstream job');

  /* ---- the key is bound to the request content ---- */
  const tampered = await start({ ...request, messages: [{ role: 'user', content: 'different' }] });
  assert.equal(tampered.status, 409,
    'reusing a key for different content must be refused, not silently answered');

  /* ---- and to the principal ---- */
  const otherDevice = await start({
    ...request, device_id: '22222222-2222-4222-8222-222222222222'
  });
  assert.equal(otherDevice.status, 409,
    'a leaked key must not let another principal adopt the job');

  /* ---- distinct keys still start distinct jobs ---- */
  const beforeFresh = upstreamCalls;
  const fresh = await start({ ...request, idempotency_key: 'retry-key-0002' });
  assert.equal(fresh.status, 200);
  const freshJob = await fresh.json();
  assert.notEqual(freshJob.job_id, firstJob.job_id);
  await drain(freshJob);
  assert.equal(upstreamCalls, beforeFresh + 1, 'a new key is a new job');

  /* ---- omitting the key keeps the old, non-idempotent behaviour ---- */
  const bare = { provider: 'qwen', license_key: LICENSE, device_id: DEVICE,
    messages: [{ role: 'user', content: 'bare' }] };
  const bareStart = await start(bare);
  assert.equal(bareStart.status, 200);
  await drain(await bareStart.json());

  /* ---- replay survives one-shot blob consumption and deletion ---- */
  const blobMessages = JSON.stringify([{ role: 'user', content: 'blob-backed retry' }]);
  const ticketResponse = await fetch(`${base}/ai/upload-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...entitlementBody({ licenseKey: LICENSE, deviceId: DEVICE }),
      size: blobMessages.length,
    }),
  });
  assert.equal(ticketResponse.status, 200, await ticketResponse.clone().text());
  const ticket = await ticketResponse.json();
  const uploaded = await fetch(`${base}/ai/blob`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      blob_id: ticket.blob_id,
      upload_token: ticket.upload_token,
      seq: 0,
      total: 1,
      chunk: blobMessages,
    }),
  });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).complete, true);

  const blobRequest = {
    provider: 'qwen',
    license_key: LICENSE,
    device_id: DEVICE,
    idempotency_key: 'retry-key-blob-0001',
    messages_blob: ticket.blob_id,
  };
  const firstBlobStart = await start(blobRequest);
  assert.equal(firstBlobStart.status, 200, await firstBlobStart.clone().text());
  const firstBlobJob = await firstBlobStart.json();
  // The first start consumed and freed the one-shot blob. Idempotency must be
  // checked before trying to redeem it again, or this legitimate retry gets a
  // 410 and tempts the client to rebuild/pay for a second job.
  const replayBlobStart = await start(blobRequest);
  assert.equal(replayBlobStart.status, 200, await replayBlobStart.clone().text());
  const replayBlobJob = await replayBlobStart.json();
  assert.equal(replayBlobJob.job_id, firstBlobJob.job_id);
  assert.equal(replayBlobJob.job_token, firstBlobJob.job_token);
  await drain(firstBlobJob);

  console.log('vps /ai/start idempotency regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
