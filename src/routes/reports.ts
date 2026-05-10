import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { pool } from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { generateRevenueReport } from '../services/revenueReport';

const router = Router();
router.use(authenticate, requireAdmin);

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
  } else {
    // Default: last 14 days
    periodEnd = new Date();
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

// GET /:id/download — stream the Excel file
router.get('/:id/download', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
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

  const filename = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  fs.createReadStream(filePath).pipe(res);
}));

export default router;
