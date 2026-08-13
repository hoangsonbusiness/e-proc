import { Router } from 'express';
import db from '../db/postgres.js';
import { cache } from '../cache.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { studentAuthMiddleware } from '../middleware/studentAuth.js';
import { createRecordingUploadUrl, inspectRecordingObject, isS3Configured } from '../services/s3.js';
import rateLimit from 'express-rate-limit';
import { sessionTracker, detectConcurrentSession } from '../middleware/sessionTracker.js';
import { getExamContext, assertCanStart, computeExamDeadline, sendExamGuardError, ExamGuardError } from '../services/examGuard.js';
import { parseBlueprintCompat } from '../services/blueprint.js';
import { persistViolation, computeViolationLock, isForensicOnlyViolation } from '../services/violationStore.js';
import { enqueueStudentQueueJobs } from '../services/queueStore.js';
dotenv.config();
// Phải khớp chính xác với DB layer: có DATABASE_URL => PostgreSQL, không có => SQLite.
// Dựa vào NODE_ENV làm local PostgreSQL bỏ qua FOR UPDATE và tái tạo race violation.
const USE_SQLITE = !process.env.DATABASE_URL;
const router = Router();
// [P2-4] Throttle ghi forensic 'concurrent_session': tránh append một row mỗi lần
// autosave answer khi student ở trạng thái suspicious kéo dài (vd 2 jti cùng IP, hoặc
// đổi mạng tuần tự — suspicious nhưng không lock). Chỉ ghi khi FINGERPRINT bằng chứng
// đổi, hoặc đã quá FORENSIC_DEDUP_MS kể từ lần ghi cuối cho cùng fingerprint.
// In-memory: mỗi serverless instance giữ riêng — xấu nhất là vài row trùng khi scale,
// vẫn tốt hơn nhiều so với ghi mỗi answer. Không phải cache bền vững, chỉ để giảm nhiễu.
const FORENSIC_DEDUP_MS = 60_000;
const lastConcurrentForensic = new Map(); // key: `${studentId}:${fingerprint}` → ts
// [P2-3] Các key đang có INSERT forensic chạy dở (in-flight) — chặn hai request cùng instance
// cùng vượt gate rồi cùng ghi. Thêm key TRƯỚC await, xóa trong finally.
const inflightConcurrentForensic = new Set();
// [SEC] Rate-limit riêng cho /verify — chống brute-force access code.
// 10 lần / phút / IP đủ cho retry hợp lệ nhưng chặn dò mã hàng loạt.
const verifyRateLimit = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a minute and try again.' },
});
const toGMT7 = (utcDate) => {
    return new Date(utcDate.getTime() + 7 * 60 * 60 * 1000);
};
// Hoàn tất nộp bài: quiz → chấm tự động ngay (bỏ qua ai_queue); essay → đẩy hàng đợi AI.
// Dùng chung cho cả nộp thủ công lẫn auto-submit (timeout / vắng mặt quá lâu).
// Không tự set status='submitted' — caller đảm nhiệm việc đó.
async function finalizeSubmission(studentId, examType) {
    if (examType === 'quiz') {
        const quizRows = await db.query(`
      SELECT eq.id, eq.answer, q.type, q.correct_answers, q.score
      FROM exam_questions eq
      JOIN question_bank q ON eq.question_id = q.id
      WHERE eq.student_id = ?
    `, [studentId]);
        const norm = (arr) => [...new Set(arr.map((s) => String(s).trim().toUpperCase()))].sort();
        const scored = [];
        for (const row of quizRows.rows) {
            let correct = [];
            try {
                correct = row.correct_answers ? JSON.parse(row.correct_answers) : [];
            }
            catch (_) { }
            let chosen = [];
            try {
                chosen = row.answer ? JSON.parse(row.answer) : [];
            }
            catch (_) {
                if (typeof row.answer === 'string' && row.answer.trim())
                    chosen = [row.answer.trim()];
            }
            const c = norm(correct);
            const a = norm(chosen);
            const isCorrect = c.length > 0 && c.length === a.length && c.every((k, i) => k === a[i]);
            const gained = isCorrect ? (row.score != null ? Number(row.score) : 1) : 0;
            scored.push({ id: Number(row.id), score: gained, feedback: isCorrect ? 'Correct' : 'Incorrect' });
        }
        if (scored.length > 0) {
            const scoreCases = scored.map(() => 'WHEN ? THEN ?').join(' ');
            const feedbackCases = scored.map(() => 'WHEN ? THEN ?').join(' ');
            const ids = scored.map((item) => item.id);
            await db.query(`
        UPDATE exam_questions
        SET ai_score = CASE id ${scoreCases} ELSE ai_score END,
            ai_feedback = CASE id ${feedbackCases} ELSE ai_feedback END
        WHERE id IN (${ids.map(() => '?').join(', ')})
      `, [
                ...scored.flatMap((item) => [item.id, item.score]),
                ...scored.flatMap((item) => [item.id, item.feedback]),
                ...ids,
            ]);
        }
    }
}
async function persistAnswerBatch(tx, studentId, rawAnswers) {
    if (!Array.isArray(rawAnswers))
        return 0;
    if (rawAnswers.length > 100) {
        const error = new Error('Too many answers');
        error.code = 'INVALID_ANSWERS';
        throw error;
    }
    const deduped = new Map();
    for (const item of rawAnswers) {
        const order = Number(item?.question_order);
        if (!Number.isInteger(order) || order <= 0 || typeof item?.answer !== 'string') {
            const error = new Error('Invalid answer payload');
            error.code = 'INVALID_ANSWERS';
            throw error;
        }
        if (item.answer.length > 100_000) {
            const error = new Error('Answer is too large');
            error.code = 'INVALID_ANSWERS';
            throw error;
        }
        deduped.set(order, item.answer);
    }
    if (deduped.size === 0)
        return 0;
    const orders = [...deduped.keys()];
    const placeholders = orders.map(() => '?').join(', ');
    const assignedResult = await tx.query(`
    SELECT eq.question_order, q.type, q.options
    FROM exam_questions eq
    JOIN question_bank q ON q.id = eq.question_id
    WHERE eq.student_id = ? AND eq.question_order IN (${placeholders})
  `, [studentId, ...orders]);
    if (assignedResult.rows.length !== orders.length) {
        const error = new Error('One or more questions are not assigned to this student');
        error.code = 'INVALID_ANSWERS';
        throw error;
    }
    const assignedByOrder = new Map(assignedResult.rows.map((row) => [Number(row.question_order), row]));
    const normalized = [];
    for (const [order, originalAnswer] of deduped) {
        const assigned = assignedByOrder.get(order);
        let answer = originalAnswer;
        if (assigned.type === 'SingleChoice' || assigned.type === 'MultipleChoice') {
            let selected;
            try {
                selected = JSON.parse(answer);
            }
            catch {
                selected = [];
            }
            if (!Array.isArray(selected) || selected.some((key) => typeof key !== 'string')) {
                const error = new Error('Invalid quiz answer');
                error.code = 'INVALID_ANSWERS';
                throw error;
            }
            const allowed = new Set();
            try {
                for (const option of JSON.parse(assigned.options || '[]'))
                    allowed.add(option.key);
            }
            catch { }
            selected = [...new Set(selected)];
            if (selected.some((key) => !allowed.has(key)) || (assigned.type === 'SingleChoice' && selected.length > 1)) {
                const error = new Error('Invalid quiz option');
                error.code = 'INVALID_ANSWERS';
                throw error;
            }
            answer = JSON.stringify(selected);
        }
        normalized.push([order, answer]);
    }
    const cases = normalized.map(() => 'WHEN ? THEN ?').join(' ');
    await tx.query(`
    UPDATE exam_questions
    SET answer = CASE question_order ${cases} ELSE answer END
    WHERE student_id = ? AND question_order IN (${placeholders})
  `, [...normalized.flatMap(([order, answer]) => [order, answer]), studentId, ...orders]);
    return normalized.length;
}
async function submitExamAtomically(studentId, reason, options = {}) {
    const transition = await db.withTransaction(async (tx) => {
        const lockSql = `
      SELECT s.status, s.exam_deadline, s.recording_finalized_at, b.record_mode, b.record_enabled,
             b.exam_type, b.ai_grading_enabled
      FROM students s JOIN batches b ON b.id = s.batch_id
      WHERE s.id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}
    `;
        const row = (await tx.query(lockSql, [studentId])).rows[0];
        if (!row)
            throw new Error('Student not found');
        if (row.status === 'submitted')
            return { already: true, examType: row.exam_type || 'essay' };
        if (row.status !== 'in_progress')
            throw new Error('Exam is not in progress');
        const recordMode = row.record_mode || (row.record_enabled ? 's3' : 'none');
        const deadlinePassed = row.exam_deadline && new Date() >= new Date(row.exam_deadline);
        const finalReason = deadlinePassed ? 'timeout' : reason;
        await persistAnswerBatch(tx, studentId, options.answers);
        await tx.query(`UPDATE students
       SET status = 'submitted', submitted_at = ?, submit_reason = ?,
           recording_incomplete = CASE WHEN ? = 's3' AND recording_finalized_at IS NULL THEN TRUE ELSE recording_incomplete END
       WHERE id = ? AND status = 'in_progress'`, [new Date().toISOString(), finalReason, recordMode, studentId]);
        if (row.exam_type !== 'quiz' && row.ai_grading_enabled) {
            await enqueueStudentQueueJobs(tx, studentId, new Date());
        }
        return { already: false, examType: row.exam_type || 'essay' };
    });
    // Essay queue rows are committed atomically with submission. Quiz scoring is idempotent.
    if (transition.examType === 'quiz')
        await finalizeSubmission(studentId, transition.examType);
    return transition;
}
async function startExamAtomically(studentId) {
    return db.withTransaction(async (tx) => {
        const context = await getExamContext(studentId, tx);
        assertCanStart(context, new Date(), USE_SQLITE || process.env.SKIP_TIME_CHECK === 'true');
        const locked = (await tx.query(`SELECT s.*, b.duration, b.end_time, b.blueprint, b.exam_type
       FROM students s JOIN batches b ON b.id = s.batch_id
       WHERE s.id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}`, [studentId])).rows[0];
        assertCanStart({ ...context, status: locked.status }, new Date(), USE_SQLITE || process.env.SKIP_TIME_CHECK === 'true');
        const existing = await tx.query('SELECT COUNT(*) AS count FROM exam_questions WHERE student_id = ?', [studentId]);
        const existingCount = Number(existing.rows[0]?.count || 0);
        if (locked.status === 'in_progress' && existingCount > 0) {
            await tx.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [studentId]);
            return { success: true, questions_count: existingCount, resume: true };
        }
        await tx.query('DELETE FROM exam_questions WHERE student_id = ?', [studentId]);
        const { blueprintMode, items: blueprintItems } = parseBlueprintCompat(locked.blueprint);
        if (blueprintItems.length === 0) {
            throw new ExamGuardError(422, 'invalid_blueprint', 'Exam blueprint is empty or invalid');
        }
        const examType = locked.exam_type === 'quiz' ? 'quiz' : 'essay';
        const typeFilterSql = examType === 'quiz'
            ? `AND type IN ('SingleChoice', 'MultipleChoice')`
            : `AND type NOT IN ('SingleChoice', 'MultipleChoice')`;
        const picked = [];
        for (const item of blueprintItems) {
            if (!item || typeof item.module !== 'string' || !item.module.trim()) {
                throw new ExamGuardError(422, 'invalid_blueprint', 'Exam blueprint contains an invalid module');
            }
            if (blueprintMode === 'type' && (typeof item.type !== 'string' || !item.type.trim())) {
                throw new ExamGuardError(422, 'invalid_blueprint', 'Exam blueprint contains an invalid question type');
            }
            for (const level of ['Easy', 'Medium', 'Hard']) {
                const count = Number(item[level.toLowerCase()] || 0);
                if (count <= 0)
                    continue;
                const blueprintTypeSql = blueprintMode === 'type' ? 'AND LOWER(type) = LOWER(?)' : '';
                const queryParams = blueprintMode === 'type'
                    ? [item.module.trim(), level, item.type.trim(), count]
                    : [item.module.trim(), level, count];
                const available = await tx.query(`
          SELECT id, type, options FROM question_bank
          WHERE LOWER(module) = LOWER(?) AND LOWER(level) = LOWER(?) ${blueprintTypeSql} ${typeFilterSql}
          ORDER BY RANDOM() LIMIT ?
        `, queryParams);
                for (const q of available.rows)
                    picked.push({ id: q.id, type: q.type, options: q.options ?? null });
            }
        }
        for (let i = picked.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1);
            [picked[i], picked[j]] = [picked[j], picked[i]];
        }
        for (let i = 0; i < picked.length; i++) {
            const q = picked[i];
            let optionOrder = null;
            if ((q.type === 'SingleChoice' || q.type === 'MultipleChoice') && q.options) {
                try {
                    const keys = JSON.parse(q.options).map((option) => option.key);
                    for (let a = keys.length - 1; a > 0; a--) {
                        const b = crypto.randomInt(a + 1);
                        [keys[a], keys[b]] = [keys[b], keys[a]];
                    }
                    optionOrder = JSON.stringify(keys);
                }
                catch { }
            }
            await tx.query('INSERT INTO exam_questions (student_id, question_id, question_order, option_order) VALUES (?, ?, ?, ?)', [studentId, q.id, i + 1, optionOrder]);
        }
        const now = new Date();
        const batchEnd = new Date(locked.end_time);
        const deadline = computeExamDeadline(now, Number(locked.duration || 30), batchEnd);
        await tx.query(`UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?,
       disconnected_at = NULL, recording_finalized_at = NULL, recording_final_part_index = NULL,
       recording_incomplete = FALSE WHERE id = ?`, [now.toISOString(), deadline.toISOString(), studentId]);
        return { success: true, questions_count: picked.length };
    });
}
/**
 * Anti-Cheat: đánh giá phiên đồng thời và cưỡng chế xử lý.
 * - suspicious (đổi IP/UA/nhiều jti) → chỉ ghi forensic 'concurrent_session'.
 * - lockable (chồng lấn thời gian) → ghi forensic + auto-submit ngay ở backend.
 * Bọc try/catch toàn bộ: lỗi detect KHÔNG được làm hỏng request thi.
 * Trả về true nếu đã auto-lock (để caller biết mà dừng phục vụ nội dung).
 */
async function enforceConcurrentSession(studentId, batchId) {
    try {
        // [P2-4] Short-circuit nếu đã nộp — sau lần overlap đầu tiên auto-submit, client vẫn có
        // thể spam /answer|/questions|/violation; sessionTracker vẫn upsert và overlap còn trong
        // cửa sổ 60s, không được để mỗi request đó tạo thêm row.
        const statusRow0 = await db.query('SELECT status FROM students WHERE id = ?', [studentId]);
        if (statusRow0.rows[0]?.status !== 'in_progress')
            return false;
        const ev = await detectConcurrentSession(studentId);
        if (!ev.suspicious)
            return false;
        // [P2-3][P2-4] Dedupe theo fingerprint bằng chứng — áp dụng cho CẢ overlap (không còn ghi
        // trên mọi request khi overlap). "Lần overlap đầu tiên luôn ghi" được bảo đảm bằng cách
        // đưa overlap vào chính fingerprint: fingerprint có overlap:true là mới ⇒ chưa có trong map
        // ⇒ ghi ngay; các request overlap tiếp theo cùng fingerprint bị throttle 60s.
        const fingerprint = JSON.stringify({
            ips: [...ev.ips].sort(),
            userAgents: [...ev.userAgents].sort(),
            jtis: [...ev.jtis].sort(),
            overlap: ev.overlap,
        });
        const dedupKey = `${studentId}:${fingerprint}`;
        const nowMs = Date.now();
        const lastMs = lastConcurrentForensic.get(dedupKey) || 0;
        // [P2-3] Chặn race nội-instance: nếu key đang có INSERT chạy dở thì bỏ qua — không thì hai
        // request đồng thời cùng đọc lastMs=0, cùng vượt gate, cùng ghi. `shouldLog` gồm cả điều
        // kiện in-flight để không đợi INSERT xong mới biết trùng.
        const shouldLog = !inflightConcurrentForensic.has(dedupKey) &&
            (nowMs - lastMs >= FORENSIC_DEDUP_MS || lastMs === 0);
        if (shouldLog) {
            inflightConcurrentForensic.add(dedupKey); // đánh dấu TRƯỚC await
            try {
                const metadataJson = JSON.stringify({
                    ips: ev.ips,
                    userAgents: ev.userAgents,
                    jtis: ev.jtis,
                    overlap: ev.overlap,
                }).slice(0, 2000);
                await db.query('INSERT INTO violation_events (student_id, batch_id, type, text_length, content_preview, question_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)', [studentId, batchId, 'concurrent_session', ev.ips.length, `IPs: ${ev.ips.join(', ')}`.slice(0, 500), null, metadataJson]);
                // [P2-3] CHỈ set timestamp SAU khi insert thành công — insert lỗi tạm thời không được
                // suppress 60s và làm mất cơ hội ghi lại evidence ở request kế.
                lastConcurrentForensic.set(dedupKey, nowMs);
            }
            catch (logErr) {
                console.error('[concurrent_session] forensic log failed (non-fatal):', logErr?.message);
            }
            finally {
                inflightConcurrentForensic.delete(dedupKey); // dọn dù thành công hay lỗi
            }
        }
        if (ev.lockable) {
            // status đã xác nhận in_progress ở đầu hàm.
            await submitExamAtomically(studentId, 'concurrent_session');
            console.log('[concurrent_session] Auto-submitted (overlap) student:', studentId, 'ips:', ev.ips);
            return true;
        }
        return false;
    }
    catch (err) {
        console.error('[enforceConcurrentSession] failed:', err?.message);
        throw err;
    }
}
/**
 * [P1-2] Đường cưỡng chế lock DUY NHẤT, dùng chung cho cả event mới lẫn replay.
 * Nếu đạt ngưỡng khóa và student còn 'in_progress' thì auto-submit — kể cả khi request
 * TRƯỚC đã tính locked nhưng submitExamAtomically lỗi tạm thời rồi client retry vào nhánh
 * replay. Vì submitExamAtomically idempotent (return { already } nếu đã submitted), gọi lại
 * an toàn. Ném lỗi ra ngoài để caller trả 500 → client tiếp tục retry cho tới khi lock chốt.
 */
async function ensureViolationLock(studentId, type, currentCount, total, forensicOnly) {
    const locked = computeViolationLock(type, currentCount, total, forensicOnly);
    if (!locked)
        return false;
    const statusRow = await db.query('SELECT status FROM students WHERE id = ?', [studentId]);
    if (statusRow.rows[0]?.status === 'in_progress') {
        await submitExamAtomically(studentId, type === 'recording_stopped' ? 'recording_stopped' : 'violation');
        console.log('[violation] Auto-submitted (locked) student:', studentId, 'type:', type);
    }
    return true;
}
router.post('/verify', verifyRateLimit, async (req, res) => {
    try {
        const { access_code } = req.body;
        if (!access_code) {
            return res.status(400).json({ error: 'Access code required' });
        }
        const result = await db.query(`
      SELECT s.*, b.name as batch_name, b.start_time, b.end_time, b.duration, b.record_enabled, b.record_mode
      FROM students s
      JOIN batches b ON s.batch_id = b.id
      WHERE s.access_code = ?
    `, [access_code]);
        const student = result.rows[0];
        if (!student) {
            return res.status(404).json({ error: 'Invalid access code' });
        }
        if (student.status === 'submitted') {
            return res.status(400).json({ error: 'Exam already submitted' });
        }
        // Cho phép in_progress để resume exam (không block)
        const nowGMT7 = toGMT7(new Date());
        const startTime = toGMT7(new Date(student.start_time));
        const endTime = toGMT7(new Date(student.end_time));
        // Skip time check in development mode (USE_SQLITE=true)
        const isDevMode = USE_SQLITE || process.env.SKIP_TIME_CHECK === 'true';
        if (!isDevMode && (nowGMT7 < startTime || nowGMT7 > endTime)) {
            return res.status(400).json({
                error: 'Exam is not available at this time',
                scheduled: `${startTime.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} - ${endTime.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`
            });
        }
        const emailsResult = await db.query(`
      SELECT email FROM students 
      WHERE batch_id = ? AND access_code = ?
    `, [student.batch_id, access_code]);
        // [C-4] Cấp student token (JWT ngắn hạn 4h) — không trả raw studentId dạng tin tưởng nữa
        const secret = process.env.JWT_SECRET;
        // jti: định danh phiên riêng cho mỗi lần verify — dùng phát hiện dùng đồng thời nhiều client
        const jti = crypto.randomUUID();
        await db.query('UPDATE students SET active_jti = ? WHERE id = ?', [jti, student.id]);
        const studentToken = jwt.sign({ studentId: student.id, batchId: student.batch_id, jti }, secret, { expiresIn: '4h' });
        // Chế độ ghi màn hình: 'none' | 'local' | 's3'. record_enabled cũ vẫn được suy ra để tương thích.
        const recordMode = student.record_mode || (student.record_enabled ? 's3' : 'none');
        // Với mode 'local': cấp password mã hóa zip (server sinh & giữ, học viên KHÔNG thấy).
        // Sinh 1 lần rồi tái dùng để resume-after-reload dùng lại đúng pass. Học viên chỉ
        // dùng ngầm để mã hóa file .zip; muốn xem lại video phải lấy pass từ trang Results.
        let recordingPassword = student.recording_password || null;
        if (recordMode === 'local' && !recordingPassword) {
            recordingPassword = crypto.randomBytes(24).toString('base64url');
            await db.query('UPDATE students SET recording_password = ? WHERE id = ?', [recordingPassword, student.id]);
        }
        res.json({
            valid: true,
            student_token: studentToken,
            access_code: student.access_code,
            emails: emailsResult.rows.map((s) => s.email),
            duration: student.duration,
            student_id: student.id, // giữ lại để hiển thị UI (không dùng cho auth)
            dev_mode: isDevMode,
            exam_start: startTime.toISOString(),
            exam_end: endTime.toISOString(),
            record_enabled: !!student.record_enabled, // giữ để tương thích ngược
            record_mode: recordMode,
            // chỉ trả pass khi local — client dùng ngầm để mã hóa, không hiển thị
            recording_password: recordMode === 'local' ? recordingPassword : undefined,
        });
    }
    catch (error) {
        if (sendExamGuardError(res, error))
            return;
        res.status(500).json({ error: error.message });
    }
});
router.post('/select-email', async (req, res) => {
    try {
        const { student_id, email } = req.body;
        const result = await db.query('SELECT * FROM students WHERE id = ? AND email = ?', [student_id, email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Invalid student or email' });
        }
        res.json({ valid: true, student_id: result.rows[0].id });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/exam/start', studentAuthMiddleware, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const student_id = req.studentPayload.studentId;
        const startedExam = await startExamAtomically(student_id);
        return res.json(startedExam);
        /* Legacy implementation retained temporarily below for source compatibility; unreachable after atomic start. */
        console.log('[startExam] student_id:', student_id);
        const studentResult = await db.query('SELECT s.*, b.duration, b.end_time FROM students s JOIN batches b ON s.batch_id = b.id WHERE s.id = ?', [student_id]);
        const student = studentResult.rows[0];
        console.log('[startExam] student:', student);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        console.log('[startExam] student.status:', student.status);
        if (student.status === 'submitted') {
            return res.status(400).json({ error: 'Exam already submitted' });
        }
        if (student.status === 'in_progress') {
            const existingQuestions = await db.query('SELECT COUNT(*) as count FROM exam_questions WHERE student_id = ?', [student_id]);
            if (existingQuestions.rows[0].count === 0) {
                console.log('[startExam] Resume but no questions, generating...');
                // Fall through to generate questions below
            }
            else {
                console.log('[startExam] Resume exam for student in_progress, questions:', existingQuestions.rows[0].count);
                // Xoá disconnected_at khi resume thành công
                await db.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [student_id]);
                return res.json({ success: true, questions_count: existingQuestions.rows[0].count, resume: true });
            }
        }
        else {
            // Auto-reset: Xóa exam_questions cũ nếu status = pending (phòng trường hợp có dữ liệu cũ)
            if (student.status === 'pending') {
                await db.query('DELETE FROM exam_questions WHERE student_id = ?', [student_id]);
                console.log('[startExam] Auto-reset: Xóa exam_questions cũ (nếu có)');
            }
        }
        const batchResult = await db.query('SELECT blueprint, exam_type FROM batches WHERE id = ?', [student.batch_id]);
        const batch = batchResult.rows[0];
        const { blueprintMode, items: blueprintItems } = parseBlueprintCompat(batch?.blueprint);
        const examType = batch?.exam_type === 'quiz' ? 'quiz' : 'essay';
        // Batch quiz chỉ lấy câu trắc nghiệm; batch essay chỉ lấy câu tự luận/coding.
        // Tránh lôi nhầm câu khác loại khi một module chứa lẫn cả hai (blueprint mode 'module').
        const typeFilterSql = examType === 'quiz'
            ? `AND type IN ('SingleChoice', 'MultipleChoice')`
            : `AND type NOT IN ('SingleChoice', 'MultipleChoice')`;
        // Mỗi câu kèm type + options (để sinh thứ tự đáp án xáo cho câu quiz)
        const picked = [];
        for (const item of blueprintItems) {
            for (const level of ['Easy', 'Medium', 'Hard']) {
                const count = item[level.toLowerCase()];
                if (count > 0) {
                    const blueprintTypeSql = blueprintMode === 'type' ? 'AND LOWER(type) = LOWER(?)' : '';
                    const queryParams = blueprintMode === 'type'
                        ? [item.module, level, item.type, count]
                        : [item.module, level, count];
                    const availableResult = await db.query(`
            SELECT id, type, options FROM question_bank
            WHERE LOWER(module) = LOWER(?) AND LOWER(level) = LOWER(?) ${blueprintTypeSql} ${typeFilterSql}
            ORDER BY RANDOM()
            LIMIT ?
          `, queryParams);
                    for (const q of availableResult.rows) {
                        picked.push({ id: q.id, type: q.type, options: q.options ?? null });
                    }
                }
            }
        }
        // Fisher–Yates: xáo thứ tự CÂU cho riêng học viên này
        for (let i = picked.length - 1; i > 0; i--) {
            const j = crypto.randomInt(i + 1);
            [picked[i], picked[j]] = [picked[j], picked[i]];
        }
        for (let i = 0; i < picked.length; i++) {
            const q = picked[i];
            // Câu quiz (Single/Multiple): xáo thứ tự các key option và persist để chấm/F5 ổn định
            let optionOrder = null;
            if ((q.type === 'SingleChoice' || q.type === 'MultipleChoice') && q.options) {
                try {
                    const opts = JSON.parse(q.options);
                    const keys = opts.map((o) => o.key);
                    for (let a = keys.length - 1; a > 0; a--) {
                        const b = crypto.randomInt(a + 1);
                        [keys[a], keys[b]] = [keys[b], keys[a]];
                    }
                    optionOrder = JSON.stringify(keys);
                }
                catch (_) { /* options lỗi → để NULL, client hiển thị theo thứ tự gốc */ }
            }
            await db.query(`
        INSERT INTO exam_questions (student_id, question_id, question_order, option_order)
        VALUES (?, ?, ?, ?)
      `, [student_id, q.id, i + 1, optionOrder]);
        }
        // Ghi thời điểm bắt đầu và deadline (chỉ set khi chưa có)
        const durationSeconds = (student.duration || 30) * 60;
        const now = new Date();
        const deadline = computeExamDeadline(now, durationSeconds / 60, new Date(student.end_time));
        await db.query("UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL WHERE id = ?", [now.toISOString(), deadline.toISOString(), student_id]);
        res.json({ success: true, questions_count: picked.length });
    }
    catch (error) {
        if (sendExamGuardError(res, error))
            return;
        res.status(500).json({ error: error.message });
    }
});
router.get('/exam/questions', studentAuthMiddleware, sessionTracker, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        // [C-4] Đọc studentId từ token đã xác thực, không tin x-student-id header
        const studentId = req.studentPayload.studentId.toString();
        // === SERVER-SIDE TIMER GUARD ===
        const studentResult = await db.query(`
      SELECT s.status, s.exam_deadline, s.disconnected_at, b.duration
      FROM students s
      JOIN batches b ON s.batch_id = b.id
      WHERE s.id = ?
    `, [parseInt(studentId)]);
        const student = studentResult.rows[0];
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        if (student.status === 'submitted') {
            return res.status(410).json({
                error: 'Exam already submitted',
                reason: 'submitted'
            });
        }
        const now = new Date();
        // Nếu học viên mới bắt đầu truy cập bài thi lần đầu (status = pending)
        if (student.status === 'pending') {
            return res.json({ questions: [], time_remaining: null });
        }
        // Kiểm tra deadline đã qua chưa
        if (student.exam_deadline) {
            const deadline = new Date(student.exam_deadline);
            if (now >= deadline) {
                console.log('[getQuestions] Deadline passed, auto-submitting student:', studentId);
                await submitExamAtomically(parseInt(studentId), 'timeout');
                return res.status(410).json({
                    error: 'Time is up. Your exam has been automatically submitted.',
                    reason: 'timeout'
                });
            }
        }
        // Kiểm tra thời gian vắng mặt (disconnected > 2 phút)
        const DISCONNECT_GRACE_SECONDS = 120; // 2 phút
        if (student.disconnected_at) {
            const disconnectedAt = new Date(student.disconnected_at);
            const absentSeconds = (now.getTime() - disconnectedAt.getTime()) / 1000;
            if (absentSeconds > DISCONNECT_GRACE_SECONDS) {
                console.log('[getQuestions] Student absent too long (%ds), auto-submitting:', Math.round(absentSeconds));
                await submitExamAtomically(parseInt(studentId), 'absent_too_long');
                await db.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [parseInt(studentId)]);
                return res.status(410).json({
                    error: 'You were absent for more than 2 minutes. Your exam has been automatically submitted.',
                    reason: 'absent_too_long'
                });
            }
            // Trong grace period: xóa disconnected_at (học viên đã quay lại đúng hạn)
            await db.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [parseInt(studentId)]);
        }
        // === CONCURRENT SESSION GUARD ===
        // Endpoint này được poll đều đặn nên là nơi tự nhiên để phát hiện phiên song song,
        // kể cả khi client kia không gửi violation. Auto-lock khi có chồng lấn thời gian.
        const autoLocked = await enforceConcurrentSession(parseInt(studentId), req.studentPayload.batchId);
        if (autoLocked) {
            return res.status(410).json({
                error: 'Multiple concurrent sessions detected. Your exam has been automatically submitted.',
                reason: 'concurrent_session'
            });
        }
        // Tính time_remaining từ server
        let time_remaining = null;
        if (student.exam_deadline) {
            const deadline = new Date(student.exam_deadline);
            time_remaining = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));
        }
        // === END GUARD ===
        // Lưu ý bảo mật: KHÔNG select q.correct_answers — đáp án đúng không bao giờ rời server.
        const result = await db.query(`
      SELECT eq.question_order, eq.answer, eq.option_order, q.id, q.type, q.level, q.module, q.question_sample, q.options
      FROM exam_questions eq
      JOIN question_bank q ON eq.question_id = q.id
      WHERE eq.student_id = ?
      ORDER BY eq.question_order
    `, [parseInt(studentId)]);
        const questions = result.rows.map((q) => {
            const isQuiz = q.type === 'SingleChoice' || q.type === 'MultipleChoice';
            let options;
            if (isQuiz && q.options) {
                try {
                    const parsed = JSON.parse(q.options);
                    const order = q.option_order ? JSON.parse(q.option_order) : null;
                    if (order && order.length) {
                        const byKey = new Map(parsed.map((o) => [o.key, o]));
                        options = order.map((k) => byKey.get(k)).filter(Boolean);
                    }
                    else {
                        options = parsed;
                    }
                }
                catch (_) {
                    options = undefined;
                }
            }
            return {
                question_order: q.question_order,
                id: q.id,
                type: q.type,
                level: q.level,
                module: q.module,
                question_sample: q.question_sample,
                answer: q.answer || '',
                ...(options ? { options } : {}),
            };
        });
        res.json({ questions, time_remaining });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Endpoint nhận beacon khi học viên tắt trình duyệt / đóng tab
// [C-4] sendBeacon không hỗ trợ custom headers nên token được gửi trong body
router.post('/exam/disconnect', studentAuthMiddleware, async (req, res) => {
    try {
        const studentId = req.studentPayload.studentId.toString();
        const studentResult = await db.query('SELECT status FROM students WHERE id = ?', [parseInt(studentId)]);
        const student = studentResult.rows[0];
        // Chỉ ghi disconnected_at nếu đang in_progress
        if (student && student.status === 'in_progress') {
            await db.query('UPDATE students SET disconnected_at = ? WHERE id = ?', [new Date().toISOString(), parseInt(studentId)]);
            console.log('[disconnect] Ghi disconnected_at cho student:', studentId);
        }
        res.status(204).send();
    }
    catch (error) {
        // Không trả lỗi để không block beacon
        res.status(204).send();
    }
});
router.post('/exam/answers', studentAuthMiddleware, sessionTracker, async (req, res) => {
    try {
        const studentId = req.studentPayload.studentId;
        const autoLocked = await enforceConcurrentSession(studentId, req.studentPayload.batchId);
        if (autoLocked) {
            return res.status(410).json({ error: 'Multiple concurrent sessions detected', reason: 'concurrent_session' });
        }
        const saved = await db.withTransaction(async (tx) => {
            const row = (await tx.query(`SELECT status, exam_deadline FROM students WHERE id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}`, [studentId])).rows[0];
            if (!row || row.status !== 'in_progress') {
                const error = new Error('Exam is no longer accepting answers');
                error.code = 'NOT_ACCEPTING';
                throw error;
            }
            if (!row.exam_deadline || new Date() >= new Date(row.exam_deadline)) {
                const error = new Error('Deadline passed');
                error.code = 'DEADLINE_PASSED';
                throw error;
            }
            return persistAnswerBatch(tx, studentId, req.body?.answers);
        });
        return res.json({ success: true, persisted: saved });
    }
    catch (error) {
        if (error?.code === 'DEADLINE_PASSED') {
            await submitExamAtomically(req.studentPayload.studentId, 'timeout');
            return res.status(410).json({ error: error.message, reason: 'timeout' });
        }
        if (error?.code === 'NOT_ACCEPTING') {
            return res.status(410).json({ error: error.message, reason: 'submitted_or_timeout' });
        }
        if (error?.code === 'INVALID_ANSWERS')
            return res.status(400).json({ error: error.message });
        return res.status(500).json({ error: error.message });
    }
});
router.post('/exam/answer', studentAuthMiddleware, sessionTracker, async (req, res) => {
    try {
        // [C-4] studentId từ token đã xác thực
        const studentId = req.studentPayload.studentId.toString();
        const questionOrder = Number(req.body?.question_order);
        let answer = req.body?.answer;
        if (!Number.isInteger(questionOrder) || questionOrder <= 0 || typeof answer !== 'string') {
            return res.status(400).json({ error: 'Invalid answer payload' });
        }
        if (answer.length > 100_000)
            return res.status(413).json({ error: 'Answer is too large' });
        // [SEC] Không nhận answer sau khi đã nộp hoặc quá deadline.
        // Trước đây /answer chỉ buffer mù → sau khi bị khóa/auto-submit vẫn ghi đè được đáp án.
        const assigned = (await db.query(`
      SELECT q.type, q.options
      FROM exam_questions eq JOIN question_bank q ON q.id = eq.question_id
      WHERE eq.student_id = ? AND eq.question_order = ?
    `, [parseInt(studentId), questionOrder])).rows[0];
        if (!assigned)
            return res.status(404).json({ error: 'Question is not assigned to this student' });
        if (assigned.type === 'SingleChoice' || assigned.type === 'MultipleChoice') {
            let selected;
            try {
                selected = JSON.parse(answer);
            }
            catch {
                return res.status(400).json({ error: 'Invalid quiz answer' });
            }
            if (!Array.isArray(selected) || selected.some((key) => typeof key !== 'string')) {
                return res.status(400).json({ error: 'Invalid quiz answer' });
            }
            const allowed = new Set();
            try {
                for (const option of JSON.parse(assigned.options || '[]'))
                    allowed.add(option.key);
            }
            catch { }
            selected = [...new Set(selected)];
            if (selected.some((key) => !allowed.has(key)) || (assigned.type === 'SingleChoice' && selected.length > 1)) {
                return res.status(400).json({ error: 'Invalid quiz option' });
            }
            answer = JSON.stringify(selected);
        }
        // [#4][P1-2] Đánh giá đa phiên TRƯỚC khi ghi answer. Nếu để sau UPDATE thì request
        // của client thứ hai (chính request gây phát hiện multi-IP) vẫn kịp ghi đè answer,
        // rồi auto-submit lại chấm đúng answer bẩn đó. sessionTracker (middleware) đã upsert
        // last_seen cho request này nên detect thấy phiên hiện tại. Answer request đã tồn tại
        // sẵn → piggyback, không tạo request/heartbeat mới (an toàn free tier).
        try {
            const autoLocked = await enforceConcurrentSession(parseInt(studentId), req.studentPayload.batchId);
            if (autoLocked) {
                return res.status(410).json({
                    error: 'Multiple concurrent sessions detected. Your exam has been automatically submitted.',
                    reason: 'concurrent_session',
                });
            }
        }
        catch (concErr) {
            // Không để lỗi detect làm hỏng luồng answer
            console.error('[answer] concurrent-session check failed (non-fatal):', concErr?.message);
        }
        // Lưu vào buffer trước
        const saved = await db.query(`
      UPDATE exam_questions
      SET answer = ?
      WHERE student_id = ? AND question_order = ?
        AND EXISTS (
          SELECT 1 FROM students s
          WHERE s.id = exam_questions.student_id
            AND s.status = 'in_progress'
            AND s.exam_deadline IS NOT NULL
            AND s.exam_deadline > CURRENT_TIMESTAMP
        )
    `, [answer, parseInt(studentId), questionOrder]);
        if (saved.rowCount !== 1) {
            const current = (await db.query('SELECT status, exam_deadline FROM students WHERE id = ?', [parseInt(studentId)])).rows[0];
            if (current?.status === 'in_progress' && current.exam_deadline && new Date() >= new Date(current.exam_deadline)) {
                await submitExamAtomically(parseInt(studentId), 'timeout');
                return res.status(410).json({ error: 'Deadline passed', reason: 'timeout' });
            }
            return res.status(410).json({ error: 'Exam is no longer accepting answers', reason: 'submitted_or_timeout' });
        }
        res.json({ success: true, persisted: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/exam/flush', studentAuthMiddleware, async (req, res) => {
    try {
        // [C-4] studentId từ token xác thực
        // flush toàn bộ buffer (bao gồm cả của student hiện tại) — ok vì chỉ admin-triggered
        await cache.flushAnswers();
        res.json({ success: true, flushed: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/exam/submit', studentAuthMiddleware, async (req, res) => {
    const startedAt = Date.now();
    try {
        // [C-4] studentId từ token đã xác thực
        const studentId = req.studentPayload.studentId.toString();
        // [SEC] Idempotent: nếu đã submitted thì trả OK ngay, không flush/queue lại
        // (tránh re-queue chấm điểm trùng khi client gọi submit nhiều lần).
        const result = await submitExamAtomically(parseInt(studentId), 'manual', { answers: req.body?.answers });
        res.json({ success: true, already: result.already, message: 'Exam submitted. Results will be available shortly.' });
    }
    catch (error) {
        console.error('Submit error:', error);
        if (error?.code === 'INVALID_ANSWERS')
            return res.status(400).json({ error: error.message });
        res.status(500).json({ error: error.message });
    }
    finally {
        const pool = db.getPool();
        console.info('[Metrics] exam_submit', {
            duration_ms: Date.now() - startedAt,
            status_code: res.statusCode,
            answer_count: Array.isArray(req.body?.answers) ? req.body.answers.length : 0,
            pool_total: typeof pool?.totalCount === 'number' ? pool.totalCount : undefined,
            pool_idle: typeof pool?.idleCount === 'number' ? pool.idleCount : undefined,
            pool_waiting: typeof pool?.waitingCount === 'number' ? pool.waitingCount : undefined,
        });
    }
});
router.post('/violation', studentAuthMiddleware, sessionTracker, async (req, res) => {
    try {
        // [C-4] studentId từ token đã xác thực
        const studentId = req.studentPayload.studentId.toString();
        const batchId = req.studentPayload.batchId;
        // [SEC] Kiểm tra phiên đồng thời trước — nếu chồng lấn thời gian, backend auto-lock ngay.
        const autoLocked = await enforceConcurrentSession(parseInt(studentId), batchId);
        if (autoLocked) {
            return res.json({ violation_count: 0, total_violations: 0, locked: true, reason: 'concurrent_session' });
        }
        const { type, content_preview, text_length, question_id, metadata } = req.body;
        // Validate violation type — chỉ chấp nhận các loại hợp lệ.
        // suspicious_paste is accepted as forensic evidence but never auto-locks:
        // insertion size alone cannot prove clipboard use. focus_lost remains
        // lockable because it is measured through blur/focus with a grace period.
        const validTypes = [
            'tab_switch',
            'fullscreen_exit',
            'copy_attempt',
            'cut_attempt',
            'paste_attempt',
            'devtools_open',
            'view_source',
            'extension_panel',
            'screenshot_attempt', // phím PrintScreen / PrtSc
            'print_attempt', // Ctrl+P hoặc browser print dialog
            'suspicious_paste', // Thâm nhập text lớn bất thường qua Maccy/Win+V Accessibility API
            'focus_lost', // Mất focus cửa sổ (Split View / mở app khác trên macOS)
            'recording_stopped', // Thí sinh tự dừng chia sẻ màn hình giữa bài (getDisplayMedia track ended)
            'rapid_text_insertion',
            'multiple_display_detected',
            'concurrent_session', // dùng đồng thời nhiều client/IP — server tự phát hiện & ghi
        ];
        if (!type || !validTypes.includes(type)) {
            return res.status(400).json({ error: 'Invalid violation type' });
        }
        const forensicOnly = isForensicOnlyViolation(type);
        const eventId = typeof req.body?.event_id === 'string' ? req.body.event_id.slice(0, 64) : null;
        const preview = typeof content_preview === 'string' ? content_preview.slice(0, 500) : null;
        const textLen = Number.isFinite(text_length) ? Math.trunc(text_length) : null;
        const qId = typeof question_id === 'string' ? question_id : null;
        const metadataJson = metadata && typeof metadata === 'object'
            ? JSON.stringify(metadata).slice(0, 2000)
            : null;
        // [P1-1] Claim event + upsert counter + đọc total/current TRONG MỘT TRANSACTION, qua module
        // dùng chung `persistViolation` (route và regression test gọi CHUNG hàm này — test không
        // sao chép SQL). Nguyên tử: event + counter cùng commit/rollback (không còn half-commit).
        // KHÔNG có fallback non-idempotent: migration (event_id + 2 unique index) bắt buộc trước
        // deploy; transaction lỗi → propagate ra catch ngoài → 500 → client retry CÙNG event_id.
        const { replay, total, currentCount } = await db.withTransaction((tx) => persistViolation(tx, {
            studentId: parseInt(studentId),
            batchId,
            type,
            eventId,
            forensicOnly,
            textLength: textLen,
            contentPreview: preview,
            questionId: qId,
            metadataJson,
            lockStudentRow: !USE_SQLITE, // Postgres: khóa row student trong tx; SQLite tự serialize
        }));
        // [P1-2] CẢ event mới lẫn replay đều đi qua CHUNG một đường cưỡng chế lock. Nếu request
        // trước tính locked nhưng submitExamAtomically lỗi tạm thời (student vẫn in_progress),
        // replay sẽ thử lại tại đây thay vì chỉ trả locked:true mà bỏ qua auto-submit. Lỗi ở
        // ensureViolationLock ném ra ngoài → 500 → client retry tiếp cho tới khi lock chốt.
        const locked = await ensureViolationLock(parseInt(studentId), type, currentCount, total, forensicOnly);
        res.json({
            violation_count: currentCount,
            total_violations: total,
            locked,
            forensic_only: forensicOnly,
            ...(replay ? { idempotent_replay: true } : {}),
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Cấp presigned PUT URL để client upload 1 phần video record thẳng lên S3.
// batchId/studentId lấy từ JWT — client KHÔNG thể chỉ định để ghi đè video người khác.
router.post('/exam/recording-url', studentAuthMiddleware, async (req, res) => {
    try {
        if (!isS3Configured()) {
            return res.status(503).json({ error: 'S3 not configured' });
        }
        const studentId = req.studentPayload.studentId;
        const batchId = req.studentPayload.batchId;
        // Chỉ cấp URL khi batch ở mode 's3' (chốt chặn server-side, tránh mod/ai lách).
        // Mode 'local' ghi ra máy học viên, không dùng S3 → không cấp URL.
        const batchRes = await db.query(`
      SELECT b.record_mode, b.record_enabled, s.status, s.exam_deadline, s.submitted_at, s.recording_incomplete
      FROM batches b JOIN students s ON s.batch_id = b.id
      WHERE b.id = ? AND s.id = ?
    `, [batchId, studentId]);
        const batchMode = batchRes.rows[0]?.record_mode || (batchRes.rows[0]?.record_enabled ? 's3' : 'none');
        if (batchMode !== 's3') {
            return res.status(403).json({ error: 'S3 recording not enabled for this batch' });
        }
        const submittedRecordingGrace = batchRes.rows[0]?.status === 'submitted'
            && batchRes.rows[0]?.recording_incomplete
            && batchRes.rows[0]?.submitted_at
            && Date.now() - new Date(batchRes.rows[0].submitted_at).getTime() <= 15 * 60_000;
        if (batchRes.rows[0]?.status !== 'in_progress' && !submittedRecordingGrace) {
            return res.status(409).json({ error: 'Exam is not in progress' });
        }
        if (!submittedRecordingGrace && batchRes.rows[0]?.exam_deadline && new Date() >= new Date(batchRes.rows[0].exam_deadline)) {
            return res.status(410).json({ error: 'Deadline passed', reason: 'timeout' });
        }
        const { partIndex, contentType } = req.body;
        const idx = Number(partIndex);
        if (!Number.isInteger(idx) || idx < 0) {
            return res.status(400).json({ error: 'Invalid partIndex' });
        }
        const existingPart = await db.query('SELECT id FROM recording_parts WHERE student_id = ? AND part_index = ?', [studentId, idx]);
        if (existingPart.rows.length > 0) {
            return res.status(409).json({ error: 'Recording part has already been finalized' });
        }
        const { url, key } = await createRecordingUploadUrl({
            batchId,
            studentId,
            partIndex: idx,
            contentType: typeof contentType === 'string' ? contentType : undefined,
        });
        res.json({ url, key });
    }
    catch (error) {
        console.error('[recording-url] failed:', error?.message);
        res.status(500).json({ error: error.message });
    }
});
router.post('/exam/recording-complete', studentAuthMiddleware, async (req, res) => {
    try {
        const studentId = req.studentPayload.studentId;
        const batchId = req.studentPayload.batchId;
        const partIndex = Number(req.body?.partIndex);
        if (!Number.isInteger(partIndex) || partIndex < 0) {
            return res.status(400).json({ error: 'Invalid recording part metadata' });
        }
        const exam = (await db.query(`
      SELECT s.status, s.submitted_at, s.recording_incomplete, b.record_mode, b.record_enabled
      FROM students s JOIN batches b ON b.id = s.batch_id
      WHERE s.id = ? AND b.id = ?
    `, [studentId, batchId])).rows[0];
        const recordMode = exam?.record_mode || (exam?.record_enabled ? 's3' : 'none');
        const submittedRecordingGrace = exam?.status === 'submitted' && exam?.recording_incomplete && exam?.submitted_at
            && Date.now() - new Date(exam.submitted_at).getTime() <= 15 * 60_000;
        if (!exam || (exam.status !== 'in_progress' && !submittedRecordingGrace))
            return res.status(409).json({ error: 'Exam is not accepting recording parts' });
        if (recordMode !== 's3')
            return res.status(403).json({ error: 'S3 recording is not enabled' });
        const objectKey = `recordings/${batchId}/${studentId}/part${String(partIndex).padStart(3, '0')}.webm`;
        const { byteSize } = await inspectRecordingObject(objectKey);
        if (byteSize <= 0)
            return res.status(422).json({ error: 'Uploaded recording part is empty' });
        await db.query(`
      INSERT INTO recording_parts (student_id, batch_id, part_index, object_key, byte_size, uploaded_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (student_id, part_index) DO NOTHING
    `, [studentId, batchId, partIndex, objectKey, Math.trunc(byteSize), new Date().toISOString()]);
        res.json({ success: true, key: objectKey });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/exam/recording-finalize', studentAuthMiddleware, async (req, res) => {
    try {
        const studentId = req.studentPayload.studentId;
        const batchId = req.studentPayload.batchId;
        const finalPartIndex = Number(req.body?.finalPartIndex);
        if (!Number.isInteger(finalPartIndex) || finalPartIndex < 0 || finalPartIndex > 1000) {
            return res.status(400).json({ error: 'Invalid finalPartIndex' });
        }
        await db.withTransaction(async (tx) => {
            const row = (await tx.query(`
        SELECT s.status, s.submitted_at, s.recording_incomplete,
               s.recording_finalized_at, s.recording_final_part_index,
               b.record_mode, b.record_enabled
        FROM students s JOIN batches b ON b.id = s.batch_id
        WHERE s.id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}
      `, [studentId])).rows[0];
            const submittedRecordingGrace = row?.status === 'submitted' && row?.recording_incomplete && row?.submitted_at
                && Date.now() - new Date(row.submitted_at).getTime() <= 15 * 60_000;
            if (!row || (row.status !== 'in_progress' && !submittedRecordingGrace)) {
                throw Object.assign(new Error('Exam is not accepting recording finalization'), { code: 'NOT_IN_PROGRESS' });
            }
            const mode = row.record_mode || (row.record_enabled ? 's3' : 'none');
            if (mode !== 's3')
                throw Object.assign(new Error('S3 recording is not enabled'), { code: 'BAD_RECORD_MODE' });
            if (row.recording_finalized_at) {
                if (Number(row.recording_final_part_index) !== finalPartIndex) {
                    throw Object.assign(new Error('Recording was already finalized with a different manifest'), { code: 'MANIFEST_CONFLICT' });
                }
                return;
            }
            const parts = await tx.query('SELECT part_index FROM recording_parts WHERE student_id = ? ORDER BY part_index', [studentId]);
            if (parts.rows.length !== finalPartIndex + 1 || parts.rows.some((part, index) => Number(part.part_index) !== index)) {
                throw Object.assign(new Error('Recording parts are incomplete'), { code: 'RECORDING_INCOMPLETE' });
            }
            await tx.query('UPDATE recording_parts SET is_final = TRUE WHERE student_id = ? AND part_index = ?', [studentId, finalPartIndex]);
            await tx.query('UPDATE students SET recording_finalized_at = ?, recording_final_part_index = ?, recording_incomplete = FALSE WHERE id = ?', [new Date().toISOString(), finalPartIndex, studentId]);
        });
        res.json({ success: true, finalPartIndex });
    }
    catch (error) {
        const status = error?.code === 'RECORDING_INCOMPLETE' ? 409
            : error?.code === 'MANIFEST_CONFLICT' ? 409
                : error?.code === 'NOT_IN_PROGRESS' ? 409
                    : error?.code === 'BAD_RECORD_MODE' ? 403 : 500;
        res.status(status).json({ error: error.message, reason: error?.code?.toLowerCase() });
    }
});
export default router;
