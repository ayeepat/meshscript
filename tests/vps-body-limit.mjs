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

function rawPost(port, {
  body, contentLength, bodyChunks = null, route = '/ai/start', ip = null, admin = false
}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    // Omit Content-Length when we want a genuinely chunked upload: Node will
    // then frame the request as Transfer-Encoding: chunked once we stream the
    // pieces with req.write(), which is the only way to exercise the server's
    // mid-stream overflow branch rather than the upfront declared-length guard.
    if (contentLength != null) headers['Content-Length'] = String(contentLength);
    if (ip) headers['X-Forwarded-For'] = ip;
    if (admin) headers['X-Admin-Key'] = 'test-admin-key';
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: route,
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

function holdBody(port, ip, body = '{') {
  const req = http.request({
    host: '127.0.0.1', port, path: '/ai/start', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }
  });
  req.on('error', () => {});
  req.write(body); // omit req.end(): server must keep this body reservation open
  return req;
}

let verifyCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/verify')) {
    verifyCalls += 1;
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
    ADMIN_KEY: 'test-admin-key',
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

  for (const route of ['/ai/start', '/ai/chat', '/ai/upload-ticket', '/ai/blob']) {
    for (const raw of ['null', '[]', '1', 'true', '"text"']) {
      const malformedShape = await rawPost(proxyPort, {
        route, body: raw, contentLength: Buffer.byteLength(raw), admin: route === '/ai/chat'
      });
      assert.equal(malformedShape.status, 400,
        `${route} must reject JSON ${raw} as malformed input instead of throwing`);
      assert.match(JSON.parse(malformedShape.text).error.message, /Некорректный запрос/);
    }
  }

  const completeButUnterminated = JSON.stringify({
    provider: 'qwen', license_key: 'SMESH-ABORTED-BODY',
    device_id: '00000000-0000-4000-8000-000000000061',
    messages: [{ role: 'user', content: 'must never run' }]
  });
  const held = [
    holdBody(proxyPort, '198.51.100.90', completeButUnterminated),
    ...Array.from({ length: 3 }, () => holdBody(proxyPort, '198.51.100.90'))
  ];
  await new Promise((resolve) => setTimeout(resolve, 50));
  const perIpOverflow = await rawPost(proxyPort, {
    body: '{}', contentLength: 2, ip: '198.51.100.90'
  });
  assert.equal(perIpOverflow.status, 429,
    'one anonymous IP may not hold more than four body buffers open');
  held.forEach((req) => req.destroy());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterAbort = await rawPost(proxyPort, {
    body: '{}', contentLength: 2, ip: '198.51.100.90'
  });
  assert.equal(afterAbort.status, 400,
    'aborted bodies must release their per-IP reservations for later requests');
  assert.equal(verifyCalls, 0,
    'an aborted request must not dispatch even when its partial transport body is valid JSON');

  console.log('vps body limit regression passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
