-- A referral code must never resolve to more than one capability/owner.
-- getOrCreateCode retries random generation when this index rejects a
-- different auth_hash using the same code. If historic duplicate codes exist,
-- this migration intentionally fails closed for manual review rather than
-- deleting or silently reassigning valuable referral state.
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_auth_claims_code
  ON referral_auth_claims(code);
