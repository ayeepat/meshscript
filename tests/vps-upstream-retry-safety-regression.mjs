import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { entitlementBody, TEST_VPS_SECURITY_ENV } from './helpers/vps-entitlement.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('proxy did not start');
}

let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url === '/verify') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    upstreamCalls += 1;
    // The provider received the paid POST body, then the transport disappeared
    // before response headers. Retrying this state is financially ambiguous:
    // the first model invocation may already be running/billed.
    req.resume();
    req.on('end', () => res.destroy());
    return;
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-retry-safety-'));
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
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});

try {
  await waitFor(`${base}/health`);
  const started = await fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'qwen',
      ...entitlementBody({
        licenseKey: 'SMESH-AMBIGUOUS-RETRY-KEY',
        deviceId: '00000000-0000-4000-8000-000000000068'
      }),
      messages: [{ role: 'user', content: 'one paid attempt only' }]
    })
  });
  assert.equal(started.status, 200, await started.clone().text());
  const job = await started.json();

  let final = null;
  for (let i = 0; i < 20; i++) {
    const poll = await fetch(
      `${base}/ai/poll?job=${encodeURIComponent(job.job_id)}&cursor=0`,
      { headers: { 'X-Job-Token': job.job_token } }
    );
    assert.equal(poll.status, 200);
    final = await poll.json();
    if (final.done) break;
  }
  assert.equal(final?.done, true);
  assert.equal(typeof final.error, 'string');

  // The old retry loop made its third call after 2.7 seconds. Waiting beyond
  // that proves this ambiguous failure did not silently multiply provider cost.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  assert.equal(upstreamCalls, 1,
    'a POST that reached the provider must never be automatically replayed after an ambiguous reset');

  console.log('vps upstream retry safety regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
