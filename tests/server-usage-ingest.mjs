import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';

const { default: worker } = await import('../backend/src/worker.js');
const { issueTelemetryToken } = await import('../backend/src/telemetry-token.js');

// POST /t/ai — the INGEST_KEY-gated server-truth usage sink. Verifies the
// auth boundary (secret required, browsers rejected outright) and that a
// valid batch lands as 'ai_call' rows — a type the open /t endpoint refuses,
// so clients can never forge server-truth data.

const INGEST_KEY = 'i'.repeat(48);
const ctx = { waitUntil() {} };
const SERVER_DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_DEVICE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function dbStub() {
  const batches = [];
  const budgets = new Map();
  return {
    batches,
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            sql, binds,
            async first() {
              if (!sql.includes('INSERT INTO telemetry_budget')) return null;
              const isDevice = sql.includes("SELECT ?1, 'device'");
              const day = binds[0];
              const scope = isDevice ? 'device' : binds[1];
              const key = isDevice ? binds[1] : binds[2];
              const amount = isDevice ? binds[2] : binds[3];
              const cap = binds[4];
              const limit = binds[5];
              const id = `${day}|${scope}|${key}`;
              const current = budgets.get(id) || 0;
              if (current > limit) return null;
              const count = Math.min(current + amount, cap);
              budgets.set(id, count);
              return count;
            },
            async run() { return {}; },
            async all() { return { results: [] }; }
          };
        }
      };
    },
    async batch(stmts) { batches.push(stmts); return []; }
  };
}

async function postAi(body, headers = {}, env = {}) {
  return worker.fetch(new Request('https://smeshapi.site/t/ai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  }), env, ctx);
}

// No INGEST_KEY configured → closed, even with a header supplied.
{
  const res = await postAi({ events: [] }, { 'X-Ingest-Key': INGEST_KEY }, { DB: dbStub() });
  assert.equal(res.status, 401, 'missing INGEST_KEY secret must fail closed');
}

// Wrong key → 401, nothing written.
{
  const db = dbStub();
  const res = await postAi({ events: [] }, { 'X-Ingest-Key': 'wrong' }, { INGEST_KEY, DB: db });
  assert.equal(res.status, 401);
  assert.equal(db.batches.length, 0);
}

// Correct key but a browser Origin → 401 (server-to-server only).
{
  const res = await postAi({ events: [] }, {
    'X-Ingest-Key': INGEST_KEY, Origin: 'https://evil.example'
  }, { INGEST_KEY, DB: dbStub() });
  assert.equal(res.status, 401, 'browser callers must never reach /t/ai');
}

// Correct key, no DB binding → 503.
{
  const res = await postAi({ events: [] }, { 'X-Ingest-Key': INGEST_KEY }, { INGEST_KEY });
  assert.equal(res.status, 503);
}

// Correct key + DB: valid event stored as ai_call, invalid device dropped.
{
  const db = dbStub();
  const res = await postAi({
    events: [
      { device_id: SERVER_DEVICE, provider: 'qwen', model: 'qwen3.7-plus', tokens_in: 1000, tokens_out: 500, cost_usd: 0.001, meta: { src: 'vps' } },
      { device_id: 'x', provider: 'qwen' } // fails cleanPublicDeviceId → skipped
    ]
  }, { 'X-Ingest-Key': INGEST_KEY }, { INGEST_KEY, DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, accepted: 1 });
  assert.equal(db.batches.length, 1);
  const stmts = db.batches[0];
  assert.equal(stmts.length, 2, 'one device upsert + one event insert');
  assert.match(stmts[0].sql, /INSERT INTO devices/);
  assert.equal(stmts[0].binds[0], SERVER_DEVICE);
  assert.match(stmts[1].sql, /'ai_call'/);
  assert.ok(stmts[1].binds.includes(1000) && stmts[1].binds.includes(500), 'token counts must be bound');
}

// The browser /t endpoint requires a device-bound capability and must keep
// refusing the ai_call type even after that narrower admission succeeds.
{
  const db = dbStub();
  const body = JSON.stringify({
    device_id: CLIENT_DEVICE,
    browser: 'chrome',
    events: [{ type: 'ai_call', tokens_in: 9_999_999, cost_usd: 50 }]
  });
  const anonymous = await worker.fetch(new Request('https://smeshapi.site/t', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  }), { DB: db, INGEST_KEY }, ctx);
  assert.equal(anonymous.status, 401);
  assert.equal(db.batches.length, 0);

  const attestation = await issueTelemetryToken(
    { INGEST_KEY },
    CLIENT_DEVICE
  );
  const res = await worker.fetch(new Request('https://smeshapi.site/t', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telemetry-Token': attestation.token
    },
    body
  }), { DB: db, INGEST_KEY }, ctx);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.accepted, 0, 'clients must not be able to forge server-truth ai_call rows');
}

console.log('server usage ingest regression passed');
