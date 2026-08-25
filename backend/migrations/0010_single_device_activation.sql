-- 0010_single_device_activation — one authenticated active installation per
-- license. Historical license_devices rows remain intact for audit/referral
-- migration; only this table authorizes current use. activated_at is retained
-- across transfers and is the first-use clock for activation-bound plans.

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
