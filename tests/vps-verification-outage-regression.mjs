import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  issueTestEntitlement, TEST_VPS_SECURITY_ENV
} from './helpers/vps-entitlement.mjs';

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
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-verify-outage-'));
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...TEST_VPS_SECURITY_ENV,
    HOST: '127.0.0.1', PORT: String(proxyPort),
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_PROXY_API_KEY: 'test-key',
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});
let logs = '';
proc.stderr.on('data', (chunk) => { logs += chunk; });

const ticket = (entitlementToken, extra = {}) => fetch(`${base}/ai/upload-ticket`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    entitlement_token: entitlementToken, size: 1, ...extra
  })
});

try {
  await waitFor(`${base}/health`);

  const valid = issueTestEntitlement({
    licenseKey: 'SMESH-LOCAL-ONLY-KEY',
    deviceId: '00000000-0000-4000-8000-000000000073'
  });
  assert.equal((await ticket(valid)).status, 200);

  const expired = issueTestEntitlement({
    licenseKey: 'SMESH-EXPIRED-KEY',
    deviceId: '00000000-0000-4000-8000-000000000074',
    now: Date.now() - 11 * 60 * 1000
  });
  assert.equal((await ticket(expired)).status, 403,
    'expired capabilities must fail closed without any grace period');

  const tampered = valid.slice(0, -1) + (valid.endsWith('A') ? 'B' : 'A');
  assert.equal((await ticket(tampered, {
    license_key: 'SMESH-MUST-NOT-BE-LOGGED',
    device_id: '00000000-0000-4000-8000-000000000075'
  })).status, 403);
  assert.equal(logs.includes(valid), false, 'entitlement tokens must never enter diagnostics');
  assert.equal(logs.includes('SMESH-MUST-NOT-BE-LOGGED'), false,
    'caller-supplied raw credentials must never enter diagnostics');

  console.log('vps entitlement expiry and no-content-log regressions passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
