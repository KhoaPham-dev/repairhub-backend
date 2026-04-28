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
  TRA_KHACH:  'HUY_TRA_MAY',
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

function formatDateCode(date: Date): string {
  const y = String(date.getFullYear()).slice(2);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function main() {
  // Guard: required env vars
  const missing = ['DB_HOST','DB_NAME','DB_USER','DB_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}. Check your .env file.`);
  }

  // Guard: Excel file path must be provided
  if (!EXCEL_PATH) {
    throw new Error('Usage: npm run import:march <path-to-excel-file>');
  }

  // Guard: --force flag required to prevent accidental data wipe
  if (!process.argv.includes('--force')) {
    throw new Error(
      'This script deletes ALL orders and customers. Re-run with --force to confirm:\n' +
      '  npm run import:march <file> -- --force'
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
    // Step 1: clear existing data in FK-safe order
    await pool.query('DELETE FROM order_images');
    await pool.query('DELETE FROM order_status_history');
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM customers');
    console.log('Cleared existing data.');

    // Step 2: lookup prerequisites
    const branchRes = await pool.query("SELECT id FROM branches WHERE name = 'Quận 1' LIMIT 1");
    if (branchRes.rows.length === 0) throw new Error('Run npm run seed first');
    const branchId: string = branchRes.rows[0].id;

    const userRes = await pool.query("SELECT id FROM users WHERE username = 'admin' LIMIT 1");
    if (userRes.rows.length === 0) throw new Error('Run npm run seed first');
    const adminId: string = userRes.rows[0].id;

    // Step 3: read Excel
    const workbook = XLSX.readFile(path.resolve(EXCEL_PATH));
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    const dataRows = rows.slice(1) as Array<Array<string | number | null>>;
    const dateSeq: Record<string, number> = {};

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let customersUpserted = 0;

    for (const row of dataRows) {
      try {
        // Col 2: status — skip rows with unrecognized status after mapping
        const rawStatus = sanitize(row[2], 30);
        const status = STATUS_MAP[rawStatus] ?? (KNOWN_STATUSES.has(rawStatus) ? rawStatus : null);
        if (!status) {
          console.warn(`Skipping row: unrecognized status "${rawStatus}"`);
          skipped++;
          continue;
        }

        // Col 3: fault_description
        const faultDescription = sanitize(row[3], 500) || 'Nhập từ dữ liệu cũ';

        // Col 4: date
        const rawDate = sanitize(row[4], 20);
        if (!rawDate) { skipped++; continue; }
        const createdAt = parseDate(rawDate);
        if (!createdAt) {
          console.warn(`Skipping row: invalid date "${rawDate}"`);
          skipped++;
          continue;
        }
        const dateCode = formatDateCode(createdAt);

        dateSeq[dateCode] = (dateSeq[dateCode] ?? 0) + 1;
        const seq = String(dateSeq[dateCode]).padStart(5, '0');
        const orderCode = `ORD-${dateCode}-${seq}`;

        // Col 5: customer name
        const customerName = sanitize(row[5], 100) || 'Khách';

        // Col 6: customer type
        const rawType = sanitize(row[6], 20);
        const customerType = TYPE_MAP[rawType] ?? 'RETAIL';

        // Col 7: phone — sanitized to safe characters only
        const phone = sanitizePhone(row[7]);
        if (!phone) { skipped++; continue; }

        // Col 8: device_name
        const deviceName = sanitize(row[8], 100) || 'Không rõ';

        // Col 9: cost in thousands VND
        const rawCost = row[9];
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
    console.log(`Skipped:  ${skipped} (conflict / invalid / unrecognized)`);
    console.log(`Errors:   ${errors}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
