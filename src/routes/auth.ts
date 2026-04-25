import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database';
import { authenticate } from '../middleware/auth';
import { logActivity } from '../utils/activityLog';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.post('/login', asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ success: false, data: null, error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
    return;
  }

  const result = await pool.query(
    'SELECT id, username, password_hash, full_name, role, branch_id, is_active FROM users WHERE username = $1',
    [username.trim()]
  );

  const user = result.rows[0];

  if (!user || !user.is_active) {
    res.status(401).json({ success: false, data: null, error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    res.status(401).json({ success: false, data: null, error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
    return;
  }

  const secret = process.env.JWT_SECRET || 'change-me';
  const timeoutMinutes = 30;

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, branch_id: user.branch_id },
    secret,
    { expiresIn: `${timeoutMinutes}m` }
  );

  await logActivity(user.id, 'LOGIN', 'user', user.id);

  res.json({
    success: true,
    data: {
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, branch_id: user.branch_id },
    },
    error: null,
  });
}));

router.post('/logout', authenticate, asyncHandler(async (req: Request, res: Response) => {
  if (req.user) await logActivity(req.user.id, 'LOGOUT', 'user', req.user.id);
  res.json({ success: true, data: null, error: null });
}));

router.get('/me', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const result = await pool.query(
    'SELECT id, username, full_name, role, branch_id FROM users WHERE id = $1',
    [req.user!.id]
  );
  res.json({ success: true, data: result.rows[0] || null, error: null });
}));

export default router;
