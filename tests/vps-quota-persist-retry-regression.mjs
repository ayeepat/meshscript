import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
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
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-quota-retry-'));
const quotaPath = path.join(temp, 'quota.json');
// A directory at the target path makes the first atomic rename fail without
// weakening the parent directory or touching any external file.
await mkdir(quotaPath);
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
let logs = '';
proc.stderr.on('data', (chunk) => { logs += chunk; });

try {
  await waitFor(`${base}/health`);
  const notReady = await fetch(`${base}/ready`);
  assert.equal(notReady.status, 503, await notReady.clone().text());
  assert.equal((await notReady.json()).checks.quota_store, false);

  const blocked = await fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'qwen',
      ...entitlementBody({
        licenseKey: 'SMESH-QUOTA-RETRY-KEY',
        deviceId: '00000000-0000-4000-8000-000000000064'
      }),
      messages: [{ role: 'user', content: 'persist me' }]
    })
  });
  assert.equal(blocked.status, 503, await blocked.clone().text(),
    'admission must fail closed while quota state cannot be read or persisted');
  for (let i = 0; i < 100 && !logs.includes('admissions disabled'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(logs, /quota (?:load|persist) failed; admissions disabled/,
    'the probe must exercise the storage-health latch');

  await rename(quotaPath, path.join(temp, 'former-quota-directory'));
  const recovered = await fetch(`${base}/ready`);
  assert.equal(recovered.status, 200, await recovered.clone().text(),
    'readiness must recover after the quota target is repaired');
  const started = await fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'qwen',
      ...entitlementBody({
        licenseKey: 'SMESH-QUOTA-RETRY-KEY',
        deviceId: '00000000-0000-4000-8000-000000000064'
      }),
      messages: [{ role: 'user', content: 'persist me after repair' }]
    })
  });
  assert.equal(started.status, 200, await started.clone().text());
  proc.kill('SIGTERM');
  await Promise.race([
    once(proc, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('proxy did not stop')), 3000))
  ]);

  const persisted = JSON.parse(await readFile(quotaPath, 'utf8'));
  assert.equal(persisted.counts['*|all'], 1,
    'graceful shutdown must retry a previously failed dirty quota write');
  assert.deepEqual(
    Object.entries(persisted.counts)
      .filter(([key]) => /^h:[a-f0-9]{64}\|qwen$/.test(key))
      .map(([, value]) => value),
    [1]
  );

  console.log('vps quota persistence fail-closed recovery regression passed');
} finally {
  if (proc.exitCode === null) proc.kill('SIGKILL');
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
