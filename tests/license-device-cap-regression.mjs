// Regression: the per-license device cap (DEVICE_LIMIT) must hold even under
// concurrent /verify calls. The historical KV-only path (read device_ids →
// check length < limit → push) let two simultaneous verifies with distinct
// devices both observe room and both push, exceeding the cap. verifyLicense now
// claims a slot with one atomic conditional INSERT in D1; KV has no CAS, so D1
// is the authority for the cap while the KV row stays a display mirror.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { deactivateLicense, getLicense, verifyLicense } from '../backend/src/licenses.js';

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

// Models SQLite's serialized-writer semantics for the one operation that matters:
// the conditional INSERT re-counts and inserts in a SINGLE synchronous step (no
// await inside run()), so concurrent claims can never both pass the cap.
class FakeD1 {
  rows = new Set(); // "LICENSE|device"
  count(key) { let n = 0; for (const r of this.rows) if (r.startsWith(key + '|')) n++; return n; }
  prepare(sql) {
    return {
      bind: (...args) => ({
        run: async () => {
          if (sql.includes('license_devices') && sql.includes('SELECT')) {
            const [key, device, , limit] = args;            // conditional insert
            const id = `${key}|${device}`;
            if (this.rows.has(id)) return { meta: { changes: 0 } };        // OR IGNORE
            if (this.count(key) < limit) { this.rows.add(id); return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };                 // cap full
          }
          if (sql.includes('license_devices')) {             // seed (VALUES)
            this.rows.add(`${args[0]}|${args[1]}`);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };                   // purchases mirror etc.
        },
        first: async () => {
          if (sql.includes('SELECT 1 FROM license_devices')) {
            return this.rows.has(`${args[0]}|${args[1]}`) ? { 1: 1 } : null;
          }
          return null;
        }
      })
    };
  }
  async batch(statements) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async first(column) {
        const row = db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const ACTIVE_LIFETIME = { type: 'lifetime', status: 'active', expires_at: null };
const seedLicense = (kv, key, deviceIds = []) =>
  kv.store.set(key, JSON.stringify({ key, ...ACTIVE_LIFETIME, device_ids: deviceIds }));

const dev = (n) => `device-${String(n).padStart(4, '0')}-uuid`;

/* ---- 0. malformed keys never become an empty KV lookup ---- */
{
  let reads = 0;
  const env = { LICENSES: { async get() { reads += 1; return null; } } };
  assert.equal(await getLicense(env, '!not-a-license!'), null);
  assert.equal(reads, 0, 'invalid keys must be rejected before calling KV with an empty normalized key');
}

/* ---- 1. first activation owns device №1 and receives a bearer capability ---- */
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new SqliteD1(sqlite), DEVICE_LIMIT: '1' };
  seedLicense(kv, 'SMESH-SINGLE');

  const first = await verifyLicense(env, 'SMESH-SINGLE', dev(1));
  assert.equal(first.ok, true);
  assert.match(first.activation_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await verifyLicense(env, 'SMESH-SINGLE', dev(1))).reason, 'device_in_use',
    'the public installation UUID alone must not authenticate a repeat verify');
  assert.equal((await verifyLicense(env, 'SMESH-SINGLE', dev(1), 'x'.repeat(43))).reason, 'device_in_use');
  assert.equal((await verifyLicense(env, 'SMESH-SINGLE', dev(1), first.activation_token)).ok, true,
    'device №1 stays usable only with its server-issued activation capability');
  const competing = await verifyLicense(env, 'SMESH-SINGLE', dev(2));
  assert.deepEqual(
    { reason: competing.reason, device_number: competing.device_number },
    { reason: 'device_in_use', device_number: 1 }
  );

  assert.equal((await deactivateLicense(env, 'SMESH-SINGLE', dev(1), 'x'.repeat(43))).ok, false);
  assert.equal((await deactivateLicense(env, 'SMESH-SINGLE', dev(1), first.activation_token)).ok, true);
  const moved = await verifyLicense(env, 'SMESH-SINGLE', dev(2));
  assert.equal(moved.ok, true, 'explicit sign-out releases the one active installation');
  assert.notEqual(moved.activation_token, first.activation_token);
  assert.equal((await verifyLicense(env, 'SMESH-SINGLE', dev(1), first.activation_token)).reason,
    'device_in_use', 'the old installation cannot revive itself after transfer');
  sqlite.close();
}

/* ---- 2. synchronized first claims still have exactly one winner ---- */
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new SqliteD1(sqlite), DEVICE_LIMIT: '1' };
  seedLicense(kv, 'SMESH-RACE');
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => verifyLicense(env, 'SMESH-RACE', dev(100 + index)))
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => result.reason === 'device_in_use').length, 7);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS n FROM license_activations WHERE license_key = ? AND status = 'active'"
  ).get('SMESH-RACE').n, 1);
  sqlite.close();
}

/* ---- 3. a pre-migration license preserves its earliest historical device ---- */
{
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  const kv = new FakeKV();
  const env = { LICENSES: kv, DB: new SqliteD1(sqlite), DEVICE_LIMIT: '1' };
  seedLicense(kv, 'SMESH-LEGACY', [dev(1), dev(2), dev(3)]);
  assert.equal((await verifyLicense(env, 'SMESH-LEGACY', dev(2))).reason, 'device_in_use',
    'a copied legacy key cannot steal continuity from device №1');
  assert.equal((await verifyLicense(env, 'SMESH-LEGACY', dev(1))).ok, true);
  sqlite.close();
}

/* ---- 4. the authoritative activation registry and exact config fail closed ---- */
{
  const kv = new FakeKV();
  seedLicense(kv, 'SMESH-NODB', [dev(1)]);
  assert.equal((await verifyLicense({ LICENSES: kv, DEVICE_LIMIT: '1' }, 'SMESH-NODB', dev(1))).reason,
    'service_unavailable');

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8'));
  const badConfig = { LICENSES: kv, DB: new SqliteD1(sqlite), DEVICE_LIMIT: '3' };
  assert.equal((await verifyLicense(badConfig, 'SMESH-NODB', dev(1))).reason, 'service_unavailable',
    'deployments cannot silently reopen the historical multi-device policy');
  sqlite.close();
}

console.log('license device-cap regressions passed');
