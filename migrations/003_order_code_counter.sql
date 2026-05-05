-- Annual sequential counter for order codes.
-- See ADR-0004 (tech-docs/systems/repair-hub/adr/0004-order-code-counter-table.md).
--
-- One row per calendar year. last_issued holds the most recent
-- sequence value handed out. The application reserves the next value
-- via INSERT ... ON CONFLICT DO UPDATE RETURNING, which is atomic
-- under concurrent writes thanks to row-level locking on the UPDATE.

CREATE TABLE IF NOT EXISTS order_code_counters (
  year         INTEGER PRIMARY KEY,
  last_issued  INTEGER NOT NULL DEFAULT -1,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
