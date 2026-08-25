import assert from 'node:assert/strict';

await import('./helpers/worker-runtime-shim.mjs');
import worker from '../backend/src/worker.js';

let kvReads = 0;
const env = {
  BACKUP_MAINTENANCE: 'true',
  RUNTIME_WRITE_EPOCH: '2',
  ADMIN_SECRET: 'maintenance-admin-secret'.repeat(2),
  LICENSES: {
    async get() { kvReads += 1; return null; },
    async put() { throw new Error('maintenance must suppress KV writes'); }
  },
  DB: {
    prepare(sql) {
      if (sql.includes('FROM runtime_write_fence')) {
        return { async first() { return { write_epoch: 2, writes_enabled: 0 }; } };
      }
      throw new Error('only admin health may probe D1 during maintenance');
    }
  }
};
const ctx = {
  waitUntilCalls: 0,
  waitUntil() { this.waitUntilCalls += 1; }
};

const liveness = await worker.fetch(new Request('https://api.example/health'), env, ctx);
assert.equal(liveness.status, 200);
assert.deepEqual(await liveness.json(), { ok: true, maintenance: true },
  'public liveness must stay reachable and disclose the deliberate maintenance state');

const verify = await worker.fetch(new Request('https://api.example/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    key: 'SMESH-LOOKUP-MUST-NOT-RUN',
    device_id: '11111111-1111-4111-8111-111111111111'
  })
}), env, ctx);
assert.equal(verify.status, 503);
assert.deepEqual(await verify.json(), { ok: false, reason: 'maintenance' });
assert.equal(verify.headers.get('retry-after'), '120');
assert.equal(verify.headers.get('access-control-allow-origin'), '*');
assert.equal(kvReads, 0, 'maintenance admission must run before entitlement storage access');

for (const [path, method] of [
  ['/webhook/robokassa?OutSum=199&InvId=7&SignatureValue=x', 'GET'],
  ['/admin/issue', 'POST'],
  ['/telegram/webhook', 'POST'],
  ['/referral/check?code=ABCDEFGH', 'GET']
]) {
  const response = await worker.fetch(new Request(`https://api.example${path}`, { method }), env, ctx);
  assert.equal(response.status, 503, `${method} ${path} must be write-gated`);
  assert.equal((await response.json()).reason, 'maintenance');
}

// Readiness is the authenticated proof that the maintenance-aware deployment
// is active. It remains callable, reports red, and names the exact gate.
const badReadiness = await worker.fetch(new Request('https://api.example/admin/health', {
  headers: { 'X-Admin-Token': 'wrong-maintenance-token' }
}), env, ctx);
assert.equal(badReadiness.status, 401,
  'an unauthenticated maintenance probe must fail without writing a D1 abuse counter');

const readiness = await worker.fetch(new Request('https://api.example/admin/health', {
  headers: { 'X-Admin-Token': env.ADMIN_SECRET }
}), env, ctx);
assert.equal(readiness.status, 503);
const readinessBody = await readiness.json();
assert.equal(readinessBody.ok, false);
assert.equal(readinessBody.checks.backup_maintenance, false);
assert.equal(readinessBody.checks.write_fence, true,
  'maintenance readiness must positively prove the durable row is closed');
assert.deepEqual(readinessBody.write_fence, {
  configured_epoch: 2,
  database_epoch: 2,
  writes_enabled: 0
});

await worker.scheduled({}, env, ctx);
assert.equal(ctx.waitUntilCalls, 0,
  'maintenance must suppress new cron retry/prune writers, not merely public routes');

const normalHealth = await worker.fetch(
  new Request('https://api.example/health'),
  { BACKUP_MAINTENANCE: 'false' },
  ctx
);
assert.deepEqual(await normalHealth.json(), { ok: true, maintenance: false },
  'only the exact true setting may enable the gate');

console.log('backup maintenance gate regression passed');
