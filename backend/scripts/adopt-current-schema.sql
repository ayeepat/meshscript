-- Adopt a LIVE D1 database that already has either the complete schema.sql
-- snapshot or its exact immediately preceding shape without the additive
-- runtime fence, but no
-- complete Wrangler migration ledger.
--
-- Run this only with:
--   wrangler d1 execute ... --remote --file=scripts/adopt-current-schema.sql
--
-- Remote FILE ingestion is atomic: Cloudflare restores the original database
-- if any statement fails. Never paste these statements one by one. The shape
-- and index guards run before the one ledger write. The optional additive
-- write-fence bootstrap below is in the same rollback boundary; the file
-- rejects an old, current-but-partial, or future/unknown database without
-- touching application rows.

-- Wrangler's own migration-table definition (Wrangler 4.x).
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Capture whether the durable fence already existed before this adoption.
-- The absent-table case is the legitimate pre-0005-fence bootstrap. An existing
-- fence table, however, must already contain its one valid authority row; do
-- not turn a partial/failed 0005 into an apparently successful adoption by
-- silently seeding that row below. This helper is part of the same atomic file
-- and is dropped on success.
CREATE TABLE _smesh_adoption_preflight (
  fence_table_preexisting INTEGER NOT NULL
    CHECK (fence_table_preexisting IN (0, 1)),
  fence_valid_rows_before_seed INTEGER NOT NULL
    CHECK (fence_valid_rows_before_seed IN (0, 1))
);
INSERT INTO _smesh_adoption_preflight
  (fence_table_preexisting, fence_valid_rows_before_seed)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM sqlite_master
  WHERE type = 'table' AND name = 'runtime_write_fence'
) THEN 1 ELSE 0 END, 0;

-- Bootstrap the additive 0005 control table when adopting the immediately
-- preceding current snapshot. This file is one atomic remote
-- ingestion: if any later exact-shape guard fails, both this table/seed and the
-- migration ledger roll back. A malformed pre-existing lookalike is not
-- repaired by IF NOT EXISTS and is rejected by the signatures/checks below.
CREATE TABLE IF NOT EXISTS runtime_write_fence (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  write_epoch    INTEGER NOT NULL CHECK (write_epoch >= 1),
  writes_enabled INTEGER NOT NULL DEFAULT 1 CHECK (writes_enabled IN (0, 1)),
  updated_at     INTEGER NOT NULL
);
UPDATE _smesh_adoption_preflight
SET fence_valid_rows_before_seed = (
  SELECT COUNT(*) FROM runtime_write_fence
  WHERE singleton = 1 AND write_epoch >= 1 AND writes_enabled IN (0, 1)
);
INSERT OR IGNORE INTO runtime_write_fence
  (singleton, write_epoch, writes_enabled, updated_at)
VALUES (1, 1, 1, unixepoch('subsec') * 1000);

-- Bootstrap the additive 0007 refund-poll state the same way. This table only
-- ever holds derived retry bookkeeping, so unlike the fence it needs no seed
-- row and an empty table is the correct adopted state. A malformed
-- pre-existing lookalike is not repaired by IF NOT EXISTS and is rejected by
-- the shape/DDL/index guards below.
CREATE TABLE IF NOT EXISTS payment_refund_poll (
  order_id      INTEGER PRIMARY KEY,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_poll_at  INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  last_error_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_payment_refund_poll_due
  ON payment_refund_poll(next_poll_at);


-- Bootstrapped at its FINAL 0009 shape, not 0008's. Both migrations are part of
-- the same unreleased batch, so no live database can be at 0008-without-0009;
-- the shape guard below rejects any that somehow is, rather than an
-- unconditional ALTER that would fail on an already-current database (SQLite
-- has no ADD COLUMN IF NOT EXISTS).
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

-- Additive 0010 single-device activation authority. An empty table is the
-- correct migration state: the earliest historical license_devices row claims
-- continuity lazily on that installation's first post-deploy verification.
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

-- Additive 0012 consent evidence. Receipts deliberately contain only
-- pseudonymous entitlement references, the four choices and timestamps.
CREATE TABLE IF NOT EXISTS consent_receipts (
  receipt_id      TEXT    PRIMARY KEY,
  license_ref     TEXT    NOT NULL,
  device_id       TEXT    NOT NULL,
  consent_version INTEGER NOT NULL,
  terms           INTEGER NOT NULL CHECK (terms IN (0, 1)),
  ai_processing   INTEGER NOT NULL CHECK (ai_processing IN (0, 1)),
  telemetry       INTEGER NOT NULL CHECK (telemetry IN (0, 1)),
  eligibility     INTEGER NOT NULL CHECK (eligibility IN (0, 1)),
  client_at       TEXT    NOT NULL,
  received_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_receipts_subject_time
  ON consent_receipts(license_ref, device_id, received_at DESC);

-- D1 rejects CREATE TEMP TABLE. These ordinary helper tables live only for
-- this atomic remote-file ingestion and are dropped on success; any failure
-- restores the pre-ingestion database. Omit IF NOT EXISTS so a name collision
-- fails closed instead of trusting attacker- or operator-created helper data.
CREATE TABLE _smesh_expected_current_shape (
  table_name TEXT PRIMARY KEY,
  signature  TEXT NOT NULL
);

-- Column PRAGMAs alone cannot see table CHECK clauses, collations, generated
-- expressions, table-level UNIQUE constraints, STRICT/WITHOUT ROWID options,
-- or foreign keys. Keep an allowlist of the complete canonical CREATE TABLE
-- text as a second, independent proof. Wrangler/D1 file ingestion removes SQL
-- comments before preparing statements, while direct SQLite snapshot loading
-- retains them; rebuild migrations also store comment-free CREATE statements.
-- Both known products are listed exactly rather than weakening this to token or
-- substring checks.
CREATE TABLE _smesh_expected_current_ddl (
  table_name TEXT NOT NULL,
  ddl_signature TEXT NOT NULL,
  PRIMARY KEY (table_name, ddl_signature)
);

-- Signature = columns in cid order as name:type:notnull:default:pk.
INSERT INTO _smesh_expected_current_shape(table_name, signature) VALUES
  ('counters',
   'name:TEXT:0::1|value:INTEGER:1::0'),
  ('consent_receipts',
   'receipt_id:TEXT:0::1|license_ref:TEXT:1::0|device_id:TEXT:1::0|consent_version:INTEGER:1::0|terms:INTEGER:1::0|ai_processing:INTEGER:1::0|telemetry:INTEGER:1::0|eligibility:INTEGER:1::0|client_at:TEXT:1::0|received_at:INTEGER:1::0'),
  ('d1_migrations',
   'id:INTEGER:0::1|name:TEXT:0::0|applied_at:TIMESTAMP:1:CURRENT_TIMESTAMP:0'),
  ('delivery_outbox',
   'license_key:TEXT:0::1|email:TEXT:0::0|telegram_user_id:INTEGER:0::0|is_preorder:INTEGER:1:0:0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|claim_token:TEXT:0::0|lease_until:INTEGER:0::0|delivered_at:INTEGER:0::0'),
  ('device_tombstones',
   'device_id:TEXT:0::1|deleted_at:INTEGER:1::0'),
  ('devices',
   'device_id:TEXT:0::1|first_seen:INTEGER:1::0|last_seen:INTEGER:1::0|browser:TEXT:0::0|ua:TEXT:0::0|version:TEXT:0::0|provider:TEXT:0::0|license_key:TEXT:0::0|license_ref:TEXT:0::0|license_type:TEXT:0::0'),
  ('events',
   'id:INTEGER:0::1|ts:INTEGER:1::0|day:TEXT:1::0|device_id:TEXT:1::0|type:TEXT:1::0|subject:TEXT:0::0|provider:TEXT:0::0|model:TEXT:0::0|tokens_in:INTEGER:1:0:0|tokens_out:INTEGER:1:0:0|cost_usd:REAL:1:0:0|files_pdf:INTEGER:1:0:0|files_img:INTEGER:1:0:0|meta:TEXT:0::0'),
  ('kv_apply_locks',
   'name:TEXT:0::1|lease_until:INTEGER:1::0'),
  ('kv_materializations',
   'name:TEXT:0::1|materialized_at:INTEGER:1::0'),
  ('license_activations',
   'license_key:TEXT:0::1|status:TEXT:1::0|device_id:TEXT:0::0|token_hash:TEXT:0::0|generation:INTEGER:1:1:0|activated_at:INTEGER:0::0|last_seen_at:INTEGER:0::0|deactivated_at:INTEGER:0::0'),
  ('license_devices',
   'license_key:TEXT:1::1|device_id:TEXT:1::2|added_at:INTEGER:1::0'),
  ('license_release_fence',
   'license_key:TEXT:0::1|device_id:TEXT:1::0|released_at:INTEGER:1::0|released_by:TEXT:0::0'),
  ('license_revocations',
   'license_key:TEXT:0::1|revoked_at:INTEGER:1::0|reason:TEXT:0::0'),
  ('license_telegram_links',
   'license_key:TEXT:0::1|telegram_user_id:TEXT:1::0|linked_at:INTEGER:1::0'),
  ('payment_issuance',
   'gateway:TEXT:1::1|payment_id:TEXT:1::2|license_key:TEXT:1::0|license_json:TEXT:1::0|created_at:INTEGER:1::0'),
  ('payment_events',
   'id:INTEGER:0::1|gateway:TEXT:1::0|payment_id:TEXT:1::0|order_id:INTEGER:0::0|environment:TEXT:0::0|event_type:TEXT:1::0|amount_kopecks:INTEGER:0::0|currency:TEXT:0::0|details_json:TEXT:0::0|created_at:INTEGER:1::0'),
  ('payment_orders',
   'order_id:INTEGER:0::1|gateway:TEXT:1::0|environment:TEXT:1::0|status:TEXT:1::0|amount_kopecks:INTEGER:1::0|currency:TEXT:1::0|plan_type:TEXT:1::0|subscription_days:INTEGER:0::0|email:TEXT:0::0|telegram_user_id:TEXT:0::0|referral_code:TEXT:0::0|device_id:TEXT:0::0|is_preorder:INTEGER:1:0:0|fiscalization_mode:TEXT:1::0|receipt_json:TEXT:0::0|created_at:INTEGER:1::0|expires_at:INTEGER:1::0|paid_at:INTEGER:0::0|fulfilled_at:INTEGER:0::0|provider_op_key:TEXT:0::0|reconciled_at:INTEGER:0::0|refund_request_id:TEXT:0::0|refund_status:TEXT:0::0|refund_kopecks:INTEGER:0::0|refunded_at:INTEGER:0::0'),
  ('payment_refund_poll',
   'order_id:INTEGER:0::1|attempts:INTEGER:1:0:0|next_poll_at:INTEGER:1:0:0|last_error:TEXT:0::0|last_error_at:INTEGER:0::0'),
  ('payment_review',
   'gateway:TEXT:1::1|payment_id:TEXT:1::2|invoice_id:TEXT:0::0|amount_rub:REAL:0::0|reason:TEXT:1::0|fields_json:TEXT:0::0|created_at:INTEGER:1::0|resolved_at:INTEGER:0::0|environment:TEXT:0::0|amount_kopecks:INTEGER:0::0|resolution:TEXT:0::0|resolution_note:TEXT:0::0'),
  ('proxy_quota',
   'day:TEXT:1::1|license_key:TEXT:1::2|provider:TEXT:1::3|count:INTEGER:1:0:0'),
  ('purchases',
   'license_key:TEXT:0::1|gateway:TEXT:0::0|payment_id:TEXT:0::0|type:TEXT:0::0|status:TEXT:0::0|amount_rub:REAL:0::0|email:TEXT:0::0|telegram_user_id:TEXT:0::0|issued_at:INTEGER:0::0|expires_at:INTEGER:0::0|is_preorder:INTEGER:0:0:0|note:TEXT:0::0|device_ids:TEXT:0::0|amount_kopecks:INTEGER:0::0'),
  ('referral_apply_locks',
   'ref_code:TEXT:0::1|lease_until:INTEGER:1::0'),
  ('referral_auth_claims',
   'auth_hash:TEXT:0::1|code:TEXT:1::0|created_at:INTEGER:1::0'),
  ('referral_credit_state',
   'license_key:TEXT:0::1|ref_code:TEXT:1::0|days:INTEGER:1::0|status:TEXT:1::0|created_at:INTEGER:1::0|applied_at:INTEGER:0::0|materialized_at:INTEGER:0::0|target_kind:TEXT:0::0|target_key:TEXT:0::0|target_expiry:TEXT:0::0|target_generation:INTEGER:1:0:0|retry_attempts:INTEGER:1:0:0|retry_after:INTEGER:1:0:0|last_error_at:INTEGER:0::0'),
  ('referral_credits',
   'license_key:TEXT:0::1|ref_code:TEXT:1::0|claimed_at:INTEGER:1::0'),
  ('runtime_write_fence',
   'singleton:INTEGER:0::1|write_epoch:INTEGER:1::0|writes_enabled:INTEGER:1:1:0|updated_at:INTEGER:1::0'),
  ('subscription_notifications',
   'id:INTEGER:0::1|license_key:TEXT:1::0|stage:TEXT:1::0|telegram_user_id:TEXT:1::0|due_at:INTEGER:1::0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|claim_token:TEXT:0::0|lease_until:INTEGER:0::0|sent_at:INTEGER:0::0|cancelled_at:INTEGER:0::0|answer_code:TEXT:0::0|answered_at:INTEGER:0::0'),
  ('support_forward_outbox',
   'ticket_no:TEXT:0::1|source_chat_id:TEXT:0::0|source_message_id:INTEGER:0::0|has_attachment:INTEGER:1:0:0|created_at:INTEGER:1::0|attempts:INTEGER:1:0:0|next_attempt_at:INTEGER:1::0|claim_token:TEXT:0::0|lease_until:INTEGER:0::0|text_forwarded_at:INTEGER:0::0|attachment_forwarded_at:INTEGER:0::0|forwarded_at:INTEGER:0::0'),
  ('telegram_updates',
   'update_id:INTEGER:0::1|claimed_at:INTEGER:1::0|lease_until:INTEGER:1::0|completed_at:INTEGER:0::0|result_kind:TEXT:0::0|ticket_no:TEXT:0::0'),
  ('telemetry_budget',
   'day:TEXT:1::1|scope:TEXT:1::2|budget_key:TEXT:1::3|count:INTEGER:1:0:0');

-- Canonicalization below lowercases and removes identifier quotes and ASCII
-- whitespace, but deliberately retains comments. A comment can therefore
-- never forge a missing constraint: the complete stored DDL must equal one of
-- these known snapshot/migration products, not merely contain a keyword.
INSERT INTO _smesh_expected_current_ddl(table_name, ddl_signature) VALUES
  ('consent_receipts', 'createtableconsent_receipts(receipt_idtextprimarykey,license_reftextnotnull,device_idtextnotnull,consent_versionintegernotnull,termsintegernotnullcheck(termsin(0,1)),ai_processingintegernotnullcheck(ai_processingin(0,1)),telemetryintegernotnullcheck(telemetryin(0,1)),eligibilityintegernotnullcheck(eligibilityin(0,1)),client_attextnotnull,received_atintegernotnull)'),
  ('counters', 'createtablecounters(nametextprimarykey,valueintegernotnull)'),
  ('d1_migrations', 'createtabled1_migrations(idintegerprimarykeyautoincrement,nametextunique,applied_attimestampdefaultcurrent_timestampnotnull)'),
  ('delivery_outbox', 'createtabledelivery_outbox(license_keytextprimarykey,emailtext,telegram_user_idinteger,is_preorderintegernotnulldefault0,created_atintegernotnull,attemptsintegernotnulldefault0,next_attempt_atintegernotnull,claim_tokentext,lease_untilinteger,delivered_atinteger)'),
  ('device_tombstones', 'createtabledevice_tombstones(device_idtextprimarykey,deleted_atintegernotnull--msepoch)'),
  ('device_tombstones', 'createtabledevice_tombstones(device_idtextprimarykey,deleted_atintegernotnull)'),
  ('devices', 'createtabledevices(device_idtextprimarykey,first_seenintegernotnull,--msepochlast_seenintegernotnull,--msepochbrowsertext,--chrome|yandex|opera|edge|firefox|otheruatext,--legacy,alwaysnullnow(rawuaisnotstored)versiontext,--extensionversionprovidertext,--lastselectedaiproviderlicense_keytext,--legacy,alwaysnullnowlicense_reftext,--legacypseudonym,nolongerwrittenlicense_typetext--lifetime|subscription|none)'),
  ('devices', 'createtabledevices(device_idtextprimarykey,first_seenintegernotnull,last_seenintegernotnull,browsertext,uatext,versiontext,providertext,license_keytext,license_reftext,license_typetext)'),
  ('events', 'createtableevents(idintegerprimarykeyautoincrement,tsintegernotnull,--msepoch(client,server-clamped)daytextnotnull,--yyyy-mm-dd,moscowtimedevice_idtextnotnull,typetextnotnull,--install|update|heartbeat|solve|test_solve|test_requestion|gdz_pull|errorsubjecttext,--meshsubjectname(solves/gdz)providertext,--openrouter|groq|qwen|deepseekmodeltext,--exactmodelidtheproviderreportedtokens_inintegernotnulldefault0,tokens_outintegernotnulldefault0,cost_usdrealnotnulldefault0,--exactprovidercostwhenreported,elseestimatefiles_pdfintegernotnulldefault0,--pdfattachmentsonthissolvefiles_imgintegernotnulldefault0,--imageattachments(photos/screenshots)metatext--fixed-vocabulary,typedmetricsonly(seeanalytics.js))'),
  ('events', 'createtableevents(idintegerprimarykeyautoincrement,tsintegernotnull,daytextnotnull,device_idtextnotnull,typetextnotnull,subjecttext,providertext,modeltext,tokens_inintegernotnulldefault0,tokens_outintegernotnulldefault0,cost_usdrealnotnulldefault0,files_pdfintegernotnulldefault0,files_imgintegernotnulldefault0,metatext)'),
  ('kv_apply_locks', 'createtablekv_apply_locks(nametextprimarykey,lease_untilintegernotnull)'),
  ('kv_materializations', 'createtablekv_materializations(nametextprimarykey,materialized_atintegernotnull)'),
  ('license_activations', 'createtablelicense_activations(license_keytextprimarykey,statustextnotnullcheck(statusin(''active'',''inactive'')),device_idtext,token_hashtext,generationintegernotnulldefault1check(generation>=1),activated_atinteger,last_seen_atinteger,deactivated_atinteger,check((status=''active''anddevice_idisnotnullandtoken_hashisnotnullandactivated_atisnotnullandlast_seen_atisnotnull)or(status=''inactive''anddevice_idisnullandtoken_hashisnull)))'),
  ('license_devices', 'createtablelicense_devices(license_keytextnotnull,device_idtextnotnull,added_atintegernotnull,--msepochprimarykey(license_key,device_id))'),
  ('license_devices', 'createtablelicense_devices(license_keytextnotnull,device_idtextnotnull,added_atintegernotnull,primarykey(license_key,device_id))'),
  ('license_release_fence', 'createtablelicense_release_fence(license_keytextprimarykey,device_idtextnotnull,released_atintegernotnull,released_bytext)'),
  ('license_revocations', 'createtablelicense_revocations(license_keytextprimarykey,revoked_atintegernotnull,--msepochreasontext)'),
  ('license_revocations', 'createtablelicense_revocations(license_keytextprimarykey,revoked_atintegernotnull,reasontext)'),
  ('license_telegram_links', 'createtablelicense_telegram_links(license_keytextprimarykey,telegram_user_idtextnotnull,linked_atintegernotnull)'),
  ('payment_issuance', 'createtablepayment_issuance(gatewaytextnotnull,payment_idtextnotnull,license_keytextnotnullunique,license_jsontextnotnull,created_atintegernotnull,primarykey(gateway,payment_id))'),
  ('payment_events', 'createtablepayment_events(idintegerprimarykeyautoincrement,gatewaytextnotnull,payment_idtextnotnull,order_idinteger,environmenttext,event_typetextnotnull,amount_kopecksinteger,currencytext,details_jsontext,created_atintegernotnull)'),
  ('payment_orders', 'createtablepayment_orders(order_idintegerprimarykeyautoincrement,gatewaytextnotnullcheck(gateway=''robokassa''),environmenttextnotnullcheck(environmentin(''production'',''test'')),statustextnotnullcheck(statusin(''pending'',''paid'',''fulfilled'',''review'',''refund_pending'',''refunded'',''expired'')),amount_kopecksintegernotnullcheck(amount_kopecks>0),currencytextnotnullcheck(currency=''rub''),plan_typetextnotnullcheck(plan_typein(''lifetime'',''subscription'')),subscription_daysintegercheck(subscription_daysisnullorsubscription_daysbetween1and3650),emailtext,telegram_user_idtext,referral_codetext,device_idtext,is_preorderintegernotnulldefault0check(is_preorderin(0,1)),fiscalization_modetextnotnullcheck(fiscalization_modein(''provider'',''external'')),receipt_jsontext,created_atintegernotnull,expires_atintegernotnull,paid_atinteger,fulfilled_atinteger,provider_op_keytext,reconciled_atinteger,refund_request_idtext,refund_statustext,refund_kopecksintegercheck(refund_kopecksisnullorrefund_kopecks>0),refunded_atinteger,check((fiscalization_mode=''provider''andreceipt_jsonisnotnull)or(fiscalization_mode=''external''andreceipt_jsonisnull)))'),
  ('payment_refund_poll', 'createtablepayment_refund_poll(order_idintegerprimarykey,attemptsintegernotnulldefault0check(attempts>=0),next_poll_atintegernotnulldefault0,last_errortext,last_error_atinteger)'),
  ('payment_review', 'createtablepayment_review(gatewaytextnotnull,payment_idtextnotnull,invoice_idtext,amount_rubreal,reasontextnotnull,--invalid_plan_config|no_floor_configured|below_floor|no_contact|no_plan_matchedfields_jsontext,created_atintegernotnull,--msepochresolved_atinteger,environmenttext,amount_kopecksinteger,resolutiontext,resolution_notetext,primarykey(gateway,payment_id))'),
  ('payment_review', 'createtablepayment_review(gatewaytextnotnull,payment_idtextnotnull,invoice_idtext,amount_rubreal,reasontextnotnull,fields_jsontext,created_atintegernotnull,resolved_atinteger,environmenttext,amount_kopecksinteger,resolutiontext,resolution_notetext,primarykey(gateway,payment_id))'),
  ('proxy_quota', 'createtableproxy_quota(daytextnotnull,--yyyy-mm-dd,moscowtimelicense_keytextnotnull,--normalizedkey,or''*''forglobalprovidertextnotnull,--qwen|deepseek|''all''(globalrow)countintegernotnulldefault0,primarykey(day,license_key,provider))'),
  ('proxy_quota', 'createtableproxy_quota(daytextnotnull,license_keytextnotnull,providertextnotnull,countintegernotnulldefault0,primarykey(day,license_key,provider))'),
  ('purchases', 'createtablepurchases(license_keytextprimarykey,gatewaytext,--robokassa|manual|referral|...payment_idtext,typetext,--lifetime|subscriptionstatustext,--active|revokedamount_rubreal,--nullforcomp/referralkeysemailtext,telegram_user_idtext,issued_atinteger,--msepochexpires_atinteger,--msepoch,null=lifetimeis_preorderintegerdefault0,notetext,device_idstext,--jsonarrayofactivateddeviceidsamount_kopecksinteger--authoritativeminorunitsformoney)'),
  ('purchases', 'createtablepurchases(license_keytextprimarykey,gatewaytext,--robokassa|manual|referral|...payment_idtext,typetext,--lifetime|subscriptionstatustext,--active|revokedamount_rubreal,--nullforcomp/referralkeysemailtext,telegram_user_idtext,issued_atinteger,--msepochexpires_atinteger,--msepoch,null=lifetimeis_preorderintegerdefault0,notetext,device_idstext--jsonarrayofactivateddeviceids,amount_kopecksinteger)'),
  ('purchases', 'createtablepurchases(license_keytextprimarykey,gatewaytext,payment_idtext,typetext,statustext,amount_rubreal,emailtext,telegram_user_idtext,issued_atinteger,expires_atinteger,is_preorderintegerdefault0,notetext,device_idstext,amount_kopecksinteger)'),
  ('referral_apply_locks', 'createtablereferral_apply_locks(ref_codetextprimarykey,lease_untilintegernotnull)'),
  ('referral_auth_claims', 'createtablereferral_auth_claims(auth_hashtextprimarykey,codetextnotnull,created_atintegernotnull)'),
  ('referral_credit_state', 'createtablereferral_credit_state(license_keytextprimarykey,ref_codetextnotnull,daysintegernotnull,statustextnotnull,--pending|appliedcreated_atintegernotnull,applied_atinteger,materialized_atinteger,--setafterd1-derivedref:*kvrewritetarget_kindtext,--owner|rewardtarget_keytext,target_expirytext,--fixedisoexpiryforreplaytarget_generationintegernotnulldefault0,retry_attemptsintegernotnulldefault0,retry_afterintegernotnulldefault0,--msepoch;failedcodesbackofflast_error_atinteger)'),
  ('referral_credit_state', 'createtablereferral_credit_state(license_keytextprimarykey,ref_codetextnotnull,daysintegernotnull,statustextnotnull,created_atintegernotnull,applied_atinteger,materialized_atinteger,target_kindtext,target_keytext,target_expirytext,target_generationintegernotnulldefault0,retry_attemptsintegernotnulldefault0,retry_afterintegernotnulldefault0,last_error_atinteger)'),
  ('referral_credits', 'createtablereferral_credits(license_keytextprimarykey,ref_codetextnotnull,claimed_atintegernotnull)'),
  ('runtime_write_fence', 'createtableruntime_write_fence(singletonintegerprimarykeycheck(singleton=1),write_epochintegernotnullcheck(write_epoch>=1),writes_enabledintegernotnulldefault1check(writes_enabledin(0,1)),updated_atintegernotnull)'),
  ('subscription_notifications', 'createtablesubscription_notifications(idintegerprimarykeyautoincrement,license_keytextnotnull,stagetextnotnullcheck(stagein(''expiry_3d'',''expiry_1d'',''expired'',''winback'')),telegram_user_idtextnotnull,due_atintegernotnull,created_atintegernotnull,attemptsintegernotnulldefault0check(attempts>=0),next_attempt_atintegernotnull,claim_tokentext,lease_untilinteger,sent_atinteger,cancelled_atinteger,answer_codetext,answered_atinteger,unique(license_key,stage))'),
  ('support_forward_outbox', 'createtablesupport_forward_outbox(ticket_notextprimarykey,source_chat_idtext,source_message_idinteger,has_attachmentintegernotnulldefault0check(has_attachmentin(0,1)),created_atintegernotnull,attemptsintegernotnulldefault0check(attempts>=0),next_attempt_atintegernotnull,claim_tokentext,lease_untilinteger,text_forwarded_atinteger,attachment_forwarded_atinteger,forwarded_atinteger,check(has_attachment=0orforwarded_atisnotnullor(source_chat_idisnotnullandsource_message_idisnotnull)))'),
  ('telegram_updates', 'createtabletelegram_updates(update_idintegerprimarykey,claimed_atintegernotnull,lease_untilintegernotnull,completed_atinteger,result_kindtext,ticket_notext)'),
  ('telemetry_budget', 'createtabletelemetry_budget(daytextnotnull,scopetextnotnull,--ip|device|admin_fail|verify_failbudget_keytextnotnull,countintegernotnulldefault0,primarykey(day,scope,budget_key))'),
  ('telemetry_budget', 'createtabletelemetry_budget(daytextnotnull,scopetextnotnull,budget_keytextnotnull,countintegernotnulldefault0,primarykey(day,scope,budget_key))');

CREATE TABLE _smesh_expected_current_indexes (
  index_name  TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  is_unique   INTEGER NOT NULL,
  origin_kind TEXT NOT NULL,
  is_partial  INTEGER NOT NULL,
  columns_sig TEXT NOT NULL,
  ddl_signature TEXT NOT NULL
);
INSERT INTO _smesh_expected_current_indexes
  (index_name, table_name, is_unique, origin_kind, is_partial, columns_sig,
   ddl_signature) VALUES
  ('idx_consent_receipts_subject_time', 'consent_receipts', 0, 'c', 0,
   'license_ref|device_id|received_at',
   'createindexidx_consent_receipts_subject_timeonconsent_receipts(license_ref,device_id,received_atdesc)'),
  ('idx_license_activations_device', 'license_activations', 0, 'c', 1,
   'device_id',
   'createindexidx_license_activations_deviceonlicense_activations(device_id)wherestatus=''active'''),
  ('idx_delivery_outbox_due', 'delivery_outbox', 0, 'c', 0,
   'delivered_at|next_attempt_at|lease_until',
   'createindexidx_delivery_outbox_dueondelivery_outbox(delivered_at,next_attempt_at,lease_until)'),
  ('idx_events_day', 'events', 0, 'c', 0, 'day',
   'createindexidx_events_dayonevents(day)'),
  ('idx_events_device', 'events', 0, 'c', 0, 'device_id|day',
   'createindexidx_events_deviceonevents(device_id,day)'),
  ('idx_events_type', 'events', 0, 'c', 0, 'type|day',
   'createindexidx_events_typeonevents(type,day)'),
  ('idx_license_devices_device', 'license_devices', 0, 'c', 0, 'device_id',
   'createindexidx_license_devices_deviceonlicense_devices(device_id)'),
  ('idx_payment_events_payment', 'payment_events', 0, 'c', 0,
   'gateway|payment_id|created_at',
   'createindexidx_payment_events_paymentonpayment_events(gateway,payment_id,created_at)'),
  ('idx_payment_orders_status', 'payment_orders', 0, 'c', 0,
   'environment|status|created_at',
   'createindexidx_payment_orders_statusonpayment_orders(environment,status,created_at)'),
  ('idx_payment_refund_poll_due', 'payment_refund_poll', 0, 'c', 0, 'next_poll_at',
   'createindexidx_payment_refund_poll_dueonpayment_refund_poll(next_poll_at)'),
  ('idx_purchases_issued', 'purchases', 0, 'c', 0, 'issued_at',
   'createindexidx_purchases_issuedonpurchases(issued_at)'),
  ('idx_purchases_telegram', 'purchases', 0, 'c', 0, 'telegram_user_id',
   'createindexidx_purchases_telegramonpurchases(telegram_user_id)'),
  ('idx_license_telegram_links_user', 'license_telegram_links', 0, 'c', 0,
   'telegram_user_id',
   'createindexidx_license_telegram_links_useronlicense_telegram_links(telegram_user_id)'),
  ('idx_subscription_notifications_due', 'subscription_notifications', 0, 'c', 0,
   'sent_at|cancelled_at|next_attempt_at|lease_until',
   'createindexidx_subscription_notifications_dueonsubscription_notifications(sent_at,cancelled_at,next_attempt_at,lease_until)'),
  ('idx_referral_auth_claims_code', 'referral_auth_claims', 1, 'c', 0, 'code',
   'createuniqueindexidx_referral_auth_claims_codeonreferral_auth_claims(code)'),
  ('idx_referral_credit_retry', 'referral_credit_state', 0, 'c', 0,
   'status|materialized_at|retry_after|created_at',
   'createindexidx_referral_credit_retryonreferral_credit_state(status,materialized_at,retry_after,created_at)'),
  ('idx_support_forward_outbox_due', 'support_forward_outbox', 0, 'c', 0,
   'forwarded_at|next_attempt_at|lease_until',
   'createindexidx_support_forward_outbox_dueonsupport_forward_outbox(forwarded_at,next_attempt_at,lease_until)'),
  ('idx_telegram_updates_claimed', 'telegram_updates', 0, 'c', 0, 'claimed_at',
   'createindexidx_telegram_updates_claimedontelegram_updates(claimed_at)');

-- The known migration ledger, in order. This lives in a table rather than in
-- inline SQL because workerd's SQLite caps a compound SELECT at five terms:
-- the previous `UNION ALL` dependency chain was already at that ceiling and
-- could not accept another migration. A keyed table also removes the three
-- hand-maintained copies of this list that had to stay in sync.
CREATE TABLE _smesh_expected_migration_order (
  name     TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE
);
INSERT INTO _smesh_expected_migration_order(name, position) VALUES
  ('0001_baseline.sql', 1),
  ('0002_referral_code_unique.sql', 2),
  ('0003_operational_leases.sql', 3),
  ('0004_support_outbox.sql', 4),
  ('0005_runtime_write_fence.sql', 5),
  ('0006_payment_authority.sql', 6),
  ('0007_refund_poll_isolation.sql', 7),
  ('0008_telegram_update_idempotency.sql', 8),
  ('0009_telegram_ticket_binding.sql', 9),
  ('0010_single_device_activation.sql', 10),
  ('0011_subscription_lifecycle.sql', 11),
  ('0012_consent_receipts.sql', 12);

CREATE TABLE _smesh_adoption_guard (
  ok INTEGER NOT NULL
     CONSTRAINT smesh_adoption_requires_exact_current_schema CHECK (ok = 1)
);
INSERT INTO _smesh_adoption_guard(ok)
SELECT CASE WHEN
  -- No unknown application tables, views, or triggers: any of them can be
  -- evidence that this database belongs to a newer or hand-modified schema
  -- (and a trigger can actively change writes). The only known D1-owned tables
  -- are the exact `_cf_KV` and pinned-runtime `_cf_METADATA` shapes; an
  -- arbitrary `_cf_*` prefix is not a trust boundary. SQLite's own `sqlite_*`
  -- objects remain internal.
  NOT EXISTS (
    SELECT 1
    FROM sqlite_master
    WHERE type IN ('table', 'view', 'trigger')
      AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
      AND (
        type <> 'table'
        OR (
          name NOT IN (
            SELECT table_name FROM _smesh_expected_current_shape
          )
          AND name NOT IN (
            '_smesh_expected_current_shape',
            '_smesh_expected_current_ddl',
            '_smesh_expected_current_indexes',
            '_smesh_expected_migration_order',
            '_smesh_adoption_preflight',
            '_smesh_adoption_guard',
            '_smesh_adoption_result_guard'
          )
          AND name NOT IN ('_cf_KV', '_cf_METADATA')
        )
      )
  )
  -- If D1's optional internal KV table exists, accept only its documented
  -- WITHOUT ROWID definition. A user-created lookalike must not gain trust by
  -- choosing the platform prefix.
  AND NOT EXISTS (
    SELECT 1
    FROM sqlite_master
    WHERE name = '_cf_KV'
      AND (
        type <> 'table'
        OR lower(
          replace(replace(replace(replace(replace(replace(replace(replace(
            sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
            '"', ''), '`', ''), '[', ''), ']', '')
        ) <> 'createtable_cf_kv(keytextprimarykey,valueblob)withoutrowid'
      )
  )
  -- Wrangler 4.114.0's local D1 runtime owns this metadata table. Accept only
  -- its exact persisted shape, just as for the remote platform KV table.
  AND NOT EXISTS (
    SELECT 1
    FROM sqlite_master
    WHERE name = '_cf_METADATA'
      AND (
        type <> 'table'
        OR lower(
          replace(replace(replace(replace(replace(replace(replace(replace(
            sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
            '"', ''), '`', ''), '[', ''), ']', '')
        ) <> 'createtable_cf_metadata(keyintegerprimarykey,valueblob)'
      )
  )
  -- Every current table has the exact ordered column/type/default/PK shape.
  AND NOT EXISTS (
    SELECT 1
    FROM _smesh_expected_current_shape AS expected
    WHERE expected.signature <> COALESCE((
      SELECT group_concat(signature_part, '|')
      FROM (
        SELECT
          name || ':' || type || ':' || "notnull" || ':' ||
          COALESCE(dflt_value, '') || ':' || pk AS signature_part
        FROM pragma_table_xinfo(expected.table_name)
        ORDER BY cid
      )
    ), '')
  )
  -- Generated/hidden columns can be omitted by pragma_table_info and can alter
  -- write semantics without changing the visible column list.
  AND NOT EXISTS (
    SELECT 1
    FROM _smesh_expected_current_shape AS expected,
         pragma_table_xinfo(expected.table_name) AS column_info
    WHERE COALESCE(column_info.hidden, 0) <> 0
  )
  -- Prove the complete CREATE TABLE statements, not just their columns. This
  -- closes table-level UNIQUE/CHECK/FK, generated-column, collation, STRICT,
  -- and WITHOUT ROWID lookalikes.
  AND NOT EXISTS (
    SELECT 1
    FROM _smesh_expected_current_shape AS expected
    WHERE NOT EXISTS (
      SELECT 1
      FROM _smesh_expected_current_ddl AS allowed
      WHERE allowed.table_name = expected.table_name
        AND allowed.ddl_signature = COALESCE((
          SELECT lower(
            replace(replace(replace(replace(replace(replace(replace(replace(
              sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
              '"', ''), '`', ''), '[', ''), ']', '')
          )
          FROM sqlite_master
          WHERE type = 'table' AND name = expected.table_name
        ), '')
    )
  )
  -- The explicit named-index set is exact. Extra UNIQUE/partial indexes can
  -- silently change accepted application writes, so they are not benign
  -- operator metadata and must fail adoption just like an unknown table.
  AND NOT EXISTS (
    SELECT 1
    FROM sqlite_master
    WHERE type = 'index'
      AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
      AND name NOT IN (
        SELECT index_name FROM _smesh_expected_current_indexes
      )
  )
  -- Every expected named index has exact uniqueness, origin, partialness and
  -- ordered columns. `partial=0` is security-relevant for referral codes.
  AND NOT EXISTS (
    SELECT 1
    FROM _smesh_expected_current_indexes AS expected
    WHERE COALESCE((
      SELECT "unique"
      FROM pragma_index_list(expected.table_name)
      WHERE name = expected.index_name
    ), -1) <> expected.is_unique
    OR COALESCE((
      SELECT origin
      FROM pragma_index_list(expected.table_name)
      WHERE name = expected.index_name
    ), '') <> expected.origin_kind
    OR COALESCE((
      SELECT partial
      FROM pragma_index_list(expected.table_name)
      WHERE name = expected.index_name
    ), -1) <> expected.is_partial
    OR expected.columns_sig <> COALESCE((
      SELECT group_concat(name, '|')
      FROM (
        SELECT name
        FROM pragma_index_info(expected.index_name)
        ORDER BY seqno
      )
    ), '')
    OR expected.ddl_signature <> COALESCE((
      SELECT lower(
        replace(replace(replace(replace(replace(replace(replace(replace(
          sql, char(9), ''), char(10), ''), char(13), ''), ' ', ''),
          '"', ''), '`', ''), '[', ''), ']', '')
      )
      FROM sqlite_master
      WHERE type = 'index' AND name = expected.index_name
    ), '')
  )
  -- Wrangler's ledger itself must retain its UNIQUE(name) invariant.
  AND EXISTS (
    SELECT 1
    FROM pragma_index_list('d1_migrations') AS ledger_index
    WHERE ledger_index."unique" = 1 AND ledger_index.origin = 'u'
      AND (
        SELECT group_concat(name, '|')
        FROM (
          SELECT name FROM pragma_index_info(ledger_index.name)
          ORDER BY seqno
        )
      ) = 'name'
  )
  -- Column signatures do not expose table-level UNIQUE constraints. Payment
  -- recovery relies on this one to prevent two gateway claims choosing the
  -- same license key, so verify the implicit unique index explicitly.
  AND EXISTS (
    SELECT 1
    FROM pragma_index_list('payment_issuance') AS issuance_index
    WHERE issuance_index."unique" = 1 AND issuance_index.origin = 'u'
      AND (
        SELECT group_concat(name, '|')
        FROM (
          SELECT name FROM pragma_index_info(issuance_index.name)
          ORDER BY seqno
        )
      ) = 'license_key'
  )
  -- The canonical table DDL above proves every table-level CHECK. Validate the
  -- live singleton row too: valid structure with a missing/duplicate control
  -- row is still not a safe database to bless.
  AND (
    SELECT COUNT(*) FROM runtime_write_fence
    WHERE singleton = 1 AND write_epoch >= 1 AND writes_enabled IN (0, 1)
  ) = 1
  -- An absent fence is the intended pre-0005 bootstrap, provided the old
  -- ledger did not already claim 0005. If the table existed before adoption,
  -- its authority row must also have existed before the seed above.
  AND EXISTS (
    SELECT 1 FROM _smesh_adoption_preflight AS preflight
    WHERE (
      preflight.fence_table_preexisting = 0
      AND preflight.fence_valid_rows_before_seed = 0
      AND NOT EXISTS (
        SELECT 1 FROM d1_migrations
        WHERE name = '0005_runtime_write_fence.sql'
      )
    ) OR (
      preflight.fence_table_preexisting = 1
      AND preflight.fence_valid_rows_before_seed = 1
    )
  )
  -- Never overwrite or bless an unknown/future migration history.
  AND NOT EXISTS (
    SELECT 1 FROM d1_migrations
    WHERE name IS NULL
       OR name NOT IN (SELECT name FROM _smesh_expected_migration_order)
  )
  -- Wrangler records migrations in order. Accept only a contiguous known
  -- prefix (including the empty prefix or the complete ledger), not a
  -- hand-edited known-name subset with a gap. Every recorded name is proven
  -- known by the check above and positions are unique, so "no gap" is exactly
  -- "no recorded position exceeds the number of recorded rows".
  AND NOT EXISTS (
    SELECT 1
    FROM d1_migrations AS recorded
    JOIN _smesh_expected_migration_order AS expected ON expected.name = recorded.name
    WHERE expected.position > (SELECT COUNT(*) FROM d1_migrations)
  )
  THEN 1 ELSE 0 END;

-- One atomic statement: either every known snapshot migration is recorded or
-- none is. INSERT OR IGNORE makes a compatible prefix ledger and reruns safe.
INSERT OR IGNORE INTO d1_migrations(name)
SELECT name FROM _smesh_expected_migration_order ORDER BY position;

CREATE TABLE _smesh_adoption_result_guard (
  ok INTEGER NOT NULL
     CONSTRAINT smesh_adoption_must_record_complete_ledger CHECK (ok = 1)
);
INSERT INTO _smesh_adoption_result_guard(ok)
SELECT CASE WHEN
  (SELECT COUNT(*) FROM d1_migrations)
    = (SELECT COUNT(*) FROM _smesh_expected_migration_order)
  AND NOT EXISTS (
    SELECT 1 FROM _smesh_expected_migration_order AS expected
    WHERE NOT EXISTS (
      SELECT 1 FROM d1_migrations WHERE name = expected.name
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM d1_migrations
    WHERE name IS NULL
       OR name NOT IN (SELECT name FROM _smesh_expected_migration_order)
  )
  THEN 1 ELSE 0 END;

DROP TABLE _smesh_adoption_result_guard;
DROP TABLE _smesh_adoption_guard;
DROP TABLE _smesh_expected_migration_order;
DROP TABLE _smesh_expected_current_indexes;
DROP TABLE _smesh_expected_current_ddl;
DROP TABLE _smesh_expected_current_shape;
DROP TABLE _smesh_adoption_preflight;
