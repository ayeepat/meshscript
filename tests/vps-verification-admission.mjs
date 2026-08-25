import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

async function expectStartupReject(envPatch, pattern) {
  const child = spawn(process.execPath, ['backend-vps/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '32123',
      ...envPatch
    },
    stdio: 'pipe'
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0, `invalid configuration unexpectedly started:\n${output}`);
  assert.match(output, pattern);
}

let inFlight = 0;
let maxInFlight = 0;
let verifyCalls = 0;
let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
  if (req.url === '/verify') {
    verifyCalls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, type: 'lifetime', expires_at: null }));
    }, 350);
    return;
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
const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-verify-admission-'));
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
  const requests = Array.from({ length: 6 }, (_, index) => fetch(`${base}/ai/upload-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.77'
    },
    body: JSON.stringify({
      license_key: `SMESH-VERIFY-${index}`,
      device_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      activation_token: ACTIVATION_TOKEN,
      size: 1,
    })
  }));
  const responses = await Promise.all(requests);
  const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429],
    'one anonymous IP may hold at most four outbound license verifications');
  assert.equal(verifyCalls, 4, 'rejected attempts must never reach the Worker');
  assert.equal(maxInFlight, 4);

  const beforeShared = verifyCalls;
  const shared = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/ai/upload-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.88'
    },
    body: JSON.stringify({
      license_key: 'SMESH-SHARED-VERIFY-KEY',
      device_id: '00000000-0000-4000-8000-000000000071',
      activation_token: ACTIVATION_TOKEN,
      size: 1
    })
  })));
  assert.deepEqual(shared.map((response) => response.status).sort((a, b) => a - b),
    [200, 200, 429, 429],
    'the per-device upload cap still applies after a shared verification');
  assert.equal(verifyCalls - beforeShared, 1,
    'concurrent requests for one license/device must share one authoritative verification');

  // Once the complete body has arrived, disconnect while /verify is delayed.
  // The verifier may finish and warm its positive cache, but the unreachable
  // start response must not charge quota or create paid upstream work.
  const beforeDisconnected = verifyCalls;
  const abandoned = http.request({
    host: '127.0.0.1',
    port: proxyPort,
    path: '/ai/start',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.99' }
  });
  abandoned.on('error', () => {});
  abandoned.end(JSON.stringify({
    provider: 'qwen',
    license_key: 'SMESH-DISCONNECTED-START-KEY',
    device_id: '00000000-0000-4000-8000-000000000072',
    activation_token: ACTIVATION_TOKEN,
    messages: [{ role: 'user', content: 'must never run' }]
  }));
  for (let i = 0; i < 80 && verifyCalls === beforeDisconnected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(verifyCalls, beforeDisconnected + 1, 'the disconnect probe must reach license verification');
  abandoned.destroy();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(upstreamCalls, 0,
    'a client that disappeared during verification must not create unreachable paid work');

  const reachable = await fetch(`${base}/ai/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.99' },
    body: JSON.stringify({
      provider: 'qwen',
      license_key: 'SMESH-DISCONNECTED-START-KEY',
      device_id: '00000000-0000-4000-8000-000000000072',
      activation_token: ACTIVATION_TOKEN,
      messages: [{ role: 'user', content: 'control' }]
    })
  });
  assert.equal(reachable.status, 200, 'the neighboring connected start must remain available');
  for (let i = 0; i < 40 && upstreamCalls === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(upstreamCalls, 1);

  const source = await readFile(new URL('../backend-vps/server.js', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('async function handleAiStart'), source.indexOf('function hasJobToken'));
  assert.ok(start.indexOf('await prepareChat') < start.indexOf('reserveJobAccounting'),
    'active AI slots must be reserved only after authentication completes');
  assert.match(source, /server\.requestTimeout\s*=\s*30\s*\*\s*1000/);
  assert.match(source, /server\.headersTimeout\s*=\s*15\s*\*\s*1000/);
  assert.match(source, /MAX_ACTIVE_JOBS\s*=\s*24/,
    'active jobs must fit beneath the service memory ceiling at maximum request/output size');
  assert.match(source, /MAX_RETAINED_JOBS\s*=\s*64/,
    'completed polling jobs must have an aggregate retention cap');
  assert.match(source, /startsByIp/,
    'rotating license/device ids must not bypass the per-IP job-start budget');
  assert.match(source, /MAX_UPLOAD_TICKETS\s*=\s*240/,
    'upload capabilities must have a global map bound');
  assert.match(source, /MAX_BUFFERED_BODY_BYTES\s*=\s*48\s*\*\s*1024\s*\*\s*1024/,
    'anonymous request bodies must have an aggregate memory ceiling');
  assert.match(source, /MAX_BODY_REQUESTS_PER_IP\s*=\s*4/,
    'slow body senders must have a per-IP admission ceiling');
  assert.match(source, /server\.maxConnections\s*=\s*128/,
    'the loopback listener must have a hard socket ceiling');
  assert.match(source, /new URL\(req\.url \|\| '\/', 'http:\/\/localhost'\)/,
    'request routing must not parse an attacker-controlled Host header');
  assert.match(source, /Invalid HOST: smesh-proxy must listen on loopback behind Caddy/,
    'the direct Node listener must refuse accidental public exposure');
  await expectStartupReject(
    { HOST: '0.0.0.0' },
    /Invalid HOST: smesh-proxy must listen on loopback behind Caddy/
  );
  await expectStartupReject(
    { AI_PROXY_BASE_URL: 'http://example.com/v1' },
    /Invalid AI_PROXY_BASE_URL: HTTPS is required/
  );
  await expectStartupReject(
    { LICENSE_VERIFY_URL: 'https://user:secret@smeshapi\.site/verify' },
    /Invalid LICENSE_VERIFY_URL: credentials, query strings, and fragments are not allowed/
  );
  const setup = await readFile(new URL('../backend-vps/setup.sh', import.meta.url), 'utf8');
  assert.match(setup, /Invalid DOMAIN: expected a DNS hostname/,
    'installer must not interpolate an unvalidated environment value into Caddy config');
  assert.match(setup, /if \[\[ -x \/usr\/bin\/node \]\]/,
    'installer must inspect the exact Node executable used by systemd, not an interactive PATH shim');
  assert.doesNotMatch(setup, /command -v node/);
  assert.match(setup, /systemctl restart smesh-proxy/,
    're-running setup must load the freshly written server and unit');
  assert.match(setup, /ProtectProc=invisible/);
  assert.match(setup, /PrivateDevices=true/);
  assert.match(setup, /caddy validate --config \/etc\/caddy\/Caddyfile/,
    'the installer must validate the effective proxy configuration before restarting Caddy');
  assert.match(setup, /header_up X-Forwarded-For \{remote_host\}/,
    'Caddy must replace attacker-supplied forwarding chains with the real TLS peer address');

  console.log('vps verification admission regressions passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
