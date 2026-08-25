-- 0009_telegram_ticket_binding — bind a minted support ticket to the Telegram
-- update that created it, so a redelivery cannot mint a second one.
--
-- 0008 made the webhook reject duplicates, but the ticket, the outbox row and
-- the user-facing messages were all created BEFORE completion was recorded. A
-- completion write that failed (or a worker that died in that window) left
-- completed_at NULL, and once the lease expired Telegram's own retry ran the
-- whole thing again: tickets 1001 AND 1002, two owner forwards, two
-- confirmations.
--
-- With the ticket number bound to update_id, a replay reuses the SAME ticket,
-- the outbox insert becomes a no-op, and the confirmation is skipped because
-- the ticket was not freshly minted by that delivery.

ALTER TABLE telegram_updates ADD COLUMN ticket_no TEXT;
