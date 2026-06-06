-- RH-132: Add indexes on orders.created_at to prevent full table scans
-- on dashboard queries that filter by date range.
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created_at_status ON orders(created_at, status);
