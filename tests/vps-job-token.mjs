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

async function post(url, body, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

async function get(url, headers = {}) {
  return fetch(url, { method: 'GET', headers });
}

const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end('data: {"choices":[{"delta":{"content":"Привет"}}]}\n\ndata: [DONE]\n\n');
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

  const started = await post(`${base}/ai/start`, {
    provider: 'qwen',
    license_key: 'SMESH-TEST-TEST-TEST',
    device_id: 'device-aaaaaaaa',
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(started.status, 200);
  const startJson = await started.json();
  assert.equal(startJson.ok, true);
  assert.match(startJson.job_id, /^[0-9a-f-]{36}$/i);
  assert.match(startJson.job_token, /^[0-9a-f-]{36}$/i);

  const missingToken = await get(`${base}/ai/poll?job=${encodeURIComponent(startJson.job_id)}&cursor=0`);
  assert.equal(missingToken.status, 404, 'poll without X-Job-Token must look like an unknown job');

  const wrongToken = await get(`${base}/ai/poll?job=${encodeURIComponent(startJson.job_id)}&cursor=0`, {
    'X-Job-Token': '00000000-0000-0000-0000-000000000000'
  });
  assert.equal(wrongToken.status, 404, 'poll with the wrong token must look like an unknown job');

  const pollOk = await get(`${base}/ai/poll?job=${encodeURIComponent(startJson.job_id)}&cursor=0`, {
    'X-Job-Token': startJson.job_token
  });
  assert.equal(pollOk.status, 200);
  assert.equal(pollOk.headers.get('cache-control'), 'no-store');
  assert.equal(pollOk.headers.get('access-control-allow-origin'), null);
  const pollJson = await pollOk.json();
  assert.equal(pollJson.ok, true);
  assert.equal(typeof pollJson.chunk, 'string');

  const cancelWrong = await post(`${base}/ai/cancel`, { job: startJson.job_id }, {
    'X-Job-Token': '11111111-1111-1111-1111-111111111111'
  });
  assert.equal(cancelWrong.status, 404, 'known job + wrong token must not cancel');

  const stillThere = await get(`${base}/ai/poll?job=${encodeURIComponent(startJson.job_id)}&cursor=${pollJson.cursor || 0}`, {
    'X-Job-Token': startJson.job_token
  });
  assert.equal(stillThere.status, 200, 'wrong-token cancel must leave the job intact');

  const cancelRight = await post(`${base}/ai/cancel`, { job: startJson.job_id }, {
    'X-Job-Token': startJson.job_token
  });
  assert.equal(cancelRight.status, 200);
  assert.equal((await cancelRight.json()).ok, true);

  const gone = await get(`${base}/ai/poll?job=${encodeURIComponent(startJson.job_id)}&cursor=0`, {
    'X-Job-Token': startJson.job_token
  });
  assert.equal(gone.status, 404, 'right-token cancel must remove the job');

  console.log('vps job token regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
