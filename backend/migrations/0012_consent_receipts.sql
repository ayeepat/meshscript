CREATE TABLE IF NOT EXISTS consent_receipts (
  receipt_id       TEXT    PRIMARY KEY,
  license_ref      TEXT    NOT NULL,
  device_id        TEXT    NOT NULL,
  consent_version  INTEGER NOT NULL,
  terms            INTEGER NOT NULL CHECK (terms IN (0, 1)),
  ai_processing    INTEGER NOT NULL CHECK (ai_processing IN (0, 1)),
  telemetry        INTEGER NOT NULL CHECK (telemetry IN (0, 1)),
  eligibility      INTEGER NOT NULL CHECK (eligibility IN (0, 1)),
  client_at        TEXT    NOT NULL,
  received_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_receipts_subject_time
  ON consent_receipts(license_ref, device_id, received_at DESC);
