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

let authorityUnavailable = false;
const mock = http.createServer((req, res) => {
  if (req.url !== '/verify') return res.writeHead(404).end();
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.key.includes('REDACT')) {
      res.writeHead(502, { 'Content-Type': 'text/plain', 'CF-Ray': 'test-ray' });
      return res.end(`upstream reflected ${body.key} and ${body.device_id}`);
    }
    if (body.key.includes('MALFORMED')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: 'false', reason: 'revoked' }));
    }
    if (authorityUnavailable) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'service_unavailable' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  });
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-verify-outage-'));
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST: '127.0.0.1', PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    AI_PROXY_API_KEY: 'test-key',
    PROXY_VERIFY_CACHE_TTL_MS: '100',
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});
let logs = '';
proc.stderr.on('data', (chunk) => { logs += chunk; });

const ticket = (key, deviceId) => fetch(`${base}/ai/upload-ticket`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    license_key: key, device_id: deviceId,
    activation_token: ACTIVATION_TOKEN, size: 1
  })
});

try {
  await waitFor(`${base}/health`);

  const goodKey = 'SMESH-GRACE-TEST-KEY';
  const goodDevice = '00000000-0000-4000-8000-000000000073';
  assert.equal((await ticket(goodKey, goodDevice)).status, 200);

  const malformed = await ticket(
    'SMESH-MALFORMED-VERDICT-KEY',
    '00000000-0000-4000-8000-000000000074'
  );
  assert.equal(malformed.status, 503,
    'a truthy non-boolean verifier verdict must fail closed, never authorize an upload capability');

  await new Promise((resolve) => setTimeout(resolve, 150));
  authorityUnavailable = true;

  const grace = await ticket(goodKey, goodDevice);
  assert.equal(grace.status, 200,
    'a recent positive verdict may use the documented grace window while revocation authority is unavailable');

  const fresh = await ticket('SMESH-FRESH-TEST-KEY', '00000000-0000-4000-8000-000000000075');
  assert.equal(fresh.status, 503,
    'service_unavailable is infrastructure failure, not a 403 license verdict');

  const reflectedKey = 'SMESH-REDACT-SECRET-KEY';
  const reflectedDevice = '00000000-0000-4000-8000-000000000076';
  const reflected = await ticket(reflectedKey, reflectedDevice);
  assert.equal(reflected.status, 503);
  assert.equal(logs.includes(reflectedKey), false, 'verify diagnostics must redact reflected bearer keys');
  assert.equal(logs.includes(reflectedDevice), false, 'verify diagnostics must redact reflected device ids');
  assert.match(logs, /\[REDACTED\]/, 'diagnostics remain useful while sensitive values are masked');

  console.log('vps verification outage and log-redaction regressions passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
