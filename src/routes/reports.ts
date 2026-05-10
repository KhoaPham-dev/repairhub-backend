import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { pool } from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { generateRevenueReport, todayVN, REPORTS_DIR } from '../services/revenueReport';

const router = Router();
router.use(authenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET / — list all reports ordered by generated_at DESC
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, period_start, period_end, generated_at, status, error
     FROM revenue_reports
     ORDER BY generated_at DESC`
  );
  res.json({ success: true, data: result.rows, error: null });
}));

// POST /generate — generate a report (awaited, returns 201 with report data)
router.post('/generate', asyncHandler(async (req: Request, res: Response) => {
  const { period_start, period_end } = req.body as { period_start?: string; period_end?: string };

  let periodEnd: Date;
  let periodStart: Date;

  if (period_start && period_end) {
    periodStart = new Date(period_start);
    periodEnd = new Date(period_end);

    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      res.status(400).json({ success: false, data: null, error: 'Ngày không hợp lệ' });
      return;
    }
    if (periodEnd <= periodStart) {
      res.status(400).json({ success: false, data: null, error: 'Ngày kết thúc phải sau ngày bắt đầu' });
      return;
    }
  } else {
    // Default: last 14 days (using VN local date to avoid UTC date mismatch before 07:00 VN time)
    periodEnd = todayVN();
    periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 13);
  }

  const reportId = await generateRevenueReport(periodStart, periodEnd, req.user!.id);

  const result = await pool.query(
    `SELECT id, period_start, period_end, generated_at, status, error, file_path
     FROM revenue_reports
     WHERE id = $1`,
    [reportId]
  );

  res.status(201).json({ success: true, data: result.rows[0], error: null });
}));

// GET /partner — generate and stream a partner report as an Excel file
router.get('/partner', asyncHandler(async (req: Request, res: Response) => {
  const { partner_id, start, end } = req.query as { partner_id?: string; start?: string; end?: string };

  // Validate required params
  if (!partner_id || !start || !end) {
    res.status(400).json({ success: false, data: null, error: 'Thiếu tham số bắt buộc: partner_id, start, end' });
    return;
  }

  // Validate UUID
  if (!UUID_RE.test(partner_id)) {
    res.status(400).json({ success: false, data: null, error: 'partner_id không hợp lệ' });
    return;
  }

  // Validate dates
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime())) {
    res.status(400).json({ success: false, data: null, error: 'Ngày bắt đầu không hợp lệ' });
    return;
  }
  if (isNaN(endDate.getTime())) {
    res.status(400).json({ success: false, data: null, error: 'Ngày kết thúc không hợp lệ' });
    return;
  }
  if (endDate < startDate) {
    res.status(400).json({ success: false, data: null, error: 'Ngày kết thúc phải >= ngày bắt đầu' });
    return;
  }

  // Normalize validated dates to YYYY-MM-DD strings for DB query
  const startNorm = startDate.toISOString().slice(0, 10);
  const endDate2 = new Date(endDate);
  endDate2.setDate(endDate2.getDate() + 1);
  const endNorm = endDate2.toISOString().slice(0, 10);

  // Check partner existence
  const partnerResult = await pool.query(
    `SELECT id, name FROM customers WHERE id = $1 AND UPPER(type) = 'PARTNER'`,
    [partner_id]
  );
  if (partnerResult.rows.length === 0) {
    res.status(404).json({ success: false, data: null, error: 'Đối tác không tồn tại' });
    return;
  }
  const partner = partnerResult.rows[0] as { id: string; name: string };

  // Query orders using normalized date strings
  const ordersResult = await pool.query(
    `SELECT
       o.order_code,
       o.status,
       o.fault_description,
       o.created_at,
       o.device_name,
       o.quotation
     FROM orders o
     WHERE o.customer_id = $1
       AND o.created_at >= $2
       AND o.created_at < $3
     ORDER BY o.created_at ASC`,
    [partner_id, startNorm, endNorm]
  );

  // Build Excel workbook in memory
  const wb = XLSX.utils.book_new();

  const headerRows: (string | number | null)[][] = [
    [`Đối tác: ${partner.name} | Kỳ: ${start} – ${end}`],
    [],
    ['Mã đơn', 'Trạng thái', 'Ghi chú', 'Ngày tạo', 'Thiết bị', 'Báo giá'],
  ];

  const dataRows: (string | number | null)[][] = ordersResult.rows.map((row) => {
    const createdAt = new Date(row.created_at).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    return [
      row.order_code,
      row.status,
      row.fault_description ?? '',
      createdAt,
      row.device_name ?? '',
      row.quotation !== null ? parseFloat(row.quotation) : 0,
    ];
  });

  const ws = XLSX.utils.aoa_to_sheet([...headerRows, ...dataRows]);
  XLSX.utils.book_append_sheet(wb, ws, 'Chi tiết đơn hàng');

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  // Sanitize partner name for use in Content-Disposition filename header
  // Strip non-ASCII to keep Content-Disposition header safe across all locales
  const safeName = (partner.name as string)
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/["\\]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'partner';
  const filename = `partner-report-${safeName}-${startNorm}-${endNorm}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}));

// GET /:id/download — stream the Excel file
router.get('/:id/download', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!UUID_RE.test(id)) {
    res.status(404).json({ success: false, data: null, error: 'Báo cáo không tồn tại' });
    return;
  }

  const result = await pool.query(
    `SELECT file_path FROM revenue_reports WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    res.status(404).json({ success: false, data: null, error: 'Báo cáo không tồn tại' });
    return;
  }

  const filePath: string | null = result.rows[0].file_path;
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).json({ success: false, data: null, error: 'File báo cáo không tồn tại' });
    return;
  }

  // Path traversal guard — ensure file resolves inside the reports directory
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(REPORTS_DIR + path.sep)) {
    res.status(403).json({ success: false, data: null, error: 'Forbidden' });
    return;
  }

  const filename = path.basename(resolved);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  fs.createReadStream(resolved).pipe(res);
}));

export default router;
