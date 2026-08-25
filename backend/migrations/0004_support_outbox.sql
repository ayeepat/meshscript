-- 0004_support_outbox — durable, exclusively claimed support forwarding.
-- Ticket text and sender profile data remain in expiring KV records. D1 keeps
-- only the ticket number and the temporary Telegram source route required to
-- copy an attachment; that route is nulled as soon as forwarding settles.

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
