-- Drop and recreate product_type CHECK to include BAO_HANH
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_product_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_product_type_check
  CHECK (product_type IN ('SPEAKER', 'HEADPHONE', 'OTHER', 'BAO_HANH'));

-- Extend order_code column to fit "-BH" suffix (e.g. ORD-20260426-12345-BH = 28 chars)
ALTER TABLE orders ALTER COLUMN order_code TYPE VARCHAR(40);

-- Seed Quận 1 and Quận 9 branches (upsert by name)
INSERT INTO branches (name, address, phone, manager_name)
VALUES
  ('Quận 1', '123 Đường Lê Lợi, Quận 1, TP.HCM', '0281234001', 'Quản lý Quận 1'),
  ('Quận 9', '456 Đường Nguyễn Xiển, Quận 9, TP.HCM', '0281234009', 'Quản lý Quận 9')
ON CONFLICT (name) DO NOTHING;
