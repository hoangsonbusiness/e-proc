import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import db from '../db/postgres.js';

export interface StudentTokenPayload {
  studentId: number;
  batchId: number;
  jti?: string; // định danh phiên — dùng phát hiện dùng đồng thời nhiều client
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      studentPayload?: StudentTokenPayload;
    }
  }
}

/**
 * [C-4] Student Auth Middleware
 *
 * Xác thực JWT được cấp cho học viên sau bước verify access code.
 * Không tin tưởng x-student-id header do client tự khai báo.
 * Sau khi verify thành công, đính kèm payload vào req.studentPayload.
 */
export async function studentAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // sendBeacon (POST /exam/disconnect) có thể gửi token trong body thay vì header
  const authHeader = req.headers['authorization'];
  const bodyToken = (req.body as any)?.student_token as string | undefined;

  const rawToken = authHeader?.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : bodyToken;

  if (!rawToken) {
    return res.status(401).json({ error: 'Unauthorized: No student token provided' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('[StudentAuth] JWT_SECRET is not configured!');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  let payload: StudentTokenPayload;
  try {
    payload = jwt.verify(rawToken, secret) as StudentTokenPayload;
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorized: Student token expired' });
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid student token' });
  }

  if (!payload.studentId || !payload.batchId) {
    return res.status(401).json({ error: 'Unauthorized: Invalid student token payload' });
  }

  if (!payload.jti) {
    return res.status(401).json({ error: 'Unauthorized: Missing session identifier', reason: 'session_revoked' });
  }

  let active;
  try {
    active = await db.query('SELECT active_jti FROM students WHERE id = ?', [payload.studentId]);
  } catch (err) {
    // A database outage does not make a valid JWT invalid. Fail closed, but
    // classify the failure as retryable so recording finalization can recover.
    console.error('[StudentAuth] Failed to validate the active exam session:', err);
    res.setHeader('Retry-After', '1');
    return res.status(503).json({
      error: 'Student authentication service is temporarily unavailable',
      reason: 'auth_backend_unavailable',
    });
  }

  if (!active.rows[0] || active.rows[0].active_jti !== payload.jti) {
    return res.status(401).json({ error: 'Unauthorized: This exam session is no longer active', reason: 'session_revoked' });
  }

  req.studentPayload = payload;
  next();
}
