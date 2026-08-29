-- 0011_subscription_lifecycle — the Telegram /sub surface: who owns a key in
-- Telegram, a fence that makes a remote device release stick, and the durable
-- outbox behind expiry reminders and the win-back survey.
--
-- license_telegram_links: purchases.telegram_user_id only exists for buyers who
-- paid through the Telegram checkout binding. Buyers delivered by email have no
-- Telegram identity at all, so /sub needs a place to record the one they prove
-- by sending their key. A link may only be created while the key has no other
-- Telegram owner, which is what keeps "only the bound account may release this
-- device" meaningful.
--
-- license_release_fence: releasing an activation only sets the row inactive,
-- and claimActiveInstallation re-activates whichever installation verifies
-- first. The released machine still holds the key and re-verifies on its own
-- schedule, so without this fence a remote release was silently undone minutes
-- later and the buyer's new computer kept seeing device_in_use. The fence names
-- the released device, not its bearer token: a client that drops the token on a
-- rejected verdict must not thereby become eligible to re-claim the seat. It is
-- cleared by any successful activation, bypassed by a deliberate re-activation
-- the user typed (activation_intent), and expires on its own so an installation
-- that never updates cannot be locked out forever.
--
-- subscription_notifications: Telegram sends are not idempotent and the cron
-- sweep can overlap itself, so every reminder is claimed by compare-and-set
-- with a lease and backoff before it is attempted — the same shape as
-- delivery_outbox and support_forward_outbox. UNIQUE(license_key, stage) is the
-- send-once guarantee; the surrogate id keeps the licence key (a bearer
-- credential) out of Telegram callback_data and the webhook debug record.

CREATE TABLE IF NOT EXISTS license_telegram_links (
  license_key      TEXT    PRIMARY KEY,
  telegram_user_id TEXT    NOT NULL,
  linked_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_license_telegram_links_user
  ON license_telegram_links(telegram_user_id);

CREATE TABLE IF NOT EXISTS license_release_fence (
  license_key TEXT    PRIMARY KEY,
  device_id   TEXT    NOT NULL,
  released_at INTEGER NOT NULL,
  released_by TEXT
);

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

CREATE INDEX IF NOT EXISTS idx_purchases_telegram
  ON purchases(telegram_user_id);
