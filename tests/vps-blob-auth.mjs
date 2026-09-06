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
  let authenticatedBody = body;
  if (body?.license_key) {
    const { license_key: licenseKey, device_id: deviceId, activation_token: _unused, ...rest } = body;
    authenticatedBody = { ...rest, ...entitlementBody({ licenseKey, deviceId }) };
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(authenticatedBody)
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
    ...TEST_VPS_SECURITY_ENV,
    HOST: '127.0.0.1',
    PORT: String(proxyPort),
    LICENSE_VERIFY_URL: `http://127.0.0.1:${mockPort}/verify`,
    AI_PROXY_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    AI_PROXY_API_KEY: 'test-key',
    UPLOAD_ABSOLUTE_TTL_MS: '3000',
    QUOTA_FILE: path.join(temp, 'quota.json')
  },
  stdio: 'pipe'
});

try {
  await waitFor(`${base}/health`);

  const anonymous = await post(`${base}/ai/blob`, {
    blob_id: '00000000-0000-4000-8000-000000000001', seq: 0, total: 1, chunk: '[]'
  });
  assert.equal(anonymous.status, 403, 'anonymous callers must not allocate a blob');
  const fractionalSequence = await post(`${base}/ai/blob`, {
    blob_id: '00000000-0000-4000-8000-000000000001',
    seq: 0.5, total: 1, chunk: '[]'
  });
  assert.equal(fractionalSequence.status, 400,
    'chunk sequence numbers must be canonical integers, never silently rounded');
  const overlongDevice = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TEST-TEST-TEST', device_id: 'd'.repeat(65), size: 1
  });
  assert.equal(overlongDevice.status, 403,
    'device ids outside the extension UUID schema must be rejected, not truncated into another identity');
  const piiLikeDevice = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TEST-TEST-TEST', device_id: '79991234567', size: 1
  });
  assert.equal(piiLikeDevice.status, 403,
    'caller-chosen phone/license-like text must never become a device identity or telemetry field');

  const deviceA = '00000000-0000-4000-8000-000000000001';
  const ticketRes = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TEST-TEST-TEST', device_id: deviceA, size: 1024
  });
  assert.equal(ticketRes.status, 200);
  const ticket = await ticketRes.json();
  assert.equal(ticket.ok, true);

  const wrongBlob = await post(`${base}/ai/blob`, {
    blob_id: '00000000-0000-4000-8000-000000000002', upload_token: ticket.upload_token,
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
    device_id: '00000000-0000-4000-8000-000000000002', messages_blob: ticket.blob_id
  });
  assert.equal(wrongOwner.status, 403, 'a completed blob must be bound to its uploading device');

  const started = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: 'SMESH-TEST-TEST-TEST',
    device_id: deviceA, messages_blob: ticket.blob_id
  });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).ok, true);

  // Adaptive-size fallback: the client's probe attempt may reach the server
  // after the client saw a timeout. Generation 1 supersedes that probe, and a
  // delayed generation-0 request must never reset the authoritative attempt.
  const ticket2Res = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TEST-TEST-TEST', device_id: deviceA, size: 1024
  });
  assert.equal(ticket2Res.status, 200);
  const ticket2 = await ticket2Res.json();

  const probeChunk = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    generation: 0, seq: 0, total: 2, chunk: 'stray-probe-bytes'
  });
  assert.equal(probeChunk.status, 200, 'probe chunk should be accepted');

  const payload = JSON.stringify([{ role: 'user', content: 'hello again' }]);
  const third = Math.ceil(payload.length / 3);
  const retry0 = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    generation: 1, seq: 0, total: 3, chunk: payload.slice(0, third)
  });
  assert.equal(retry0.status, 200, 'size-fallback retry with a new total must restart the blob, not 403');
  const delayedProbe = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    generation: 0, seq: 1, total: 2, chunk: 'late-probe-bytes'
  });
  assert.equal(delayedProbe.status, 200, 'a delayed superseded probe chunk must be an idempotent no-op');
  const retry1 = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    generation: 1, seq: 1, total: 3, chunk: payload.slice(third, third * 2)
  });
  assert.equal(retry1.status, 200);
  const retry2 = await post(`${base}/ai/blob`, {
    blob_id: ticket2.blob_id, upload_token: ticket2.upload_token,
    generation: 1, seq: 2, total: 3, chunk: payload.slice(third * 2)
  });
  assert.equal(retry2.status, 200);
  assert.equal((await retry2.json()).complete, true, 'restarted blob must complete cleanly');

  const restarted = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: 'SMESH-TEST-TEST-TEST',
    device_id: deviceA, messages_blob: ticket2.blob_id
  });
  assert.equal(restarted.status, 200, 'a restarted blob must redeem with intact data');
  assert.equal((await restarted.json()).ok, true);

  // Compatibility for extension versions already in the field: without an
  // explicit generation, fallback has more chunks than the large probe. The
  // VPS permits that one-way transition once and ignores a late lower-total
  // probe chunk instead of letting arrival order corrupt the upload.
  const legacyTicketRes = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-LEGACY-LEGACY-KEY',
    device_id: '00000000-0000-4000-8000-000000000003',
    size: 1024
  });
  assert.equal(legacyTicketRes.status, 200);
  const legacyTicket = await legacyTicketRes.json();
  assert.equal((await post(`${base}/ai/blob`, {
    blob_id: legacyTicket.blob_id, upload_token: legacyTicket.upload_token,
    seq: 0, total: 2, chunk: 'legacy-probe'
  })).status, 200);
  const legacyPayload = JSON.stringify([{ role: 'user', content: 'legacy fallback' }]);
  const legacyThird = Math.ceil(legacyPayload.length / 3);
  assert.equal((await post(`${base}/ai/blob`, {
    blob_id: legacyTicket.blob_id, upload_token: legacyTicket.upload_token,
    seq: 0, total: 3, chunk: legacyPayload.slice(0, legacyThird)
  })).status, 200);
  assert.equal((await post(`${base}/ai/blob`, {
    blob_id: legacyTicket.blob_id, upload_token: legacyTicket.upload_token,
    seq: 1, total: 2, chunk: 'late-legacy-probe'
  })).status, 200);
  assert.equal((await post(`${base}/ai/blob`, {
    blob_id: legacyTicket.blob_id, upload_token: legacyTicket.upload_token,
    seq: 1, total: 3, chunk: legacyPayload.slice(legacyThird, legacyThird * 2)
  })).status, 200);
  const legacyComplete = await post(`${base}/ai/blob`, {
    blob_id: legacyTicket.blob_id, upload_token: legacyTicket.upload_token,
    seq: 2, total: 3, chunk: legacyPayload.slice(legacyThird * 2)
  });
  assert.equal(legacyComplete.status, 200);
  assert.equal((await legacyComplete.json()).complete, true);
  const legacyStarted = await post(`${base}/ai/start`, {
    provider: 'qwen', license_key: 'SMESH-LEGACY-LEGACY-KEY',
    device_id: '00000000-0000-4000-8000-000000000003',
    messages_blob: legacyTicket.blob_id
  });
  assert.equal(legacyStarted.status, 200, 'legacy fallback must redeem with intact data after a delayed probe');

  const conflictTicketRes = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-CONFLICT-CONFLICT-KEY',
    device_id: '00000000-0000-4000-8000-000000000004',
    size: 2
  }, { 'X-Forwarded-For': '198.51.100.9' });
  assert.equal(conflictTicketRes.status, 200);
  const conflictTicket = await conflictTicketRes.json();
  assert.equal((await post(`${base}/ai/blob`, {
    blob_id: conflictTicket.blob_id, upload_token: conflictTicket.upload_token,
    seq: 0, total: 2, chunk: 'a'
  })).status, 200);
  const conflictingRetry = await post(`${base}/ai/blob`, {
    blob_id: conflictTicket.blob_id, upload_token: conflictTicket.upload_token,
    seq: 0, total: 2, chunk: 'b'
  });
  assert.equal(conflictingRetry.status, 409,
    'the same chunk sequence with different bytes must invalidate the ambiguous upload');
  assert.equal((await post(`${base}/ai/blob`, {
    blob_id: conflictTicket.blob_id, upload_token: conflictTicket.upload_token,
    seq: 1, total: 2, chunk: 'c'
  })).status, 403, 'an invalidated upload capability cannot be resumed');

  // Ticket caps aggregate across devices on one license. Device #1 normally
  // owns the token, while the second slot permits one legitimate retry.
  const capTickets = [];
  for (let i = 0; i < 4; i++) {
    capTickets.push(await post(`${base}/ai/upload-ticket`, {
      license_key: 'SMESH-CAP-CAP-CAP',
      device_id: `00000000-0000-4000-8000-${String(10 + i).padStart(12, '0')}`,
      size: 1
    }, { 'X-Forwarded-For': `198.51.100.${10 + i}` }));
  }
  assert.deepEqual(capTickets.map((response) => response.status), [200, 200, 429, 429],
    'a third live ticket for one license must be refused across devices');

  const overrunTicketRes = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-SIZE-SIZE-SIZE',
    device_id: '00000000-0000-4000-8000-000000000020',
    size: 3
  }, { 'X-Forwarded-For': '198.51.100.30' });
  assert.equal(overrunTicketRes.status, 200);
  const overrunTicket = await overrunTicketRes.json();
  const overrun = await post(`${base}/ai/blob`, {
    blob_id: overrunTicket.blob_id, upload_token: overrunTicket.upload_token,
    seq: 0, total: 1, chunk: 'four'
  });
  assert.equal(overrun.status, 413, 'chunks must never exceed the ticket declaration');

  // Admission reserves declared memory before the first byte. The fifth 9 MiB
  // ticket exceeds the separate 40 MiB pre-upload reservation ceiling even
  // when every blob map is still empty.
  const maxBlobChars = 9 * 1024 * 1024;
  const reservations = [];
  for (let i = 0; i < 9; i++) {
    reservations.push(await post(`${base}/ai/upload-ticket`, {
      license_key: `SMESH-RESERVE-${i}-KEY`,
      device_id: `00000000-0000-4000-8000-${String(30 + i).padStart(12, '0')}`,
      size: maxBlobChars
    }, { 'X-Forwarded-For': `203.0.113.${10 + i}` }));
  }
  assert.deepEqual(reservations.map((response) => response.status),
    [200, 200, 200, 200, 429, 429, 429, 429, 429],
    'declared reservations must hit the global pre-upload ceiling before chunks arrive');

  // A duplicate chunk may slide the short idle expiry, but never the absolute
  // lifetime. The test-only TTL override keeps this deterministic and quick.
  const ttlTicketRes = await post(`${base}/ai/upload-ticket`, {
    license_key: 'SMESH-TTL-TTL-TTL',
    device_id: '00000000-0000-4000-8000-000000000050',
    size: 1
  }, { 'X-Forwarded-For': '192.0.2.55' });
  assert.equal(ttlTicketRes.status, 200);
  const ttlTicket = await ttlTicketRes.json();
  const duplicate = () => post(`${base}/ai/blob`, {
    blob_id: ttlTicket.blob_id, upload_token: ttlTicket.upload_token,
    seq: 0, total: 1, chunk: 'x'
  });
  assert.equal((await duplicate()).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal((await duplicate()).status, 200, 'activity may refresh the idle TTL inside the absolute lifetime');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal((await duplicate()).status, 403,
    'duplicate chunks must not keep a ticket/blob alive past its absolute lifetime');

  console.log('vps blob authorization and upload-limit regressions passed');
} finally {
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  mock.close();
  await rm(temp, { recursive: true, force: true });
}
