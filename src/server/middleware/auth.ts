import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AdminUser {
  id: number;
  username: string;
  role: string;
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error('[Auth] JWT_SECRET is not configured!');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const payload = jwt.verify(token, secret) as AdminUser;
    req.adminUser = payload;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized: Token expired' });
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
}

// Chỉ cho phép role 'superadmin' — dùng sau authMiddleware, cho các route quản lý user
// và các thao tác đặc quyền khác (vd bật ghi màn hình lên S3).
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.adminUser?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Forbidden: Superadmin access required' });
  }
  next();
}
