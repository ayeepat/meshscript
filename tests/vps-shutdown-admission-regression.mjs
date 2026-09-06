import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
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
  if (req.url === '/v1/chat/completions') {
    upstreamCalls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-shutdown-admission-'));
const quotaPath = path.join(temp, 'quota.json');
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
    QUOTA_FILE: quotaPath
  },
  stdio: 'pipe'
});

try {
  await waitFor(`${base}/health`);
  const body = JSON.stringify({
    provider: 'qwen',
    ...entitlementBody({
      licenseKey: 'SMESH-SHUTDOWN-PENDING-KEY',
      deviceId: '00000000-0000-4000-8000-000000000065'
    }),
    messages: [{ role: 'user', content: 'must not launch during shutdown' }]
  });
  let resolveResponse;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const pending = http.request({
    host: '127.0.0.1', port: proxyPort, path: '/ai/start', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (response) => {
    response.resume();
    response.on('end', () => resolveResponse(response.statusCode));
  });
  pending.on('error', () => resolveResponse(null));
  const split = Math.floor(body.length / 2);
  pending.write(body.slice(0, split));
  await new Promise((resolve) => setTimeout(resolve, 50));

  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  pending.end(body.slice(split));
  const status = await responsePromise;
  if (status != null) assert.equal(status, 503);
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('proxy did not stop')), 3000))
  ]);

  assert.equal(upstreamCalls, 0,
    'a request body completing after shutdown begins must not create new paid work');
  await assert.rejects(access(quotaPath), { code: 'ENOENT' },
    'a shutdown-rejected start must not charge or persist daily quota');

  console.log('vps shutdown admission regression passed');
} finally {
  if (proc.exitCode === null) proc.kill('SIGKILL');
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
