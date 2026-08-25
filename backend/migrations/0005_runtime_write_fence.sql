-- 0005_runtime_write_fence — durable, epoch-scoped authority for every
-- application D1/KV mutation. The backup runbook closes and increments this
-- row before deploying maintenance, so invocations from older deployments
-- cannot regain write authority when maintenance ends.
CREATE TABLE runtime_write_fence (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  write_epoch    INTEGER NOT NULL CHECK (write_epoch >= 1),
  writes_enabled INTEGER NOT NULL DEFAULT 1 CHECK (writes_enabled IN (0, 1)),
  updated_at     INTEGER NOT NULL
);

INSERT INTO runtime_write_fence
  (singleton, write_epoch, writes_enabled, updated_at)
VALUES (1, 1, 1, unixepoch('subsec') * 1000);
