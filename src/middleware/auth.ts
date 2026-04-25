import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  id: string;
  username: string;
  role: 'ADMIN' | 'TECHNICIAN';
  branch_id: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.token;

  if (!token) {
    res.status(401).json({ success: false, data: null, error: 'Yêu cầu đăng nhập' });
    return;
  }

  try {
    const secret = process.env.JWT_SECRET || 'change-me';
    const payload = jwt.verify(token, secret) as AuthUser;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ success: false, data: null, error: 'Phiên đăng nhập hết hạn' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ success: false, data: null, error: 'Chỉ quản trị viên được phép thực hiện' });
    return;
  }
  next();
}
