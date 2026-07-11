import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// End-to-end: a poll job that streams a usage frame from the (mock) 302.AI
// upstream must produce exactly one POST /t/ai report to the (mock) worker,
// carrying the shared INGEST_KEY, the real token counts, the model id and a
// nonzero list-rate cost estimate — the server-truth series the dashboard
// charts as "API-вызовы (сервер)".

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

const SSE =
  'data: {"model":"qwen3.7-plus","choices":[{"delta":{"content":"Привет"}}]}\n\n' +
  'data: {"model":"qwen3.7-plus","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n' +
  'data: [DONE]\n\n';

let resolveReport;
const reported = new Promise((resolve) => { resolveReport = resolve; });

const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end(SSE);
  }
  if (req.url === '/t/ai' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, accepted: 1 }));
      resolveReport({
        key: req.headers['x-ingest-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      });
    });
    return;
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
    INGEST_URL: `http://127.0.0.1:${mockPort}/t/ai`,
    INGEST_KEY: 'ingest-secret-for-test',
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

  const report = await Promise.race([
    reported,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no /t/ai report within 10s')), 10000))
  ]);

  assert.equal(report.key, 'ingest-secret-for-test', 'report must authenticate with INGEST_KEY');
  assert.equal(report.body.events.length, 1);
  const ev = report.body.events[0];
  assert.equal(ev.device_id, 'device-aaaaaaaa');
  assert.equal(ev.provider, 'qwen');
  assert.equal(ev.model, 'qwen3.7-plus');
  assert.equal(ev.tokens_in, 1000);
  assert.equal(ev.tokens_out, 500);
  assert.ok(ev.cost_usd > 0, 'list-rate estimate must be nonzero for known models');
  assert.equal(ev.meta.src, 'vps');
  assert.equal(ev.meta.ok, true);
  assert.equal(ev.meta.est_rates, true);

  console.log('vps usage report regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
