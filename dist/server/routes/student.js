import { Router } from 'express';
import db from '../db/postgres.js';
import { cache } from '../cache.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { studentAuthMiddleware } from '../middleware/studentAuth.js';
import { createRecordingUploadUrl, inspectRecordingObject, isS3Configured } from '../services/s3.js';
dotenv.config();
const USE_SQLITE = process.env.USE_SQLITE === 'true' || process.env.NODE_ENV !== 'production';
const router = Router();
const toGMT7 = (utcDate) => {
    return new Date(utcDate.getTime() + 7 * 60 * 60 * 1000);
};
// Hoàn tất nộp bài: quiz → chấm tự động ngay (bỏ qua ai_queue); essay → đẩy hàng đợi AI.
// Dùng chung cho cả nộp thủ công lẫn auto-submit (timeout / vắng mặt quá lâu).
// Không tự set status='submitted' — caller đảm nhiệm việc đó.
async function finalizeSubmission(studentId) {
    const batchType = await db.query(`
    SELECT b.exam_type FROM students s JOIN batches b ON s.batch_id = b.id WHERE s.id = ?
  `, [studentId]);
    const examType = batchType.rows[0]?.exam_type || 'essay';
    if (examType === 'quiz') {
        const quizRows = await db.query(`
      SELECT eq.id, eq.answer, q.type, q.correct_answers, q.score
      FROM exam_questions eq
      JOIN question_bank q ON eq.question_id = q.id
      WHERE eq.student_id = ?
    `, [studentId]);
        const norm = (arr) => [...new Set(arr.map((s) => String(s).trim().toUpperCase()))].sort();
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
            await db.query('UPDATE exam_questions SET ai_score = ?, ai_feedback = ? WHERE id = ?', [gained, isCorrect ? 'Correct' : 'Incorrect', row.id]);
        }
    }
    else {
        const examQuestionsResult = await db.query('SELECT id FROM exam_questions WHERE student_id = ?', [studentId]);
        for (const eq of examQuestionsResult.rows) {
            cache.addToQueue(eq.id, studentId);
        }
    }
}
router.post('/verify', async (req, res) => {
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
        const studentToken = jwt.sign({ studentId: student.id, batchId: student.batch_id }, secret, { expiresIn: '4h' });
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
router.post('/exam/environment-ack', studentAuthMiddleware, async (req, res) => {
    try {
        const studentId = req.studentPayload.studentId;
        const { acknowledgements, environment } = req.body || {};
        const required = [
            'focusMode', 'notifications', 'iphoneMirroring',
            'universalControl', 'externalDisplays', 'clearWorkspace',
        ];
        if (!acknowledgements || required.some((key) => acknowledgements[key] !== true)) {
            return res.status(400).json({ error: 'All exam environment acknowledgements are required' });
        }
        const snapshot = {
            acknowledgements: Object.fromEntries(required.map((key) => [key, true])),
            environment: {
                platform: typeof environment?.platform === 'string' ? environment.platform.slice(0, 100) : 'unknown',
                screenCheckSupported: environment?.screenCheckSupported === true,
                screenExtended: typeof environment?.screenExtended === 'boolean' ? environment.screenExtended : null,
                screenWidth: Number.isFinite(environment?.screenWidth) ? Math.trunc(environment.screenWidth) : null,
                screenHeight: Number.isFinite(environment?.screenHeight) ? Math.trunc(environment.screenHeight) : null,
                devicePixelRatio: Number.isFinite(environment?.devicePixelRatio) ? environment.devicePixelRatio : null,
            },
        };
        if (snapshot.environment.screenExtended === true) {
            return res.status(409).json({ error: 'Multiple or extended displays are not allowed during the exam' });
        }
        await db.query('UPDATE students SET environment_acknowledged_at = ?, environment_snapshot = ? WHERE id = ?', [new Date().toISOString(), JSON.stringify(snapshot), studentId]);
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.post('/exam/start', studentAuthMiddleware, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const student_id = req.studentPayload.studentId;
        console.log('[startExam] student_id:', student_id);
        const studentResult = await db.query('SELECT s.*, b.duration FROM students s JOIN batches b ON s.batch_id = b.id WHERE s.id = ?', [student_id]);
        const student = studentResult.rows[0];
        console.log('[startExam] student:', student);
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        if (!student.environment_acknowledged_at) {
            return res.status(428).json({ error: 'Exam environment checklist must be completed before starting' });
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
        const blueprint = batch?.blueprint
            ? (typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : batch.blueprint)
            : [];
        const examType = batch?.exam_type === 'quiz' ? 'quiz' : 'essay';
        // Batch quiz chỉ lấy câu trắc nghiệm; batch essay chỉ lấy câu tự luận/coding.
        // Tránh lôi nhầm câu khác loại khi một module chứa lẫn cả hai (blueprint mode 'module').
        const typeFilterSql = examType === 'quiz'
            ? `AND type IN ('SingleChoice', 'MultipleChoice')`
            : `AND type NOT IN ('SingleChoice', 'MultipleChoice')`;
        // Mỗi câu kèm type + options (để sinh thứ tự đáp án xáo cho câu quiz)
        const picked = [];
        for (const item of blueprint) {
            for (const level of ['Easy', 'Medium', 'Hard']) {
                const count = item[level.toLowerCase()];
                if (count > 0) {
                    const availableResult = await db.query(`
            SELECT id, type, options FROM question_bank
            WHERE module = ? AND level = ? ${typeFilterSql}
            ORDER BY RANDOM()
            LIMIT ?
          `, [item.module, level, count]);
                    for (const q of availableResult.rows) {
                        picked.push({ id: q.id, type: q.type, options: q.options ?? null });
                    }
                }
            }
        }
        // Fisher–Yates: xáo thứ tự CÂU cho riêng học viên này
        for (let i = picked.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
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
                        const b = Math.floor(Math.random() * (a + 1));
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
        const deadline = new Date(now.getTime() + durationSeconds * 1000);
        await db.query("UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL WHERE id = ?", [now.toISOString(), deadline.toISOString(), student_id]);
        res.json({ success: true, questions_count: picked.length });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
router.get('/exam/questions', studentAuthMiddleware, async (req, res) => {
    try {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        // [C-4] Đọc studentId từ token đã xác thực, không tin x-student-id header
        const studentId = req.studentPayload.studentId.toString();
        // === SERVER-SIDE TIMER GUARD ===
        const studentResult = await db.query(`
      SELECT s.status, s.exam_deadline, s.disconnected_at, s.environment_acknowledged_at, b.duration
      FROM students s
      JOIN batches b ON s.batch_id = b.id
      WHERE s.id = ?
    `, [parseInt(studentId)]);
        const student = studentResult.rows[0];
        if (!student) {
            return res.status(404).json({ error: 'Student not found' });
        }
        if (!student.environment_acknowledged_at) {
            return res.status(428).json({ error: 'Exam environment checklist must be completed before loading questions' });
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
            const durationSeconds = (student.duration || 30) * 60;
            const deadline = new Date(now.getTime() + durationSeconds * 1000);
            await db.query("UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL WHERE id = ?", [now.toISOString(), deadline.toISOString(), parseInt(studentId)]);
            student.status = 'in_progress';
            student.exam_deadline = deadline;
        }
        // Kiểm tra deadline đã qua chưa
        if (student.exam_deadline) {
            const deadline = new Date(student.exam_deadline);
            if (now >= deadline) {
                console.log('[getQuestions] Deadline passed, auto-submitting student:', studentId);
                await db.query("UPDATE students SET status = 'submitted' WHERE id = ?", [parseInt(studentId)]);
                await cache.flushAnswers();
                await finalizeSubmission(parseInt(studentId));
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
                await db.query("UPDATE students SET status = 'submitted', disconnected_at = NULL WHERE id = ?", [parseInt(studentId)]);
                await cache.flushAnswers();
                await finalizeSubmission(parseInt(studentId));
                return res.status(410).json({
                    error: 'You were absent for more than 2 minutes. Your exam has been automatically submitted.',
                    reason: 'absent_too_long'
                });
            }
            // Trong grace period: xóa disconnected_at (học viên đã quay lại đúng hạn)
            await db.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [parseInt(studentId)]);
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
router.post('/exam/answer', studentAuthMiddleware, async (req, res) => {
    try {
        // [C-4] studentId từ token đã xác thực
        const studentId = req.studentPayload.studentId.toString();
        const { question_order, answer } = req.body;
        // Lưu vào buffer trước
        cache.bufferAnswer(parseInt(studentId), question_order, answer);
        res.json({ success: true, cached: true });
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
    try {
        // [C-4] studentId từ token đã xác thực
        const studentId = req.studentPayload.studentId.toString();
        await cache.flushAnswers();
        await db.query("UPDATE students SET status = 'submitted' WHERE id = ?", [parseInt(studentId)]);
        await finalizeSubmission(parseInt(studentId));
        res.json({ success: true, message: 'Exam submitted. Results will be available shortly.' });
    }
    catch (error) {
        console.error('Submit error:', error);
        res.status(500).json({ error: error.message });
    }
});
router.post('/violation', studentAuthMiddleware, async (req, res) => {
    try {
        // [C-4] studentId từ token đã xác thực
        const studentId = req.studentPayload.studentId.toString();
        const batchId = req.studentPayload.batchId;
        const { type, content_preview, text_length, question_id, metadata } = req.body;
        // Validate violation type — chỉ chấp nhận các loại hợp lệ.
        // suspicious_paste & focus_lost giờ là lockable (không còn log-only) —
        // suspicious_paste dùng threshold 300 ký tự + focus_lost đo qua blur/focus
        // với đệm 3s nên đủ tin cậy để tính vào ngưỡng khóa như mọi type khác.
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
        ];
        if (!type || !validTypes.includes(type)) {
            return res.status(400).json({ error: 'Invalid violation type' });
        }
        const forensicOnly = type === 'rapid_text_insertion' || type === 'multiple_display_detected';
        const existingResult = await db.query('SELECT * FROM violations WHERE student_id = ? AND type = ?', [parseInt(studentId), type]);
        if (!forensicOnly && existingResult.rows.length === 0) {
            await db.query('INSERT INTO violations (student_id, type, count) VALUES (?, ?, 1)', [parseInt(studentId), type]);
        }
        else if (!forensicOnly) {
            await db.query('UPDATE violations SET count = count + 1 WHERE id = ?', [existingResult.rows[0].id]);
        }
        // Anti-Cheat forensic log: ghi từng lần vi phạm (append-only) để admin review.
        // content_preview chỉ lưu tối đa 500 ký tự đầu, chỉ có với suspicious_paste.
        // QUAN TRỌNG: forensic log là phụ trợ — KHÔNG được để lỗi ghi log (vd bảng chưa
        // tồn tại trên DB cũ) làm hỏng logic lock/auto-submit của MỌI loại vi phạm.
        // Vì vậy bọc riêng try/catch, nuốt lỗi và chỉ log ra console.
        try {
            const preview = typeof content_preview === 'string' ? content_preview.slice(0, 500) : null;
            const textLen = Number.isFinite(text_length) ? Math.trunc(text_length) : null;
            const qId = typeof question_id === 'string' ? question_id : null;
            const metadataJson = metadata && typeof metadata === 'object'
                ? JSON.stringify(metadata).slice(0, 2000)
                : null;
            await db.query('INSERT INTO violation_events (student_id, batch_id, type, text_length, content_preview, question_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)', [parseInt(studentId), batchId, type, textLen, preview, qId, metadataJson]);
        }
        catch (logErr) {
            console.error('[violation] forensic log insert failed (non-fatal):', logErr?.message);
        }
        const totalResult = await db.query('SELECT SUM(count) as total FROM violations WHERE student_id = ?', [parseInt(studentId)]);
        const total = parseInt(totalResult.rows[0]?.total) || 0;
        const currentResult = await db.query('SELECT count FROM violations WHERE student_id = ? AND type = ?', [parseInt(studentId), type]);
        const currentCount = parseInt(currentResult.rows[0]?.count) || 0;
        // recording_stopped: dừng chia sẻ màn hình = cố ý trốn giám sát → khóa NGAY lần đầu.
        // Các type khác: khóa khi 1 type đạt >= 2 lần HOẶC tổng vi phạm >= 2 (mọi type đều tính).
        const locked = !forensicOnly && (type === 'recording_stopped' || currentCount >= 2 || total >= 2);
        res.json({
            violation_count: currentCount,
            total_violations: total,
            locked,
            forensic_only: forensicOnly,
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
        const batchRes = await db.query('SELECT record_mode, record_enabled FROM batches WHERE id = ?', [batchId]);
        const batchMode = batchRes.rows[0]?.record_mode || (batchRes.rows[0]?.record_enabled ? 's3' : 'none');
        if (batchMode !== 's3') {
            return res.status(403).json({ error: 'S3 recording not enabled for this batch' });
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
export default router;
