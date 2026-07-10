import jwt from 'jsonwebtoken';
/**
 * [C-4] Student Auth Middleware
 *
 * Xác thực JWT được cấp cho học viên sau bước verify access code.
 * Không tin tưởng x-student-id header do client tự khai báo.
 * Sau khi verify thành công, đính kèm payload vào req.studentPayload.
 */
export function studentAuthMiddleware(req, res, next) {
    // sendBeacon (POST /exam/disconnect) có thể gửi token trong body thay vì header
    const authHeader = req.headers['authorization'];
    const bodyToken = req.body?.student_token;
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
    try {
        const payload = jwt.verify(rawToken, secret);
        if (!payload.studentId || !payload.batchId) {
            return res.status(401).json({ error: 'Unauthorized: Invalid student token payload' });
        }
        req.studentPayload = payload;
        next();
    }
    catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Unauthorized: Student token expired' });
        }
        return res.status(401).json({ error: 'Unauthorized: Invalid student token' });
    }
}
