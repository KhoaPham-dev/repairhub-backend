import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/search', async (req: Request, res: Response) => {
  const { q } = req.query;
  if (!q) { res.json({ success: true, data: [], error: null }); return; }

  const result = await pool.query(
    `SELECT o.*, c.name AS customer_name, c.phone AS customer_phone,
            b.name AS branch_name,
            (SELECT json_agg(json_build_object('id', oi.id, 'image_path', oi.image_path, 'image_type', oi.image_type))
             FROM order_images oi WHERE oi.order_id = o.id) AS images,
            CASE
              WHEN o.warranty_end_date IS NULL THEN 'UNKNOWN'
              WHEN o.warranty_end_date >= CURRENT_DATE THEN 'ACTIVE'
              ELSE 'EXPIRED'
            END AS warranty_status,
            CASE
              WHEN o.warranty_end_date IS NOT NULL
                   AND o.warranty_end_date >= CURRENT_DATE
                   AND o.warranty_end_date <= CURRENT_DATE + INTERVAL '30 days'
              THEN true ELSE false
            END AS expiring_soon
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     JOIN branches b ON b.id = o.branch_id
     WHERE o.status = 'DA_GIAO'
       AND (c.phone ILIKE $1 OR o.serial_imei ILIKE $1 OR o.device_name ILIKE $1)
     ORDER BY o.updated_at DESC
     LIMIT 50`,
    [`%${q}%`]
  );

  res.json({ success: true, data: result.rows, error: null });
});

export default router;
