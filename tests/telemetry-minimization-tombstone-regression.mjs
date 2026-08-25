// Regressions for two audit findings:
//  B-07: "content-free" telemetry is now ENFORCED at the boundary — meta is
//        reduced to an allowlisted vocabulary of short scalars (free-text
//        through unknown string keys, nested objects, or 400-char JSON blobs
//        can no longer be persisted), and subject is bounded/de-controlled.
//  B-08: /t/delete writes a tombstone atomically with its deletes, and both
//        ingest paths gate their inserts on tombstone freshness INSIDE the
//        statement — an ingest admitted before the deletion can no longer
//        recreate the erased device afterwards.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { handleIngest, handleServerIngest, handleDeleteDevice } from '../backend/src/analytics.js';

// Executes the ingest/delete SQL against in-memory state, honouring the
// tombstone WHERE NOT EXISTS conditions (the cutoff binds last in every
// gated insert; the device id binds first for devices, third for events).
class FakeD1 {
  budgets = new Map();
  devices = new Map();
  events = [];
  tombstones = new Map();

  blockedByTombstone(sql, device, cutoff) {
    if (!sql.includes('device_tombstones')) return false;
    const deletedAt = this.tombstones.get(device);
    return deletedAt != null && deletedAt > cutoff;
  }

  prepare(sql) {
    const db = this;
    return {
      bind: (...args) => ({
        sql,
        args,
        async first() {
          if (sql.includes('SELECT (') && sql.includes('AS known')) {
            return db.devices.has(args[0]) || db.events.some((event) => event.device_id === args[0]) ||
              [...db.budgets.keys()].some((id) => id.includes(`|device|${args[0]}`)) ? 1 : 0;
          }
          if (sql.includes('INSERT INTO telemetry_budget')) {
            if (sql.includes("'device'")) {
              const [day, key, amount, cutoff] = args;
              if (db.blockedByTombstone(sql, key, cutoff)) return null;
              const id = `${day}|device|${key}`;
              const count = (db.budgets.get(id) || 0) + amount;
              db.budgets.set(id, count);
              return count;
            }
            const [day, scope, key, amount] = args;
            const id = `${day}|${scope}|${key}`;
            const count = (db.budgets.get(id) || 0) + amount;
            db.budgets.set(id, count);
            return count; // handleIngest reads .first('count')
          }
          return null;
        },
        async run() {
          if (sql.includes('INSERT INTO device_tombstones')) {
            db.tombstones.set(args[0], args[1]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM events')) {
            db.events = db.events.filter((event) => event.device_id !== args[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM devices')) {
            db.devices.delete(args[0]);
            return { meta: { changes: 1 } };
          }
          if (sql.includes('DELETE FROM telemetry_budget')) {
            for (const id of [...db.budgets.keys()]) {
              if (id.includes('|device|') && id.endsWith(`|${args[0]}`)) db.budgets.delete(id);
            }
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO devices')) {
            const device = args[0];
            if (db.blockedByTombstone(sql, device, args.at(-1))) return { meta: { changes: 0 } };
            db.devices.set(device, sql.includes('browser, ua, version')
              ? { device_id: device, browser: args[2], version: args[3], provider: args[4], license_type: args[5] }
              : { device_id: device });
            return { meta: { changes: 1 } };
          }
          if (sql.includes('INSERT INTO events')) {
            const device = args[2];
            if (db.blockedByTombstone(sql, device, args.at(-1))) return { meta: { changes: 0 } };
            const isServer = sql.includes("'ai_call'");
            db.events.push(isServer
              ? { device_id: device, type: 'ai_call', provider: args[3], model: args[4], meta: args[8] ?? null }
              : {
                  device_id: device,
                  type: args[3],
                  subject: args[4],
                  provider: args[5],
                  model: args[6],
                  tokens_in: args[7],
                  tokens_out: args[8],
                  cost_usd: args[9],
                  meta: args[12] ?? null
                });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 1 } };
        }
      })
    };
  }

  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

const DEVICE = 'aaaaaaaa-1111-4111-8111-111111111111';

const ingest = (env, events, device = DEVICE, fields = {}) => handleIngest(new Request('https://smeshapi.site/t', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.99' },
  body: JSON.stringify({ device_id: device, browser: 'chrome', events, ...fields })
}), env, device);

const deleteDevice = (env, device = DEVICE) => handleDeleteDevice(new Request('https://smeshapi.site/t/delete', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ device_id: device })
}), env, device);

/* ---- B-07: meta is reduced to the allowlisted content-free vocabulary ---- */
{
  const db = new FakeD1();
  const env = { DB: db };
  const res = await ingest(env, [{
    ts: Date.now(),
    type: 'solve',
    subject: 'Алгебра\nОтвет: x=42, пароль qwerty',
    tokens_in: 5_000_000,
    tokens_out: 5_000_000,
    cost_usd: 50,
    meta: {
      mode: 'brief', followup: 1, gdz_auto: 0, ok: true,
      op: 'пароль qwerty внутри разрешённого ключа',      // allowlisted key, invalid value — drop
      passwordqwerty: true, answer42: 1,                 // secret-bearing keys — must drop
      msg: 'решение: пароль от журнала qwerty123',       // free text — must drop
      task_text: 'Реши уравнение...',                    // free text — must drop
      'API-Key': 'sk-abc123',                            // bad key shape — must drop
      nested: { secret: 'value' },                       // objects — must drop
      huge: 9e99                                          // unknown numeric metric — must drop
    }
  }], DEVICE, {
    version: 'password.qwerty',
    provider: 'secret-provider-qwerty',
    license_type: 'answer-x42'
  });
  assert.equal(res.ok, true);
  assert.equal(db.events.length, 1);
  const stored = db.events[0];
  const meta = JSON.parse(stored.meta);
  assert.deepEqual(meta, { mode: 'brief', followup: 1, gdz_auto: 0, ok: true },
    'only allowlisted scalars may survive into stored meta');
  assert.ok(!stored.meta.includes('qwerty') && !stored.meta.includes('sk-abc'),
    'free text and credential-like values must never be persisted');
  assert.equal(stored.subject, 'Алгебра',
    'subject must be reduced to a fixed school-subject vocabulary');
  assert.ok(!stored.subject.includes('Ответ') && !stored.subject.includes('qwerty'),
    'answer/password text must not survive through subject');
  assert.equal(stored.provider, null);
  assert.equal(stored.model, null);
  assert.equal(stored.tokens_in, 0);
  assert.equal(stored.tokens_out, 0);
  assert.equal(stored.cost_usd, 0,
    'client-chosen usage cannot poison financial-looking provider totals');
  const storedDevice = db.devices.get(DEVICE);
  assert.equal(storedDevice.version, null);
  assert.equal(storedDevice.provider, null);
  assert.equal(storedDevice.license_type, null);
  assert.ok(!JSON.stringify({ stored, storedDevice }).includes('qwerty'),
    'free-text telemetry fields outside meta must not persist secrets either');

  await handleServerIngest(new Request('https://smeshapi.site/t/ai', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{
      device_id: DEVICE,
      provider: 'password-qwerty',
      model: 'answer-x42',
      meta: { src: 'vps', answer42: 1 }
    }] })
  }), env);
  const serverStored = db.events.at(-1);
  assert.equal(serverStored.provider, null);
  assert.equal(serverStored.model, null);
  assert.deepEqual(JSON.parse(serverStored.meta), { src: 'vps' });

  const noise = await ingest(env, [{ ts: Date.now(), type: 'error', meta: { MSG: 'x', blob: { a: 1 } } }]);
  assert.equal(noise.ok, true);
  assert.equal(db.events.at(-1).meta, null, 'meta with nothing allowlisted stores as NULL');
}

/* ---- B-08: deletion tombstone defeats in-flight recreation ---- */
{
  const db = new FakeD1();
  const env = { DB: db };
  await ingest(env, [{ ts: Date.now(), type: 'solve', subject: 'Физика' }]);
  assert.equal(db.devices.has(DEVICE), true);
  assert.equal(db.events.length, 1);
  assert.equal([...db.budgets.keys()].some((id) => id.includes(`|device|${DEVICE}`)), true);

  const deleted = await deleteDevice(env);
  assert.deepEqual(deleted, { ok: true, deleted: true });
  assert.equal(db.devices.has(DEVICE), false);
  assert.equal(db.events.length, 0);
  assert.equal([...db.budgets.keys()].some((id) => id.includes(`|device|${DEVICE}`)), false,
    'deletion must erase the device-scoped admission budget too');

  // The in-flight replay: a request admitted before the delete now lands its
  // batch after it. Nothing may reappear, even though the call reports ok.
  const replay = await ingest(env, [{ ts: Date.now(), type: 'solve', subject: 'Физика' }]);
  assert.equal(replay.ok, true, 'telemetry must never break the extension');
  assert.equal(db.devices.has(DEVICE), false, 'a fresh tombstone must block device recreation');
  assert.equal(db.events.length, 0, 'a fresh tombstone must block event recreation');
  assert.equal([...db.budgets.keys()].some((id) => id.includes(`|device|${DEVICE}`)), false,
    'an in-flight/replayed ingest must not recreate the erased device budget');
  assert.equal([...db.budgets.keys()].some((id) => id.includes('|ip|')), true,
    'the non-personal-to-this-capability IP abuse budget may remain');

  // The server-observed path is gated identically.
  await handleServerIngest(new Request('https://smeshapi.site/t/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ device_id: DEVICE, provider: 'qwen', tokens_in: 10 }] })
  }), env);
  assert.equal(db.devices.has(DEVICE), false);
  assert.equal(db.events.length, 0);

  // Deletion stays idempotent.
  assert.deepEqual(await deleteDevice(env), { ok: true, deleted: false });

  // An expired tombstone stops blocking: the user erased history, not future
  // participation — a still-opted-in install may report again later.
  db.tombstones.set(DEVICE, Date.now() - 16 * 60 * 1000);
  await ingest(env, [{ ts: Date.now(), type: 'solve', subject: 'Физика' }]);
  assert.equal(db.devices.has(DEVICE), true);
  assert.equal(db.events.length, 1);
}

const schema = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
assert.match(schema, /CREATE TABLE IF NOT EXISTS device_tombstones/,
  'the deletion tombstone table must ship with the schema');

// The shipped «Файл не подгрузился? Диагностика» button renders its output into
// a textarea a schoolchild is invited to copy into a support chat. It must
// report WHICH LAYER failed, never the account behind it.
{
  const scraper = await readFile(new URL('../src/content/scraper.js', import.meta.url), 'utf8');
  const diagnostic = scraper.slice(
    scraper.indexOf('async function debugFetch('),
    scraper.indexOf('/* ---------- Entry point ---------- */')
  );
  assert.ok(diagnostic.length > 0, 'the support diagnostic must be extractable');

  for (const [field, why] of [
    ['personId:', 'the JWT person claim identifies the account'],
    ['studentId:', 'the resolved student id identifies the child'],
    ['storageHints', 'scraping localStorage values exports raw account identifiers'],
    ['bodySample', 'a Mesh error body can echo the student and person ids'],
    ['pageUrl', 'the full diary URL carries per-account query parameters'],
    ['out.apiUrl', 'the family-API query string carries student_id and person_id'],
  ]) {
    assert.ok(!diagnostic.includes(field),
      `the support diagnostic must not report ${field.replace(/[:.]/g, '')} — ${why}`);
  }
  for (const field of ['tokenFound', 'personIdFound', 'studentIdFound', 'studentIdSource']) {
    assert.ok(diagnostic.includes(field),
      `the support diagnostic must still report ${field} so the failing layer stays identifiable`);
  }
  // The bare pathname is NOT safe: this endpoint ends in the lesson id, so
  // reporting it exported the very identifier the contract withholds. The path
  // must go through the same opaque-segment redaction as every other URL.
  assert.match(diagnostic, /out\.apiPath = diagnosticUrl\(apiUrl\)\.replace\(/,
    'the API path must be redacted, not reported verbatim');
  assert.match(diagnostic, /pagePath:\s*\(\(\) => \{[\s\S]*?diagnosticUrl\(location\.href\)/,
    'the diary page path must use the same opaque-id redaction as attachment URLs');
  assert.ok(!diagnostic.includes('lessonId: lessonId'),
    'the lesson id itself must never be exported — only its presence');
  assert.match(diagnostic, /lessonIdFound: !!lessonId/,
    'the support diagnostic must still report whether a lesson was resolved');
  assert.doesNotMatch(scraper, /errorText/,
    'no caller may read a non-OK Mesh body back out of fetchMeshJson');

  const redactStart = scraper.indexOf('function diagnosticSegment(');
  const redactEnd = scraper.indexOf('// Strict scalar allowlist', redactStart);
  assert.ok(redactStart >= 0 && redactEnd > redactStart,
    'the production diagnostic redactor must be extractable');
  const redaction = { URL, location: { href: 'https://school.mos.ru/diary/homework/987654' } };
  vm.createContext(redaction);
  vm.runInContext(
    `${scraper.slice(redactStart, redactEnd)}\nthis.diagnosticUrl = diagnosticUrl;`,
    redaction
  );
  assert.equal(
    redaction.diagnosticUrl('https://school.mos.ru/api/family/web/v1/lesson_schedule_items/123456?student_id=789&sig=secret'),
    'https://school.mos.ru/api/family/web/v1/lesson_schedule_items/<id>?<redacted>',
    'lesson/account ids and signed capability queries must be absent from copied diagnostics'
  );
}

console.log('telemetry minimization and tombstone regressions passed');
