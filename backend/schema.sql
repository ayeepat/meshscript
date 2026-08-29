-- СМЭШ AI analytics schema (D1 / SQLite) — the FULL-SCHEMA SNAPSHOT.
--
-- This file describes the complete current shape for FRESH databases and for
-- reading. It is NOT a migration system: every statement is CREATE TABLE IF
-- NOT EXISTS, so reapplying it against an older database silently keeps the
-- old column shape and the worker then fails at runtime on missing columns.
--
-- Deployed databases evolve ONLY through migrations/ (wrangler d1 migrations;
-- tracked in the d1_migrations table):
--   change flow: edit this snapshot AND add migrations/000N_<name>.sql with
--                the ALTER/CREATE delta, in the same commit — the
--                schema-migration-parity regression fails if they diverge.
--   apply:       npx wrangler d1 migrations apply smesh-analytics --remote
--   fresh/local: npx wrangler d1 execute smesh-analytics --local --file=schema.sql
--
-- `day` columns are calendar days in MOSCOW time (UTC+3) — the audience is
-- Russian school students, so "a day" must mean their day, not UTC's.

-- Durable write authority for cross-store backups. BACKUP_MAINTENANCE blocks
-- new route/cron admission, while this primary-D1 row is checked immediately
-- before every D1/KV mutation. Rotating write_epoch revokes invocations from
-- every older deployment even after writes are enabled again.
CREATE TABLE IF NOT EXISTS runtime_write_fence (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  write_epoch    INTEGER NOT NULL CHECK (write_epoch >= 1),
  writes_enabled INTEGER NOT NULL DEFAULT 1 CHECK (writes_enabled IN (0, 1)),
  updated_at     INTEGER NOT NULL
);
INSERT OR IGNORE INTO runtime_write_fence
  (singleton, write_epoch, writes_enabled, updated_at)
VALUES (1, 1, 1, unixepoch('subsec') * 1000);

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
UPDATE devices
SET ua = NULL, license_key = NULL, license_ref = NULL
WHERE ua IS NOT NULL OR license_key IS NOT NULL OR license_ref IS NOT NULL;

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
  device_ids       TEXT,                  -- JSON array of activated device ids
  amount_kopecks   INTEGER                -- authoritative minor units for money
);
CREATE INDEX IF NOT EXISTS idx_purchases_issued ON purchases(issued_at);
-- The Telegram support bot resolves «/sub» from the buyer's numeric id.
CREATE INDEX IF NOT EXISTS idx_purchases_telegram
  ON purchases(telegram_user_id);

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

-- Server-created order authority. ResultURL proves Robokassa accepted money;
-- only a matching row here authorizes product, amount, currency, environment,
-- contact and referral fulfillment.
CREATE TABLE IF NOT EXISTS payment_orders (
  order_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway           TEXT    NOT NULL CHECK (gateway = 'robokassa'),
  environment       TEXT    NOT NULL CHECK (environment IN ('production', 'test')),
  status            TEXT    NOT NULL CHECK (status IN (
    'pending', 'paid', 'fulfilled', 'review', 'refund_pending', 'refunded', 'expired'
  )),
  amount_kopecks    INTEGER NOT NULL CHECK (amount_kopecks > 0),
  currency          TEXT    NOT NULL CHECK (currency = 'RUB'),
  plan_type         TEXT    NOT NULL CHECK (plan_type IN ('lifetime', 'subscription')),
  subscription_days INTEGER CHECK (subscription_days IS NULL OR subscription_days BETWEEN 1 AND 3650),
  email             TEXT,
  telegram_user_id  TEXT,
  referral_code     TEXT,
  device_id         TEXT,
  is_preorder       INTEGER NOT NULL DEFAULT 0 CHECK (is_preorder IN (0, 1)),
  fiscalization_mode TEXT   NOT NULL CHECK (fiscalization_mode IN ('provider', 'external')),
  receipt_json      TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  paid_at           INTEGER,
  fulfilled_at      INTEGER,
  provider_op_key   TEXT,
  reconciled_at     INTEGER,
  refund_request_id TEXT,
  refund_status     TEXT,
  refund_kopecks    INTEGER CHECK (refund_kopecks IS NULL OR refund_kopecks > 0),
  refunded_at       INTEGER,
  CHECK (
    (fiscalization_mode = 'provider' AND receipt_json IS NOT NULL) OR
    (fiscalization_mode = 'external' AND receipt_json IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status
  ON payment_orders(environment, status, created_at);

-- Append-only transition/evidence log. Sensitive callback signatures and
-- license bearer keys are stripped or one-way referenced before storage.
CREATE TABLE IF NOT EXISTS payment_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway         TEXT    NOT NULL,
  payment_id      TEXT    NOT NULL,
  order_id        INTEGER,
  environment     TEXT,
  event_type      TEXT    NOT NULL,
  amount_kopecks  INTEGER,
  currency        TEXT,
  details_json    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_events_payment
  ON payment_events(gateway, payment_id, created_at);

-- Per-order refund polling state. The cron sweep used to select a fixed
-- ORDER BY order_id batch and query the provider sequentially under one outer
-- catch, so the FIRST row whose provider call threw ended the whole sweep and
-- was then re-selected every run — twenty stuck rows could permanently starve
-- every later refund, leaving provider-finished refunds with live licenses.
-- Backing off a failing row here moves it out of the eligible set, so
-- selection stays fair and one bad row can no longer block the queue.
-- next_poll_at is a ms epoch; 0 means "due now".
CREATE TABLE IF NOT EXISTS payment_refund_poll (
  order_id      INTEGER PRIMARY KEY,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_poll_at  INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_error_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payment_refund_poll_due
  ON payment_refund_poll(next_poll_at);

-- Atomic referral capability→code claim. KV cannot create-if-absent, so the
-- unique auth_hash chooses one stable code under simultaneous first requests;
-- the KV record and pointers are recoverable materializations of this claim.
CREATE TABLE IF NOT EXISTS referral_auth_claims (
  auth_hash TEXT    PRIMARY KEY,
  code      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
-- A code is itself a bearer lookup capability and must map to exactly one
-- referral owner. Random generation retries on this unique conflict.
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
  target_expiry TEXT,                      -- fixed ISO expiry for replay
  target_generation INTEGER NOT NULL DEFAULT 0,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0,  -- ms epoch; failed codes back off
  last_error_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referral_credit_retry
  ON referral_credit_state(status, materialized_at, retry_after, created_at);

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
  claim_token      TEXT,
  lease_until      INTEGER,
  delivered_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_delivery_outbox_due
  ON delivery_outbox(delivered_at, next_attempt_at, lease_until);

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

-- One authenticated ACTIVE installation per license. `license_devices` above
-- remains an append-only compatibility/audit index; it is not authorization.
-- The first installation receives a random bearer capability whose SHA-256
-- digest is stored here. activated_at is also the immutable start clock for
-- activation-bound subscriptions; deactivate/reactivate never resets it. A
-- different installation cannot replace the active row merely by choosing
-- another client-side UUID: the current installation must explicitly
-- deactivate with that capability first.
CREATE TABLE IF NOT EXISTS license_activations (
  license_key    TEXT    PRIMARY KEY,
  status         TEXT    NOT NULL CHECK (status IN ('active', 'inactive')),
  device_id      TEXT,
  token_hash     TEXT,
  generation     INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  activated_at   INTEGER,
  last_seen_at   INTEGER,
  deactivated_at INTEGER,
  CHECK (
    (status = 'active' AND device_id IS NOT NULL AND token_hash IS NOT NULL
                       AND activated_at IS NOT NULL AND last_seen_at IS NOT NULL)
    OR
    (status = 'inactive' AND device_id IS NULL AND token_hash IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_license_activations_device
  ON license_activations(device_id) WHERE status = 'active';

-- Which Telegram account owns a key. `purchases.telegram_user_id` covers only
-- buyers who paid through the Telegram checkout binding; buyers delivered by
-- email prove ownership by sending the key to the bot, and that proof is
-- recorded here. A link is created only while the key has no other Telegram
-- owner, which is what makes "only the bound account may release the device"
-- an actual authorization rule rather than a display convention.
CREATE TABLE IF NOT EXISTS license_telegram_links (
  license_key      TEXT    PRIMARY KEY,
  telegram_user_id TEXT    NOT NULL,
  linked_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_telegram_links_user
  ON license_telegram_links(telegram_user_id);

-- Makes a remote device release stick. Deactivation only sets the activation
-- row inactive, and claimActiveInstallation re-activates whichever installation
-- verifies first — the released machine still holds the key and re-verifies on
-- its own schedule, so a release requested from the bot was silently undone
-- minutes later. The fence names the released DEVICE rather than its bearer
-- token, because a client that drops the token on a rejected verdict must not
-- become eligible to re-claim the seat by doing so. Any successful activation
-- clears it, a deliberate re-activation the user typed bypasses it, and the
-- cron prune expires it so an installation that never updates is not locked
-- out forever.
CREATE TABLE IF NOT EXISTS license_release_fence (
  license_key TEXT    PRIMARY KEY,
  device_id   TEXT    NOT NULL,
  released_at INTEGER NOT NULL,
  released_by TEXT
);

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
  environment TEXT,
  amount_kopecks INTEGER,
  resolution TEXT,
  resolution_note TEXT,
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

-- Durable owner-forwarding outbox for the Telegram support bot. Ticket bodies
-- and sender profile data stay only in expiring KV records. D1 retains the
-- ticket number plus the temporary Telegram source route needed to copy an
-- attachment; those identifiers are nulled as soon as forwarding settles.
CREATE TABLE IF NOT EXISTS support_forward_outbox (
  ticket_no               TEXT    PRIMARY KEY,
  source_chat_id          TEXT,
  source_message_id       INTEGER,
  has_attachment          INTEGER NOT NULL DEFAULT 0
                                  CHECK (has_attachment IN (0, 1)),
  created_at              INTEGER NOT NULL,
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at         INTEGER NOT NULL,
  claim_token             TEXT,
  lease_until             INTEGER,
  text_forwarded_at       INTEGER,
  attachment_forwarded_at INTEGER,
  forwarded_at            INTEGER,
  CHECK (
    has_attachment = 0 OR
    forwarded_at IS NOT NULL OR
    (source_chat_id IS NOT NULL AND source_message_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_support_forward_outbox_due
  ON support_forward_outbox(forwarded_at, next_attempt_at, lease_until);

-- Telegram webhook idempotency. Telegram defines update_id precisely so a
-- receiver can ignore repeats, and it RETRIES any delivery that is not
-- acknowledged with a 2xx. The handler used to persist nothing and always
-- answer 200: replaying one update minted a second ticket, forwarded it to the
-- owner again and sent the user a second confirmation, while a genuine
-- internal failure was acknowledged as success and never retried.
--
-- The lease makes this recoverable rather than a claim-and-ACK: a delivery that
-- dies mid-processing leaves an incomplete row whose lease expires, so Telegram's
-- own retry can pick it up instead of the update being lost.
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id    INTEGER PRIMARY KEY,
  claimed_at   INTEGER NOT NULL,
  lease_until  INTEGER NOT NULL,
  completed_at INTEGER,
  result_kind  TEXT,
  ticket_no    TEXT
);
CREATE INDEX IF NOT EXISTS idx_telegram_updates_claimed
  ON telegram_updates(claimed_at);

-- Durable outbox for subscription lifecycle messages: two expiry reminders, the
-- notice just after a subscription lapses, and the win-back survey three days
-- later. Telegram sends are not idempotent and cron sweeps can overlap, so each
-- row is claimed by compare-and-set under a lease with backoff before it is
-- attempted — the same shape as delivery_outbox and support_forward_outbox.
-- UNIQUE(license_key, stage) is the send-once guarantee. The surrogate id keeps
-- the license key (a bearer credential) out of Telegram callback_data and out
-- of the webhook debug record; `answer_code` stores only the fixed survey
-- choice, never the free-text reply, which goes to the owner's chat alone.
CREATE TABLE IF NOT EXISTS subscription_notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key      TEXT    NOT NULL,
  stage            TEXT    NOT NULL CHECK (stage IN ('expiry_3d', 'expiry_1d', 'expired', 'winback')),
  telegram_user_id TEXT    NOT NULL,
  due_at           INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  INTEGER NOT NULL,
  claim_token      TEXT,
  lease_until      INTEGER,
  sent_at          INTEGER,
  cancelled_at     INTEGER,
  answer_code      TEXT,
  answered_at      INTEGER,
  UNIQUE (license_key, stage)
);
CREATE INDEX IF NOT EXISTS idx_subscription_notifications_due
  ON subscription_notifications(sent_at, cancelled_at, next_attempt_at, lease_until);

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

-- Atomic abuse budgets shared by telemetry, admin-auth failures, failed
-- license lookups, and the GDZ proxy. KV read-modify-write counters lose
-- increments under concurrency; this table keeps each budget authoritative.
-- Rows from old days can be pruned.
--
-- `scope` values: ip | device | admin_fail | verify_fail | gdz | gdz_cover |
-- support_rate (per-minute bot flood control) | bind_attempt (per-day cap on
-- «send me your key» guesses, which would otherwise be a key-existence oracle).
-- The two GDZ scopes bucket by a SHA-256 of the license key, never the key
-- itself (src/gdz.js); covers are metered separately from answer lookups so
-- browsing the textbook picker cannot eat the day's answer allowance.
--
-- NOTE: keep prose OUTSIDE the CREATE TABLE body. /admin/health fingerprints
-- each table against `sqlite_master.sql`, which stores the statement text
-- verbatim — a comment added between the parentheses changes that fingerprint
-- and reports the deployed table as an invalid shape.
CREATE TABLE IF NOT EXISTS telemetry_budget (
  day        TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  budget_key TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, scope, budget_key)
);
