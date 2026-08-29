/**
 * A /ai/chat reservation may be handed back ONLY when the provider provably did
 * no billable work. "No stream reached the client" is not that proof: the POST
 * body can arrive at 302.AI in full and still yield no readable response, so
 * refunding every failure would let a caller buy unlimited ambiguous work under
 * a cap of one — the daily caps would stop bounding the bill at all.
 *
 * Releasable: the provider's own explicit refusals (auth/billing, quota,
 * malformed request, "no available models").
 * Retained: cancellation, timeout, connection reset, and ambiguous 5xx.
 *
 * The release is deliberately sequential and per-license-first: the shared
 * global breaker is only given a slot back after the license row provably gave
 * one back, so an interrupted release always leaves counters too HIGH.
 */
import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';
import { handleAiChat } from '../backend/src/ai-proxy.js';

const LICENSE = 'SMESH-QUOTA-REL-01';
const DEVICE = '00000000-0000-4000-8000-0000000000bb';
const ACTIVATION_TOKEN = 'a'.repeat(43);
const ACTIVATION_HASH = [...new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(ACTIVATION_TOKEN)
))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Minimal proxy_quota model with the real statement semantics: the charge
// saturates at the cap, the release refuses to go below zero.
class QuotaD1 {
  rows = new Map(); // `${day}|${licenseKey}|${provider}` -> count
  constructor(cap, globalCap) { this.cap = cap; this.globalCap = globalCap; }
  key(day, licenseKey, provider) { return `${day}|${licenseKey}|${provider}`; }
  get(day, licenseKey, provider) { return this.rows.get(this.key(day, licenseKey, provider)) || 0; }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            return { meta: { changes: sql.includes('UPDATE license_activations') ? 1 : 0 } };
          },
          async all() { return { results: [] }; },
          async first() {
            if (sql.includes('SET count = count - 1')) {
              // Two shapes: the per-license row and the '*'/'all' breaker.
              const [day, licenseKey, provider] = sql.includes("license_key = '*'")
                ? [args[0], '*', 'all']
                : args;
              const key = db.key(day, licenseKey, provider);
              const current = db.rows.get(key) || 0;
              if (current <= 0) return null;
              db.rows.set(key, current - 1);
              return { count: current - 1 };
            }
            // Only the proxy_quota disambiguation read. Everything else — the
            // license_revocations lookup in particular — must answer "no row",
            // or verifyLicense reads a truthy object as a revocation.
            if (sql.includes('FROM proxy_quota')) {
              const [day, licenseKey, provider] = args;
              return {
                mine: db.get(day, licenseKey, provider),
                total: db.get(day, '*', 'all')
              };
            }
            if (sql.includes('FROM license_activations')) {
              return { status: 'active', device_id: DEVICE, token_hash: ACTIVATION_HASH, generation: 1 };
            }
            return null;
          }
        };
      }
    };
  }

  async batch(statements) {
    // The charge batch: mine first (gated on the global), then the breaker.
    const [mine, total] = statements;
    const [day, licenseKey, provider, globalCap, cap] = mine.__args;
    const currentTotal = this.get(day, '*', 'all');
    const currentMine = this.get(day, licenseKey, provider);
    if (currentTotal >= globalCap || currentMine >= cap) {
      return [{ results: [] }, { results: [] }];
    }
    this.rows.set(this.key(day, licenseKey, provider), currentMine + 1);
    this.rows.set(this.key(day, '*', 'all'), currentTotal + 1);
    void total;
    return [
      { results: [{ count: currentMine + 1 }] },
      { results: [{ count: currentTotal + 1 }] }
    ];
  }
}

// The charge path builds its statements with .bind(...); capture those args.
const originalPrepare = QuotaD1.prototype.prepare;
QuotaD1.prototype.prepare = function prepare(sql) {
  const built = originalPrepare.call(this, sql);
  return {
    bind: (...args) => Object.assign(built.bind(...args), { __args: args, sql })
  };
};

// ai-proxy keeps a module-level "this row is saturated" cache keyed by
// day|license|provider. It is deliberately never reset between requests, so
// each block below uses its OWN license key — otherwise one block's exhausted
// cap would shed the next block's request before it ever reaches D1.
function environment(db, licenseKey = LICENSE, overrides = {}) {
  return {
    DB: db,
    AI_PROXY_API_KEY: 'sk-live',
    LICENSES: {
      async get(key) {
        return key.startsWith('SMESH-QUOTA-REL')
          ? JSON.stringify({
              key, type: 'lifetime', status: 'active',
              expires_at: null, device_ids: [DEVICE]
            })
          : null;
      },
      async put() {}
    },
    PROXY_QWEN_DAILY: '5',
    PROXY_GLOBAL_DAILY: '10',
    ...overrides
  };
}

function chatRequest(licenseKey = LICENSE, provider = 'qwen', extra = {}) {
  return new Request('https://smeshapi.site/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      license_key: licenseKey,
      device_id: DEVICE,
      activation_token: ACTIVATION_TOKEN,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra
    })
  });
}

const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const realFetch = globalThis.fetch;
let licenseSeq = 0;
const nextLicense = () => `${LICENSE}-${++licenseSeq}`;

/* ---- emergency Auto route also uses GLM with forced maximum thinking ---- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  let upstreamBody = null;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  };
  try {
    const response = await handleAiChat(
      chatRequest(key, 'deepseek', { reasoning_effort: 'low' }),
      environment(db, key)
    );
    assert.equal(response.status, 200);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(upstreamBody.model, 'glm-5.3-flash');
  assert.equal(upstreamBody.reasoning_effort, 'max');
  assert.deepEqual(upstreamBody.thinking, { type: 'enabled' });
}

/* --------- a thrown upstream fetch RETAINS the charge (ambiguous) --------- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  // The Workers runtime cannot tell a refused connection from a reset that
  // dropped an already-delivered POST body, so this must fail closed. A local
  // provider that accepts full bodies and then destroys the connection is the
  // exact shape that used to let one quota slot buy unbounded provider work.
  globalThis.fetch = async () => { throw new TypeError('connection reset'); };
  try {
    const response = await handleAiChat(chatRequest(key), environment(db, key));
    assert.equal(response.status, 502);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 1,
    'a reset upstream may already have received the request — the slot stands');
  assert.equal(db.get(day, '*', 'all'), 1,
    'the global breaker must also hold an ambiguous dispatch');
}

/* ------------ an ambiguous upstream 5xx RETAINS the charge ------------- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  globalThis.fetch = async () => new Response('{"error":"boom"}', { status: 500 });
  try {
    const response = await handleAiChat(chatRequest(key), environment(db, key));
    assert.equal(response.status, 502);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 1,
    'a 5xx may follow completed paid work — the slot stands');
  assert.equal(db.get(day, '*', 'all'), 1);
}

/* --------- repeated ambiguous failures still saturate the cap ---------- */
{
  const db = new QuotaD1(2, 10);
  const key = nextLicense();
  const env = environment(db, key, { PROXY_QWEN_DAILY: '2' });
  globalThis.fetch = async () => { throw new TypeError('connection reset'); };
  try {
    assert.equal((await handleAiChat(chatRequest(key), env)).status, 502);
    assert.equal((await handleAiChat(chatRequest(key), env)).status, 502);
    // Third attempt: the licence's two slots are gone, so the cap now bounds
    // the ambiguous provider work instead of refunding it away. This is the
    // whole point of the finding — under the old behaviour a caller could
    // repeat this forever at a cap of two.
    const third = await handleAiChat(chatRequest(key), env);
    assert.equal(third.status, 429, 'ambiguous failures must still exhaust the daily cap');
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 2);
}

/* ------ an explicit provider refusal (auth/billing) releases it -------- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  globalThis.fetch = async () => new Response('{"error":"invalid key"}', { status: 401 });
  try {
    const response = await handleAiChat(chatRequest(key), environment(db, key));
    assert.equal(response.status, 503);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 0,
    'a rejected request ran no model — the student keeps the slot');
  assert.equal(db.get(day, '*', 'all'), 0);
}

/* ---------- an upstream rate-limit refusal releases the charge ---------- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  globalThis.fetch = async () => new Response('{"error":"slow down"}', { status: 429 });
  try {
    const response = await handleAiChat(chatRequest(key), environment(db, key));
    assert.equal(response.status, 429);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 0,
    'a throttled request ran no model — the student keeps the slot');
  assert.equal(db.get(day, '*', 'all'), 0);
}

/* ------- "no available models" is non-billable despite being 503 ------- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  globalThis.fetch = async () => new Response(
    '{"error":{"err_code":-10008,"message":"No available models currently"}}', { status: 503 }
  );
  try {
    const response = await handleAiChat(chatRequest(key), environment(db, key));
    assert.equal(response.status, 503);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 0,
    'an unrouted model ran nothing — the student keeps the slot');
  assert.equal(db.get(day, '*', 'all'), 0);
}

/* -------- positive control: a real answer KEEPS its reservation --------- */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
  try {
    const response = await handleAiChat(chatRequest(key), environment(db, key));
    assert.equal(response.status, 200);
  } finally { globalThis.fetch = realFetch; }

  assert.equal(db.get(day, key, 'qwen'), 1,
    'a delivered answer must consume exactly one slot');
  assert.equal(db.get(day, '*', 'all'), 1);
}

/* ----------- a release never drives a counter below zero ------------ */
{
  const db = new QuotaD1(5, 10);
  const key = nextLicense();
  const { releaseQuota } = await import('../backend/src/ai-proxy.js');
  assert.equal(await releaseQuota(environment(db, key), day, key, 'qwen'), false,
    'releasing a charge that was never made must be a no-op');
  assert.equal(db.get(day, key, 'qwen'), 0);
  assert.equal(db.get(day, '*', 'all'), 0);
}

console.log('ai proxy quota release regression passed');
