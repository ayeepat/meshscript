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

const LARGE_CONTENT = 'Ж"\\'.repeat(20000);
const LARGE_SSE =
  `data: ${JSON.stringify({ choices: [{ delta: { content: LARGE_CONTENT } }] })}\n\n` +
  'data: [DONE]\n\n';

const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
  }
  if (req.url === '/v1/chat/completions') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let userText = '';
      try { userText = String(JSON.parse(raw).messages?.[0]?.content || ''); } catch { /* scenario stays default */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (userText.includes('clean-eof')) {
        // A body that simply ENDS without `data: [DONE]` — a graceful FIN with
        // the exact shape of a truncated answer.
        return res.write('data: {"choices":[{"delta":{"content":"partial-clean-eof"}}]}\n\n', () => {
          setTimeout(() => res.end(), 20);
        });
      }
      if (userText.includes('embedded-done')) {
        // The assistant may discuss the literal protocol marker. It is JSON
        // content, not an SSE field line, and cannot prove stream completion.
        return res.end(
          'data: {"choices":[{"delta":{"content":"Example: data: [DONE]"}}]}\n\n'
        );
      }
      if (userText.includes('large-backlog')) {
        return res.end(LARGE_SSE);
      }
      if (userText.includes('complete')) {
        return res.write(
          'data: {"choices":[{"delta":{"content":"Полный ответ"}}]}\n\ndata: [DONE]\n\n',
          () => { setTimeout(() => res.end(), 20); }
        );
      }
      // Destroy, rather than end, so fetch's web stream reports a transport
      // failure after yielding one valid content delta. The write callback makes
      // that ordering deterministic even on a loaded regression runner.
      res.write('data: {"choices":[{"delta":{"content":"Обрыв"}}]}\n\n', () => {
        setTimeout(() => res.destroy(), 20);
      });
    });
    return;
  }
  res.writeHead(404).end();
});

const mockPort = await listen(mock);
const proxyPort = 20000 + Math.floor(Math.random() * 20000);
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-proxy-interrupt-'));
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
let proxyLogs = '';
proc.stdout.on('data', (chunk) => { proxyLogs += chunk; });
proc.stderr.on('data', (chunk) => { proxyLogs += chunk; });

async function runPollJob(content) {
  const started = await post(`${base}/ai/start`, {
    provider: 'qwen',
    license_key: 'SMESH-TEST-TEST-TEST',
    device_id: '00000000-0000-4000-8000-000000000067',
    activation_token: ACTIVATION_TOKEN,
    messages: [{ role: 'user', content }]
  });
  assert.equal(started.status, 200, await started.clone().text() + '\n' + proxyLogs);
  const start = await started.json();

  let cursor = 0;
  let text = '';
  let final = null;
  let pollCount = 0;
  let maxResponseBytes = 0;
  for (let i = 0; i < 40; i++) {
    const poll = await fetch(
      `${base}/ai/poll?job=${encodeURIComponent(start.job_id)}&cursor=${cursor}`,
      { headers: { 'X-Job-Token': start.job_token } }
    );
    assert.equal(poll.status, 200, proxyLogs);
    const raw = await poll.text();
    pollCount += 1;
    maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(raw));
    final = JSON.parse(raw);
    text += final.chunk;
    cursor = final.cursor;
    if (final.done) break;
  }
  return { text, final, pollCount, maxResponseBytes };
}

try {
  await waitFor(`${base}/health`);

  // 1. Abrupt socket destruction after partial text.
  const broken = await runPollJob('hi');
  assert.ok(broken.final?.done, 'the interrupted job must reach a terminal state');
  assert.match(broken.text, /Обрыв/, 'the test must exercise a break after partial text arrived');
  assert.equal(typeof broken.final.error, 'string');
  assert.match(broken.final.error, /ответ получен не полностью/,
    'partial upstream transport failure must not look like a successful complete answer');

  // 2. A GRACEFUL EOF without `data: [DONE]` is equally incomplete: the
  //    upstream ended the body cleanly mid-answer.
  const cleanEof = await runPollJob('clean-eof');
  assert.ok(cleanEof.final?.done);
  assert.match(cleanEof.text, /partial-clean-eof/);
  assert.equal(typeof cleanEof.final.error, 'string',
    'a clean EOF without the terminal frame must not be accepted as a complete answer');
  assert.match(cleanEof.final.error, /ответ получен не полностью/);

  // 3. A marker-shaped substring inside assistant JSON is not the terminal
  //    SSE frame; a clean EOF after it is still truncated.
  const embeddedDone = await runPollJob('embedded-done');
  assert.match(embeddedDone.text, /Example: data: \[DONE\]/);
  assert.match(embeddedDone.final.error, /ответ получен не полностью/);

  // 4. Control: the same shape WITH the terminal frame completes without error.
  const complete = await runPollJob('complete');
  assert.ok(complete.final?.done);
  assert.equal(complete.final.error, null, proxyLogs);
  assert.match(complete.text, /Полный ответ/);

  // 5. If a client misses several progressive polls, the accumulated backlog
  // must be split below the measured RU transfer allowance. Returning the
  // whole buffer would make every retry stall at the same cursor forever.
  const backlog = await runPollJob('large-backlog');
  assert.equal(backlog.text, LARGE_SSE, 'bounded polls must reconstruct the upstream stream byte-for-byte');
  assert.ok(backlog.pollCount > 1, 'the control payload must require several bounded polls');
  assert.ok(backlog.maxResponseBytes < 12 * 1024,
    `each poll response must stay independently deliverable, got ${backlog.maxResponseBytes} bytes`);
  assert.equal(backlog.final.done, true, 'done is terminal only after the successful backlog is drained');
  assert.equal(backlog.final.error, null);

  console.log('vps stream interrupt regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
