import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../config/database';
import { authenticate, requireAdmin } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();
router.use(authenticate, requireAdmin);

router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    'SELECT id, username, full_name, role, branch_id, is_active, created_at FROM users ORDER BY created_at DESC'
  );
  res.json({ success: true, data: result.rows, error: null });
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const { username, password, full_name, role, branch_id } = req.body as {
    username: string; password: string; full_name: string;
    role: 'ADMIN' | 'TECHNICIAN'; branch_id?: string;
  };

  if (!username || !password || !full_name || !role) {
    res.status(400).json({ success: false, data: null, error: 'Thiếu thông tin bắt buộc' });
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, full_name, role, branch_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, username, full_name, role, branch_id, is_active, created_at`,
    [username.trim(), hash, full_name.trim(), role, branch_id || null]
  );

  await logActivity(req.user!.id, 'CREATE_USER', 'user', result.rows[0].id);
  res.status(201).json({ success: true, data: result.rows[0], error: null });
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy người dùng' }); return; }
  const { full_name, role, branch_id, is_active } = req.body as {
    full_name?: string; role?: string; branch_id?: string; is_active?: boolean;
  };

  const result = await pool.query(
    `UPDATE users SET
       full_name = COALESCE($1, full_name),
       role = COALESCE($2, role),
       branch_id = COALESCE($3, branch_id),
       is_active = COALESCE($4, is_active),
       updated_at = NOW()
     WHERE id = $5
     RETURNING id, username, full_name, role, branch_id, is_active`,
    [full_name, role, branch_id, is_active, req.params.id]
  );

  if (!result.rows[0]) { res.status(404).json({ success: false, data: null, error: 'Không tìm thấy người dùng' }); return; }
  await logActivity(req.user!.id, 'UPDATE_USER', 'user', req.params.id);
  res.json({ success: true, data: result.rows[0], error: null });
}));

router.post('/:id/reset-password', asyncHandler(async (req: Request, res: Response) => {
  const { password } = req.body as { password: string };
  if (!password) { res.status(400).json({ success: false, data: null, error: 'Mật khẩu không được để trống' }); return; }

  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.params.id]);
  await logActivity(req.user!.id, 'RESET_PASSWORD', 'user', req.params.id);
  res.json({ success: true, data: null, error: null });
}));

router.get('/activity-log', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  const result = await pool.query(
    `SELECT al.*, u.username, u.full_name
     FROM activity_log al
     JOIN users u ON u.id = al.user_id
     ORDER BY al.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json({ success: true, data: result.rows, error: null });
}));

router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(404).json({ success: false, data: null, error: 'Không tìm thấy người dùng' });
    return;
  }
  if (req.params.id === req.user!.id) {
    res.status(400).json({ success: false, data: null, error: 'Không thể xoá tài khoản của chính mình' });
    return;
  }
  await pool.query('UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1', [req.params.id]);
  await logActivity(req.user!.id, 'DELETE_USER', 'user', req.params.id);
  res.json({ success: true, data: null, error: null });
}));

export default router;
