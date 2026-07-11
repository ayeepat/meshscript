import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';

const { default: worker } = await import('../backend/src/worker.js');

// POST /t/ai — the INGEST_KEY-gated server-truth usage sink. Verifies the
// auth boundary (secret required, browsers rejected outright) and that a
// valid batch lands as 'ai_call' rows — a type the open /t endpoint refuses,
// so clients can never forge server-truth data.

const INGEST_KEY = 'i'.repeat(48);
const ctx = { waitUntil() {} };

function dbStub() {
  const batches = [];
  return {
    batches,
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            sql, binds,
            async first() { return null; },
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
      { device_id: 'device-aaaaaaaa', provider: 'qwen', model: 'qwen3.7-plus', tokens_in: 1000, tokens_out: 500, cost_usd: 0.001, meta: { src: 'vps' } },
      { device_id: 'x', provider: 'qwen' } // fails cleanDeviceId → skipped
    ]
  }, { 'X-Ingest-Key': INGEST_KEY }, { INGEST_KEY, DB: db });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, accepted: 1 });
  assert.equal(db.batches.length, 1);
  const stmts = db.batches[0];
  assert.equal(stmts.length, 2, 'one device upsert + one event insert');
  assert.match(stmts[0].sql, /INSERT INTO devices/);
  assert.equal(stmts[0].binds[0], 'device-aaaaaaaa');
  assert.match(stmts[1].sql, /'ai_call'/);
  assert.ok(stmts[1].binds.includes(1000) && stmts[1].binds.includes(500), 'token counts must be bound');
}

// The OPEN /t endpoint must keep refusing the ai_call type outright.
{
  const db = dbStub();
  const res = await worker.fetch(new Request('https://smeshapi.site/t', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_id: 'device-bbbbbbbb',
      browser: 'chrome',
      events: [{ type: 'ai_call', tokens_in: 9_999_999, cost_usd: 50 }]
    })
  }), { DB: db }, ctx);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.accepted, 0, 'clients must not be able to forge server-truth ai_call rows');
}

console.log('server usage ingest regression passed');
