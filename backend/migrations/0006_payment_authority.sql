-- 0006_payment_authority — server-owned orders, integer money, and auditable
-- payment/review lifecycle. Existing REAL ruble values are retained only for
-- compatibility; all new accounting and comparisons use integer kopecks.

ALTER TABLE purchases ADD COLUMN amount_kopecks INTEGER;
UPDATE purchases
SET amount_kopecks = CAST(ROUND(amount_rub * 100) AS INTEGER)
WHERE amount_rub IS NOT NULL AND amount_kopecks IS NULL;

ALTER TABLE payment_review ADD COLUMN environment TEXT;
ALTER TABLE payment_review ADD COLUMN amount_kopecks INTEGER;
ALTER TABLE payment_review ADD COLUMN resolution TEXT;
ALTER TABLE payment_review ADD COLUMN resolution_note TEXT;
UPDATE payment_review
SET amount_kopecks = CAST(ROUND(amount_rub * 100) AS INTEGER)
WHERE amount_rub IS NOT NULL AND amount_kopecks IS NULL;

CREATE TABLE payment_orders (
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
CREATE INDEX idx_payment_orders_status
  ON payment_orders(environment, status, created_at);

CREATE TABLE payment_events (
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
CREATE INDEX idx_payment_events_payment
  ON payment_events(gateway, payment_id, created_at);
