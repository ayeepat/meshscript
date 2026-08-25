-- 0008_telegram_update_idempotency — make webhook processing replay-safe and
-- retryable.
--
-- Telegram defines update_id specifically so a receiver can ignore repeats, and
-- it retries any delivery it does not see acknowledged with a 2xx. The handler
-- persisted neither: replaying update 777 produced tickets 1001 AND 1002, two
-- owner forwards and two user confirmations, and replaying an owner reply
-- delivered it twice. In the other direction, an internal exception was still
-- answered with 200, so failed processing could never be retried.
--
-- The lease column is what keeps this from being a naive claim-and-ACK: a
-- delivery that dies after claiming leaves completed_at NULL, and once its
-- lease expires Telegram's own retry re-claims the update instead of it being
-- silently dropped.

CREATE TABLE telegram_updates (
  update_id    INTEGER PRIMARY KEY,
  claimed_at   INTEGER NOT NULL,
  lease_until  INTEGER NOT NULL,
  completed_at INTEGER,
  result_kind  TEXT
);
CREATE INDEX idx_telegram_updates_claimed
  ON telegram_updates(claimed_at);
