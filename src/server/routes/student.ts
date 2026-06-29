import { Router, Request, Response } from 'express';
import db from '../db/postgres.js';
import { cache } from '../cache.js';
import dotenv from 'dotenv';

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

    res.json({
      valid: true,
      access_code: student.access_code,
      emails: emailsResult.rows.map((s: any) => s.email),
      duration: student.duration,
      student_id: student.id,
      dev_mode: isDevMode,
      exam_start: startTime.toISOString(),
      exam_end: endTime.toISOString()
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


router.get('/exam/questions', async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const studentId = req.headers['x-student-id'] as string;
    if (!studentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // === SERVER-SIDE TIMER GUARD ===
    const studentResult = await db.query(
      'SELECT status, exam_deadline, disconnected_at FROM students WHERE id = ?',
      [parseInt(studentId)]
    );
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
router.post('/exam/disconnect', async (req: Request, res: Response) => {
  try {
    // sendBeacon có thể gửi body dạng text/plain nên cần parse linh hoạt
    let studentId: string | undefined = req.headers['x-student-id'] as string;

    if (!studentId) {
      // Fallback: parse từ body (sendBeacon gửi JSON string)
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        studentId = body?.student_id?.toString();
      } catch (_) { /* ignore parse errors */ }
    }

    if (!studentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

router.post('/exam/answer', async (req: Request, res: Response) => {
  try {
    const studentId = req.headers['x-student-id'] as string;
    if (!studentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { question_order, answer } = req.body;

    // Lưu vào buffer trước
    cache.bufferAnswer(parseInt(studentId), question_order, answer);

    res.json({ success: true, cached: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/exam/flush', async (req: Request, res: Response) => {
  try {
    const studentId = req.headers['x-student-id'] as string;
    if (!studentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await cache.flushAnswers();

    res.json({ success: true, flushed: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/exam/submit', async (req: Request, res: Response) => {
  try {
    const studentId = req.headers['x-student-id'] as string;
    if (!studentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

router.post('/violation', async (req: Request, res: Response) => {
  try {
    const studentId = req.headers['x-student-id'] as string;
    if (!studentId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type } = req.body;

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
      locked: currentCount >= 2 || total >= 2
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
