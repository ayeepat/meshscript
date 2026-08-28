#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const temp = await mkdtemp(path.join(os.tmpdir(), 'smesh-model-control-'));
const quotaFile = path.join(temp, 'quota.json');
const modelFile = path.join(temp, 'model-config.json');
const calls = [];

const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (req.url === '/verify') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    calls.push(body.model);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n` +
      'data: [DONE]\n\n'
    );
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamPort = upstream.address().port;

const proxyPort = await new Promise((resolve, reject) => {
  const probe = http.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});
const proxy = spawn(process.execPath, ['backend-vps/server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: String(proxyPort),
    HOST: '127.0.0.1',
    AI_PROXY_API_KEY: 'test-upstream-key',
    AI_PROXY_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    LICENSE_VERIFY_URL: `http://127.0.0.1:${upstreamPort}/verify`,
    QUOTA_FILE: quotaFile,
    MODEL_CONFIG_FILE: modelFile,
    MODEL_ADMIN_KEY: 'model-admin-test-key-with-enough-entropy',
    MODEL_DASHBOARD_ORIGIN: 'https://ayeepat.github.io'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

const base = `http://127.0.0.1:${proxyPort}`;
for (let i = 0; i < 100; i++) {
  try {
    const ready = await fetch(`${base}/ready`);
    if (ready.ok) break;
  } catch { /* starting */ }
  await new Promise((resolve) => setTimeout(resolve, 30));
  if (i === 99) throw new Error('proxy did not become ready');
}

const origin = 'https://ayeepat.github.io';
const adminHeaders = {
  Origin: origin,
  'Content-Type': 'application/json',
  'X-Model-Admin-Key': 'model-admin-test-key-with-enough-entropy'
};

try {
  const blockedOrigin = await fetch(`${base}/admin/model-config`, {
    headers: { Origin: 'https://attacker.example', 'X-Model-Admin-Key': adminHeaders['X-Model-Admin-Key'] }
  });
  assert.equal(blockedOrigin.status, 403);
  assert.equal(blockedOrigin.headers.get('access-control-allow-origin'), null);

  const unauthorized = await fetch(`${base}/admin/model-config`, { headers: { Origin: origin } });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('access-control-allow-origin'), origin);

  const unauthorizedPut = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{not json'
  });
  assert.equal(unauthorizedPut.status, 401,
    'an unauthorized PUT must be rejected before its body is parsed');

  for (let attempt = 1; attempt < 19; attempt += 1) {
    const failed = await fetch(`${base}/admin/model-config`, { headers: { Origin: origin } });
    assert.equal(failed.status, 401);
  }
  const limited = await fetch(`${base}/admin/model-config`, { headers: { Origin: origin } });
  assert.equal(limited.status, 429);
  const ownerAfterFailures = await fetch(`${base}/admin/model-config`, { headers: adminHeaders });
  assert.equal(ownerAfterFailures.status, 200,
    'the correct key must recover immediately instead of being locked out by failed attempts');

  const preflight = await fetch(`${base}/admin/model-config`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);

  const initial = await fetch(`${base}/admin/model-config`, { headers: adminHeaders });
  assert.equal(initial.status, 200);
  const initialState = await initial.json();
  assert.equal(initialState.revision, 0);
  assert.equal(initialState.config.routes.standard.text[0], 'glm-5.3-flash');

  const nextConfig = structuredClone(initialState.config);
  nextConfig.limits.frontier_per_license = 1;
  nextConfig.limits.standard_per_license = 3;
  nextConfig.routes.deepseek.text = ['frontier-test-model'];
  nextConfig.routes.qwen.text = ['qwen-frontier-test-model'];
  nextConfig.routes.standard.text = ['glm-5.3-flash'];
  const saved = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ expected_revision: 0, reason: 'regression setup', config: nextConfig })
  });
  if (saved.status !== 200) throw new Error(`save failed: ${saved.status} ${await saved.text()}`);
  assert.equal((await saved.json()).revision, 1);

  const stale = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ expected_revision: 0, config: nextConfig })
  });
  assert.equal(stale.status, 409);

  const requestBody = (provider, nonce) => ({
    provider,
    license_key: 'SMESH-MODEL-CONTROL-TEST',
    device_id: '123e4567-e89b-42d3-a456-426614174000',
    activation_token: 'a'.repeat(43),
    messages: [{ role: 'user', content: `hello ${nonce}` }],
    idempotency_key: `123e4567-e89b-42d3-a456-42661417400${nonce}`
  });
  const start = async (provider, nonce) => {
    const response = await fetch(`${base}/ai/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(provider, nonce))
    });
    if (response.status !== 200) throw new Error(`start failed: ${response.status} ${await response.text()}`);
    await response.json();
    const expectedCalls = Number(nonce);
    for (let i = 0; i < 100 && calls.length < expectedCalls; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  await start('deepseek', '1');
  await start('qwen', '2');
  assert.deepEqual(calls, ['frontier-test-model', 'glm-5.3-flash'],
    'the combined frontier allowance must spill the second route into the standard chain');

  const live = await (await fetch(`${base}/admin/model-config`, { headers: adminHeaders })).json();
  const hot = structuredClone(live.config);
  hot.limits.force_standard = true;
  hot.routes.standard.text = ['step-3.5-flash'];
  const hotSaved = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ expected_revision: live.revision, reason: 'price switch', config: hot })
  });
  if (hotSaved.status !== 200) throw new Error(`hot save failed: ${hotSaved.status} ${await hotSaved.text()}`);

  await start('deepseek', '3');
  assert.equal(calls[2], 'step-3.5-flash',
    'the first request after a dashboard save must use the new model without a restart');

  const rollbackState = await (await fetch(`${base}/admin/model-config`, { headers: adminHeaders })).json();
  const rolledBack = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({
      expected_revision: rollbackState.revision,
      reason: 'undo price switch',
      rollback_revision: 1
    })
  });
  if (rolledBack.status !== 200) {
    throw new Error(`rollback failed: ${rolledBack.status} ${await rolledBack.text()}`);
  }
  assert.equal((await rolledBack.json()).revision, 3);

  await start('qwen', '4');
  assert.equal(calls[3], 'glm-5.3-flash',
    'a rollback must become the live route on the next request');

  const quota = JSON.parse(await readFile(quotaFile, 'utf8'));
  const licenseCounts = Object.entries(quota.counts).filter(([key]) => key !== '*|all');
  assert.deepEqual(licenseCounts.map(([key, count]) => [key.split('|').at(-1), count]).sort(), [
    ['deepseek', 1], ['standard', 3]
  ]);
  assert.equal(quota.counts['*|all'], 4);

  const persisted = JSON.parse(await readFile(modelFile, 'utf8'));
  assert.equal(persisted.revision, 3);
  assert.equal(persisted.config.routes.standard.text[0], 'glm-5.3-flash');
  assert.equal(persisted.history[0].revision, 2);
} finally {
  proxy.kill('SIGTERM');
  upstream.close();
}

console.log('VPS live model control regression passed');
