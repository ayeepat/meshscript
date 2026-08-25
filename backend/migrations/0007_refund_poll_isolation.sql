-- 0007_refund_poll_isolation — durable per-order refund polling state.
--
-- The refund sweep previously selected a fixed ORDER BY order_id batch and
-- polled the provider sequentially inside ONE try/catch: the first row whose
-- provider query threw aborted the entire sweep, and because selection was
-- deterministic that same row was chosen again on every cron run. A
-- permanently failing low order id therefore starved every later refund
-- indefinitely, which can leave a paid license active after the money has
-- already been returned.
--
-- Recording attempts and a next_poll_at per row lets a failing refund back off
-- out of the eligible set so the rest of the queue drains.

-- next_poll_at is a ms epoch; 0 means "due now".
CREATE TABLE payment_refund_poll (
  order_id      INTEGER PRIMARY KEY,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_poll_at  INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_error_at INTEGER
);
CREATE INDEX idx_payment_refund_poll_due
  ON payment_refund_poll(next_poll_at);
