import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';

const { default: worker } = await import('../backend/src/worker.js');

const env = {
  ADMIN_SECRET: 'a'.repeat(64),
  LICENSES: { get: async () => null }
};
const ctx = { waitUntil() {} };
const DASHBOARD = 'https://ayeepat.github.io';

async function invoke(headers = {}) {
  return worker.fetch(new Request('https://smeshapi.site/admin/license?key=SMESH-TEST', {
    headers: { 'x-admin-token': env.ADMIN_SECRET, ...headers }
  }), env, ctx);
}

// Non-stats admin routes stay CLI-only: ANY browser origin — including the
// dashboard's own — must be rejected before the token is considered.
const browserResponse = await invoke({ Origin: 'https://owner.github.io' });
assert.equal(browserResponse.status, 401, 'browser-origin admin requests must be rejected');
const dashboardOnCliRoute = await invoke({ Origin: DASHBOARD });
assert.equal(dashboardOnCliRoute.status, 401, 'dashboard origin must not reach non-stats admin routes');

const cliResponse = await invoke();
assert.equal(cliResponse.status, 404, 'token-authenticated CLI request must reach the route');

const preflight = await worker.fetch(new Request('https://smeshapi.site/admin/license', {
  method: 'OPTIONS',
  headers: {
    Origin: 'https://owner.github.io',
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'x-admin-token'
  }
}), env, ctx);
assert.equal(preflight.headers.get('access-control-allow-headers'), 'Content-Type');

/* ---- stats routes: the owner dashboard origin (and only it) may call ---- */

async function stats(headers = {}, extraEnv = {}) {
  return worker.fetch(new Request('https://smeshapi.site/admin/stats/overview?days=1', {
    headers: { 'x-admin-token': env.ADMIN_SECRET, ...headers }
  }), { ...env, ...extraEnv }, ctx);
}

// Dashboard origin + valid token: passes the guard (503 no_db proves it got
// through auth with no DB bound) and carries CORS for that exact origin.
const dashboardStats = await stats({ Origin: DASHBOARD });
assert.equal(dashboardStats.status, 503, 'dashboard origin + token must pass the admin gate');
assert.equal(dashboardStats.headers.get('access-control-allow-origin'), DASHBOARD);

// Any other origin is rejected even with a valid token.
const foreignStats = await stats({ Origin: 'https://owner.github.io' });
assert.equal(foreignStats.status, 401, 'foreign origins must not reach stats even with the token');
assert.equal(foreignStats.headers.get('access-control-allow-origin'), null);

// Stats preflight from the dashboard origin must whitelist X-Admin-Token…
const statsPreflight = await worker.fetch(new Request('https://smeshapi.site/admin/stats/overview', {
  method: 'OPTIONS',
  headers: {
    Origin: DASHBOARD,
    'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'x-admin-token'
  }
}), env, ctx);
assert.equal(statsPreflight.headers.get('access-control-allow-headers'), 'Content-Type, X-Admin-Token');
assert.equal(statsPreflight.headers.get('access-control-allow-origin'), DASHBOARD);

// …while a stats preflight from anywhere else keeps the public header set.
const foreignPreflight = await worker.fetch(new Request('https://smeshapi.site/admin/stats/overview', {
  method: 'OPTIONS',
  headers: { Origin: 'https://owner.github.io', 'Access-Control-Request-Method': 'GET' }
}), env, ctx);
assert.equal(foreignPreflight.headers.get('access-control-allow-headers'), 'Content-Type');

/* ---- brute-force limiter: over the daily fail budget ⇒ 429 up front ---- */

const throttledDb = {
  prepare(sql) {
    return {
      bind() {
        return {
          async first() { return /SELECT count FROM telemetry_budget/.test(sql) ? { count: 50 } : null; },
          async run() { return {}; },
          async all() { return { results: [] }; }
        };
      }
    };
  },
  async batch() { return []; }
};
const throttled = await stats({}, { DB: throttledDb });
assert.equal(throttled.status, 429, 'an IP over the fail budget must be throttled before token compare');

console.log('admin route guard regression passed');
