import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOO_BIG = 'Запрос слишком большой. Уберите часть вложений и попробуйте снова.';

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

function rawPost(port, { body, contentLength, bodyChunks = null }) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    // Omit Content-Length when we want a genuinely chunked upload: Node will
    // then frame the request as Transfer-Encoding: chunked once we stream the
    // pieces with req.write(), which is the only way to exercise the server's
    // mid-stream overflow branch rather than the upfront declared-length guard.
    if (contentLength != null) headers['Content-Length'] = String(contentLength);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ai/upload-ticket',
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (bodyChunks && bodyChunks.length) {
      for (const chunk of bodyChunks) req.write(chunk);
      req.end();
      return;
    }
    req.end(body);
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
  await waitFor(`http://127.0.0.1:${proxyPort}/health`);

  const hugeBody = 'x'.repeat(MAX_BODY_BYTES + 1);
  const splitAt = Math.floor(hugeBody.length / 3);
  const overflow = await rawPost(proxyPort, {
    body: null,
    contentLength: null,
    bodyChunks: [
      hugeBody.slice(0, splitAt),
      hugeBody.slice(splitAt, splitAt * 2),
      hugeBody.slice(splitAt * 2)
    ]
  });
  assert.equal(overflow.status, 413, 'mid-stream chunked overflow must return HTTP 413 instead of resetting the socket');
  assert.equal(overflow.headers.connection, 'close');
  assert.match(overflow.text, /Запрос слишком большой/);
  assert.equal(JSON.parse(overflow.text).error.message, TOO_BIG);

  const declaredTooBig = await rawPost(proxyPort, {
    body: '{}',
    contentLength: MAX_BODY_BYTES + 1000
  });
  assert.equal(declaredTooBig.status, 413, 'oversized declared Content-Length must be rejected before reading the body');
  assert.equal(declaredTooBig.headers.connection, 'close');
  assert.equal(JSON.parse(declaredTooBig.text).error.message, TOO_BIG);

  console.log('vps body limit regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
