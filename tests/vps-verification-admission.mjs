import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  entitlementBody, issueTestEntitlement, TEST_VPS_SECURITY_ENV
} from './helpers/vps-entitlement.mjs';

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
      ...TEST_VPS_SECURITY_ENV,
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

let upstreamCalls = 0;
const mock = http.createServer((req, res) => {
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
    ...TEST_VPS_SECURITY_ENV,
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
  const postTicket = (body) => fetch(`${base}/ai/upload-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, size: 1 })
  });

  const rawCredentials = await postTicket({
    license_key: 'SMESH-RAW-KEY-MUST-STOP-AT-WORKER',
    device_id: '00000000-0000-4000-8000-000000000071',
    activation_token: 'A'.repeat(43)
  });
  assert.equal(rawCredentials.status, 403,
    'the inference service must never accept a raw license or activation token');

  const validToken = issueTestEntitlement({
    licenseKey: 'SMESH-LOCAL-ENTITLEMENT',
    deviceId: '00000000-0000-4000-8000-000000000071'
  });
  assert.equal((await postTicket({ entitlement_token: validToken })).status, 200);

  const tamperedToken = validToken.slice(0, -1) + (validToken.endsWith('A') ? 'B' : 'A');
  assert.equal((await postTicket({ entitlement_token: tamperedToken })).status, 403,
    'a modified capability must fail local signature verification');
  assert.equal((await postTicket({
    entitlement_token: issueTestEntitlement({ now: Date.now() - 11 * 60 * 1000 })
  })).status, 403, 'an expired capability must fail closed');

  const sharedBody = entitlementBody({
    licenseKey: 'SMESH-SHARED-TICKET-CAP',
    deviceId: '00000000-0000-4000-8000-000000000072'
  });
  const shared = await Promise.all(Array.from({ length: 4 }, () => postTicket(sharedBody)));
  assert.deepEqual(shared.map((response) => response.status).sort((a, b) => a - b),
    [200, 200, 429, 429], 'the per-principal upload-ticket cap remains enforced');
  assert.equal(upstreamCalls, 0, 'ticket authorization must not contact the paid model gateway');

  const source = await readFile(new URL('../backend-vps/server.js', import.meta.url), 'utf8');
  const start = source.slice(source.indexOf('async function handleAiStart'), source.indexOf('function hasJobToken'));
  assert.ok(start.indexOf('await prepareChat') < start.indexOf('reserveJobAccounting'),
    'active AI slots must be reserved only after authentication completes');
  assert.doesNotMatch(source, /LICENSE_VERIFY_URL|verifyLicenseUpstream|activation_token/,
    'the VPS must have no fallback path for raw license verification');
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

  console.log('vps local entitlement admission regressions passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
