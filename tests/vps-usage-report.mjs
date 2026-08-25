import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ACTIVATION_TOKEN = 'A'.repeat(43);

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
  const authenticatedBody = body?.license_key && body.activation_token == null
    ? { ...body, activation_token: ACTIVATION_TOKEN }
    : body;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(authenticatedBody)
  });
}

// Visible content is delayed behind an INSTANT role-only delta (a real
// upstream keepalive), so the test can prove ttft_ms measures the first
// VISIBLE token — not the first raw byte, which is near-immediate here.
const CONTENT_DELAY_MS = 500;

let resolveReport;
const reported = new Promise((resolve) => { resolveReport = resolve; });
const reports = [];
let heldIngestResponse = null;
let resolveIngestClosed;
const ingestClosed = new Promise((resolve) => { resolveIngestClosed = resolve; });

const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Instant keepalive / role-only delta: first BYTE, but not a visible token.
    res.write('data: {"model":"qwen3.7-plus","choices":[{"delta":{"role":"assistant"}}]}\n\n');
    setTimeout(() => {
      // Split the content delta EXACTLY at the `"content":"` boundary across
      // two writes — exercises the ttft boundary-carry (a token split across a
      // chunk must still trip tFirstToken, not slip to a later delta).
      res.write('data: {"model":"qwen3.7-plus","choices":[{"delta":{"content":"');
      res.write('Привет"}}]}\n\n');
      res.write('data: {"model":"qwen3.7-plus","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":500}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, CONTENT_DELAY_MS);
    return;
  }
  if (req.url === '/t/ai' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      // Deliberately never end the acknowledgement body. The proxy does not
      // consume it, so it must explicitly cancel it after receiving headers.
      res.write('{"ok":true');
      heldIngestResponse = res;
      res.on('close', resolveIngestClosed);
      const report = {
        key: req.headers['x-ingest-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      };
      reports.push(report);
      resolveReport(report);
    });
    return;
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-test-'));
const quotaPath = path.join(temp, 'quota.json');
await writeFile(quotaPath, JSON.stringify({
  day: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10),
  counts: { 'SMESH-LEGACY-RAW-KEY|qwen': 0, '*|all': 0 }
}), { mode: 0o600 });
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
    QUOTA_FILE: quotaPath
  },
  stdio: 'pipe'
});
let proxyLogs = '';
proc.stdout.on('data', (chunk) => { proxyLogs += chunk; });
proc.stderr.on('data', (chunk) => { proxyLogs += chunk; });

try {
  await waitFor(`${base}/health`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const migratedQuota = await readFile(quotaPath, 'utf8');
  assert.equal(migratedQuota.includes('SMESH-LEGACY-RAW-KEY'), false,
    'startup must rewrite legacy quota files without redeemable license keys');
  assert.match(migratedQuota, /h:[a-f0-9]{64}\|qwen/);

  // An otherwise identical solve must remain invisible until the user opts in.
  const privateStarted = await post(`${base}/ai/start`, {
    provider: 'qwen',
    license_key: 'SMESH-TEST-TEST-TEST',
    device_id: 'A0000000-0000-4000-8000-000000000069',
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(privateStarted.status, 200, await privateStarted.text() + '\n' + proxyLogs);
  await new Promise((resolve) => setTimeout(resolve, CONTENT_DELAY_MS + 500));
  assert.equal(reports.length, 0, 'server usage must be silent without strict telemetry opt-in');

  const started = await post(`${base}/ai/start`, {
    provider: 'qwen',
    license_key: 'SMESH-TEST-TEST-TEST',
    device_id: 'A0000000-0000-4000-8000-000000000069',
    telemetry_opt_in: true,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(started.status, 200, await started.clone().text() + '\n' + proxyLogs);
  const startJson = await started.json();
  assert.equal(startJson.ok, true);

  const report = await Promise.race([
    reported,
    new Promise((_, reject) => setTimeout(() => reject(new Error('no /t/ai report within 10s')), 10000))
  ]);

  assert.equal(report.key, 'ingest-secret-for-test', 'report must authenticate with INGEST_KEY');
  assert.equal(report.body.events.length, 1);
  const ev = report.body.events[0];
  assert.equal(ev.device_id, 'a0000000-0000-4000-8000-000000000069',
    'accepted UUIDs are canonicalized before reaching opt-in telemetry');
  assert.equal(ev.provider, 'qwen');
  assert.equal(ev.model, 'qwen3.7-plus');
  assert.equal(ev.tokens_in, 1000);
  assert.equal(ev.tokens_out, 500);
  assert.ok(ev.cost_usd > 0, 'list-rate estimate must be nonzero for known models');
  assert.equal(ev.meta.src, 'vps');
  assert.equal(ev.meta.ok, true);
  assert.equal(ev.meta.est_rates, true);
  // Per-phase timings ride the same meta (no schema change) so the dashboard
  // can show where the solve time goes. A full streamed job sets all phases.
  assert.ok(Number.isFinite(ev.meta.connect_ms) && ev.meta.connect_ms >= 0, 'connect_ms present');
  assert.ok(Number.isFinite(ev.meta.resp_ms) && ev.meta.resp_ms >= 0, 'resp_ms present');
  assert.ok(Number.isFinite(ev.meta.ttft_ms), 'ttft_ms present');
  assert.ok(Number.isFinite(ev.meta.stream_ms) && ev.meta.stream_ms >= 0, 'stream_ms present');
  assert.ok(Number.isFinite(ev.meta.total_ms) && ev.meta.total_ms >= ev.meta.ttft_ms, 'total_ms >= ttft_ms');
  // The crux: ttft is the first VISIBLE token, not the instant keepalive byte.
  assert.ok(ev.meta.ttft_ms > ev.meta.resp_ms,
    `ttft (${ev.meta.ttft_ms}) must be later than first byte (${ev.meta.resp_ms})`);
  assert.ok(ev.meta.ttft_ms >= CONTENT_DELAY_MS - 150,
    `ttft (${ev.meta.ttft_ms}) must reflect the ~${CONTENT_DELAY_MS}ms content delay`);
  assert.ok(ev.meta.resp_ms < CONTENT_DELAY_MS - 150,
    `resp_ms (${ev.meta.resp_ms}) must capture the instant keepalive, not the delayed content`);
  await Promise.race([
    ingestClosed,
    new Promise((_, reject) => setTimeout(() => reject(
      new Error('proxy retained an unread ingest response body')
    ), 2000))
  ]);

  console.log('vps usage report regression passed');
} finally {
  heldIngestResponse?.destroy();
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
