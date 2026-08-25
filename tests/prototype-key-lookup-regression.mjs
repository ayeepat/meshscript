/**
 * Caller-controlled strings used as object keys must resolve OWN properties.
 *
 * A bare `TABLE[key]` also returns Object.prototype members, and every lookup
 * table below was reachable from an untrusted or semi-trusted caller:
 *
 *   /admin/stats/<name>      → STATS_ROUTES['constructor'] is Object, and
 *                              Object(env, params) RETURNS env — the handler
 *                              then serialized every configured secret into the
 *                              response body.
 *   /ai/chat provider        → PROVIDERS['constructor'] passed the
 *                              unknown-provider gate with no cap/model config.
 *   /t meta keys             → META_STRING_VALUES['constructor'] is Object, and
 *                              `Object.has` is not a function → uncaught
 *                              TypeError → 500 that dropped the event batch.
 *   /admin/stats/users?sort= → USER_SORTS['constructor'] was interpolated
 *                              straight into ORDER BY.
 *
 * The prototype member names are the whole point of this file: do not "simplify"
 * them to ordinary unknown strings, which every version of this code rejected.
 */
import assert from 'node:assert/strict';
import './helpers/worker-runtime-shim.mjs';

const { default: worker } = await import('../backend/src/worker.js');
const { handleAiChat } = await import('../backend/src/ai-proxy.js');
const analytics = await import('../backend/src/analytics.js');

const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];
const ADMIN_SECRET = 'a'.repeat(64);
const STATS_SECRET = 's'.repeat(64);
const DEVICE = '11111111-1111-4111-8111-111111111111';
const ctx = { waitUntil() {} };

/* ------------------- /admin/stats/<name> secret disclosure ------------------ */

const SECRETS = {
  ADMIN_SECRET,
  STATS_SECRET,
  ROBOKASSA_PASSWORD2_PRODUCTION: 'robokassa-password-two',
  AI_PROXY_API_KEY: 'sk-302ai-live-key',
  TELEGRAM_BOT_TOKEN: '123456:telegram-bot-token',
  INGEST_KEY: 'i'.repeat(48)
};
// A DB must be bound, otherwise handleAdminStats short-circuits on no_db before
// it ever resolves the route name — which would make this test pass vacuously.
// The stub records SQL and answers benignly; a stub that threw would leave
// unawaited rejections behind inside the handler's Promise.all batches.
class RecordingD1 {
  statements = [];
  prepare(sql) {
    this.statements.push(sql);
    return {
      bind: () => this.statement(),
      ...this.statement()
    };
  }
  statement() {
    return {
      async run() { return { meta: { changes: 0 } }; },
      async first() { return null; },
      async all() { return { results: [] }; }
    };
  }
  aggregated() {
    return this.statements.filter((sql) =>
      /FROM events|FROM devices|FROM purchases|FROM referral/i.test(sql));
  }
}
const statsDb = new RecordingD1();
const statsEnv = {
  ...SECRETS,
  LICENSES: { get: async () => null },
  DB: statsDb
};

for (const name of PROTOTYPE_KEYS) {
  const response = await worker.fetch(
    new Request(`https://smeshapi.site/admin/stats/${name}`, {
      headers: { 'x-stats-token': STATS_SECRET }
    }),
    statsEnv,
    ctx
  );
  const body = await response.text();
  assert.equal(response.status, 404,
    `/admin/stats/${name} must be an unknown route, not a prototype member`);
  assert.deepEqual(JSON.parse(body), { ok: false, reason: 'not_found' });
  for (const [key, secret] of Object.entries(SECRETS)) {
    assert.ok(!body.includes(secret), `/admin/stats/${name} leaked ${key}`);
  }
  assert.deepEqual(statsDb.aggregated(), [],
    `/admin/stats/${name} must not run any stats query`);
}

// Positive control: the guard rejects prototype members ONLY. A real route name
// still dispatches and aggregates. Without this, an over-strict guard would 404
// everything and the checks above would pass while the dashboard was broken.
const realRoute = await worker.fetch(
  new Request('https://smeshapi.site/admin/stats/overview?days=1', {
    headers: { 'x-stats-token': STATS_SECRET }
  }),
  statsEnv,
  ctx
);
assert.equal(realRoute.status, 200, 'a genuine stats route must still dispatch');
assert.ok(statsDb.aggregated().length > 0,
  'a genuine stats route must reach its aggregation queries');

/* ---------------------- /ai/chat provider selection ------------------------ */

// A charge must never happen for a provider that has no cap: `mine > undefined`
// is false, i.e. no per-license daily limit at all. D1 here throws on any use,
// so reaching the quota statement at all fails this test loudly.
const hostileProxyEnv = {
  AI_PROXY_API_KEY: 'sk-live',
  DB: {
    prepare() { throw new Error('quota accounting must not run for an unknown provider'); },
    batch() { throw new Error('quota accounting must not run for an unknown provider'); }
  }
};

for (const provider of PROTOTYPE_KEYS) {
  const response = await handleAiChat(new Request('https://smeshapi.site/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      license_key: 'SMESH-AAAA-BBBB-CCCC',
      device_id: DEVICE,
      messages: [{ role: 'user', content: 'hi' }]
    })
  }), hostileProxyEnv);
  assert.equal(response.status, 400,
    `provider="${provider}" must be rejected as unknown, not treated as a config object`);
  assert.equal((await response.json()).error.message, 'Неизвестный провайдер.');
}

/* -------------------------- /t telemetry meta keys ------------------------- */

// sanitizeMeta is module-private; drive it through the real ingest path. The
// batch must be accepted (200) and the prototype key must not survive into the
// stored meta — the old code threw a TypeError that surfaced as a 500.
class MetaCapturingD1 {
  events = [];
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          sql,
          args,
          async run() {
            if (sql.includes('INSERT INTO events')) db.events.push(args);
            return { meta: { changes: 1 } };
          },
          async first() {
            if (sql.includes('telemetry_budget')) return { count: 1 };
            return null;
          },
          async all() { return { results: [] }; }
        };
      }
    };
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

for (const key of PROTOTYPE_KEYS) {
  const db = new MetaCapturingD1();
  const result = await analytics.handleIngest(
    new Request('https://smeshapi.site/t', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: DEVICE,
        events: [{ type: 'solve', meta: { [key]: 'brief', mode: 'brief' } }]
      })
    }),
    { DB: db },
    DEVICE
  );
  assert.notEqual(result.status, 500,
    `a meta key of "${key}" must not crash ingest`);
  assert.ok(result.ok !== false || result.reason !== 'bad_json',
    `a meta key of "${key}" must not be treated as malformed input`);
  for (const args of db.events) {
    const meta = args.find((value) => typeof value === 'string' && value.startsWith('{'));
    if (!meta) continue;
    const parsed = JSON.parse(meta);
    // Object.hasOwn, not `parsed[key]`: reading a prototype member off the
    // parsed object is the very mistake this file exists to prevent.
    assert.ok(!Object.hasOwn(parsed, key),
      `"${key}" must not be persisted as a meta field`);
    assert.equal(parsed.mode, 'brief',
      'the legitimate meta field alongside it must still be stored');
  }
}

/* ------------------- /admin/stats/users ORDER BY / LIMIT ------------------- */

// statsUsers splices sort/limit/offset into SQL text. Capture what it builds.
class SqlRecordingD1 {
  statements = [];
  prepare(sql) {
    this.statements.push(sql);
    return {
      bind: () => ({
        async all() { return { results: [] }; },
        async first() { return { n: 0 }; }
      })
    };
  }
}

for (const sort of PROTOTYPE_KEYS) {
  const db = new SqlRecordingD1();
  await analytics.statsUsers({ DB: db }, { sort, days: '1' });
  for (const sql of db.statements) {
    assert.ok(!/native code/.test(sql),
      `sort="${sort}" must not interpolate a function into SQL`);
    assert.ok(!/ORDER BY function/i.test(sql),
      `sort="${sort}" must fall back to the default ORDER BY`);
  }
}

// SQLite rejects a non-integer LIMIT/OFFSET outright, so they must be truncated
// before they ever reach the statement text.
{
  const db = new SqlRecordingD1();
  await analytics.statsUsers({ DB: db }, { limit: '5.5', offset: '2.7', days: '1' });
  const page = db.statements.find((sql) => sql.includes('LIMIT'));
  assert.match(page, /LIMIT 5 OFFSET 2/,
    'fractional paging input must be truncated to integers');
}

// A `%` in the operator's search box is a literal, not a match-everything
// wildcard, so the bound term escapes it and the statement declares ESCAPE.
{
  const db = new SqlRecordingD1();
  await analytics.statsUsers({ DB: db }, { q: '100%_x', days: '1' });
  const page = db.statements.find((sql) => sql.includes('LIKE'));
  assert.match(page, /LIKE \? ESCAPE '\\'/, 'LIKE filters must declare an escape character');
}

console.log('prototype key lookup regression passed');
