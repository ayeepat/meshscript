import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const ctx = { waitUntil() {} };
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

function verifyBudgetDb() {
  const budgets = new Map();
  const activations = new Map();
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first(column) {
              if (sql.includes('FROM license_activations')) return activations.get(args[0]) || null;
              const [day, scope, key, amount, limit] = args;
              const id = `${day}|${scope}|${key}`;
              let count = budgets.get(id) || 0;
              if (sql.includes('INSERT INTO telemetry_budget')) {
                if (count + amount > limit) return null;
                count += amount;
                budgets.set(id, count);
              } else if (sql.includes('UPDATE telemetry_budget')) {
                count = Math.max(0, count - amount);
                budgets.set(id, count);
              } else return null;
              return column === 'count' ? count : { count };
            },
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO license_activations')) {
                if (activations.has(args[0])) return { meta: { changes: 0 } };
                activations.set(args[0], {
                  status: 'active', device_id: args[1], token_hash: args[2], generation: 1
                });
                return { meta: { changes: 1 } };
              }
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    },
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
  };
}

// License credentials belong in the request body, not in URLs that routinely
// reach browser history, reverse-proxy logs, and monitoring systems.
{
  const env = {
    DB: verifyBudgetDb(),
    OWNER_LICENSE_KEY: 'SMESH-OWNER-TEST-KEY',
    ENTITLEMENT_SECRET: 'test-entitlement-secret-at-least-32-bytes'
  };
  const res = await worker.fetch(new Request('https://api.example/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'SMESH-OWNER-TEST-KEY', device_id: DEVICE_ID })
  }), env, ctx);
  assert.equal(res.status, 200);
  const verdict = await res.json();
  assert.equal(verdict.ok, true);
  assert.match(verdict.entitlement_token || '', /^et1\./,
    'a successful verification must mint a short-lived AI capability');

  const legacyGet = await worker.fetch(
    new Request(`https://api.example/verify?key=SMESH-OWNER-TEST-KEY&device_id=${DEVICE_ID}`),
    env,
    ctx
  );
  assert.equal(legacyGet.status, 404, 'GET /verify must not accept URL-borne bearer credentials');

  const oversized = await worker.fetch(new Request('https://api.example/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'x'.repeat(5000), device_id: 'd' })
  }), env, ctx);
  assert.equal(oversized.status, 413, 'verify body must be bounded even without Content-Length');
}

const licenseClient = source('../src/lib/license.js');
const vps = source('../backend-vps/server.js');
const workerSource = source('../backend/src/worker.js');
const licenseBackend = source('../backend/src/licenses.js');
const supportBackend = source('../backend/src/delivery/support.js');
const aiProxy = source('../backend/src/ai-proxy.js');
const analyticsBackend = source('../backend/src/analytics.js');
const analyticsSchema = source('../backend/schema.sql');
assert.match(licenseClient, /method:\s*'POST'/);
assert.match(licenseClient, /redirect:\s*'error'/,
  'license credentials must not follow an upstream redirect');
assert.doesNotMatch(licenseClient, /searchParams\.set\(['"]key/);
// The license authority exchanges the reusable key for a short-lived,
// purpose-bound capability. Only that capability crosses into the AI service.
const proxyClient = source('../src/lib/smesh-proxy.js');
assert.match(proxyClient, /entitlement_token: status\.entitlement_token/);
assert.doesNotMatch(proxyClient, /license_key:|activation_token:|device_id:/,
  'AI requests must never contain reusable license or activation credentials');
assert.match(vps, /verifyEntitlement\(body\.entitlement_token\)/,
  'the VPS must authorize inference locally from the signed capability');
assert.ok((vps.match(/redirect:\s*'error'/g) || []).length >= 2,
  'VPS AI-provider and telemetry credentials must fail closed on redirects');

// A 307/308 can replay a POST body at the redirect target. Every direct
// credential-bearing extension request must reject it rather than forwarding
// license keys, provider keys, referral capabilities, or task text.
for (const path of [
  '../src/lib/http.js',
  '../src/lib/groq.js',
  '../src/lib/openrouter.js',
  '../src/lib/referral.js',
  '../src/lib/smesh-proxy.js',
  '../src/lib/telemetry.js',
  '../src/settings/settings.js'
]) {
  assert.match(source(path), /redirect:\s*'error'/, `${path} must reject redirects`);
  assert.doesNotMatch(source(path), /(?:res|response)\.(?:json|text)\(\)/,
    `${path} must not buffer an unbounded response body`);
}
for (const path of [
  '../backend/src/ai-proxy.js',
  '../backend/src/delivery/email.js',
  '../backend/src/delivery/telegram.js',
  '../backend/src/delivery/support.js'
]) {
  assert.match(source(path), /redirect:\s*'manual'/, `${path} must not auto-follow redirects`);
}

// Every provider exposed by onboarding must round-trip through Settings as
// the exact same id. This guards against Groq→OpenRouter and Qwen→DeepSeek
// substitutions when a user merely opens and saves Settings.
const settingsHtml = source('../src/settings/settings.html');
const popupHtml = source('../src/popup/popup.html');
const settingsJs = source('../src/settings/settings.js');
for (const id of ['openrouter', 'groq', 'qwen', 'deepseek']) {
  assert.match(settingsHtml, new RegExp(`<option value=["']${id}["']`));
  assert.match(popupHtml, new RegExp(`data-p=["']${id}["']`));
}
assert.doesNotMatch(settingsJs, /PROVIDER_TO_OPTION/);
assert.match(settingsJs, /PROVIDER_OPTIONS\.has\(stored\.aiProvider\) \? stored\.aiProvider/);
assert.match(settingsJs, /setTelemetryPreference\(false\)/,
  'server erasure must also withdraw statistics through the serialized preference writer');
assert.match(settingsJs, /consentTelemetry/,
  'statistics must remain an independent optional control');

// Both halves of the consent boundary are explicit and fail closed.
assert.match(source('../src/lib/smesh-proxy.js'), /telemetryOptIn = stored\.telemetryEnabled === true/);
assert.match(vps, /job\.telemetryOptIn !== true/);

// Bearer credentials and user/provider content must not appear in operational
// logs, including exception messages that may contain tokens or task text.
assert.match(workerSource, /safeErrorText\(e, env\)/);
const safeErrorSource = workerSource.slice(
  workerSource.indexOf('function safeErrorText'),
  workerSource.indexOf('async function readUpstreamJson')
);
assert.doesNotMatch(safeErrorSource, /\.message|\.stack|String\(errorValue\)/,
  'operational error logging must not serialize exception content');
assert.doesNotMatch(licenseBackend, /console\.warn\([^\n]*license\.key/);
assert.doesNotMatch(supportBackend, /console\.error\([^\n]*step\.error/);
assert.doesNotMatch(aiProxy, /console\.error\([^\n]*text\.slice/);
assert.doesNotMatch(vps, /console\.error\([^\n]*text\.slice/);
assert.doesNotMatch(aiProxy, /console\.warn\([^\n]*text\.slice/);
assert.doesNotMatch(vps, /console\.warn\([^\n]*text\.slice/);
assert.match(vps, /function quotaLicenseRef\(licenseKey\)/);
assert.doesNotMatch(vps, /bump\(`\$\{licenseKey\}\|\$\{providerId\}`\)/,
  'persistent VPS quota keys must not contain redeemable license credentials');
assert.doesNotMatch(vps, /await (?:upstream|r)\.(?:text|json)\(/,
  'VPS control/error responses must use streamed byte-capped readers');
assert.doesNotMatch(workerSource, /await res\.json\(\)/,
  'Worker upstream JSON must use streamed byte-capped readers');
assert.doesNotMatch(analyticsBackend, /ANALYTICS_SALT|licenseRef\(/,
  'legacy telemetry credentials must be discarded rather than persisted under another identifier');
assert.match(analyticsSchema, /SET ua = NULL, license_key = NULL/,
  'schema application must purge legacy raw telemetry identifiers');
assert.match(analyticsBackend, /export async function purgeLegacyIdentifiers/,
  'authenticated maintenance must also purge optional legacy pseudonyms');

// A non-200 from /verify is infrastructure trouble, not a verdict — and its
// body may still be JSON (the worker's own error responses are, and its 404
// answers {"ok":false,"reason":"not_found"}). verifyKey must route that to the
// soft-failure path: caching it as a verdict would show a paying user
// «ключ не найден» for the length of any worker outage.
{
  const store = new Map();
  globalThis.chrome = { storage: { local: {
    async get(keys) {
      if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, store.get(key)]));
      return { [keys]: store.get(keys) };
    },
    async set(entries) { for (const [k, v] of Object.entries(entries)) store.set(k, v); },
    async remove(key) { store.delete(key); }
  } } };
  globalThis.fetch = async () => new Response(
    JSON.stringify({ ok: false, reason: 'not_found' }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  );
  const { verifyKey } = await import('../src/lib/license.js');

  // Fresh key during an outage → retryable 'network', never a definitive verdict.
  const fresh = await verifyKey('SMESH-TEST-1111-2222');
  assert.equal(fresh.ok, false);
  assert.equal(fresh.reason, 'network', 'non-200 JSON must not be cached as a key verdict');

  // Cached-good key during an outage → the valid status survives, soft-flagged.
  const lastVerifiedAt = Date.now() - 60_000;
  store.set('licenseStatus', {
    key: 'SMESH-TEST-1111-2222', ok: true, type: 'lifetime',
    checkedAt: lastVerifiedAt, lastVerifiedAt, activation_token: 'a'.repeat(43)
  });
  const stale = await verifyKey('SMESH-TEST-1111-2222');
  assert.equal(stale.ok, true, 'a worker outage must not clobber a valid cached license');
  assert.equal(stale.softError, 'network');
  assert.equal(stale.lastVerifiedAt, lastVerifiedAt,
    'an outage must not refresh the last server-confirmed entitlement instant');
}

console.log('privacy, provider persistence, and credential transport regressions passed');
