import bcrypt from 'bcryptjs';
const PASSWORD_HASH_COST = 10;
const MIN_PASSWORD_LENGTH = 8;
export class AdminUserPasswordError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AdminUserPasswordError';
    }
}
function parseTargetUserId(rawId) {
    const value = typeof rawId === 'number' ? String(rawId) : rawId;
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
        throw new AdminUserPasswordError(400, 'User ID must be a positive integer');
    }
    const targetUserId = Number(value);
    if (!Number.isSafeInteger(targetUserId)) {
        throw new AdminUserPasswordError(400, 'User ID must be a positive integer');
    }
    return targetUserId;
}
export async function resetAdminUserPassword(executor, rawTargetUserId, newPassword) {
    const targetUserId = parseTargetUserId(rawTargetUserId);
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
        throw new AdminUserPasswordError(400, `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const existing = await executor.query('SELECT id FROM admin_users WHERE id = ?', [targetUserId]);
    if (existing.rows.length === 0) {
        throw new AdminUserPasswordError(404, 'User not found');
    }
    const passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_COST);
    const updated = await executor.query('UPDATE admin_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [passwordHash, targetUserId]);
    if (updated.rowCount === 0) {
        throw new AdminUserPasswordError(404, 'User not found');
    }
    return { userId: targetUserId };
}
