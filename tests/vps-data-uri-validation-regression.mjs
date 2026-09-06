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

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url === '/verify') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    upstreamCalls += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: [DONE]\n\n');
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-data-uri-'));
const base = `http://127.0.0.1:${proxyPort}`;
const proc = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ...TEST_VPS_SECURITY_ENV,
    HOST: '127.0.0.1', PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_PROXY_API_KEY: 'test-key', QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});

let requestDeviceSequence = 0;
const request = (content, suffix) => {
  const identity = {
    licenseKey: `SMESH-DATA-${suffix}-KEY`,
    deviceId: `00000000-0000-4000-8000-${String(++requestDeviceSequence).padStart(12, '0')}`,
  };
  return {
    provider: 'qwen',
    ...entitlementBody(identity),
    messages: [{ role: 'user', content }]
  };
};

try {
  await waitFor(`${base}/health`);

  const unicodeImage = await post(`${base}/ai/start`, request([{
    type: 'image_url', image_url: { url: `data:image/png;base64,${'🙂'.repeat(1024)}` }
  }], 'unicode-image'));
  assert.equal(unicodeImage.status, 400,
    'a data-URI character cap must not accept multi-byte Unicode disguised as base64');

  const unicodePdf = await post(`${base}/ai/start`, request([{
    type: 'file', file: { filename: 'task.pdf', file_data: 'data:application/pdf;base64,🙂🙂' }
  }], 'unicode-pdf'));
  assert.equal(unicodePdf.status, 400, 'PDF data URIs must carry canonical base64 too');

  const badPadding = await post(`${base}/ai/start`, request([{
    type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA=' }
  }], 'padding'));
  assert.equal(badPadding.status, 400, 'non-canonical base64 padding must be rejected');

  const nonzeroFourBits = await post(`${base}/ai/start`, request([{
    type: 'image_url', image_url: { url: 'data:image/png;base64,Zh==' }
  }], 'unused-four'));
  assert.equal(nonzeroFourBits.status, 400,
    'two-padding base64 must have zero unused bits (canonical encoding is Zg==)');

  const nonzeroTwoBits = await post(`${base}/ai/start`, request([{
    type: 'file', file: { filename: 'task.pdf', file_data: 'data:application/pdf;base64,Zm9=' }
  }], 'unused-two'));
  assert.equal(nonzeroTwoBits.status, 400,
    'one-padding base64 must have zero unused bits (canonical encoding is Zm8=)');
  assert.equal(upstreamCalls, 0, 'invalid encoded bodies must never reach the paid upstream');

  const validCanonicalTails = await post(`${base}/ai/start`, request([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,Zg==' } },
    { type: 'file', file: { filename: 'task.pdf', file_data: 'data:application/pdf;base64,Zm8=' } }
  ], 'canonical-tails'));
  assert.equal(validCanonicalTails.status, 200, await validCanonicalTails.clone().text());

  const valid = await post(`${base}/ai/start`, request([{
    type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' }
  }], 'valid'));
  assert.equal(valid.status, 200, await valid.clone().text());
  for (let i = 0; i < 40 && upstreamCalls < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(upstreamCalls, 2,
    'canonical base64 remains accepted for both legal padding forms and a normal image');

  console.log('vps data-URI validation regressions passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
