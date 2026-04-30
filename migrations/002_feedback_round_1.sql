-- Drop and recreate product_type CHECK to include BAO_HANH
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_product_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_product_type_check
  CHECK (product_type IN ('SPEAKER', 'HEADPHONE', 'OTHER', 'BAO_HANH'));

-- Extend order_code column to fit "-BH" suffix (e.g. ORD-20260426-12345-BH = 28 chars)
ALTER TABLE orders ALTER COLUMN order_code TYPE VARCHAR(40);

-- NOTE: Quận 1 / Quận 9 branch seed inserts were moved to src/scripts/seed.ts
-- so migrations stay schema-only. Existing environments already have the rows
-- (this migration's earlier ON CONFLICT DO NOTHING insert), so removing the
-- INSERTs here is a no-op for upgrades.
