import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

// Accept Excel path as CLI arg or fall back to env var
const EXCEL_PATH = process.argv[2] || process.env.IMPORT_FILE || '';

const KNOWN_STATUSES = new Set([
  'TIEP_NHAN','DANG_KIEM_TRA','BAO_GIA','DANG_SUA_CHUA',
  'SUA_XONG','DA_GIAO','TRA_HANG','HUY_TRA_MAY','DANG_BAO_HANH',
]);

const STATUS_MAP: Record<string, string> = {
  DA_NHAN:    'TIEP_NHAN',
  DANG_SUA:   'DANG_SUA_CHUA',
  GIAO_HANG:  'DA_GIAO',
  HOAN_THANH: 'DA_GIAO',
  TRA_KHACH:  'TRA_HANG',
  DA_HUY:     'HUY_TRA_MAY',
};

const TYPE_MAP: Record<string, string> = {
  KHACH_LE: 'RETAIL',
  DOI_TAC:  'PARTNER',
};

// Strip non-printable characters and truncate to maxLen
function sanitize(val: unknown, maxLen: number): string {
  return String(val ?? '')
    .replace(/[^\x20-\x7EÀ-ɏḀ-ỿ]/g, '')
    .trim()
    .slice(0, maxLen);
}

// Sanitize phone: keep digits, +, spaces, dashes only
function sanitizePhone(val: unknown): string {
  return String(val ?? '').replace(/[^0-9+() \-]/g, '').trim().slice(0, 20);
}

function parseDate(s: string): Date | null {
  const parts = s.split('/').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [d, m, y] = parts;
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return null;
  return date;
}

// Generate ORD-YYYYMMDD-NNNNN matching src/routes/orders.ts:generateOrderCode.
function generateOrderCode(date: Date): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  const seq = String(Math.floor(Math.random() * 99999) + 1).padStart(5, '0');
  return `ORD-${ymd}-${seq}`;
}

// Increment the LAST digit run in an order code, preserving zero-padding.
// "ORD-20260101-00050" -> "ORD-20260101-00051"
// "ORD-20260101-00050-BH" -> "ORD-20260101-00051-BH"
function bumpOrderCode(code: string): string {
  const m = code.match(/^(.*?)(\d+)([^\d]*)$/);
  if (!m) return `${code}-1`;
  const next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return m[1] + next + m[3];
}

async function main() {
  // Guard: required env vars
  const missing = ['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Check your .env file.`);
  }

  // Guard: Excel file path must be provided
  if (!EXCEL_PATH) {
    throw new Error('Usage: npm run import:excel <path-to-excel-file> [-- --cleanup --force]');
  }

  const cleanup = process.argv.includes('--cleanup');

  // Guard: --cleanup also requires --force to prevent accidental data wipe
  if (cleanup && !process.argv.includes('--force')) {
    throw new Error(
      '--cleanup deletes ALL orders and customers. Re-run with --force to confirm:\n' +
      '  npm run import:excel <file> -- --cleanup --force'
    );
  }

  const pool = new Pool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    // Step 1: optionally clear existing data in FK-safe order
    if (cleanup) {
      await pool.query('DELETE FROM order_images');
      await pool.query('DELETE FROM order_status_history');
      await pool.query('DELETE FROM orders');
      await pool.query('DELETE FROM customers');
      console.log('Cleared existing data.');
    } else {
      console.log('Skipping cleanup — appending to existing data.');
    }

    // Step 2: lookup prerequisites
    const branchRes = await pool.query("SELECT id FROM branches WHERE name = 'Quận 1' LIMIT 1");
    if (branchRes.rows.length === 0) throw new Error('Run npm run seed first');
    const branchId: string = branchRes.rows[0].id;

    const userRes = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
    if (userRes.rows.length === 0) throw new Error('Run npm run seed first');
    const adminId: string = userRes.rows[0].id;

    // Step 3: read Excel — parse with header row so columns are referenced by name
    const workbook = XLSX.readFile(path.resolve(EXCEL_PATH));
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const dataRows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(sheet, { defval: null });

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let customersUpserted = 0;
    const seenCodes = new Set<string>();

    let coerced = 0;

    for (const row of dataRows) {
      try {
        // --- Date: parse first so we can use it for code generation if needed ---
        // Missing or invalid date is no longer fatal — we fall back to "now".
        const rawDate = sanitize(row['Ngày Tạo'], 20);
        let createdAt: Date;
        if (!rawDate) {
          createdAt = new Date();
          coerced++;
        } else {
          const parsed = parseDate(rawDate);
          if (!parsed) {
            console.warn(`Row: invalid date "${rawDate}", using now`);
            createdAt = new Date();
            coerced++;
          } else {
            createdAt = parsed;
          }
        }

        // --- Order code: generate one if missing, bump if a duplicate within this file ---
        let orderCode = sanitize(row['Mã Đơn'], 30);
        if (!orderCode) {
          orderCode = generateOrderCode(createdAt);
          console.warn(`Row missing "Mã Đơn", generated: ${orderCode}`);
          coerced++;
        }
        if (seenCodes.has(orderCode)) {
          const original = orderCode;
          while (seenCodes.has(orderCode)) {
            orderCode = bumpOrderCode(orderCode);
          }
          console.warn(`Row: duplicate "Mã Đơn" ${original} in file, renamed to ${orderCode}`);
          coerced++;
        }
        seenCodes.add(orderCode);

        // --- Status: default to TIEP_NHAN if unrecognized ---
        const rawStatus = sanitize(row['Trạng Thái'], 30);
        let status = STATUS_MAP[rawStatus] ?? (KNOWN_STATUSES.has(rawStatus) ? rawStatus : null);
        if (!status) {
          if (rawStatus) {
            console.warn(`Row ${orderCode}: unrecognized status "${rawStatus}", defaulting to TIEP_NHAN`);
          }
          status = 'TIEP_NHAN';
          coerced++;
        }

        const faultDescription = sanitize(row['Ghi Chú'], 500) || 'Nhập từ dữ liệu cũ';

        const customerName = sanitize(row['Khách Hàng'], 100) || 'Khách';

        const rawType = sanitize(row['Loại Khách Hàng'], 20);
        const customerType = TYPE_MAP[rawType] ?? 'RETAIL';

        const phone = sanitizePhone(row['Số Điện Thoại']);
        if (!phone) { skipped++; continue; }

        const deviceName = sanitize(row['Tên Thiết Bị'], 100) || 'Không rõ';

        // Cost in thousands VND
        const rawCost = row['Chi Phí'];
        const quotation = rawCost != null && rawCost !== '' ? Number(rawCost) * 1000 : 0;

        // Upsert customer
        const custRes = await pool.query(
          `INSERT INTO customers (phone, name, type)
           VALUES ($1, $2, $3)
           ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type
           RETURNING id`,
          [phone, customerName, customerType]
        );
        customersUpserted++;
        const customerId: string = custRes.rows[0].id;

        // Insert order
        const orderRes = await pool.query(
          `INSERT INTO orders (order_code, customer_id, branch_id, created_by, status, product_type, device_name, fault_description, quotation, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,'SPEAKER',$6,$7,$8,$9,$9)
           ON CONFLICT (order_code) DO NOTHING
           RETURNING id`,
          [orderCode, customerId, branchId, adminId, status, deviceName, faultDescription, quotation, createdAt]
        );

        if (orderRes.rows.length > 0) {
          const orderId: string = orderRes.rows[0].id;
          await pool.query(
            `INSERT INTO order_status_history (order_id, changed_by, new_status, changed_at)
             VALUES ($1, $2, $3, $4)`,
            [orderId, adminId, status, createdAt]
          );
          imported++;
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        console.error('Row error:', err);
      }
    }

    console.log(`Imported: ${imported} orders (${customersUpserted} customers upserted)`);
    console.log(`Skipped:  ${skipped} (missing phone / DB conflict)`);
    console.log(`Coerced:  ${coerced} fields auto-filled (missing/invalid order code, date, or status)`);
    console.log(`Errors:   ${errors}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
