// Regressions for the low-severity audit batch B-15..B-20:
//  B-16: /verify without a device id must be a 400, not an ok:true that
//        skipped the device-cap claim.
//  B-18: a JSON `null` body on /ai/chat is malformed input (400), not a
//        TypeError logged as an outage.
//  B-20: /admin/health is the admin-gated readiness view — 503 with named
//        failing checks whenever a paid-path dependency is broken, while the
//        public /health stays pure liveness.
//  B-17: the purchases list reports `truncated` instead of silently cutting
//        the money dashboard at 500 rows.
//  B-15/B-19: the backup docs cover authoritative D1 state, and the ignore
//        rules cover every env-file variant.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import './helpers/worker-runtime-shim.mjs';
import worker from '../backend/src/worker.js';
import { statsPurchases } from '../backend/src/analytics.js';

const ctx = { waitUntil() {} };

class FakeKV {
  store = new Map();
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, value); }
}

// Minimal D1: reports a configurable table list, counts for the health
// worklists, and serves the purchases queries.
class FakeD1 {
  tables;
  columns = new Map();
  indexes = new Map();
  tableSql = new Map();
  extraSchemaObjects = [];
  purchaseRows = [];
  exhausted = 3;
  reviewOpen = 2;
  reconciliationErrors = 6;
  refundUnknown = 0;
  refundPollStalled = 0;
  referralUnsettled = 4;
  referralLegacyUnjournaled = 1;
  supportForwardExhausted = 5;
  failWorklists = false;
  budgets = new Map();
  writeEpoch = 1;
  writesEnabled = 1;
  constructor(tables) {
    this.tables = tables;
    for (const [table, columns] of Object.entries(HEALTH_COLUMNS)) {
      this.columns.set(table, columns.map((column) => ({ ...column })));
    }
    for (const [name, index] of HEALTH_INDEXES) this.indexes.set(name, structuredClone(index));
    for (const [name, sql] of HEALTH_TABLE_SQL) this.tableSql.set(name, sql);
  }
  prepare(sql) {
    const db = this;
    // D1 statements may be executed with or without .bind(); mirror that.
    const statement = (args) => ({
      async all() {
        if (sql.includes('FROM sqlite_master')) {
          return {
            results: [
              ...db.tables.map((name) => ({
                type: 'table', name, tbl_name: name, sql: db.tableSql.get(name) || null
              })),
              ...[...db.indexes.entries()].map(([name, index]) => ({
                type: 'index', name, tbl_name: index.table, sql: index.sql
              })),
              ...db.extraSchemaObjects.map((object) => ({ ...object }))
            ]
          };
        }
        if (sql.startsWith('PRAGMA table_xinfo')) {
          const table = sql.match(/PRAGMA table_xinfo\("([^"]+)"\)/)?.[1];
          return {
            results: (db.columns.get(table) || []).map((column) => ({ ...column }))
          };
        }
        if (sql.startsWith('PRAGMA index_list')) {
          const table = sql.match(/PRAGMA index_list\("([^"]+)"\)/)?.[1];
          return {
            results: [...db.indexes.entries()]
              .filter(([, index]) => index.table === table)
              .map(([name, index]) => ({
                name, unique: index.unique, origin: index.origin, partial: index.partial
              }))
          };
        }
        if (sql.startsWith('PRAGMA index_info')) {
          const name = sql.match(/PRAGMA index_info\("([^"]+)"\)/)?.[1];
          return {
            results: (db.indexes.get(name)?.columns || []).map((column, seqno) => ({
              seqno, name: column
            }))
          };
        }
        if (sql.includes('SELECT * FROM purchases')) {
          if (sql.includes('license_key < ?')) {
            const [fromTs, cursorTs, , cursorKey, limit] = args;
            return {
              results: db.purchaseRows
                .filter((row) => row.issued_at >= fromTs &&
                  (row.issued_at < cursorTs ||
                    (row.issued_at === cursorTs && row.license_key < cursorKey)))
                .slice(0, limit)
            };
          }
          return { results: db.purchaseRows.slice(args[2], args[2] + args[1]) };
        }
        return { results: [] };
      },
      async first() {
        if (sql.includes('FROM runtime_write_fence')) {
          return { write_epoch: db.writeEpoch, writes_enabled: db.writesEnabled };
        }
        if (db.failWorklists && (
          sql.includes('FROM delivery_outbox') ||
          sql.includes('FROM payment_review') ||
          sql.includes('FROM payment_orders') ||
          sql.includes('FROM payment_refund_poll') ||
          sql.includes('FROM referral_credit_state') ||
          sql.includes('FROM referral_credits') ||
          sql.includes('FROM support_forward_outbox')
        )) {
          throw new Error('worklist probe unavailable');
        }
        if (sql.includes('INSERT INTO telemetry_budget')) {
          const [day, scope, key, amount, cap, limit] = args;
          const id = `${day}|${scope}|${key}`;
          const current = db.budgets.get(id) || 0;
          if (current > limit) return null;
          const count = Math.min(current + amount, cap);
          db.budgets.set(id, count);
          return count;
        }
        if (sql.includes('UPDATE telemetry_budget')) {
          const [day, scope, key, amount] = args;
          const id = `${day}|${scope}|${key}`;
          if (!db.budgets.has(id)) return null;
          const count = Math.max(0, db.budgets.get(id) - amount);
          db.budgets.set(id, count);
          return count;
        }
        if (sql.includes('SELECT count FROM telemetry_budget')) {
          return { count: db.budgets.get(`${args[0]}|${args[1]}|${args[2]}`) || 0 };
        }
        if (sql.includes('FROM delivery_outbox')) return { n: db.exhausted };
        if (sql.includes('FROM payment_review')) return { n: db.reviewOpen };
        if (sql.includes("event_type = 'reconciliation_provider_error'")) {
          return { n: db.reconciliationErrors };
        }
        if (sql.includes('FROM payment_refund_poll')) return { n: db.refundPollStalled };
        if (sql.includes('FROM payment_orders')) return { n: db.refundUnknown };
        if (sql.includes('FROM referral_credits c')) return { n: db.referralLegacyUnjournaled };
        if (sql.includes('FROM referral_credit_state')) return { n: db.referralUnsettled };
        if (sql.includes('FROM support_forward_outbox')) return { n: db.supportForwardExhausted };
        return null;
      },
      async run() { return { meta: { changes: 1 } }; }
    });
    return { ...statement([]), bind: (...args) => statement(args) };
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

class SqliteD1Adapter {
  constructor(db) { this.db = db; }
  prepare(sql) {
    const db = this.db;
    const statement = (args = []) => ({
      bind: (...bound) => statement(bound),
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first(column) {
        const row = db.prepare(sql).get(...args) || null;
        return column ? row?.[column] ?? null : row;
      },
      async run() {
        const result = db.prepare(sql).run(...args);
        return { meta: { changes: Number(result.changes) || 0 } };
      }
    });
    return statement();
  }
  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }
}

const schemaSql = await readFile(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const schemaDb = new DatabaseSync(':memory:');
schemaDb.exec(schemaSql);
const HEALTH_TABLE_SQL = new Map(schemaDb.prepare(
  `SELECT name, sql FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
).all().map((row) => [row.name, row.sql]));
const HEALTH_TABLES = [...HEALTH_TABLE_SQL.keys()];
const HEALTH_COLUMNS = Object.fromEntries(HEALTH_TABLES.map((table) => [
  table,
  schemaDb.prepare(
    `SELECT name, type, "notnull", dflt_value, pk, hidden
     FROM pragma_table_xinfo(?) ORDER BY cid`
  ).all(table)
]));
const HEALTH_INDEX_SQL = new Map(schemaDb.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type = 'index'"
).all().map((row) => [row.name, row.sql]));
const HEALTH_INDEXES = new Map();
for (const table of HEALTH_TABLES) {
  for (const index of schemaDb.prepare('SELECT * FROM pragma_index_list(?)').all(table)) {
    HEALTH_INDEXES.set(index.name, {
      table,
      unique: Number(index.unique),
      origin: index.origin,
      partial: Number(index.partial),
      sql: HEALTH_INDEX_SQL.get(index.name) ?? null,
      columns: schemaDb.prepare(
        'SELECT name FROM pragma_index_info(?) ORDER BY seqno'
      ).all(index.name).map((column) => column.name)
    });
  }
}

/* ---- B-16: /verify without a device id ---- */
{
  const env = {
    LICENSES: new FakeKV(),
    DB: new FakeD1(HEALTH_TABLES),
    OWNER_LICENSE_KEY: 'SMESH-OWNER-TEST-KEY'
  };
  const post = (body) => worker.fetch(new Request('https://api.example/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env, ctx);

  const missing = await post({ key: 'SMESH-OWNER-TEST-KEY' });
  assert.equal(missing.status, 400,
    'a verify that would skip the device-cap claim must be rejected');
  assert.equal((await missing.json()).reason, 'missing_device');

  const empty = await post({ key: 'SMESH-OWNER-TEST-KEY', device_id: '' });
  assert.equal(empty.status, 400);

  const legacyShape = await post({
    key: 'SMESH-OWNER-TEST-KEY',
    device_id: 'device-owner-01'
  });
  assert.equal(legacyShape.status, 400);
  assert.equal((await legacyShape.json()).reason, 'bad_device',
    'the public license boundary must reject content-bearing legacy identifiers');

  const ok = await post({
    key: 'SMESH-OWNER-TEST-KEY',
    device_id: '11111111-1111-4111-8111-111111111111'
  });
  assert.equal(ok.status, 200, 'clients that send their device id are unaffected');
  assert.equal((await ok.json()).ok, true);
}

/* ---- B-18: the duplicate Worker AI quota path is retired by default ---- */
{
  const env = { AI_PROXY_API_KEY: 'upstream-key', DB: new FakeD1(HEALTH_TABLES), LICENSES: new FakeKV() };
  for (const raw of ['null', '[1,2]', '"строка"']) {
    const res = await worker.fetch(new Request('https://api.example/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw
    }), env, ctx);
    assert.equal(res.status, 410, `legacy Worker AI must stay unavailable for body ${raw}`);
    assert.equal((await res.json()).reason, 'legacy_ai_proxy_disabled');
  }
}

/* ---- B-20: /admin/health readiness ---- */
{
  const healthy = {
    LICENSES: new FakeKV(),
    DB: new FakeD1(HEALTH_TABLES),
    ADMIN_SECRET: 'admin-secret-token'.repeat(3),
    STATS_SECRET: 'stats-secret-token'.repeat(3),
    DEVICE_LIMIT: '1',
    MIN_PAYMENT_RUB: '199',
    SUBSCRIPTION_PRICE_RUB: '199',
    LIFETIME_PRICE_RUB: '199',
    MONTHLY_PRICE_RUB: '149',
    MONTHLY_DAYS: '30',
    SCHOOL_YEAR_PRICE_RUB: '999',
    SCHOOL_YEAR_DAYS: '273',
    CHECKOUT_PROMO_CODE: 'TEST654',
    CHECKOUT_PROMO_MONTH_PRICE_RUB: '10',
    CHECKOUT_PROMO2_CODE: 'TEST639',
    CHECKOUT_PROMO2_MONTH_PRICE_RUB: '69',
    CHECKOUT_TELEGRAM_BOT_USERNAME: 'smeshaibot',
    CHECKOUT_CAPABILITY_SECRET: 'checkout-capability-secret-that-is-at-least-32-bytes',
    ROBOKASSA_SUCCESS_URL2: 'https://site.example/checkout/success/',
    ROBOKASSA_FAIL_URL2: 'https://site.example/checkout/',
    PAYMENT_ENVIRONMENT: 'production',
    ROBOKASSA_MERCHANT_LOGIN: 'merchant',
    ROBOKASSA_PASSWORD1_PRODUCTION: 'p1',
    ROBOKASSA_PASSWORD2_PRODUCTION: 'p2',
    ROBOKASSA_PASSWORD3_PRODUCTION: 'p3',
    ROBOKASSA_FISCALIZATION_MODE: 'provider',
    ROBOKASSA_RECEIPT_TAX: 'none',
    ROBOKASSA_RECEIPT_PAYMENT_METHOD: 'full_payment',
    ROBOKASSA_RECEIPT_PAYMENT_OBJECT: 'service',
    TELEGRAM_BOT_TOKEN: 'tg',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret-that-is-strong',
    SUPPORT_CHAT_ID: '42',
    AI_PROXY_API_KEY: 'k',
    INGEST_KEY: 'test-ingest-key-that-is-at-least-32-bytes',
    RUNTIME_WRITE_EPOCH: '1'
  };
  const get = (env, token = healthy.ADMIN_SECRET) =>
    worker.fetch(new Request('https://api.example/admin/health', {
      headers: { 'X-Admin-Token': token }
    }), env, ctx);

  const unauth = await worker.fetch(new Request('https://api.example/admin/health'), healthy, ctx);
  assert.equal(unauth.status, 401, 'readiness details must not be public');

  const ok = await get(healthy);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.missing_tables, []);
  assert.deepEqual(body.worklists, {
    delivery_exhausted: 3,
    payment_review_open: 2,
    payment_reconciliation_errors: 6,
    refund_submission_unknown: 0,
    refund_poll_stalled: 0,
    referral_unsettled: 4,
    referral_legacy_unjournaled: 1,
    support_forward_exhausted: 5
  },
    'the operator worklists must be surfaced');
  assert.equal(body.checks.worklists, true);

  const migratedHealthDb = new DatabaseSync(':memory:');
  const migrationsDir = new URL('../backend/migrations/', import.meta.url);
  for (const file of (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()) {
    migratedHealthDb.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
  }
  const migratedHealth = await get({
    ...healthy,
    DB: new SqliteD1Adapter(migratedHealthDb)
  });
  assert.equal(migratedHealth.status, 200,
    'the exact DDL gate must accept the legitimate rebuild-migration spellings');
  assert.equal((await migratedHealth.json()).checks.schema, true);
  migratedHealthDb.close();

  // Wrangler's pinned D1 ingestion removes line comments before SQLite stores
  // CREATE statements and its local runtime owns an exact _cf_METADATA table.
  // Both are legitimate platform products, but neither may weaken validation
  // of any application object or arbitrary _cf_* lookalike.
  const d1IngestedHealthDb = new DatabaseSync(':memory:');
  d1IngestedHealthDb.exec(schemaSql.replace(/--[^\r\n]*/g, ''));
  d1IngestedHealthDb.exec(
    'CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)'
  );
  const d1IngestedHealth = await get({
    ...healthy,
    DB: new SqliteD1Adapter(d1IngestedHealthDb)
  });
  assert.equal(d1IngestedHealth.status, 200,
    'readiness must accept the exact comment-free schema and platform table produced by D1');
  assert.equal((await d1IngestedHealth.json()).checks.schema, true);
  d1IngestedHealthDb.close();

  const malformedD1MetadataDb = new DatabaseSync(':memory:');
  malformedD1MetadataDb.exec(schemaSql.replace(/--[^\r\n]*/g, ''));
  malformedD1MetadataDb.exec(
    'CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value TEXT)'
  );
  const malformedD1Metadata = await get({
    ...healthy,
    DB: new SqliteD1Adapter(malformedD1MetadataDb)
  });
  assert.equal(malformedD1Metadata.status, 503,
    'the platform prefix must not bless a malformed _cf_METADATA lookalike');
  assert.deepEqual((await malformedD1Metadata.json()).invalid_table_shapes,
    ['_cf_METADATA']);
  malformedD1MetadataDb.close();

  const noCatalog = await get({
    ...healthy, SUBSCRIPTION_PRICE_RUB: undefined, LIFETIME_PRICE_RUB: undefined
  });
  assert.equal(noCatalog.status, 503,
    'an unconfigured order catalog means nothing can be sold — monitoring must see red');
  assert.equal((await noCatalog.json()).checks.payment_config, false);

  const noFiscalizationDecision = await get({
    ...healthy, ROBOKASSA_FISCALIZATION_MODE: undefined
  });
  assert.equal(noFiscalizationDecision.status, 503,
    'checkout must not launch until the merchant selects its fiscalization path');
  assert.equal((await noFiscalizationDecision.json()).checks.payment_config, false);

  const invalidReceiptTax = await get({
    ...healthy, ROBOKASSA_RECEIPT_TAX: 'guess-the-tax'
  });
  assert.equal(invalidReceiptTax.status, 503,
    'provider fiscalization must reject an unrecognized accountant-controlled tax code');
  assert.equal((await invalidReceiptTax.json()).checks.payment_config, false);

  const noIngestKey = await get({ ...healthy, INGEST_KEY: undefined });
  assert.equal(noIngestKey.status, 503,
    'telemetry attestation cannot operate without a strong signing secret');
  assert.equal((await noIngestKey.json()).checks.ingest_key, false);

  const noCheckoutCapabilitySecret = await get({
    ...healthy, CHECKOUT_CAPABILITY_SECRET: undefined
  });
  assert.equal(noCheckoutCapabilitySecret.status, 503,
    'checkout capabilities require a dedicated Worker-only signing secret');
  assert.equal((await noCheckoutCapabilitySecret.json()).checks.checkout_capability_secret, false);

  const sharedCheckoutCapabilitySecret = await get({
    ...healthy, CHECKOUT_CAPABILITY_SECRET: healthy.INGEST_KEY
  });
  assert.equal(sharedCheckoutCapabilitySecret.status, 503,
    'the VPS-shared ingest key must never double as checkout identity authority');
  assert.equal(
    (await sharedCheckoutCapabilitySecret.json()).checks.checkout_capability_secret,
    false
  );

  const weakTelegramWebhookSecret = await get({
    ...healthy, TELEGRAM_WEBHOOK_SECRET: 'too-short'
  });
  assert.equal(weakTelegramWebhookSecret.status, 503,
    'Telegram identity authority must fail readiness on a weak webhook secret');
  assert.equal((await weakTelegramWebhookSecret.json()).checks.telegram_webhook_secret, false);

  const invalidSupportOwner = await get({ ...healthy, SUPPORT_CHAT_ID: 'not-a-chat' });
  assert.equal(invalidSupportOwner.status, 503,
    'an enabled support bot without a valid owner route must make readiness red');
  assert.equal((await invalidSupportOwner.json()).checks.support_owner, false);

  const invalidPlan = await get({
    ...healthy,
    DEFAULT_LICENSE_TYPE: 'subscription',
    SUBSCRIPTION_DAYS: 'not-a-number'
  });
  assert.equal(invalidPlan.status, 503,
    'readiness must reject a subscription configuration that cannot issue a finite expiry');
  assert.equal((await invalidPlan.json()).checks.payment_config, false);

  for (const malformedPrice of [' 199', '199 ', '1e3', '199.001', '9007199254740992']) {
    const invalidPrice = await get({
      ...healthy, SUBSCRIPTION_PRICE_RUB: malformedPrice, LIFETIME_PRICE_RUB: undefined
    });
    assert.equal(invalidPrice.status, 503,
      `readiness must reject a non-canonical or unsafe RUB price: ${malformedPrice}`);
    assert.equal((await invalidPrice.json()).checks.payment_config, false);
  }

  for (const malformedDays of [' 30', '30 ', '3e1']) {
    const invalidDuration = await get({
      ...healthy,
      DEFAULT_LICENSE_TYPE: 'subscription',
      SUBSCRIPTION_DAYS: malformedDays
    });
    assert.equal(invalidDuration.status, 503,
      `readiness must reject a non-canonical subscription duration: ${malformedDays}`);
    assert.equal((await invalidDuration.json()).checks.payment_config, false);
  }

  const invalidDeviceLimit = await get({ ...healthy, DEVICE_LIMIT: '3.5' });
  assert.equal(invalidDeviceLimit.status, 503,
    'a fractional device cap would authorize more devices than configured');
  assert.equal((await invalidDeviceLimit.json()).checks.device_limit, false);

  const invalidHash = await get({ ...healthy, ROBOKASSA_HASH_ALGO: 'SHA3-256' });
  assert.equal(invalidHash.status, 503,
    'an unsupported callback hash must be visible before every payment retry fails');
  assert.equal((await invalidHash.json()).checks.robokassa_hash, false);

  const missingTable = await get({
    ...healthy,
    DB: new FakeD1(HEALTH_TABLES.filter((t) => t !== 'payment_issuance'))
  });
  assert.equal(missingTable.status, 503);
  const mt = await missingTable.json();
  assert.equal(mt.checks.schema, false);
  assert.deepEqual(mt.missing_tables, ['payment_issuance'],
    'the exact missing table must be named for the operator');

  const missingColumnDb = new FakeD1(HEALTH_TABLES);
  missingColumnDb.columns.set(
    'delivery_outbox',
    missingColumnDb.columns.get('delivery_outbox').filter((column) => column.name !== 'claim_token')
  );
  const missingColumn = await get({ ...healthy, DB: missingColumnDb });
  assert.equal(missingColumn.status, 503);
  assert.deepEqual((await missingColumn.json()).missing_columns, ['delivery_outbox.claim_token'],
    'readiness must detect a table that exists with an obsolete shape');

  const missingIndexDb = new FakeD1(HEALTH_TABLES);
  missingIndexDb.indexes.delete('idx_referral_auth_claims_code');
  const missingIndex = await get({ ...healthy, DB: missingIndexDb });
  assert.equal(missingIndex.status, 503);
  assert.deepEqual((await missingIndex.json()).missing_indexes, ['idx_referral_auth_claims_code'],
    'readiness must detect a missing correctness-critical index');

  const missingIssuanceUniqueDb = new FakeD1(HEALTH_TABLES);
  for (const [name, index] of missingIssuanceUniqueDb.indexes) {
    if (index.table === 'payment_issuance' && index.origin === 'u' &&
        index.columns.join('|') === 'license_key') {
      missingIssuanceUniqueDb.indexes.delete(name);
    }
  }
  const missingIssuanceUnique = await get({ ...healthy, DB: missingIssuanceUniqueDb });
  assert.equal(missingIssuanceUnique.status, 503,
    'same-named columns without the payment idempotency UNIQUE constraint are unsafe');
  assert.deepEqual(
    (await missingIssuanceUnique.json()).invalid_constraints,
    ['payment_issuance.UNIQUE(license_key)']
  );

  const malformedSqlite = new DatabaseSync(':memory:');
  malformedSqlite.exec(schemaSql);
  malformedSqlite.exec(`
    ALTER TABLE payment_issuance RENAME TO payment_issuance_original;
    CREATE TABLE payment_issuance (
      gateway TEXT NOT NULL,
      payment_id TEXT NOT NULL,
      license_key TEXT NOT NULL,
      license_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (gateway, payment_id)
    );
    DROP TABLE payment_issuance_original;
  `);
  const malformedRealHealth = await get({
    ...healthy,
    DB: new SqliteD1Adapter(malformedSqlite)
  });
  assert.equal(malformedRealHealth.status, 503);
  const malformedRealBody = await malformedRealHealth.json();
  assert.deepEqual(malformedRealBody.invalid_constraints,
    ['payment_issuance.UNIQUE(license_key)'],
    'real SQLite PRAGMAs must reject a same-column payment table without UNIQUE(license_key)');
  assert.equal(malformedRealBody.checks.schema, false);
  malformedSqlite.close();

  const wrongIndexShapeDb = new FakeD1(HEALTH_TABLES);
  wrongIndexShapeDb.indexes.get('idx_delivery_outbox_due').columns = [
    'delivered_at', 'next_attempt_at'
  ];
  const wrongIndexShape = await get({ ...healthy, DB: wrongIndexShapeDb });
  assert.equal(wrongIndexShape.status, 503);
  assert.deepEqual((await wrongIndexShape.json()).missing_indexes, ['idx_delivery_outbox_due'],
    'a named index with the wrong columns must not satisfy readiness');

  const wrongColumnConstraintDb = new FakeD1(HEALTH_TABLES);
  const issuanceColumns = wrongColumnConstraintDb.columns.get('payment_issuance');
  issuanceColumns.find((column) => column.name === 'license_json').notnull = 0;
  issuanceColumns.find((column) => column.name === 'payment_id').pk = 0;
  const wrongColumnConstraint = await get({ ...healthy, DB: wrongColumnConstraintDb });
  assert.equal(wrongColumnConstraint.status, 503);
  assert.deepEqual((await wrongColumnConstraint.json()).invalid_table_shapes,
    ['payment_issuance'],
    'readiness must verify NOT NULL/default/PK metadata, not only column names');

  const missingCheckDb = new FakeD1(HEALTH_TABLES);
  missingCheckDb.tableSql.set(
    'support_forward_outbox',
    missingCheckDb.tableSql.get('support_forward_outbox').replace(
      /CHECK\s*\(attempts\s*>=\s*0\)/i,
      ''
    )
  );
  const missingCheck = await get({ ...healthy, DB: missingCheckDb });
  assert.equal(missingCheck.status, 503);
  assert.deepEqual((await missingCheck.json()).invalid_table_shapes,
    ['support_forward_outbox'],
    'complete table DDL, including every CHECK, must be part of readiness');

  const commentForgedCheckDb = new DatabaseSync(':memory:');
  commentForgedCheckDb.exec(schemaSql);
  commentForgedCheckDb.exec(`
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
  const commentForgedCheck = await get({
    ...healthy,
    DB: new SqliteD1Adapter(commentForgedCheckDb)
  });
  assert.equal(commentForgedCheck.status, 503);
  assert.deepEqual((await commentForgedCheck.json()).invalid_table_shapes,
    ['runtime_write_fence'],
    'comments containing expected CHECK text must not forge the constraints');
  commentForgedCheckDb.close();

  const generatedColumnDb = new DatabaseSync(':memory:');
  generatedColumnDb.exec(schemaSql);
  generatedColumnDb.exec(
    "ALTER TABLE counters ADD COLUMN poison TEXT GENERATED ALWAYS AS ('x') VIRTUAL"
  );
  const generatedColumn = await get({ ...healthy, DB: new SqliteD1Adapter(generatedColumnDb) });
  assert.equal(generatedColumn.status, 503);
  assert.deepEqual((await generatedColumn.json()).invalid_table_shapes, ['counters'],
    'table_xinfo and complete DDL must expose generated/hidden columns');
  generatedColumnDb.close();

  const prefixedObjectDb = new DatabaseSync(':memory:');
  prefixedObjectDb.exec(schemaSql);
  prefixedObjectDb.exec(`
    CREATE UNIQUE INDEX _cf_purchase_status ON purchases(status);
    CREATE TRIGGER _cf_purchase_rewrite AFTER INSERT ON purchases
    BEGIN
      UPDATE purchases SET note = 'triggered' WHERE license_key = NEW.license_key;
    END;
  `);
  const prefixedObject = await get({ ...healthy, DB: new SqliteD1Adapter(prefixedObjectDb) });
  assert.equal(prefixedObject.status, 503);
  assert.deepEqual((await prefixedObject.json()).unexpected_schema_objects.sort(), [
    'index:_cf_purchase_status',
    'trigger:_cf_purchase_rewrite'
  ], 'an arbitrary _cf_* prefix must not exempt application indexes or triggers');
  prefixedObjectDb.close();

  const expressionIndexDb = new DatabaseSync(':memory:');
  expressionIndexDb.exec(schemaSql);
  expressionIndexDb.exec(`
    DROP INDEX idx_purchases_issued;
    CREATE INDEX idx_purchases_issued ON purchases((issued_at + 0));
  `);
  const expressionIndex = await get({ ...healthy, DB: new SqliteD1Adapter(expressionIndexDb) });
  assert.equal(expressionIndex.status, 503);
  assert.deepEqual((await expressionIndex.json()).missing_indexes,
    ['idx_purchases_issued'],
    'an expression index cannot impersonate an expected named column index');
  expressionIndexDb.close();

  const wrongFenceEpochDb = new FakeD1(HEALTH_TABLES);
  wrongFenceEpochDb.writeEpoch = 2;
  const wrongFenceEpoch = await get({ ...healthy, DB: wrongFenceEpochDb });
  assert.equal(wrongFenceEpoch.status, 503);
  assert.equal((await wrongFenceEpoch.json()).checks.write_fence, false,
    'deployment config and durable epoch must match before writes are healthy');

  const worklistFailureDb = new FakeD1(HEALTH_TABLES);
  worklistFailureDb.failWorklists = true;
  const worklistFailure = await get({ ...healthy, DB: worklistFailureDb });
  assert.equal(worklistFailure.status, 503,
    'a failed operational-worklist query must make readiness red');
  const wf = await worklistFailure.json();
  assert.equal(wf.checks.worklists, false);
  assert.deepEqual(wf.worklists, {
    delivery_exhausted: null,
    payment_review_open: null,
    payment_reconciliation_errors: null,
    refund_submission_unknown: null,
    refund_poll_stalled: null,
    referral_unsettled: null,
    referral_legacy_unjournaled: null,
    support_forward_exhausted: null
  });

  const publicHealth = await worker.fetch(new Request('https://api.example/health'), {}, ctx);
  assert.equal(publicHealth.status, 200, 'public /health stays pure liveness');
}

/* ---- B-17: purchases list reports truncation ---- */
{
  const db = new FakeD1(HEALTH_TABLES);
  db.purchaseRows = Array.from({ length: 501 }, (_, i) => ({
    license_key: `SMESH-${String(1000 - i).padStart(4, '0')}`,
    issued_at: 10_000 - i
  }));
  const full = await statsPurchases({ DB: db }, { days: 0, limit: 500 });
  assert.equal(full.truncated, true, 'a 501st row must flag the list as partial');
  assert.equal(full.purchases.length, 500);
  assert.equal(full.next_offset, 500);

  const last = await statsPurchases({ DB: db }, { days: 0, limit: 500, offset: full.next_offset });
  assert.equal(last.purchases.length, 1,
    'the row beyond the first page must be retrievable, not merely disclosed');
  assert.equal(last.has_more, false);
  assert.equal(last.next_offset, null);

  const cursorLast = await statsPurchases(
    { DB: db },
    { days: 0, limit: 500, cursor: full.next_cursor }
  );
  assert.equal(cursorLast.purchases.length, 1,
    'the opaque keyset cursor must retrieve later purchases without an offset ceiling');
  assert.equal(cursorLast.has_more, false);
  assert.equal(cursorLast.offset, null);

  const oversized = await statsPurchases(
    { DB: db },
    { days: 0, offset: 1_000_001 }
  );
  assert.deepEqual(oversized, { ok: false, reason: 'bad_offset', status: 400 },
    'oversized offsets must be rejected rather than clamped backward into an infinite page loop');

  db.purchaseRows = db.purchaseRows.slice(0, 12);
  const small = await statsPurchases({ DB: db }, { days: 0 });
  assert.equal(small.truncated, false);
  assert.equal(small.purchases.length, 12);
}

/* ---- B-15/B-19: docs and hygiene stay fixed ---- */
{
  const readme = await readFile(new URL('../backend/README.md', import.meta.url), 'utf8');
  assert.match(readme, /wrangler d1 export smesh-analytics --remote/,
    'the backup runbook must export authoritative D1 state, not only KV');
  assert.match(readme, /node scripts\/backup-kv\.mjs/,
    'the runbook must use the checked, chunked KV export');
  assert.doesNotMatch(readme, /kv bulk get --binding LICENSES/,
    'Wrangler bulk get requires a positional key-list file');
  assert.match(readme, /admin\/health/, 'monitoring docs must point at the readiness endpoint');

  const gitignore = await readFile(new URL('../backend/.gitignore', import.meta.url), 'utf8');
  assert.match(gitignore, /^\.env\*$/m, 'every .env variant must be ignored');
  assert.match(gitignore, /^\.dev\.vars\*$/m, 'every .dev.vars variant must be ignored');
}

console.log('readiness and contract regressions passed');
