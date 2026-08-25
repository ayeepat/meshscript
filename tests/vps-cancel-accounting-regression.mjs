import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ACTIVATION_TOKEN = 'A'.repeat(43);

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

const mock = http.createServer((req, res) => {
  if (req.url === '/verify') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const unavailable = http.createServer();
const unavailablePort = await listen(unavailable);
await new Promise((resolve) => unavailable.close(resolve));
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-cancel-accounting-'));
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    // A refused connection is provably pre-dispatch and therefore enters the
    // bounded retry delay without risking a duplicate paid request.
    AI_PROXY_BASE_URL: `http://127.0.0.1:${unavailablePort}/v1`,
    AI_PROXY_API_KEY: 'test-key', QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});
let proxyLogs = '';
proc.stderr.on('data', (chunk) => { proxyLogs += chunk; });

const start = () => fetch(`${base}/ai/start`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'qwen', license_key: 'SMESH-CANCEL-TEST-KEY',
    device_id: '00000000-0000-4000-8000-000000000062',
    activation_token: ACTIVATION_TOKEN,
    messages: [{ role: 'user', content: 'hi' }]
  })
});

try {
  await waitFor(`${base}/health`);
  const firstResponse = await start();
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  for (let i = 0; i < 80 && !proxyLogs.includes('upstream fetch failed'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(proxyLogs.includes('upstream fetch failed') && proxyLogs.includes('pre_dispatch=true'),
    'first runner must reach the retry branch before cancellation');
  // Let the next loop iteration pass its pre-sleep signal check; cancellation
  // now lands while the runner is deterministically inside the retry delay.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cancelled = await fetch(`${base}/ai/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Job-Token': first.job_token },
    body: JSON.stringify({ job: first.job_id })
  });
  assert.equal(cancelled.status, 200);

  const second = await start();
  assert.equal(second.status, 200, 'one new job may coexist with the cancelling runner');
  const third = await start();
  assert.equal(third.status, 429,
    'a cancelled job must retain its active slot until upstream cleanup actually settles');

  console.log('vps cancellation accounting regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
