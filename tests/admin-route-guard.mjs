import assert from 'node:assert/strict';
import worker from '../backend/src/worker.js';

const env = {
  ADMIN_SECRET: 'a'.repeat(64),
  LICENSES: { get: async () => null }
};
const ctx = { waitUntil() {} };

async function invoke(headers = {}) {
  return worker.fetch(new Request('https://smeshapi.site/admin/license?key=SMESH-TEST', {
    headers: { 'x-admin-token': env.ADMIN_SECRET, ...headers }
  }), env, ctx);
}

const browserResponse = await invoke({ Origin: 'https://owner.github.io' });
assert.equal(browserResponse.status, 401, 'browser-origin admin requests must be rejected');

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

console.log('admin route guard regression passed');
