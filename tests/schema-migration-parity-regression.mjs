// Regression (audit B-14): schema.sql is a fresh-install snapshot, not a
// migration system — reapplying it to an older database silently keeps old
// table shapes. Deployed databases therefore evolve through numbered files in
// backend/migrations/ (wrangler d1 migrations), and THIS gate keeps the two
// sources honest: applying every migration in order must produce exactly the
// snapshot's schema, so a column added to one file but not the other fails CI
// instead of failing at runtime with a missing-column error.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

function execAtomically(db, sql) {
  db.exec('SAVEPOINT smesh_regression_atomic');
  try {
    db.exec(sql);
    db.exec('RELEASE SAVEPOINT smesh_regression_atomic');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT smesh_regression_atomic');
    db.exec('RELEASE SAVEPOINT smesh_regression_atomic');
    throw error;
  }
}

function canonicalSchemaSql(sql, tableName) {
  const source = String(sql || '');
  let compact = '';
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '-' && source[i + 1] === '-') {
      i += 2;
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      compact += quote;
      i += 1;
      while (i < source.length) {
        compact += source[i];
        if (source[i] === quote) {
          if (source[i + 1] === quote) {
            compact += source[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (char === '[') {
      const end = source.indexOf(']', i + 1);
      const limit = end === -1 ? source.length : end + 1;
      compact += source.slice(i, limit);
      i = limit;
      continue;
    }
    compact += char.toLowerCase();
    i += 1;
  }

  // ALTER TABLE ... RENAME makes SQLite quote the rebuilt table name. Treat
  // only that one known identifier spelling as equivalent; quoted CHECK or
  // DEFAULT literals remain byte-for-byte significant.
  const createPrefix = compact.startsWith('createtableifnotexists')
    ? 'createtableifnotexists'
    : 'createtable';
  const identifiers = [
    `"${String(tableName).replace(/"/g, '""')}"`,
    `\`${String(tableName).replace(/`/g, '``')}\``,
    `[${String(tableName)}]`
  ];
  for (const identifier of identifiers) {
    if (compact.slice(createPrefix.length, createPrefix.length + identifier.length)
      .toLowerCase() === identifier.toLowerCase()) {
      return createPrefix + String(tableName).toLowerCase() +
        compact.slice(createPrefix.length + identifier.length);
    }
  }
  return compact;
}

assert.notEqual(
  canonicalSchemaSql(
    "CREATE TABLE sample (value TEXT CHECK(value = 'Active -- /* kept */'))",
    'sample'
  ),
  canonicalSchemaSql(
    "CREATE TABLE sample (value TEXT CHECK(value = 'active -- /* kept */'))",
    'sample'
  ),
  'DDL parity canonicalization must preserve case and comment markers inside literals'
);

function schemaShape(db) {
  const out = {};
  const tables = db.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'
     ORDER BY name`
  ).all();
  for (const { name } of tables) {
    out[name] = db.prepare(
      `SELECT name, type, "notnull", dflt_value, pk, hidden
       FROM pragma_table_xinfo(?) ORDER BY cid`
    ).all(name).map((c) =>
      `${c.name} ${c.type}${c.pk ? ' PK' : ''}${c.notnull ? ' NOT NULL' : ''}` +
      (c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : '') +
      (c.hidden ? ` HIDDEN ${c.hidden}` : ''));
  }
  out['(indexes)'] = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`
  ).all().map((r) => r.sql.replace(/\s+/g, ' '));
  out['(table-ddl)'] = db.prepare(
    `SELECT name, sql FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'
     ORDER BY name`
  ).all().map((row) => `${row.name}:${canonicalSchemaSql(row.sql, row.name)}`);
  return out;
}

const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const wranglerConfig = await readFile(new URL('../backend/wrangler.toml', import.meta.url), 'utf8');
const migrationsDir = new URL('../backend/migrations/', import.meta.url);
const migrationFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const adoptionSql = await readFile(
  new URL('../backend/scripts/adopt-current-schema.sql', import.meta.url),
  'utf8'
);
const operationalMigrationSql = await readFile(
  new URL('0003_operational_leases.sql', migrationsDir),
  'utf8'
);
assert.doesNotMatch(
  `${operationalMigrationSql}\n${adoptionSql}`.replace(/^\s*--.*$/gm, ''),
  /CREATE\s+TEMP(?:ORARY)?\s+TABLE/i,
  'D1 rejects CREATE TEMP TABLE; migration guards must use transaction-scoped ordinary tables'
);
assert.ok(migrationFiles.length >= 1 && migrationFiles[0].startsWith('0001'),
  'the baseline migration must exist');
assert.match(wranglerConfig, /migrations_dir\s*=\s*"migrations"/,
  'Wrangler must discover the tracked migration directory');
assert.match(wranglerConfig, /d1 migrations apply smesh-analytics --remote/,
  'the production runbook must apply numbered D1 migrations');
assert.doesNotMatch(wranglerConfig, /d1 execute smesh-analytics --remote --file=schema\.sql/,
  'production instructions must not reapply the fresh-install schema snapshot');

const fromSnapshot = new DatabaseSync(':memory:');
fromSnapshot.exec(schemaSql);

const migrated = new DatabaseSync(':memory:');
for (const file of migrationFiles) {
  execAtomically(migrated, await readFile(new URL(file, migrationsDir), 'utf8'));
}

assert.deepEqual(schemaShape(migrated), schemaShape(fromSnapshot),
  'migrations applied in order must produce exactly the schema.sql snapshot');

// Bootstrap/adoption must not dead-end the immediately preceding current
// snapshot: it has the exact 0001..0004 application shape but no migration
// ledger and no runtime fence, so normal migration replay would hit 0003's
// intentional already-current guard. Atomic adoption adds only the 0005 fence,
// records the proven ledger, and preserves every application row.
const preFenceCurrent = new DatabaseSync(':memory:');
for (const file of migrationFiles.filter((name) => name !== '0005_runtime_write_fence.sql')) {
  execAtomically(preFenceCurrent, await readFile(new URL(file, migrationsDir), 'utf8'));
}
preFenceCurrent.prepare(
  `INSERT INTO payment_issuance
     (gateway, payment_id, license_key, license_json, created_at)
   VALUES (?, ?, ?, ?, ?)`
).run('robokassa', 'pre-fence-payment', 'SMESH-PRE-FENCE', '{"key":"SMESH-PRE-FENCE"}', 1);
assert.equal(
  preFenceCurrent.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'runtime_write_fence'"
  ).get().n,
  0
);
execAtomically(preFenceCurrent, adoptionSql);
assert.deepEqual(
  preFenceCurrent.prepare('SELECT name FROM d1_migrations ORDER BY name').all()
    .map((row) => row.name),
  migrationFiles,
  'pre-0005 current adoption must record the exact complete migration ledger'
);
assert.deepEqual(
  { ...preFenceCurrent.prepare(
    'SELECT write_epoch, writes_enabled FROM runtime_write_fence WHERE singleton = 1'
  ).get() },
  { write_epoch: 1, writes_enabled: 1 },
  'atomic adoption must bootstrap the durable fence for the first guarded deploy'
);
assert.equal(
  preFenceCurrent.prepare(
    'SELECT license_key FROM payment_issuance WHERE payment_id = ?'
  ).get('pre-fence-payment').license_key,
  'SMESH-PRE-FENCE',
  'fence bootstrap/adoption must not rewrite paid application state'
);
assert.deepEqual(schemaShape(preFenceCurrent), schemaShape(fromSnapshot),
  'the adopted pre-0005 current snapshot must exactly match the new snapshot');

// A database already created from TODAY'S schema snapshot must adopt the
// Wrangler ledger instead of replaying old-shape rebuild migrations. Seed every
// operational field 0003 historically erased, run the checked adoption file,
// then simulate Wrangler applying only names absent from d1_migrations.
const preExisting = new DatabaseSync(':memory:');
preExisting.exec(schemaSql);
preExisting.prepare(
  `INSERT INTO delivery_outbox
     (license_key, email, created_at, attempts, next_attempt_at,
      claim_token, lease_until)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
).run('SMESH-LIVE-OUTBOX', 'buyer@example.com', 10, 7, 20, 'live-claim', 999);
preExisting.prepare(
  `INSERT INTO referral_credit_state
     (license_key, ref_code, days, status, created_at, target_kind, target_key,
      target_expiry, target_generation, retry_attempts, retry_after,
      last_error_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(
  'SMESH-LIVE-CREDIT', 'REF-LIVE-LIVE', 7, 'pending', 11, 'reward',
  'SMESH-LIVE-REWARD', '2030-01-01T00:00:00.000Z', 4, 5, 777, 666
);
preExisting.prepare(
  `INSERT INTO support_forward_outbox
     (ticket_no, source_chat_id, source_message_id, has_attachment, created_at,
      attempts, next_attempt_at, claim_token, lease_until)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run('1001', '123', 456, 1, 12, 3, 888, 'support-claim', 999);

execAtomically(preExisting, adoptionSql);
const applied = new Set(preExisting.prepare(
  'SELECT name FROM d1_migrations'
).all().map((row) => row.name));
assert.deepEqual([...applied].sort(), migrationFiles,
  'adoption must atomically record every migration represented by the snapshot');
for (const file of migrationFiles) {
  if (!applied.has(file)) {
    preExisting.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
  }
}
execAtomically(preExisting, adoptionSql);
assert.deepEqual(
  preExisting.prepare('SELECT name FROM d1_migrations ORDER BY name').all()
    .map((row) => row.name),
  migrationFiles,
  'adoption must be idempotent after the complete ledger is present'
);
assert.deepEqual(schemaShape(preExisting), schemaShape(fromSnapshot),
  'adopting an already-current database must preserve the snapshot shape');
assert.deepEqual(
  { ...preExisting.prepare(
    `SELECT attempts, next_attempt_at, claim_token, lease_until
     FROM delivery_outbox WHERE license_key = ?`
  ).get('SMESH-LIVE-OUTBOX') },
  { attempts: 7, next_attempt_at: 20, claim_token: 'live-claim', lease_until: 999 },
  'adoption must not clear a live delivery claim'
);
assert.deepEqual(
  { ...preExisting.prepare(
    `SELECT target_generation, retry_attempts, retry_after, last_error_at
     FROM referral_credit_state WHERE license_key = ?`
  ).get('SMESH-LIVE-CREDIT') },
  { target_generation: 4, retry_attempts: 5, retry_after: 777, last_error_at: 666 },
  'adoption must not reset referral generation or recovery backoff'
);
assert.deepEqual(
  { ...preExisting.prepare(
    `SELECT attempts, next_attempt_at, claim_token, lease_until
     FROM support_forward_outbox WHERE ticket_no = ?`
  ).get('1001') },
  { attempts: 3, next_attempt_at: 888, claim_token: 'support-claim', lease_until: 999 },
  'adoption must not disturb a support-forward claim'
);

// The normal migration command must fail BEFORE destructive DDL if an operator
// forgets adoption and points 0003 at an already-current database. 0001/0002
// are allowed to have landed first: the adoption file accepts that prefix.
const guardedCurrent = new DatabaseSync(':memory:');
guardedCurrent.exec(schemaSql);
guardedCurrent.prepare(
  `INSERT INTO delivery_outbox
     (license_key, created_at, attempts, next_attempt_at, claim_token, lease_until)
   VALUES (?, ?, ?, ?, ?, ?)`
).run('SMESH-GUARDED-OUTBOX', 1, 9, 2, 'must-survive', 1234);
guardedCurrent.prepare(
  `INSERT INTO referral_credit_state
     (license_key, ref_code, days, status, created_at, target_generation,
      retry_attempts, retry_after, last_error_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run('SMESH-GUARDED-CREDIT', 'REF-SAFE-SAFE', 7, 'pending', 1, 6, 7, 8, 9);
guardedCurrent.exec(await readFile(new URL('0001_baseline.sql', migrationsDir), 'utf8'));
guardedCurrent.exec(await readFile(new URL('0002_referral_code_unique.sql', migrationsDir), 'utf8'));
assert.throws(
  () => execAtomically(guardedCurrent, operationalMigrationSql),
  /smesh_0003_requires_prelease_shape/,
  '0003 must reject an already-current source before rebuilding either table'
);
assert.deepEqual(
  { ...guardedCurrent.prepare(
    `SELECT attempts, claim_token, lease_until
     FROM delivery_outbox WHERE license_key = ?`
  ).get('SMESH-GUARDED-OUTBOX') },
  { attempts: 9, claim_token: 'must-survive', lease_until: 1234 },
  'the 0003 source-shape guard must preserve a live claim on failure'
);
assert.deepEqual(
  { ...guardedCurrent.prepare(
    `SELECT target_generation, retry_attempts, retry_after, last_error_at
     FROM referral_credit_state WHERE license_key = ?`
  ).get('SMESH-GUARDED-CREDIT') },
  { target_generation: 6, retry_attempts: 7, retry_after: 8, last_error_at: 9 },
  'the 0003 source-shape guard must preserve referral recovery state on failure'
);

// Names alone are not an adequate source-shape check: a hand-edited column
// can retain its name while changing affinity or constraints. That database is
// not the migration's proven input, so reject it without coercing live rows.
const incompatibleLegacy = new DatabaseSync(':memory:');
incompatibleLegacy.exec(`
  CREATE TABLE delivery_outbox (
    license_key TEXT PRIMARY KEY, email TEXT, telegram_user_id INTEGER,
    is_preorder INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    attempts TEXT NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  INSERT INTO delivery_outbox
    (license_key, created_at, attempts, next_attempt_at)
  VALUES ('SMESH-INCOMPATIBLE', 1, '9', 2);
  CREATE TABLE referral_credit_state (
    license_key TEXT PRIMARY KEY, ref_code TEXT NOT NULL, days INTEGER NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, applied_at INTEGER,
    materialized_at INTEGER, target_kind TEXT, target_key TEXT, target_expiry TEXT
  );
`);
assert.throws(
  () => execAtomically(incompatibleLegacy, operationalMigrationSql),
  /smesh_0003_requires_prelease_shape/,
  'matching column names with incompatible types must fail before the rebuild'
);
assert.deepEqual(
  { ...incompatibleLegacy.prepare(
    `SELECT attempts FROM delivery_outbox WHERE license_key = ?`
  ).get('SMESH-INCOMPATIBLE') },
  { attempts: '9' },
  'an incompatible source rejection must leave its rows untouched'
);

const generatedLegacy = new DatabaseSync(':memory:');
generatedLegacy.exec(`
  CREATE TABLE delivery_outbox (
    license_key TEXT PRIMARY KEY, email TEXT, telegram_user_id INTEGER,
    is_preorder INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    delivered_at INTEGER,
    poison TEXT GENERATED ALWAYS AS ('x') VIRTUAL
  );
  CREATE INDEX idx_delivery_outbox_due
    ON delivery_outbox(delivered_at, next_attempt_at);
  CREATE TABLE referral_credit_state (
    license_key TEXT PRIMARY KEY, ref_code TEXT NOT NULL, days INTEGER NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, applied_at INTEGER,
    materialized_at INTEGER, target_kind TEXT, target_key TEXT, target_expiry TEXT
  );
`);
assert.throws(
  () => execAtomically(generatedLegacy, operationalMigrationSql),
  /smesh_0003_requires_prelease_shape/,
  '0003 must reject generated columns that table_info would have hidden'
);
assert.equal(
  generatedLegacy.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_xinfo('delivery_outbox') WHERE name = 'poison'"
  ).get().n,
  1,
  'the guarded rebuild must not erase a hidden legacy column on rejection'
);

// Partial current shapes and unknown/future ledgers must fail adoption without
// blessing any known migration. Execute these probes transactionally, matching
// Wrangler's migration and remote-file ingestion contracts, then assert the
// complete schema is unchanged rather than checking only ledger rows.
const partialCurrent = new DatabaseSync(':memory:');
partialCurrent.exec(schemaSql);
partialCurrent.exec('DROP INDEX idx_referral_credit_retry');
const partialShapeBeforeAdoption = schemaShape(partialCurrent);
assert.throws(
  () => execAtomically(partialCurrent, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'a missing query-critical index must make adoption fail closed'
);
assert.deepEqual(
  schemaShape(partialCurrent),
  partialShapeBeforeAdoption,
  'failed adoption must roll back its ledger and every helper object'
);

const extraIndexCurrent = new DatabaseSync(':memory:');
extraIndexCurrent.exec(schemaSql);
extraIndexCurrent.exec('CREATE UNIQUE INDEX unexpected_purchase_status ON purchases(status)');
const extraIndexShapeBeforeAdoption = schemaShape(extraIndexCurrent);
assert.throws(
  () => execAtomically(extraIndexCurrent, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'an extra index can change valid application writes and must fail exact adoption'
);
assert.deepEqual(schemaShape(extraIndexCurrent), extraIndexShapeBeforeAdoption,
  'rejected extra-index adoption must leave schema and ledger untouched');

const partialReferralUnique = new DatabaseSync(':memory:');
partialReferralUnique.exec(schemaSql);
partialReferralUnique.exec(`
  DROP INDEX idx_referral_auth_claims_code;
  CREATE UNIQUE INDEX idx_referral_auth_claims_code
    ON referral_auth_claims(code) WHERE code <> '';
`);
const partialReferralShapeBeforeAdoption = schemaShape(partialReferralUnique);
assert.throws(
  () => execAtomically(partialReferralUnique, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'a partial lookalike must not satisfy the global referral-code uniqueness gate'
);
assert.deepEqual(schemaShape(partialReferralUnique), partialReferralShapeBeforeAdoption,
  'rejected partial-index adoption must roll back every helper and ledger write');

const expressionIndexCurrent = new DatabaseSync(':memory:');
expressionIndexCurrent.exec(schemaSql);
expressionIndexCurrent.exec(`
  DROP INDEX idx_purchases_issued;
  CREATE INDEX idx_purchases_issued ON purchases((issued_at + 0));
`);
assert.throws(
  () => execAtomically(expressionIndexCurrent, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'an expression index cannot impersonate the expected named-column index'
);

const generatedColumnCurrent = new DatabaseSync(':memory:');
generatedColumnCurrent.exec(schemaSql);
generatedColumnCurrent.exec(
  "ALTER TABLE counters ADD COLUMN poison TEXT GENERATED ALWAYS AS ('x') VIRTUAL"
);
assert.throws(
  () => execAtomically(generatedColumnCurrent, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'generated/hidden columns omitted by table_info must fail exact adoption'
);
assert.equal(
  generatedColumnCurrent.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_xinfo('counters') WHERE name = 'poison' AND hidden <> 0"
  ).get().n,
  1,
  'a failed adoption must roll back without rewriting the rejected table'
);

const commentForgedChecks = new DatabaseSync(':memory:');
commentForgedChecks.exec(schemaSql);
commentForgedChecks.exec(`
  DROP TABLE runtime_write_fence;
  CREATE TABLE runtime_write_fence (
    singleton INTEGER PRIMARY KEY /* CHECK (singleton = 1) */,
    write_epoch INTEGER NOT NULL /* CHECK (write_epoch >= 1) */,
    writes_enabled INTEGER NOT NULL DEFAULT 1
      /* CHECK (writes_enabled IN (0, 1)) */,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO runtime_write_fence VALUES (1, 1, 1, 1);
`);
assert.throws(
  () => execAtomically(commentForgedChecks, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'comments containing CHECK text must not substitute for actual constraints'
);

const extraTableConstraint = new DatabaseSync(':memory:');
extraTableConstraint.exec(schemaSql);
extraTableConstraint.exec(`
  DROP TABLE counters;
  CREATE TABLE counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL,
    UNIQUE(value)
  );
`);
assert.throws(
  () => execAtomically(extraTableConstraint, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'an extra table-level UNIQUE constraint must fail exact adoption'
);

const prefixedApplicationObjects = new DatabaseSync(':memory:');
prefixedApplicationObjects.exec(schemaSql);
prefixedApplicationObjects.exec(`
  CREATE UNIQUE INDEX _cf_purchase_status ON purchases(status);
  CREATE TRIGGER _cf_purchase_rewrite AFTER INSERT ON purchases
  BEGIN
    UPDATE purchases SET note = 'triggered' WHERE license_key = NEW.license_key;
  END;
`);
assert.throws(
  () => execAtomically(prefixedApplicationObjects, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'arbitrary _cf_* indexes and triggers must not inherit platform trust'
);

const documentedPlatformTable = new DatabaseSync(':memory:');
documentedPlatformTable.exec(schemaSql);
documentedPlatformTable.exec(
  'CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID'
);
execAtomically(documentedPlatformTable, adoptionSql);
assert.deepEqual(
  documentedPlatformTable.prepare('SELECT name FROM d1_migrations ORDER BY name').all()
    .map((row) => row.name),
  migrationFiles,
  'the exact documented D1 _cf_KV table remains compatible with adoption'
);

const pinnedLocalPlatformTable = new DatabaseSync(':memory:');
pinnedLocalPlatformTable.exec(schemaSql);
pinnedLocalPlatformTable.exec(
  'CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)'
);
execAtomically(pinnedLocalPlatformTable, adoptionSql);
assert.deepEqual(
  pinnedLocalPlatformTable.prepare('SELECT name FROM d1_migrations ORDER BY name').all()
    .map((row) => row.name),
  migrationFiles,
  'the exact pinned-Wrangler D1 _cf_METADATA table remains compatible with adoption'
);

const malformedPlatformTable = new DatabaseSync(':memory:');
malformedPlatformTable.exec(schemaSql);
malformedPlatformTable.exec('CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value TEXT)');
assert.throws(
  () => execAtomically(malformedPlatformTable, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'a malformed user-created _cf_KV lookalike must fail adoption'
);

const malformedLocalPlatformTable = new DatabaseSync(':memory:');
malformedLocalPlatformTable.exec(schemaSql);
malformedLocalPlatformTable.exec(
  'CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value TEXT)'
);
assert.throws(
  () => execAtomically(malformedLocalPlatformTable, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'a malformed user-created _cf_METADATA lookalike must fail adoption'
);

const handModifiedCurrent = new DatabaseSync(':memory:');
handModifiedCurrent.exec(schemaSql);
handModifiedCurrent.exec('CREATE TABLE untracked_application_state (id TEXT PRIMARY KEY)');
const handModifiedShapeBeforeAdoption = schemaShape(handModifiedCurrent);
assert.throws(
  () => execAtomically(handModifiedCurrent, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'an untracked application table must not be mistaken for the known snapshot'
);
assert.deepEqual(
  schemaShape(handModifiedCurrent),
  handModifiedShapeBeforeAdoption,
  'failed adoption of a hand-modified schema must leave it exactly unchanged'
);

const missingIssuanceUnique = new DatabaseSync(':memory:');
missingIssuanceUnique.exec(schemaSql);
missingIssuanceUnique.exec(`
  ALTER TABLE payment_issuance RENAME TO payment_issuance_original;
  CREATE TABLE payment_issuance (
    gateway TEXT NOT NULL, payment_id TEXT NOT NULL, license_key TEXT NOT NULL,
    license_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (gateway, payment_id)
  );
  DROP TABLE payment_issuance_original;
`);
assert.throws(
  () => execAtomically(missingIssuanceUnique, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'matching columns without the payment license-key UNIQUE constraint must fail adoption'
);

const prefixLedger = new DatabaseSync(':memory:');
prefixLedger.exec(schemaSql);
prefixLedger.exec(`
  CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT INTO d1_migrations(name) VALUES
    ('0001_baseline.sql'),
    ('0002_referral_code_unique.sql');
`);
execAtomically(prefixLedger, adoptionSql);
assert.deepEqual(
  prefixLedger.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
    .map((row) => row.name),
  migrationFiles,
  'adoption must complete a compatible Wrangler ledger prefix'
);

const nonPrefixLedger = new DatabaseSync(':memory:');
nonPrefixLedger.exec(schemaSql);
nonPrefixLedger.exec(`
  CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT INTO d1_migrations(name) VALUES
    ('0001_baseline.sql'),
    ('0003_operational_leases.sql');
`);
assert.throws(
  () => execAtomically(nonPrefixLedger, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'a known-name ledger with a gap is not a compatible Wrangler prefix'
);
assert.deepEqual(
  nonPrefixLedger.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
    .map((row) => row.name),
  ['0001_baseline.sql', '0003_operational_leases.sql'],
  'rejected non-prefix history must remain untouched'
);

const missingFenceAuthority = new DatabaseSync(':memory:');
missingFenceAuthority.exec(schemaSql);
missingFenceAuthority.exec('DELETE FROM runtime_write_fence');
assert.throws(
  () => execAtomically(missingFenceAuthority, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'an existing fence table missing its authority row must not be silently repaired'
);
assert.equal(
  missingFenceAuthority.prepare(
    'SELECT COUNT(*) AS n FROM runtime_write_fence'
  ).get().n,
  0,
  'failed adoption must roll back its attempted fence seed'
);

const ledgerClaimsMissingFence = new DatabaseSync(':memory:');
ledgerClaimsMissingFence.exec(schemaSql);
ledgerClaimsMissingFence.exec('DROP TABLE runtime_write_fence');
ledgerClaimsMissingFence.exec(`
  CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT INTO d1_migrations(name) VALUES
    ('0001_baseline.sql'),
    ('0002_referral_code_unique.sql'),
    ('0003_operational_leases.sql'),
    ('0004_support_outbox.sql'),
    ('0005_runtime_write_fence.sql');
`);
assert.throws(
  () => execAtomically(ledgerClaimsMissingFence, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'adoption must not recreate a fence that the existing ledger already claims'
);
assert.equal(
  ledgerClaimsMissingFence.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'runtime_write_fence'"
  ).get().n,
  0,
  'claimed-but-missing fence rejection must roll the bootstrap table back'
);

const futureLedger = new DatabaseSync(':memory:');
futureLedger.exec(schemaSql);
futureLedger.exec(`
  CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT INTO d1_migrations(name) VALUES ('9999_unknown_future.sql');
`);
assert.throws(
  () => execAtomically(futureLedger, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'adoption must never overwrite or bless an unknown future migration history'
);
assert.deepEqual(
  futureLedger.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
    .map((row) => row.name),
  ['9999_unknown_future.sql']
);

const nullLedger = new DatabaseSync(':memory:');
nullLedger.exec(schemaSql);
nullLedger.exec(`
  CREATE TABLE d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  INSERT INTO d1_migrations(name) VALUES (NULL);
`);
assert.throws(
  () => execAtomically(nullLedger, adoptionSql),
  /smesh_adoption_requires_exact_current_schema/,
  'NULL migration names must not bypass SQL NOT IN ledger validation'
);
assert.deepEqual(
  nullLedger.prepare('SELECT name FROM d1_migrations ORDER BY id').all()
    .map((row) => row.name),
  [null],
  'failed NULL-ledger adoption must leave the unknown history untouched'
);

for (const db of [fromSnapshot, migrated]) {
  db.prepare(
    'INSERT INTO referral_auth_claims (auth_hash, code, created_at) VALUES (?, ?, ?)'
  ).run('auth-one', 'REF-AAAA-BBBB', 1);
  assert.throws(
    () => db.prepare(
      'INSERT INTO referral_auth_claims (auth_hash, code, created_at) VALUES (?, ?, ?)'
    ).run('auth-two', 'REF-AAAA-BBBB', 2),
    /UNIQUE constraint failed/,
    'one public referral code must never map to two different capabilities'
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO runtime_write_fence
         (singleton, write_epoch, writes_enabled, updated_at)
       VALUES (?, ?, ?, ?)`
    ).run(2, 1, 1, 1),
    /CHECK constraint failed/,
    'snapshot and migrations must both enforce the singleton write-fence row'
  );
  assert.throws(
    () => db.prepare(
      'UPDATE runtime_write_fence SET write_epoch = 0 WHERE singleton = 1'
    ).run(),
    /CHECK constraint failed/,
    'snapshot and migrations must both reject an invalid write epoch'
  );
  assert.throws(
    () => db.prepare(
      'UPDATE runtime_write_fence SET writes_enabled = 2 WHERE singleton = 1'
    ).run(),
    /CHECK constraint failed/,
    'snapshot and migrations must both constrain the enabled state'
  );
}

// The baseline is also the one-time privacy migration for the pre-existing
// production shape. All three retired identifier columns must be purged; a
// pseudonym is still an identifier and cannot survive merely because raw keys
// were cleared.
const privacyUpgrade = new DatabaseSync(':memory:');
privacyUpgrade.exec(`
  CREATE TABLE devices (
    device_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    browser TEXT, ua TEXT, version TEXT, provider TEXT, license_key TEXT,
    license_ref TEXT, license_type TEXT
  );
  INSERT INTO devices
    (device_id, first_seen, last_seen, ua, license_key, license_ref)
  VALUES ('legacy-device', 1, 1, 'raw user agent', 'SMESH-SECRET', 'hmac-pseudonym');
`);
for (const file of migrationFiles) {
  execAtomically(privacyUpgrade, await readFile(new URL(file, migrationsDir), 'utf8'));
}
assert.deepEqual(
  { ...privacyUpgrade.prepare(
    'SELECT ua, license_key, license_ref FROM devices WHERE device_id = ?'
  ).get('legacy-device') },
  { ua: null, license_key: null, license_ref: null },
  'the migration must purge historical raw and pseudonymous license identifiers'
);

// A still-older production shape has no license_ref column at all. The same
// baseline must add it without losing legitimate analytics dimensions and
// without ever naming the absent column in a SELECT/UPDATE against that table.
const prePseudonymUpgrade = new DatabaseSync(':memory:');
prePseudonymUpgrade.exec(`
  CREATE TABLE devices (
    device_id TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    browser TEXT, ua TEXT, version TEXT, provider TEXT, license_key TEXT,
    license_type TEXT
  );
  INSERT INTO devices
    (device_id, first_seen, last_seen, browser, ua, version, provider, license_key, license_type)
  VALUES ('older-device', 10, 20, 'chrome', 'raw ua', '1.2.3', 'qwen',
          'SMESH-OLDER-SECRET', 'subscription');
`);
for (const file of migrationFiles) {
  execAtomically(prePseudonymUpgrade, await readFile(new URL(file, migrationsDir), 'utf8'));
}
const olderRow = { ...prePseudonymUpgrade.prepare(
  `SELECT device_id, first_seen, last_seen, browser, ua, version, provider,
          license_key, license_ref, license_type
   FROM devices WHERE device_id = ?`
).get('older-device') };
assert.deepEqual(olderRow, {
  device_id: 'older-device', first_seen: 10, last_seen: 20, browser: 'chrome',
  ua: null, version: '1.2.3', provider: 'qwen', license_key: null,
  license_ref: null, license_type: 'subscription'
}, 'the pre-license_ref migration must preserve non-sensitive device analytics');

// Reproduce the ACTUAL pre-0003 operational shapes rather than seeding from
// today's snapshot. CREATE TABLE IF NOT EXISTS cannot add columns to these
// tables; the numbered rebuild migration must both add them and preserve every
// pending row.
const operationalUpgrade = new DatabaseSync(':memory:');
operationalUpgrade.exec(`
  CREATE TABLE delivery_outbox (
    license_key TEXT PRIMARY KEY, email TEXT, telegram_user_id INTEGER,
    is_preorder INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX idx_delivery_outbox_due
    ON delivery_outbox(delivered_at, next_attempt_at);
  INSERT INTO delivery_outbox
    (license_key, email, telegram_user_id, is_preorder, created_at, attempts,
     next_attempt_at, delivered_at)
  VALUES ('SMESH-OLD-OUTBOX', 'buyer@example.com', 123, 1, 10, 2, 20, NULL);

  CREATE TABLE referral_credit_state (
    license_key TEXT PRIMARY KEY, ref_code TEXT NOT NULL, days INTEGER NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, applied_at INTEGER,
    materialized_at INTEGER, target_kind TEXT, target_key TEXT, target_expiry TEXT
  );
  INSERT INTO referral_credit_state
    (license_key, ref_code, days, status, created_at, target_kind, target_key,
     target_expiry)
  VALUES ('SMESH-OLD-CREDIT', 'REF-OLD1-OLD1', 7, 'pending', 11, 'reward',
          'SMESH-OLD-REWARD', '2030-01-01T00:00:00.000Z');
`);
execAtomically(operationalUpgrade, operationalMigrationSql);
assert.deepEqual(
  { ...operationalUpgrade.prepare(
    `SELECT license_key, email, attempts, next_attempt_at, claim_token,
            lease_until, delivered_at
     FROM delivery_outbox`
  ).get() },
  {
    license_key: 'SMESH-OLD-OUTBOX',
    email: 'buyer@example.com',
    attempts: 2,
    next_attempt_at: 20,
    claim_token: null,
    lease_until: null,
    delivered_at: null
  },
  '0003 must preserve an existing undelivered job while adding its lease'
);
assert.deepEqual(
  { ...operationalUpgrade.prepare(
    `SELECT license_key, target_key, target_generation, retry_attempts,
            retry_after, last_error_at
     FROM referral_credit_state`
  ).get() },
  {
    license_key: 'SMESH-OLD-CREDIT',
    target_key: 'SMESH-OLD-REWARD',
    target_generation: 0,
    retry_attempts: 0,
    retry_after: 0,
    last_error_at: null
  },
  '0003 must preserve a pending entitlement while adding generation/backoff state'
);

// Spot-check columns the worker's queries assume, after migrations ALONE —
// the exact failure mode B-14 describes.
for (const [table, column] of [
  ['referral_credit_state', 'target_expiry'],
  ['referral_credit_state', 'materialized_at'],
  ['referral_credit_state', 'target_generation'],
  ['referral_credit_state', 'retry_after'],
  ['delivery_outbox', 'next_attempt_at'],
  ['delivery_outbox', 'claim_token'],
  ['support_forward_outbox', 'claim_token'],
  ['support_forward_outbox', 'forwarded_at'],
  ['payment_review', 'fields_json'],
  ['license_revocations', 'revoked_at'],
  ['device_tombstones', 'deleted_at'],
  ['counters', 'value'],
  ['license_devices', 'device_id'],
  ['telemetry_budget', 'budget_key']
]) {
  const cols = migrated.prepare('SELECT name FROM pragma_table_info(?)').all(table)
    .map((c) => c.name);
  assert.ok(cols.includes(column), `${table}.${column} must exist after migrations`);
}

console.log('schema/migration parity regression passed');
