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
const upstreamBodies = [];

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
    upstreamBodies.push(body);
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
  assert.deepEqual(initialState.config.routes.deepseek.text, ['qwen3.7-plus']);
  assert.deepEqual(initialState.config.routes.deepseek.vision, ['qwen3.7-plus', 'qwen-vl-plus']);
  assert.deepEqual(initialState.config.routes.qwen.vision, ['qwen3.7-plus', 'qwen-vl-plus'],
    'vision chains must contain vision-capable models only — text-only qwen-plus ' +
    'answers an image request with a confident wrong guess instead of an error');
  assert.equal(initialState.config.routes.standard.text[0], 'glm-5.3-flash',
    'the cheap post-frontier chain stays on GLM: it is ~4x cheaper per token than Qwen');
  assert.equal(initialState.config.routes.standard.vision[0], 'glm-5.3-flash');
  assert.equal(initialState.config.limits.requests_per_minute, 5);
  assert.equal(initialState.config.limits.frontier_per_license, 15);
  assert.equal(initialState.config.limits.standard_per_license, 70);

  const nextConfig = structuredClone(initialState.config);
  delete nextConfig.limits.requests_per_minute;
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
  const savedState = await saved.json();
  assert.equal(savedState.revision, 1);
  assert.equal(savedState.config.limits.requests_per_minute, 5,
    'a revision-1 config without the new field must migrate to the safe default');

  const stale = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({ expected_revision: 0, config: nextConfig })
  });
  assert.equal(stale.status, 409);

  const requestBody = (provider, nonce, identity = {}) => ({
    provider,
    license_key: identity.licenseKey || 'SMESH-MODEL-CONTROL-TEST',
    device_id: identity.deviceId || '123e4567-e89b-42d3-a456-426614174000',
    activation_token: 'a'.repeat(43),
    messages: [{ role: 'user', content: `hello ${nonce}` }],
    reasoning_effort: 'low',
    idempotency_key: `model-control-${nonce}`
  });
  const start = async (provider, nonce, identity) => {
    const expectedCalls = calls.length + 1;
    const response = await fetch(`${base}/ai/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody(provider, nonce, identity))
    });
    if (response.status !== 200) throw new Error(`start failed: ${response.status} ${await response.text()}`);
    const payload = await response.json();
    for (let i = 0; i < 100 && calls.length < expectedCalls; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return payload;
  };

  const firstJob = await start('deepseek', '1');
  const replay = await fetch(`${base}/ai/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody('deepseek', '1'))
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).job_id, firstJob.job_id);
  assert.equal(calls.length, 1, 'an exact /ai/start replay must not start or count another request');
  await start('qwen', '2');
  assert.deepEqual(calls, ['frontier-test-model', 'glm-5.3-flash'],
    'the combined frontier allowance must spill the second route into the standard chain');
  assert.equal(upstreamBodies[0].reasoning_effort, 'low',
    'a dashboard-selected non-GLM Auto model must retain ordinary effort passthrough');
  assert.equal(upstreamBodies[0].thinking, undefined);
  assert.equal(upstreamBodies[1].reasoning_effort, 'max',
    'GLM must override low-effort requests from already-installed Auto clients');
  assert.deepEqual(upstreamBodies[1].thinking, { type: 'enabled' });

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
  assert.equal(upstreamBodies[2].reasoning_effort, undefined,
    'the GLM-only max policy must not leak into another standard model');
  assert.equal(upstreamBodies[2].thinking, undefined);

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

  const beforeMinuteSave = await (await fetch(
    `${base}/admin/model-config`, { headers: adminHeaders }
  )).json();
  const minuteConfig = structuredClone(beforeMinuteSave.config);
  minuteConfig.limits.requests_per_minute = 5;
  minuteConfig.limits.standard_per_license = 70;
  const minuteSaved = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({
      expected_revision: beforeMinuteSave.revision,
      reason: 'minute limit regression',
      config: minuteConfig
    })
  });
  if (minuteSaved.status !== 200) {
    throw new Error(`minute save failed: ${minuteSaved.status} ${await minuteSaved.text()}`);
  }
  assert.equal((await minuteSaved.json()).revision, 4);

  const minuteIdentity = {
    licenseKey: 'SMESH-MINUTE-CONTROL-TEST',
    deviceId: '123e4567-e89b-42d3-a456-426614174001'
  };
  for (const nonce of ['5', '6', '7', '8', '9']) {
    await start(nonce === '6' ? 'qwen' : 'deepseek', nonce, minuteIdentity);
  }
  const globalBeforeRejectedBurst = JSON.parse(await readFile(quotaFile, 'utf8')).counts['*|all'];
  const rejectedBurst = await fetch(`${base}/ai/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody('deepseek', '10', minuteIdentity))
  });
  assert.equal(rejectedBurst.status, 429, 'the sixth request in one minute must be rejected at a cap of five');
  assert.match((await rejectedBurst.json()).error.message, /на лицензию: 5/);
  assert.equal(calls.length, 9, 'a minute-limited request must never reach the paid upstream');
  const quotaAfterRejectedBurst = JSON.parse(await readFile(quotaFile, 'utf8'));
  assert.equal(quotaAfterRejectedBurst.counts['*|all'], globalBeforeRejectedBurst,
    'a minute-limited request must not consume durable daily quota');

  const persisted = JSON.parse(await readFile(modelFile, 'utf8'));
  assert.equal(persisted.revision, 4);
  assert.equal(persisted.config.limits.requests_per_minute, 5);
  assert.equal(persisted.config.limits.standard_per_license, 70);
  assert.equal(persisted.config.routes.standard.text[0], 'glm-5.3-flash');
  assert.equal(persisted.history[0].revision, 3);

  /* ---- the live Auto model: Qwen 3.7 Plus, on its own quality policy ---- */
  // Qwen thinks by default and has NO OpenAI-style effort levels, so the
  // low-effort hint every installed client sends with a test solve must be
  // dropped rather than forwarded — and never turned into GLM's thinking/max
  // pair, which is a different vendor's knob.
  const beforeQwen = await (await fetch(`${base}/admin/model-config`, { headers: adminHeaders })).json();
  const qwenConfig = structuredClone(beforeQwen.config);
  qwenConfig.limits.frontier_per_license = 5;
  qwenConfig.limits.force_standard = false;
  qwenConfig.routes.deepseek.text = ['qwen3.7-plus'];
  qwenConfig.routes.deepseek.vision = ['qwen3.7-plus'];
  const qwenSaved = await fetch(`${base}/admin/model-config`, {
    method: 'PUT', headers: adminHeaders,
    body: JSON.stringify({
      expected_revision: beforeQwen.revision, reason: 'auto → qwen3.7-plus', config: qwenConfig
    })
  });
  if (qwenSaved.status !== 200) throw new Error(`qwen save failed: ${qwenSaved.status} ${await qwenSaved.text()}`);

  // Canonical base64 of arbitrary bytes: the VPS validates the data-URI shape
  // and never decodes the pixels, so no real PNG is needed to exercise routing.
  const imageDataUri = 'data:image/png;base64,' +
    Buffer.from('smesh-model-control-regression-image').toString('base64');
  const qwenIdentity = {
    license_key: 'SMESH-QWEN-CONTROL-TEST',
    device_id: '123e4567-e89b-42d3-a456-426614174002'
  };
  const startQwen = async (nonce, content) => {
    const expectedCalls = calls.length + 1;
    const response = await fetch(`${base}/ai/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'deepseek',
        ...qwenIdentity,
        activation_token: 'a'.repeat(43),
        messages: [{ role: 'user', content }],
        // Exactly what solveTest sends for a test page it judged easy.
        reasoning_effort: 'low',
        response_format: 'json_object',
        idempotency_key: `qwen-policy-${nonce}`
      })
    });
    if (response.status !== 200) throw new Error(`qwen start failed: ${response.status} ${await response.text()}`);
    for (let i = 0; i < 100 && calls.length < expectedCalls; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return upstreamBodies.at(-1);
  };

  const qwenText = await startQwen('text', 'реши тест');
  assert.equal(calls.at(-1), 'qwen3.7-plus', 'Auto must resolve to the dashboard-selected Qwen model');
  assert.equal(qwenText.reasoning_effort, undefined,
    'Qwen has no effort levels — the client hint must be dropped, not forwarded');
  assert.equal(qwenText.thinking, undefined,
    "GLM's forced-thinking pair must never be sent to a Qwen model");
  assert.deepEqual(qwenText.response_format, { type: 'json_object' },
    'a text test solve keeps JSON mode, which is what the answer parser expects');

  const qwenVisionBody = await startQwen('vision', [
    { type: 'text', text: 'реши тест по скриншоту' },
    { type: 'image_url', image_url: { url: imageDataUri } }
  ]);
  assert.equal(calls.at(-1), 'qwen3.7-plus');
  assert.equal(qwenVisionBody.reasoning_effort, undefined);
  assert.equal(qwenVisionBody.response_format, undefined,
    'Qwen JSON mode is unreliable once an image is in the request (same finding ' +
    'that makes src/lib/qwen.js drop it client-side); the answer parser recovers ' +
    'the {answers:[{n,a}]} shape from prose instead');
} finally {
  proxy.kill('SIGTERM');
  upstream.close();
}

console.log('VPS live model control regression passed');
