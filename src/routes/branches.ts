import { Router, Request, Response } from 'express';
import { pool } from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();
router.use(authenticate);

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { search, include_inactive } = req.query;
  let query = 'SELECT * FROM branches WHERE 1=1';
  const params: unknown[] = [];

  if (!include_inactive) { query += ' AND is_active = true'; }
  if (search) {
    params.push(`%${search}%`);
    query += ` AND (name ILIKE $${params.length} OR manager_name ILIKE $${params.length})`;
  }
  query += ' ORDER BY name';

  const result = await pool.query(query, params);
  res.json({ success: true, data: result.rows, error: null });
}));

router.post('/', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { name, address, phone, manager_name } = req.body as {
    name: string; address?: string; phone?: string; manager_name?: string;
  };
  if (!name) { res.status(400).json({ success: false, data: null, error: 'Tên chi nhánh là bắt buộc' }); return; }

  const result = await pool.query(
    `INSERT INTO branches (name, address, phone, manager_name)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name.trim(), address || null, phone || null, manager_name || null]
  );
  await logActivity(req.user!.id, 'CREATE_BRANCH', 'branch', result.rows[0].id);
  res.status(201).json({ success: true, data: result.rows[0], error: null });
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query('SELECT * FROM branches WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy chi nhánh' }); return; }
  res.json({ success: true, data: result.rows[0], error: null });
}));

router.put('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const { name, address, phone, manager_name } = req.body as {
    name?: string; address?: string; phone?: string; manager_name?: string;
  };
  const result = await pool.query(
    `UPDATE branches SET
       name = COALESCE($1, name),
       address = COALESCE($2, address),
       phone = COALESCE($3, phone),
       manager_name = COALESCE($4, manager_name),
       updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [name, address, phone, manager_name, req.params.id]
  );
  if (!result.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy chi nhánh' }); return; }
  await logActivity(req.user!.id, 'UPDATE_BRANCH', 'branch', req.params.id);
  res.json({ success: true, data: result.rows[0], error: null });
}));

router.delete('/:id', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  const activeOrders = await pool.query(
    "SELECT id FROM orders WHERE branch_id = $1 AND status NOT IN ('DA_GIAO', 'HUY_TRA_MAY') LIMIT 1",
    [req.params.id]
  );
  if (activeOrders.rows.length > 0) {
    res.status(400).json({ success: false, data: null, error: 'Không thể xoá chi nhánh đang có đơn hàng hoạt động' });
    return;
  }
  await pool.query('UPDATE branches SET is_active = false, deleted_at = NOW(), updated_at = NOW() WHERE id = $1', [req.params.id]);
  await logActivity(req.user!.id, 'DELETE_BRANCH', 'branch', req.params.id);
  res.json({ success: true, data: null, error: null });
}));

router.post('/:id/enable', requireAdmin, asyncHandler(async (req: Request, res: Response) => {
  await pool.query('UPDATE branches SET is_active = true, deleted_at = NULL, updated_at = NOW() WHERE id = $1', [req.params.id]);
  await logActivity(req.user!.id, 'ENABLE_BRANCH', 'branch', req.params.id);
  res.json({ success: true, data: null, error: null });
}));

export default router;
