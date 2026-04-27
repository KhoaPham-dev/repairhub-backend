import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();
router.use(authenticate);

// Vietnamese day abbreviations: DOW 0=Sun → CN, 1=Mon → T2, ..., 6=Sat → T7
const DOW_LABELS: Record<number, string> = {
  0: 'CN',
  1: 'T2',
  2: 'T3',
  3: 'T4',
  4: 'T5',
  5: 'T6',
  6: 'T7',
};

router.get('/revenue', asyncHandler(async (req: Request, res: Response) => {
  const { period } = req.query as { period?: string };

  if (period === 'today') {
    // Return hourly breakdown as a single entry for today
    const result = await pool.query(
      `SELECT
         CURRENT_DATE::text AS date,
         COALESCE(SUM(quotation), 0) AS revenue,
         EXTRACT(DOW FROM CURRENT_DATE)::int AS dow
       FROM orders
       WHERE status = 'DA_GIAO'
         AND created_at >= CURRENT_DATE
         AND created_at < CURRENT_DATE + INTERVAL '1 day'`
    );
    const row = result.rows[0];
    const dow = Number(row.dow);
    const data = [
      {
        day: DOW_LABELS[dow] ?? 'CN',
        date: row.date,
        revenue: Number(row.revenue),
      },
    ];
    res.json({ success: true, data, error: null });
    return;
  }

  if (period === 'week') {
    // Return 7 days Mon–Sun of current week
    const result = await pool.query(
      `SELECT
         gs.day::date::text AS date,
         EXTRACT(DOW FROM gs.day)::int AS dow,
         COALESCE(SUM(o.quotation), 0) AS revenue
       FROM generate_series(
         date_trunc('week', CURRENT_DATE),
         date_trunc('week', CURRENT_DATE) + INTERVAL '6 days',
         INTERVAL '1 day'
       ) AS gs(day)
       LEFT JOIN orders o
         ON o.created_at >= gs.day
        AND o.created_at < gs.day + INTERVAL '1 day'
        AND o.status = 'DA_GIAO'
       GROUP BY gs.day
       ORDER BY gs.day`
    );
    const data = result.rows.map((row) => ({
      day: DOW_LABELS[Number(row.dow)] ?? 'CN',
      date: row.date,
      revenue: Number(row.revenue),
    }));
    res.json({ success: true, data, error: null });
    return;
  }

  if (period === 'month') {
    // Return 4 weekly aggregates for the current month
    const result = await pool.query(
      `SELECT
         week_num,
         COALESCE(SUM(o.quotation), 0) AS revenue
       FROM (
         SELECT
           gs.day,
           LEAST(
             CEIL(EXTRACT(DAY FROM gs.day) / 7.0)::int,
             4
           ) AS week_num
         FROM generate_series(
           date_trunc('month', CURRENT_DATE),
           date_trunc('month', CURRENT_DATE) + INTERVAL '1 month' - INTERVAL '1 day',
           INTERVAL '1 day'
         ) AS gs(day)
       ) weeks
       LEFT JOIN orders o
         ON o.created_at >= date_trunc('month', CURRENT_DATE) + ((weeks.week_num - 1) * 7) * INTERVAL '1 day'
        AND o.created_at < date_trunc('month', CURRENT_DATE) + (weeks.week_num * 7) * INTERVAL '1 day'
        AND o.status = 'DA_GIAO'
       GROUP BY week_num
       ORDER BY week_num`
    );
    const data = result.rows.map((row) => ({
      day: `T${row.week_num}`,
      date: `Tuần ${row.week_num}`,
      revenue: Number(row.revenue),
    }));
    res.json({ success: true, data, error: null });
    return;
  }

  // Unknown or missing period — return empty data
  res.json({ success: true, data: [], error: null });
}));

export default router;
