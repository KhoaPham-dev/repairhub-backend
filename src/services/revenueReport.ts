import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { pool } from '../config/database';

const REPORTS_DIR = path.join(process.cwd(), 'backups', 'reports');

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function generateRevenueReport(
  periodStart: Date,
  periodEnd: Date,
  createdBy?: string
): Promise<string> {
  // 1. Insert pending row
  const insertResult = await pool.query(
    `INSERT INTO revenue_reports (period_start, period_end, status, created_by)
     VALUES ($1, $2, 'pending', $3)
     RETURNING id`,
    [formatDate(periodStart), formatDate(periodEnd), createdBy ?? null]
  );
  const reportId: string = insertResult.rows[0].id;

  try {
    // 2. Query orders in period
    const ordersResult = await pool.query(
      `SELECT status, COUNT(*) as order_count, COALESCE(SUM(quotation), 0) as total_revenue
       FROM orders
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY status`,
      [formatDate(periodStart), formatDate(periodEnd)]
    );

    // 3. Build Excel workbook
    const wb = XLSX.utils.book_new();

    const startStr = formatDate(periodStart);
    const endStr = formatDate(periodEnd);

    const rows: (string | number)[][] = [
      [`Kỳ báo cáo: ${startStr} đến ${endStr}`],
      [],
      ['Trạng thái', 'Số đơn', 'Doanh thu (VNĐ)'],
    ];

    let totalCount = 0;
    let totalRevenue = 0;

    for (const row of ordersResult.rows) {
      const count = parseInt(row.order_count, 10);
      const revenue = parseFloat(row.total_revenue);
      totalCount += count;
      totalRevenue += revenue;
      rows.push([row.status, count, revenue]);
    }

    rows.push(['Tổng cộng', totalCount, totalRevenue]);

    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'Báo cáo doanh thu');

    // 4. Write file
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const filePath = path.join(REPORTS_DIR, `report-${startStr}-${endStr}.xlsx`);
    XLSX.writeFile(wb, filePath);

    // 5. Update row to done
    await pool.query(
      `UPDATE revenue_reports SET status = 'done', file_path = $1 WHERE id = $2`,
      [filePath, reportId]
    );

    return reportId;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE revenue_reports SET status = 'failed', error = $1 WHERE id = $2`,
      [message, reportId]
    );
    throw err;
  }
}
