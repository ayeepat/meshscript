import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

const mock = http.createServer((req, res) => {
  if (req.url === '/verify') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-shutdown-'));
const quotaPath = path.join(temp, 'quota.json');
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...TEST_VPS_SECURITY_ENV,
    HOST: '127.0.0.1', PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_PROXY_API_KEY: 'test-key', QUOTA_FILE: quotaPath
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
        licenseKey: 'SMESH-SHUTDOWN-TEST-KEY',
        deviceId: '00000000-0000-4000-8000-000000000066'
      }),
      messages: [{ role: 'user', content: 'hi' }]
    })
  });
  assert.equal(started.status, 200, await started.clone().text());

  // The normal persistence path is intentionally debounced for 500 ms. A
  // systemd restart immediately after admission must still preserve the charge.
  proc.kill('SIGTERM');
  await Promise.race([
    once(proc, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('proxy did not stop')), 3000))
  ]);

  const persisted = JSON.parse(await readFile(quotaPath, 'utf8'));
  const qwenCounts = Object.entries(persisted.counts)
    .filter(([key]) => /^h:[a-f0-9]{64}\|qwen$/.test(key))
    .map(([, value]) => value);
  assert.deepEqual(qwenCounts, [1], 'SIGTERM must flush the admitted per-license charge');
  assert.equal(persisted.counts['*|all'], 1, 'SIGTERM must flush the global charge too');

  console.log('vps shutdown quota regression passed');
} finally {
  if (proc.exitCode === null) proc.kill('SIGKILL');
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
