import * as XLSX from 'xlsx';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const EXCEL_PATH = '/Users/agile/Downloads/RepairData_Thang3.xlsx';

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

function parseDate(s: string): Date {
  const [d, m, y] = s.split('/').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateCode(date: Date): string {
  const y = String(date.getFullYear()).slice(2);
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

async function main() {
  const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'repairhub',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
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
    const workbook = XLSX.readFile(EXCEL_PATH);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

    // rows[0] is header; data starts at rows[1]
    const dataRows = rows.slice(1) as Array<Array<string | number | null>>;

    // Build per-date sequence counters
    const dateSeq: Record<string, number> = {};

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let customersUpserted = 0;

    for (const row of dataRows) {
      try {
        // Col 2: status
        const rawStatus = String(row[2] ?? '').trim();
        const status = STATUS_MAP[rawStatus] ?? rawStatus;

        // Col 3: fault_description (Ghi Chú)
        const faultDescription = String(row[3] ?? '').trim();

        // Col 4: date
        const rawDate = String(row[4] ?? '').trim();
        if (!rawDate) continue;
        const createdAt = parseDate(rawDate);
        const dateCode = formatDateCode(createdAt);

        // Increment per-date seq
        dateSeq[dateCode] = (dateSeq[dateCode] ?? 0) + 1;
        const seq = String(dateSeq[dateCode]).padStart(5, '0');
        const orderCode = `ORD-${dateCode}-${seq}`;

        // Col 5: customer name
        const customerName = String(row[5] ?? '').trim();

        // Col 6: customer type
        const rawType = String(row[6] ?? '').trim();
        const customerType = TYPE_MAP[rawType] ?? 'RETAIL';

        // Col 7: phone
        const phone = String(row[7] ?? '').trim();

        // Col 8: device_name
        const deviceName = String(row[8] ?? '').trim();

        // Col 9: cost (in thousands VND)
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
    console.log(`Skipped:  ${skipped} (order_code conflict)`);
    console.log(`Errors:   ${errors}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
