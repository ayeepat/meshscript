-- СМЭШ AI analytics schema (D1 / SQLite).
-- Apply:  npx wrangler d1 execute smesh-analytics --remote --file=schema.sql
-- Local:  npx wrangler d1 execute smesh-analytics --local  --file=schema.sql
--
-- `day` columns are calendar days in MOSCOW time (UTC+3) — the audience is
-- Russian school students, so "a day" must mean their day, not UTC's.

-- One row per extension install. device_id is the same anonymous UUID the
-- extension already sends to /verify and /referral/*.
--
-- Data minimization (2026-07): `ua` and `license_key` are DEAD columns — the
-- ingest writes NULL to ua and never binds a raw key anymore. New installs get
-- `license_ref` instead: HMAC-SHA256(license_key, ANALYTICS_SALT secret),
-- computed server-side ONLY when a legacy client still posts the raw key.
-- Migration on an existing DB:
--   ALTER TABLE devices ADD COLUMN license_ref TEXT;
--   UPDATE devices SET ua = NULL, license_key = NULL;  -- purge collected raws
CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  first_seen   INTEGER NOT NULL,          -- ms epoch
  last_seen    INTEGER NOT NULL,          -- ms epoch
  browser      TEXT,                      -- chrome | yandex | opera | edge | firefox | other
  ua           TEXT,                      -- LEGACY, always NULL now (raw UA is not stored)
  version      TEXT,                      -- extension version
  provider     TEXT,                      -- last selected AI provider
  license_key  TEXT,                      -- LEGACY, never written (see license_ref)
  license_ref  TEXT,                      -- HMAC pseudonym of the license key (may be null)
  license_type TEXT                       -- lifetime | subscription | none
);

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
  meta       TEXT                         -- small JSON: {mode, gdz_auto, refused, msg, ...}
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

-- Atomic abuse budgets for the anonymous telemetry endpoint. KV read-modify-
-- write counters lose increments under concurrency; this table makes every
-- admission decision against one authoritative row. Old days can be pruned.
CREATE TABLE IF NOT EXISTS telemetry_budget (
  day        TEXT    NOT NULL,
  scope      TEXT    NOT NULL,          -- ip | device
  budget_key TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, budget_key)
);
