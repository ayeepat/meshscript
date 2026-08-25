-- 0003_operational_leases — make external delivery claims real leases and
-- prevent one permanently failing referral code from starving the recovery
-- queue. Tables are rebuilt because SQLite cannot conditionally ADD COLUMN;
-- the copied columns exist in every pre-0003 production shape.
--
-- IMPORTANT: this migration accepts ONLY the exact pre-0003 source shapes.
-- A database that was already created from the current schema.sql snapshot has
-- the new columns and must use scripts/adopt-current-schema.sql instead. The
-- guard deliberately aborts before any persistent DDL in every other case:
-- rebuilding an already-current table while selecting only old columns would
-- erase live claim leases, retry backoff, and reward generations.

-- D1 rejects CREATE TEMP TABLE. A normal helper table is safe here because
-- Wrangler applies each migration transactionally: failure rolls it back,
-- while the success path drops it before the migration ledger is committed.
-- Deliberately omit IF NOT EXISTS so an unexpected name collision fails closed.
CREATE TABLE _smesh_0003_source_guard (
  ok INTEGER NOT NULL
     CONSTRAINT smesh_0003_requires_prelease_shape CHECK (ok = 1)
);
INSERT INTO _smesh_0003_source_guard(ok)
SELECT CASE WHEN
  (
    SELECT group_concat(signature_part, '|')
    FROM (
      SELECT
        name || ':' || type || ':' || "notnull" || ':' ||
        COALESCE(dflt_value, '') || ':' || pk AS signature_part
      FROM pragma_table_xinfo('delivery_outbox')
      ORDER BY cid
    )
  ) =
    'license_key:TEXT:0::1|email:TEXT:0::0|telegram_user_id:INTEGER:0::0|is_preorder:INTEGER:1:0:0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|delivered_at:INTEGER:0::0'
  AND
  (
    SELECT group_concat(signature_part, '|')
    FROM (
      SELECT
        name || ':' || type || ':' || "notnull" || ':' ||
        COALESCE(dflt_value, '') || ':' || pk AS signature_part
      FROM pragma_table_xinfo('referral_credit_state')
      ORDER BY cid
    )
  ) =
    'license_key:TEXT:0::1|ref_code:TEXT:1::0|days:INTEGER:1::0|status:TEXT:1::0|created_at:INTEGER:1::0|applied_at:INTEGER:0::0|materialized_at:INTEGER:0::0|target_kind:TEXT:0::0|target_key:TEXT:0::0|target_expiry:TEXT:0::0'
  -- Prove the whole two-table source contract as well as visible columns.
  -- This rejects generated columns, extra CHECK/UNIQUE/FK/collation options,
  -- expression/partial indexes, and triggers that the rebuild would silently
  -- erase. The referral table has two legitimate stored spellings: the 0001
  -- baseline retains comments, while the older historical shape does not.
  AND (
    SELECT lower(
      replace(replace(replace(replace(replace(replace(replace(replace(
        sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
        '"', ''), '`', ''), '[', ''), ']', '')
    )
    FROM sqlite_master
    WHERE type = 'table' AND name = 'delivery_outbox'
  ) =
    'createtabledelivery_outbox(license_keytextprimarykey,emailtext,telegram_user_idinteger,is_preorderintegernotnulldefault0,created_atintegernotnull,attemptsintegernotnulldefault0,next_attempt_atintegernotnull,delivered_atinteger)'
  AND (
    SELECT lower(
      replace(replace(replace(replace(replace(replace(replace(replace(
        sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
        '"', ''), '`', ''), '[', ''), ']', '')
    )
    FROM sqlite_master
    WHERE type = 'table' AND name = 'referral_credit_state'
  ) IN (
    'createtablereferral_credit_state(license_keytextprimarykey,ref_codetextnotnull,daysintegernotnull,statustextnotnull,--pending|appliedcreated_atintegernotnull,applied_atinteger,materialized_atinteger,--setafterd1-derivedref:*kvrewritetarget_kindtext,--owner|rewardtarget_keytext,target_expirytext--fixedisoexpiryforreplay)',
    'createtablereferral_credit_state(license_keytextprimarykey,ref_codetextnotnull,daysintegernotnull,statustextnotnull,created_atintegernotnull,applied_atinteger,materialized_atinteger,target_kindtext,target_keytext,target_expirytext)'
  )
  AND (
    SELECT lower(
      replace(replace(replace(replace(replace(replace(replace(replace(
        sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
        '"', ''), '`', ''), '[', ''), ']', '')
    )
    FROM sqlite_master
    WHERE type = 'index' AND name = 'idx_delivery_outbox_due'
  ) =
    'createindexidx_delivery_outbox_dueondelivery_outbox(delivered_at,next_attempt_at)'
  AND NOT EXISTS (
    SELECT 1 FROM sqlite_master
    WHERE type IN ('index', 'trigger')
      AND tbl_name IN ('delivery_outbox', 'referral_credit_state')
      AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
      AND NOT (type = 'index' AND name = 'idx_delivery_outbox_due')
  )
  THEN 1 ELSE 0 END;

DROP TABLE IF EXISTS delivery_outbox_v3;
CREATE TABLE delivery_outbox_v3 (
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
INSERT INTO delivery_outbox_v3
  (license_key, email, telegram_user_id, is_preorder, created_at, attempts,
   next_attempt_at, delivered_at)
SELECT license_key, email, telegram_user_id, is_preorder, created_at, attempts,
       next_attempt_at, delivered_at
FROM delivery_outbox;
DROP TABLE delivery_outbox;
ALTER TABLE delivery_outbox_v3 RENAME TO delivery_outbox;
CREATE INDEX idx_delivery_outbox_due
  ON delivery_outbox(delivered_at, next_attempt_at, lease_until);

DROP TABLE IF EXISTS referral_credit_state_v3;
CREATE TABLE referral_credit_state_v3 (
  license_key TEXT    PRIMARY KEY,
  ref_code    TEXT    NOT NULL,
  days        INTEGER NOT NULL,
  status      TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  applied_at  INTEGER,
  materialized_at INTEGER,
  target_kind TEXT,
  target_key  TEXT,
  target_expiry TEXT,
  target_generation INTEGER NOT NULL DEFAULT 0,
  retry_attempts INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0,
  last_error_at INTEGER
);
INSERT INTO referral_credit_state_v3
  (license_key, ref_code, days, status, created_at, applied_at, materialized_at,
   target_kind, target_key, target_expiry)
SELECT license_key, ref_code, days, status, created_at, applied_at,
       materialized_at, target_kind, target_key, target_expiry
FROM referral_credit_state;
DROP TABLE referral_credit_state;
ALTER TABLE referral_credit_state_v3 RENAME TO referral_credit_state;
CREATE INDEX idx_referral_credit_retry
  ON referral_credit_state(status, materialized_at, retry_after, created_at);

DROP TABLE _smesh_0003_source_guard;
