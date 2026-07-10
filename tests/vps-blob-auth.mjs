import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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

async function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
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
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-test-'));
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
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});

try {
  await waitFor(`${base}/health`);

  const anonymous = await post(`${base}/ai/blob`, {
    blob_id: 'not-authorized', seq: 0, total: 1, chunk: '[]'
  });
  assert.equal(anonymous.status, 403, 'anonymous callers must not allocate a blob');

  const deviceA = 'device-aaaaaaaa';
  const ticketRes = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TEST-TEST-TEST', device_id: deviceA
  });
  assert.equal(ticketRes.status, 200);
  const ticket = await ticketRes.json();
  assert.equal(ticket.ok, true);

  const wrongBlob = await post(`${base}/ai/blob`, {
    blob_id: 'someone-elses-blob', upload_token: ticket.upload_token,
    seq: 0, total: 1, chunk: '[]'
  });
  assert.equal(wrongBlob.status, 403, 'a ticket must be bound to one server-issued blob id');

  const uploaded = await post(`${base}/ai/blob`, {
    blob_id: ticket.blob_id, upload_token: ticket.upload_token,
    seq: 0, total: 1, chunk: JSON.stringify([{ role: 'user', content: 'hi' }])
  });
  assert.equal(uploaded.status, 200);
  assert.equal((await uploaded.json()).complete, true);

  const wrongOwner = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: 'SMESH-TEST-TEST-TEST',
    device_id: 'device-bbbbbbbb', messages_blob: ticket.blob_id
  });
  assert.equal(wrongOwner.status, 403, 'a completed blob must be bound to its uploading device');

  const started = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: 'SMESH-TEST-TEST-TEST',
    device_id: deviceA, messages_blob: ticket.blob_id
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).ok, true);

  // Adaptive-size fallback: the client's probe attempt may land a chunk on the
  // server even when the client saw only timeouts; the RU-safe retry then
  // re-sends the SAME blob with a different total. Same ticket → the server
  // must restart the blob, not 403 the upload into a dead end.
  const ticket2Res = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TEST-TEST-TEST', device_id: deviceA
  });
  assert.equal(ticket2Res.status, 200);
  const ticket2 = await ticket2Res.json();

  const probeChunk = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    seq: 0, total: 3, chunk: 'stray-probe-bytes'
  });
  assert.equal(probeChunk.status, 200, 'probe chunk should be accepted');

  const payload = JSON.stringify([{ role: 'user', content: 'hello again' }]);
  const half = Math.ceil(payload.length / 2);
  const retry0 = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    seq: 0, total: 2, chunk: payload.slice(0, half)
  });
  assert.equal(retry0.status, 200, 'size-fallback retry with a new total must restart the blob, not 403');
  const retry1 = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    seq: 1, total: 2, chunk: payload.slice(half)
  });
  assert.equal(retry1.status, 200);
  assert.equal((await retry1.json()).complete, true, 'restarted blob must complete cleanly');

  const restarted = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: 'SMESH-TEST-TEST-TEST',
    device_id: deviceA, messages_blob: ticket2.blob_id
  });
  assert.equal(restarted.status, 200, 'a restarted blob must redeem with intact data');
  assert.equal((await restarted.json()).ok, true);

  console.log('vps blob authorization regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
