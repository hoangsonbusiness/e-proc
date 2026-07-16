import { Router, Request, Response } from 'express';
import db from '../db/postgres.js';
import { cache } from '../cache.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { studentAuthMiddleware } from '../middleware/studentAuth.js';
import type { StudentTokenPayload } from '../middleware/studentAuth.js';

dotenv.config();

const USE_SQLITE = process.env.USE_SQLITE === 'true' || process.env.NODE_ENV !== 'production';

const router = Router();

const toGMT7 = (utcDate: Date): Date => {
  return new Date(utcDate.getTime() + 7 * 60 * 60 * 1000);
};

router.post('/verify', async (req: Request, res: Response) => {
  try {
    const { access_code } = req.body;

    if (!access_code) {
      return res.status(400).json({ error: 'Access code required' });
    }

    const result = await db.query(`
      SELECT s.*, b.name as batch_name, b.start_time, b.end_time, b.duration
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
    const secret = process.env.JWT_SECRET!;
    const studentToken = jwt.sign(
      { studentId: student.id, batchId: student.batch_id } as StudentTokenPayload,
      secret,
      { expiresIn: '4h' }
    );

    res.json({
      valid: true,
      student_token: studentToken,
      access_code: student.access_code,
      emails: emailsResult.rows.map((s: any) => s.email),
      duration: student.duration,
      student_id: student.id, // giữ lại để hiển thị UI (không dùng cho auth)
      dev_mode: isDevMode,
      exam_start: startTime.toISOString(),
      exam_end: endTime.toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/select-email', async (req: Request, res: Response) => {
  try {
    const { student_id, email } = req.body;

    const result = await db.query('SELECT * FROM students WHERE id = ? AND email = ?', [student_id, email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid student or email' });
    }

    res.json({ valid: true, student_id: result.rows[0].id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/exam/start', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const { student_id } = req.body;
    console.log('[startExam] student_id:', student_id);

    const studentResult = await db.query(
      'SELECT s.*, b.duration FROM students s JOIN batches b ON s.batch_id = b.id WHERE s.id = ?',
      [student_id]
    );
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
      const existingQuestions = await db.query(
        'SELECT COUNT(*) as count FROM exam_questions WHERE student_id = ?',
        [student_id]
      );
      if (existingQuestions.rows[0].count === 0) {
        console.log('[startExam] Resume but no questions, generating...');
        // Fall through to generate questions below
      } else {
        console.log('[startExam] Resume exam for student in_progress, questions:', existingQuestions.rows[0].count);
        // Xoá disconnected_at khi resume thành công
        await db.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [student_id]);
        return res.json({ success: true, questions_count: existingQuestions.rows[0].count, resume: true });
      }
    } else {
      // Auto-reset: Xóa exam_questions cũ nếu status = pending (phòng trường hợp có dữ liệu cũ)
      if (student.status === 'pending') {
        await db.query('DELETE FROM exam_questions WHERE student_id = ?', [student_id]);
        console.log('[startExam] Auto-reset: Xóa exam_questions cũ (nếu có)');
      }
    }

    const batchResult = await db.query('SELECT blueprint FROM batches WHERE id = ?', [student.batch_id]);
    const batch = batchResult.rows[0];
    const blueprint = batch?.blueprint
      ? (typeof batch.blueprint === 'string' ? JSON.parse(batch.blueprint) : batch.blueprint)
      : [];

    const questionIds: string[] = [];

    for (const item of blueprint) {
      for (const level of ['Easy', 'Medium', 'Hard'] as const) {
        const count = item[level.toLowerCase() as 'easy' | 'medium' | 'hard'];
        if (count > 0) {
          const availableResult = await db.query(`
            SELECT id FROM question_bank
            WHERE module = ? AND level = ?
            ORDER BY RANDOM()
            LIMIT ?
          `, [item.module, level, count]);

          for (const q of availableResult.rows) {
            questionIds.push(q.id);
          }
        }
      }
    }

    for (let i = 0; i < questionIds.length; i++) {
      await db.query(`
        INSERT INTO exam_questions (student_id, question_id, question_order)
        VALUES (?, ?, ?)
      `, [student_id, questionIds[i], i + 1]);
    }

    // Ghi thời điểm bắt đầu và deadline (chỉ set khi chưa có)
    const durationSeconds = (student.duration || 30) * 60;
    const now = new Date();
    const deadline = new Date(now.getTime() + durationSeconds * 1000);
    await db.query(
      "UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL WHERE id = ?",
      [now.toISOString(), deadline.toISOString(), student_id]
    );

    res.json({ success: true, questions_count: questionIds.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


router.get('/exam/questions', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    // [C-4] Đọc studentId từ token đã xác thực, không tin x-student-id header
    const studentId = req.studentPayload!.studentId.toString();

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
      const durationSeconds = (student.duration || 30) * 60;
      const deadline = new Date(now.getTime() + durationSeconds * 1000);
      
      await db.query(
        "UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL WHERE id = ?",
        [now.toISOString(), deadline.toISOString(), parseInt(studentId)]
      );
      
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
        const examQuestionsResult = await db.query(
          'SELECT id FROM exam_questions WHERE student_id = ?',
          [parseInt(studentId)]
        );
        for (const eq of examQuestionsResult.rows) {
          cache.addToQueue(eq.id, parseInt(studentId));
        }
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
        const examQuestionsResult = await db.query(
          'SELECT id FROM exam_questions WHERE student_id = ?',
          [parseInt(studentId)]
        );
        for (const eq of examQuestionsResult.rows) {
          cache.addToQueue(eq.id, parseInt(studentId));
        }
        return res.status(410).json({
          error: 'You were absent for more than 2 minutes. Your exam has been automatically submitted.',
          reason: 'absent_too_long'
        });
      }
      // Trong grace period: xóa disconnected_at (học viên đã quay lại đúng hạn)
      await db.query('UPDATE students SET disconnected_at = NULL WHERE id = ?', [parseInt(studentId)]);
    }

    // Tính time_remaining từ server
    let time_remaining: number | null = null;
    if (student.exam_deadline) {
      const deadline = new Date(student.exam_deadline);
      time_remaining = Math.max(0, Math.floor((deadline.getTime() - now.getTime()) / 1000));
    }
    // === END GUARD ===

    const result = await db.query(`
      SELECT eq.question_order, eq.answer, q.id, q.type, q.level, q.module, q.question_sample
      FROM exam_questions eq
      JOIN question_bank q ON eq.question_id = q.id
      WHERE eq.student_id = ?
      ORDER BY eq.question_order
    `, [parseInt(studentId)]);

    const questions = result.rows.map((q: any) => ({
      ...q,
      answer: q.answer || ''
    }));

    res.json({ questions, time_remaining });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});


// Endpoint nhận beacon khi học viên tắt trình duyệt / đóng tab
// [C-4] sendBeacon không hỗ trợ custom headers nên token được gửi trong body
router.post('/exam/disconnect', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const studentId = req.studentPayload!.studentId.toString();

    const studentResult = await db.query(
      'SELECT status FROM students WHERE id = ?',
      [parseInt(studentId)]
    );
    const student = studentResult.rows[0];

    // Chỉ ghi disconnected_at nếu đang in_progress
    if (student && student.status === 'in_progress') {
      await db.query(
        'UPDATE students SET disconnected_at = ? WHERE id = ?',
        [new Date().toISOString(), parseInt(studentId)]
      );
      console.log('[disconnect] Ghi disconnected_at cho student:', studentId);
    }

    res.status(204).send();
  } catch (error: any) {
    // Không trả lỗi để không block beacon
    res.status(204).send();
  }
});

router.post('/exam/answer', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    // [C-4] studentId từ token đã xác thực
    const studentId = req.studentPayload!.studentId.toString();

    const { question_order, answer } = req.body;

    // Lưu vào buffer trước
    cache.bufferAnswer(parseInt(studentId), question_order, answer);

    res.json({ success: true, cached: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/exam/flush', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    // [C-4] studentId từ token xác thực
    // flush toàn bộ buffer (bao gồm cả của student hiện tại) — ok vì chỉ admin-triggered
    await cache.flushAnswers();

    res.json({ success: true, flushed: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/exam/submit', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    // [C-4] studentId từ token đã xác thực
    const studentId = req.studentPayload!.studentId.toString();

    await cache.flushAnswers();

    await db.query("UPDATE students SET status = 'submitted' WHERE id = ?", [parseInt(studentId)]);

    const examQuestionsResult = await db.query('SELECT id FROM exam_questions WHERE student_id = ?', [parseInt(studentId)]);

    for (const eq of examQuestionsResult.rows) {
      cache.addToQueue(eq.id, parseInt(studentId));
    }

    res.json({ success: true, message: 'Exam submitted. Results will be available shortly.' });
  } catch (error: any) {
    console.error('Submit error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/violation', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    // [C-4] studentId từ token đã xác thực
    const studentId = req.studentPayload!.studentId.toString();

    const { type } = req.body;

    // Validate violation type — chỉ chấp nhận các loại hợp lệ
    const validTypes = [
      'tab_switch',
      'fullscreen_exit',
      'copy_attempt',
      'cut_attempt',
      'paste_attempt',
      'devtools_open',
      'screenshot_attempt',  // phím PrintScreen / PrtSc
      'print_attempt',       // Ctrl+P hoặc browser print dialog
    ];
    if (!type || !validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid violation type' });
    }

    const existingResult = await db.query('SELECT * FROM violations WHERE student_id = ? AND type = ?', [parseInt(studentId), type]);

    if (existingResult.rows.length === 0) {
      await db.query('INSERT INTO violations (student_id, type, count) VALUES (?, ?, 1)', [parseInt(studentId), type]);
    } else {
      await db.query('UPDATE violations SET count = count + 1 WHERE id = ?', [existingResult.rows[0].id]);
    }

    const totalResult = await db.query('SELECT SUM(count) as total FROM violations WHERE student_id = ?', [parseInt(studentId)]);
    const total = parseInt(totalResult.rows[0]?.total) || 0;

    const currentResult = await db.query('SELECT count FROM violations WHERE student_id = ? AND type = ?', [parseInt(studentId), type]);
    const currentCount = parseInt(currentResult.rows[0]?.count) || 0;

    res.json({
      violation_count: currentCount,
      total_violations: total,
      locked: currentCount >= 2 || total >= 2,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
