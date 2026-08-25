-- 0001_baseline — the schema as of 2026-07-17, when wrangler d1 migrations
-- were adopted (audit B-14). Safe against the pre-existing production DB:
-- durable schema objects are created IF NOT EXISTS; the temporary devices
-- rebuild below is intentionally recreated within this migration. Future
-- schema changes are NEW numbered files with the delta
-- (ALTER TABLE / CREATE ...), mirrored into ../schema.sql in the same commit;
-- the schema-migration-parity regression enforces that mirror.

-- `day` columns are calendar days in MOSCOW time (UTC+3) — the audience is
-- Russian school students, so "a day" must mean their day, not UTC's.

-- One row per extension install. device_id is the same anonymous UUID the
-- extension already sends to /verify and /referral/*.
--
-- Data minimization (2026-07): `ua`, `license_key`, and `license_ref` are DEAD
-- compatibility columns. Ingest ignores raw UA/license fields from legacy
-- clients; applying this schema also purges any values collected previously.
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  first_seen   INTEGER NOT NULL,          -- ms epoch
  last_seen    INTEGER NOT NULL,          -- ms epoch
  browser      TEXT,                      -- chrome | yandex | opera | edge | firefox | other
  ua           TEXT,                      -- LEGACY, always NULL now (raw UA is not stored)
  version      TEXT,                      -- extension version
  provider     TEXT,                      -- last selected AI provider
  license_key  TEXT,                      -- LEGACY, always NULL now
  license_ref  TEXT,                      -- LEGACY pseudonym, no longer written
  license_type TEXT                       -- lifetime | subscription | none
);

-- Some pre-baseline databases predate license_ref entirely. SQLite cannot
-- conditionally reference an optional column, so `UPDATE ... license_ref`
-- aborts on those installations. Rebuild from the columns common to BOTH
-- historical shapes: all live analytics data is copied, the three retired
-- identifier columns are deliberately NULL, and the current license_ref
-- column exists afterward. The migration is transactional in D1.
CREATE TABLE devices_privacy_v2 (
  device_id    TEXT PRIMARY KEY,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  browser      TEXT,
  ua           TEXT,
  version      TEXT,
  provider     TEXT,
  license_key  TEXT,
  license_ref  TEXT,
  license_type TEXT
);
INSERT INTO devices_privacy_v2
  (device_id, first_seen, last_seen, browser, ua, version, provider,
   license_key, license_ref, license_type)
SELECT device_id, first_seen, last_seen, browser, NULL, version, provider,
       NULL, NULL, license_type
FROM devices;
DROP TABLE devices;
ALTER TABLE devices_privacy_v2 RENAME TO devices;

-- One row per usage event. Content-free by design: no task text, no answers —
-- only what/when/how-much. meta is a small JSON blob for per-type extras.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,            -- ms epoch (client, server-clamped)
  day        TEXT    NOT NULL,            -- YYYY-MM-DD, Moscow time
  device_id  TEXT    NOT NULL,
  type       TEXT    NOT NULL,            -- install|update|heartbeat|solve|test_solve|test_requestion|gdz_pull|error
  subject    TEXT,                        -- Mesh subject name (solves/gdz)
  provider   TEXT,                        -- openrouter | groq | qwen | deepseek
  model      TEXT,                        -- exact model id the provider reported
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL    NOT NULL DEFAULT 0,  -- exact provider cost when reported, else estimate
  files_pdf  INTEGER NOT NULL DEFAULT 0,  -- PDF attachments on this solve
  files_img  INTEGER NOT NULL DEFAULT 0,  -- image attachments (photos/screenshots)
  meta       TEXT                         -- fixed-vocabulary, typed metrics only (see analytics.js)
);
CREATE INDEX IF NOT EXISTS idx_events_day    ON events(day);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id, day);
CREATE INDEX IF NOT EXISTS idx_events_type   ON events(type, day);

-- Mirror of the KV license rows, so revenue/retention joins are plain SQL.
-- KV stays the source of truth; putLicense() mirrors every write here and
-- POST /admin/backfill-licenses re-syncs the whole namespace on demand.
CREATE TABLE IF NOT EXISTS purchases (
  license_key      TEXT PRIMARY KEY,
  gateway          TEXT,                  -- robokassa | manual | referral | ...
  payment_id       TEXT,
  type             TEXT,                  -- lifetime | subscription
  status           TEXT,                  -- active | revoked
  amount_rub       REAL,                  -- null for comp/referral keys
  email            TEXT,
  telegram_user_id TEXT,
  issued_at        INTEGER,               -- ms epoch
  expires_at       INTEGER,               -- ms epoch, null = lifetime
  is_preorder      INTEGER DEFAULT 0,
  note             TEXT,
  device_ids       TEXT                   -- JSON array of activated device ids
);
CREATE INDEX IF NOT EXISTS idx_purchases_issued ON purchases(issued_at);

-- Authoritative payment idempotency registry. KV cannot atomically perform
-- "create if absent", so simultaneous gateway deliveries could mint two keys.
-- license_json makes a committed claim recoverable ONLY when an invocation
-- dies before materializing the KV license row; it never refreshes or replaces
-- an existing live row.
CREATE TABLE IF NOT EXISTS payment_issuance (
  gateway      TEXT    NOT NULL,
  payment_id   TEXT    NOT NULL,
  license_key  TEXT    NOT NULL UNIQUE,
  license_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (gateway, payment_id)
);

-- Atomic referral capability→code claim. KV cannot create-if-absent, so the
-- unique auth_hash chooses one stable code under simultaneous first requests;
-- the KV record and pointers are recoverable materializations of this claim.
CREATE TABLE IF NOT EXISTS referral_auth_claims (
  auth_hash TEXT    PRIMARY KEY,
  code      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_auth_claims_code
  ON referral_auth_claims(code);

-- One atomic referral payout claim per purchased license. The reward remains
-- mirrored in KV, but concurrent webhook deliveries cannot both credit it.
CREATE TABLE IF NOT EXISTS referral_credits (
  license_key TEXT    PRIMARY KEY,
  ref_code    TEXT    NOT NULL,
  claimed_at  INTEGER NOT NULL
);

-- Retryable referral payout journal. target_* persists the resolved INTENT so
-- retries replay one absolute expiry write instead of incrementing twice after
-- a crash. materialized_at is set ONLY after ref:<code> was rewritten from D1;
-- NULL on an applied row means user-visible KV may be stale and must recover.
-- PRE-LAUNCH NOTE: if today's brief interim version of this table was applied,
-- DROP the empty referral_credit_state table and re-apply this schema.
CREATE TABLE IF NOT EXISTS referral_credit_state (
  license_key TEXT    PRIMARY KEY,
  ref_code    TEXT    NOT NULL,
  days        INTEGER NOT NULL,
  status      TEXT    NOT NULL,           -- pending | applied
  created_at  INTEGER NOT NULL,
  applied_at  INTEGER,
  materialized_at INTEGER,                -- set after D1-derived ref:* KV rewrite
  target_kind TEXT,                       -- owner | reward
  target_key  TEXT,
  target_expiry TEXT                       -- fixed ISO expiry for replay
);

-- Per-code leases serialize KV read-modify-write payouts. KV has no CAS, so
-- without this lock concurrent purchases can overwrite counters and expiry.
CREATE TABLE IF NOT EXISTS referral_apply_locks (
  ref_code    TEXT    PRIMARY KEY,
  lease_until INTEGER NOT NULL
);

-- Write-once KV materialization registry + generic per-row leases. KV has no
-- compare-and-set, so "create the KV row if missing" is a stale-read race: a
-- webhook replay can read null (KV is eventually consistent), pause, and then
-- overwrite a row that was revoked / device-bound / credited in between. A
-- name recorded here means the row was DEFINITELY written once; recovery
-- paths must never write its issue-time snapshot again. kv_apply_locks
-- serializes the materializers themselves (same lease shape as
-- referral_apply_locks). Names: 'license:<key>', 'ref:<CODE>'.
CREATE TABLE IF NOT EXISTS kv_materializations (
  name            TEXT    PRIMARY KEY,
  materialized_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv_apply_locks (
  name        TEXT    PRIMARY KEY,
  lease_until INTEGER NOT NULL
);

-- Durable license-delivery outbox. The payment webhook acks the gateway only
-- AFTER the retry job is persisted here; the worker's cron trigger re-drives
-- rows with backoff until one channel confirms (delivered_at) or attempts run
-- out. Exhausted rows stay for operator inspection — they are the "buyer paid
-- but never got the key" worklist.
CREATE TABLE IF NOT EXISTS delivery_outbox (
  license_key      TEXT    PRIMARY KEY,
  email            TEXT,
  telegram_user_id INTEGER,
  is_preorder      INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL,
  delivered_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_due
  ON delivery_outbox(delivered_at, next_attempt_at);

-- AI-proxy daily quota counters (see src/ai-proxy.js). One row per Moscow
-- day × license × provider, bumped atomically per request. The special row
-- (license_key='*', provider='all') is the global circuit-breaker counter.
-- Rows for past days are dead weight only — safe to DELETE any time.
CREATE TABLE IF NOT EXISTS proxy_quota (
  day         TEXT    NOT NULL,           -- YYYY-MM-DD, Moscow time
  license_key TEXT    NOT NULL,           -- normalized key, or '*' for global
  provider    TEXT    NOT NULL,           -- qwen | deepseek | 'all' (global row)
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, license_key, provider)
);

-- Authoritative device registry for the per-license device cap (DEVICE_LIMIT).
-- KV device_ids stays the display/admin mirror, but the CAP DECISION lives here
-- because KV has no compare-and-swap: two concurrent /verify calls with distinct
-- devices could both read `device_ids.length < limit` and both push, exceeding
-- the cap. verifyLicense (licenses.js) claims a slot with one conditional INSERT
-- whose WHERE re-counts under SQLite's write lock, so the race cannot slip past.
-- Seeded lazily from KV device_ids on the first new-device verify per license.
CREATE TABLE IF NOT EXISTS license_devices (
  license_key TEXT    NOT NULL,
  device_id   TEXT    NOT NULL,
  added_at    INTEGER NOT NULL,           -- ms epoch
  PRIMARY KEY (license_key, device_id)
);
CREATE INDEX IF NOT EXISTS idx_license_devices_device ON license_devices(device_id);

-- Authoritative revocation registry. The KV license row is rewritten wholesale
-- by concurrent mutators (the /verify device mirror, referral expiry
-- extensions) and KV reads can be stale for up to a minute, so a revocation
-- recorded only as KV status can be resurrected to "active" by an in-flight
-- read-modify-write. A row here is permanent and strongly consistent:
-- /verify (and therefore /ai/chat) rejects the key even when the KV mirror
-- says active, and heals the mirror back to revoked.
CREATE TABLE IF NOT EXISTS license_revocations (
  license_key TEXT    PRIMARY KEY,
  revoked_at  INTEGER NOT NULL,          -- ms epoch
  reason      TEXT
);

-- Paid-but-unissued review journal. A signed Robokassa callback is money that
-- already moved; when the webhook acks WITHOUT issuing (missing delivery
-- contact, unconfigured or unmatched pricing), the ack stops gateway retries
-- forever and console logs are the only other trace. The callback is
-- journaled here BEFORE that ack so the operator can recover (manual issue or
-- refund); if this write fails the webhook answers non-OK and the gateway's
-- redelivery loop stays the durable channel. fields_json has SignatureValue
-- stripped — a stored signature is an offline brute-force target for
-- Password#2. resolved_at is operator bookkeeping.
CREATE TABLE IF NOT EXISTS payment_review (
  gateway     TEXT    NOT NULL,
  payment_id  TEXT    NOT NULL,
  invoice_id  TEXT,
  amount_rub  REAL,
  reason      TEXT    NOT NULL,          -- invalid_plan_config | no_floor_configured | below_floor | no_contact | no_plan_matched
  fields_json TEXT,
  created_at  INTEGER NOT NULL,          -- ms epoch
  resolved_at INTEGER,
  PRIMARY KEY (gateway, payment_id)
);

-- Atomic named counters. Currently only the support-bot ticket sequence:
-- the historical KV read-increment-write let two concurrent submissions both
-- become «#1001», with one ticket:<no> record silently overwriting the other.
-- Seeded once from the legacy KV `seq:ticket` value so numbering continues.
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT    PRIMARY KEY,
  value INTEGER NOT NULL
);

-- Deletion tombstones for /t/delete. Without one, an in-flight ingest request
-- admitted before the deletion can recreate the device and its events right
-- after the delete returns success. Deletion writes the tombstone and the
-- DELETEs in one atomic batch; both ingest paths gate their inserts on "no
-- tombstone fresher than the TTL" inside the insert statement itself, so the
-- check cannot race the delete. After the TTL a still-opted-in install may
-- report again — the user erased history, not future participation.
CREATE TABLE IF NOT EXISTS device_tombstones (
  device_id  TEXT    PRIMARY KEY,
  deleted_at INTEGER NOT NULL             -- ms epoch
);

-- Atomic abuse budgets shared by telemetry, admin-auth failures, and failed
-- license lookups. KV read-modify-write counters lose increments under
-- concurrency; this table keeps each budget authoritative. Rows from old days
-- can be pruned.
CREATE TABLE IF NOT EXISTS telemetry_budget (
  day        TEXT    NOT NULL,
  scope      TEXT    NOT NULL,          -- ip | device | admin_fail | verify_fail
  budget_key TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, budget_key)
);
