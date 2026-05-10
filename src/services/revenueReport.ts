import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { pool } from '../config/database';

export const REPORTS_DIR = path.join(process.cwd(), 'backups', 'reports');

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDateVN(value: Date | string): string {
  return new Date(value).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

function displayCustomerType(type: string | null): string {
  if (type === 'individual') return 'Cá nhân';
  if (type === 'partner') return 'Đối tác';
  return type ?? '';
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
    const startStr = formatDate(periodStart);
    const endStr = formatDate(periodEnd);

    // 2. Query summary (grouped by status)
    const summaryResult = await pool.query(
      `SELECT status, COUNT(*) as order_count, COALESCE(SUM(quotation), 0) as total_revenue
       FROM orders
       WHERE created_at >= $1 AND created_at < $2
       GROUP BY status`,
      [startStr, endStr]
    );

    // 3. Query detail (all orders with customer info)
    const detailResult = await pool.query(
      `SELECT
         o.order_code,
         o.status,
         o.fault_description,
         o.created_at,
         c.type AS customer_type,
         o.device_name,
         o.quotation,
         c.full_name AS customer_name,
         c.phone
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       WHERE o.created_at >= $1 AND o.created_at < $2
       ORDER BY o.created_at ASC`,
      [startStr, endStr]
    );

    // 4. Build Excel workbook
    const wb = XLSX.utils.book_new();

    // --- Sheet 1: Summary ---
    const summaryRows: (string | number)[][] = [
      [`Kỳ báo cáo: ${startStr} đến ${endStr}`],
      [],
      ['Trạng thái', 'Số đơn', 'Doanh thu (VNĐ)'],
    ];

    let totalCount = 0;
    let totalRevenue = 0;

    for (const row of summaryResult.rows) {
      const count = parseInt(row.order_count, 10);
      const revenue = parseFloat(row.total_revenue);
      totalCount += count;
      totalRevenue += revenue;
      summaryRows.push([row.status, count, revenue]);
    }

    summaryRows.push(['Tổng cộng', totalCount, totalRevenue]);

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Báo cáo doanh thu');

    // --- Sheet 2: Order detail ---
    const detailRows: (string | number | null)[][] = [
      ['Mã đơn', 'Trạng thái', 'Ghi chú', 'Ngày tạo', 'Khách hàng', 'Loại khách', 'Số điện thoại', 'Thiết bị', 'Báo giá'],
    ];

    for (const row of detailResult.rows) {
      detailRows.push([
        row.order_code,
        row.status,
        row.fault_description ?? '',
        formatDateVN(row.created_at),
        row.customer_name ?? '',
        displayCustomerType(row.customer_type),
        row.phone ?? '',
        row.device_name ?? '',
        row.quotation !== null ? parseFloat(row.quotation) : 0,
      ]);
    }

    const wsDetail = XLSX.utils.aoa_to_sheet(detailRows);
    XLSX.utils.book_append_sheet(wb, wsDetail, 'Chi tiết đơn hàng');

    // 5. Write file
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const filePath = path.join(REPORTS_DIR, `report-${startStr}-${endStr}-${Date.now()}.xlsx`);
    XLSX.writeFile(wb, filePath);

    // 6. Update row to done
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
