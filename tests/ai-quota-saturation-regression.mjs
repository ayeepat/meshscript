// B-11: quota rejection must be saturating. The cap-th admitted request records
// exactly `cap`; every rejected request is either a conditional SQLite no-op or
// is shed from its isolate before D1, never another hot-row write. The global
// predicate is part of the per-license UPSERT so a FRESH Worker isolate cannot
// write a license row after the shared breaker is already open.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

class SqliteD1 {
  db = new DatabaseSync(':memory:');
  statements = 0;
  writes = 0;

  constructor() {
    this.db.exec(`
      CREATE TABLE proxy_quota (
        day TEXT NOT NULL,
        license_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, license_key, provider)
      )
    `);
  }

  totalChanges() {
    return Number(this.db.prepare('SELECT total_changes() AS n').get().n);
  }

  prepare(sql) {
    const db = this;
    let args = [];
    const statement = {
      bind(...values) {
        args = values;
        return statement;
      },
      async first(column) {
        db.statements += 1;
        const before = db.totalChanges();
        const row = db.db.prepare(sql).get(...args);
        db.writes += db.totalChanges() - before;
        return column ? row?.[column] ?? null : row ?? null;
      },
      execute() {
        const before = db.totalChanges();
        const row = db.db.prepare(sql).get(...args);
        db.writes += db.totalChanges() - before;
        return {
          success: true,
          results: row ? [row] : [],
          meta: { changes: db.totalChanges() - before }
        };
      },
    };
    return statement;
  }

  async batch(statements) {
    this.statements += statements.length;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  count(licenseKey, provider) {
    return this.db.prepare(
      'SELECT count FROM proxy_quota WHERE license_key = ? AND provider = ?'
    ).get(licenseKey, provider)?.count ?? null;
  }

  rows(provider) {
    return this.db.prepare(
      'SELECT license_key, count FROM proxy_quota WHERE provider = ? ORDER BY license_key'
    ).all(provider);
  }
}

// Queue a known number of independently-started Worker calls before letting
// SQLite serialize their transaction batches. This forces every caller to be
// in flight at once while preserving D1's documented batch isolation.
class ConcurrentSqliteD1 extends SqliteD1 {
  constructor(expectedBatches) {
    super();
    this.expectedBatches = expectedBatches;
    this.pendingBatches = [];
    this.released = false;
  }

  async batch(statements) {
    if (this.released) return super.batch(statements);
    return new Promise((resolve, reject) => {
      this.pendingBatches.push({ statements, resolve, reject });
      if (this.pendingBatches.length !== this.expectedBatches) return;
      this.released = true;
      const pending = this.pendingBatches.splice(0);
      queueMicrotask(async () => {
        for (const item of pending) {
          try {
            item.resolve(await super.batch(item.statements));
          } catch (error) {
            item.reject(error);
          }
        }
      });
    });
  }
}

class FaultingBatchD1 extends SqliteD1 {
  async batch(statements) {
    this.statements += statements.length;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      statements[0].execute();
      throw new Error('injected second quota statement failure');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

const provider = {
  name: 'Qwen',
  capVar: 'TEST_PROVIDER_CAP',
  capDefault: 80
};

let importNonce = 0;
const freshIsolate = async () => import(
  `../backend/src/ai-proxy.js?quota-isolate=${process.pid}-${Date.now()}-${importNonce++}`
);

/* Per-license saturation: even fresh isolates cannot write the rejected hit. */
{
  const db = new SqliteD1();
  const env = { DB: db, TEST_PROVIDER_CAP: '2', PROXY_GLOBAL_DAILY: '1000' };
  const first = await freshIsolate();
  assert.equal((await first.chargeQuota(env, 'SMESH-QUOTA-A', 'test-a', provider)).ok, true);
  assert.equal((await first.chargeQuota(env, 'SMESH-QUOTA-A', 'test-a', provider)).ok, true);
  assert.equal(db.count('SMESH-QUOTA-A', 'test-a'), 2);
  const writesAtCap = db.writes;

  for (let i = 0; i < 20; i++) {
    const isolate = await freshIsolate();
    assert.equal(
      (await isolate.chargeQuota(env, 'SMESH-QUOTA-A', 'test-a', provider)).ok,
      false
    );
  }
  assert.equal(db.writes, writesAtCap,
    'cross-isolate per-license rejects must be conditional no-ops, never cap+1 writes');
}

/* Global saturation is shared: a fresh isolate cannot consume a license row. */
{
  const db = new SqliteD1();
  const env = { DB: db, TEST_PROVIDER_CAP: '1000', PROXY_GLOBAL_DAILY: '2' };
  const first = await freshIsolate();
  const second = await freshIsolate();
  assert.equal((await first.chargeQuota(env, 'SMESH-GLOBAL-A', 'test-b', provider)).ok, true);
  assert.equal((await second.chargeQuota(env, 'SMESH-GLOBAL-B', 'test-b', provider)).ok, true);
  assert.equal(db.count('*', 'all'), 2, 'the global row stops at its admitted cap');
  const writesAtCap = db.writes;

  for (let i = 0; i < 20; i++) {
    const isolate = await freshIsolate();
    assert.equal(
      (await isolate.chargeQuota(env, `SMESH-GLOBAL-${i + 10}`, 'test-b', provider)).ok,
      false
    );
  }
  assert.equal(db.writes, writesAtCap,
    'fresh-isolate global rejects must not create or increment per-license rows');
  assert.equal(db.count('SMESH-GLOBAL-10', 'test-b'), null);
}

/* Concurrent starts atomically charge both rows or neither row. */
{
  const requestCount = 20;
  const db = new ConcurrentSqliteD1(requestCount);
  const env = { DB: db, TEST_PROVIDER_CAP: '1000', PROXY_GLOBAL_DAILY: '3' };
  const isolates = await Promise.all(Array.from({ length: requestCount }, () => freshIsolate()));
  const verdicts = await Promise.all(isolates.map((isolate, index) =>
    isolate.chargeQuota(env, `SMESH-RACE-${index}`, 'test-c', provider)
  ));
  assert.equal(verdicts.filter((verdict) => verdict.ok).length, 3,
    'atomic global increments admit exactly the configured concurrent maximum');
  assert.equal(db.count('*', 'all'), 3);
  const chargedRows = db.rows('test-c');
  assert.equal(chargedRows.length, 3,
    'a request rejected at the global race must not consume its license allowance');
  assert.ok(chargedRows.every((row) => row.count === 1));
  verdicts.forEach((verdict, index) => {
    assert.equal(
      db.count(`SMESH-RACE-${index}`, 'test-c') != null,
      verdict.ok,
      'only admitted concurrent requests may have per-license quota rows'
    );
  });

  const writesAfterRace = db.writes;
  const later = await freshIsolate();
  assert.equal(
    (await later.chargeQuota(env, 'SMESH-AFTER-RACE', 'test-c', provider)).ok,
    false
  );
  assert.equal(db.writes, writesAfterRace,
    'once the concurrent breaker linearizes, later isolates perform no writes');
}

/* A failure between the two statements rolls the first counter back. */
{
  const db = new FaultingBatchD1();
  const env = { DB: db, TEST_PROVIDER_CAP: '1000', PROXY_GLOBAL_DAILY: '1000' };
  const isolate = await freshIsolate();
  await assert.rejects(
    isolate.chargeQuota(env, 'SMESH-ROLLBACK', 'test-d', provider),
    /injected second quota statement failure/
  );
  assert.equal(db.count('SMESH-ROLLBACK', 'test-d'), null,
    'a failed global reservation must roll back its per-license reservation');
  assert.equal(db.count('*', 'all'), null,
    'a failed batch must leave no partial global reservation');
}

console.log('AI quota saturation regressions passed');
