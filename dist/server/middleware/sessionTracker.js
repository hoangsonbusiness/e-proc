import db from '../db/postgres.js';
/**
 * Anti-Cheat: theo dõi phiên thi để phát hiện dùng đồng thời nhiều client/IP.
 *
 * Đặt SAU studentAuthMiddleware trên các endpoint exam có ý nghĩa
 * (/exam/questions, /exam/answer, /violation). KHÔNG đặt trên /disconnect
 * (beacon — IP/UA không đáng tin, và không phản ánh hoạt động thật của thí sinh).
 *
 * Middleware chỉ GHI NHẬN (upsert last_seen), không block request nóng.
 * Việc đánh giá "đa client đáng ngờ" tách sang detectConcurrentSession()
 * để /violation gọi và ra quyết định auto-lock.
 */
// Cửa sổ coi các phiên là "gần đây" (đang hoạt động cùng lúc)
export const SESSION_WINDOW_SECONDS = 60;
// Hai request từ IP/UA khác nhau cách nhau dưới ngưỡng này = chồng lấn thời gian (bằng chứng mạnh)
export const OVERLAP_SECONDS = 10;
function clientIp(req) {
    // trust proxy=1 đã bật ở index.ts nên req.ip lấy đúng IP thật qua Vercel/proxy
    return (req.ip || req.socket?.remoteAddress || 'unknown').toString();
}
export async function sessionTracker(req, res, next) {
    try {
        const payload = req.studentPayload;
        if (payload?.studentId && payload.jti) {
            const ip = clientIp(req);
            const ua = (req.headers['user-agent'] || 'unknown').toString().slice(0, 300);
            const nowIso = new Date().toISOString();
            // UPSERT theo (student_id, jti, ip): đổi IP tạo dòng mới, cùng cặp thì cập nhật last_seen.
            // Cú pháp ON CONFLICT hoạt động cả PostgreSQL lẫn SQLite (better-sqlite3).
            await db.query(`INSERT INTO exam_sessions (student_id, batch_id, jti, ip, user_agent, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, jti, ip)
         DO UPDATE SET last_seen = ?, user_agent = ?`, [payload.studentId, payload.batchId, payload.jti, ip, ua, nowIso, nowIso, nowIso, ua]);
        }
    }
    catch (err) {
        // Không được để lỗi tracking làm hỏng request thi
        console.error('[sessionTracker] non-fatal:', err?.message);
    }
    next();
}
/**
 * Đánh giá dựa trên các dòng exam_sessions gần đây của một student.
 * 4 tín hiệu: đổi IP, đổi UA, request chồng lấn thời gian, nhiều jti active.
 * Chỉ auto-lock khi CHỒNG LẤN THỜI GIAN — tránh false-positive khi thí sinh
 * đổi mạng (wifi→4G) vốn chỉ đổi IP tuần tự chứ không chồng lấn.
 */
export async function detectConcurrentSession(studentId) {
    const cutoffIso = new Date(Date.now() - SESSION_WINDOW_SECONDS * 1000).toISOString();
    const rows = (await db.query(`SELECT jti, ip, user_agent, last_seen
     FROM exam_sessions
     WHERE student_id = ? AND last_seen >= ?
     ORDER BY last_seen ASC`, [studentId, cutoffIso])).rows;
    const ips = [...new Set(rows.map((r) => r.ip).filter(Boolean))];
    const userAgents = [...new Set(rows.map((r) => r.user_agent).filter(Boolean))];
    const jtis = [...new Set(rows.map((r) => r.jti).filter(Boolean))];
    // Chồng lấn: tồn tại 2 dòng IP KHÁC nhau có last_seen cách nhau < OVERLAP_SECONDS
    let overlap = false;
    for (let i = 0; i < rows.length && !overlap; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            if (rows[i].ip === rows[j].ip)
                continue;
            const dt = Math.abs(new Date(rows[j].last_seen).getTime() - new Date(rows[i].last_seen).getTime()) / 1000;
            if (dt < OVERLAP_SECONDS) {
                overlap = true;
                break;
            }
        }
    }
    const suspicious = ips.length >= 2 || userAgents.length >= 2 || jtis.length >= 2 || overlap;
    const lockable = overlap; // chỉ khóa khi có bằng chứng chồng lấn thời gian
    return { suspicious, lockable, ips, userAgents, jtis, overlap };
}
