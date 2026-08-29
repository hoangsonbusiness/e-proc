import { Router, Request, Response } from 'express';
import db from '../db/postgres.js';
import type { DbExecutor } from '../db/postgres.js';
import { cache } from '../cache.js';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { studentAuthMiddleware } from '../middleware/studentAuth.js';
import type { StudentTokenPayload } from '../middleware/studentAuth.js';
import rateLimit from 'express-rate-limit';
import { sessionTracker, detectConcurrentSession } from '../middleware/sessionTracker.js';
import { getExamContext, assertCanStart, computeExamDeadline, sendExamGuardError, ExamGuardError } from '../services/examGuard.js';
import { parseBlueprintCompat } from '../services/blueprint.js';
import { computeViolationLock, isForensicOnlyViolation } from '../services/violationStore.js';
import { isClientReportableViolation, isServerOwnedViolation } from '../services/violationPolicy.js';
import { createConcurrentSessionEnforcer } from '../services/concurrentSessionEnforcer.js';
import { persistViolationIfInProgress } from '../services/violationRequestStore.js';
import { isRecordingPutAcknowledgementPayload } from '../services/recordingProtocol.js';
import {
  acknowledgeReservedRecordingPart,
  effectiveAttemptRecordMode,
  finalizeRecordingManifest,
  findNextRecordingPartIndex,
  getRecordingRecoveryStatus,
  reserveRecordingUpload,
  sealRecordingManifest,
  timestampWithoutTimezoneUtcMs,
} from '../services/recordingPersistence.js';
import { issueLiveSession } from '../services/liveMonitoring.js';

let s3ServicePromise: Promise<typeof import('../services/s3.js')> | null = null;

function loadS3Service() {
  s3ServicePromise ||= import('../services/s3.js');
  return s3ServicePromise;
}

type RecordingOperationStage = 'presign' | 'complete' | 'seal' | 'status' | 'reconcile' | 'finalize';

function safeRecordingErrorCode(error: any): string | undefined {
  for (const candidate of [error?.code, error?.name]) {
    if (typeof candidate === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(candidate)) return candidate;
  }
  return undefined;
}

function logRecordingOperation(input: {
  stage: RecordingOperationStage;
  outcome: string;
  startedAt: number;
  statusCode: number;
  studentId?: number;
  batchId?: number;
  partIndex?: number;
  error?: any;
}): void {
  const upstreamStatus = Number(input.error?.$metadata?.httpStatusCode ?? input.error?.statusCode);
  const event = {
    event: 'student_recording',
    stage: input.stage,
    outcome: input.outcome,
    status_code: input.statusCode,
    duration_ms: Date.now() - input.startedAt,
    student_id: input.studentId,
    batch_id: input.batchId,
    part_index: Number.isInteger(input.partIndex) ? input.partIndex : undefined,
    error_code: safeRecordingErrorCode(input.error),
    upstream_status: Number.isInteger(upstreamStatus) ? upstreamStatus : undefined,
  };
  // Never include JWTs, presigned URLs, object keys, or raw upstream messages.
  if (input.statusCode >= 500) console.error('[recording]', event);
  else console.info('[recording]', event);
}

function recordingUploadId(req: Request, requestedPartIndex: number): string {
  const supplied = req.body?.uploadId;
  if (supplied !== undefined && supplied !== null) {
    return typeof supplied === 'string' ? supplied : '';
  }
  // Rolling-deploy compatibility for a page loaded before uploadId support.
  // The verified JWT jti keeps retries stable, while the reservation still
  // prevents old and new clients from receiving the same S3 key.
  return `legacy:${req.studentPayload!.jti}:${requestedPartIndex}`;
}

function isValidRecordingUploadId(uploadId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(uploadId);
}

dotenv.config();

// Phải khớp chính xác với DB layer: có DATABASE_URL => PostgreSQL, không có => SQLite.
// Dựa vào NODE_ENV làm local PostgreSQL bỏ qua FOR UPDATE và tái tạo race violation.
const USE_SQLITE = !process.env.DATABASE_URL;

function readRecordingRecoveryStatusLocked(studentId: number, batchId: number) {
  return db.withTransaction((tx) => getRecordingRecoveryStatus(tx, {
    studentId,
    batchId,
    useSqlite: USE_SQLITE,
  }));
}

const router = Router();

// [SEC] Rate-limit riêng cho /verify — chống brute-force access code.
// Cho phép 25-50 thí sinh chung một public IP đăng nhập gần như đồng thời.
const verifyRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute and try again.' },
});

const toGMT7 = (utcDate: Date): Date => {
  return new Date(utcDate.getTime() + 7 * 60 * 60 * 1000);
};

// Hoàn tất nộp bài: quiz được chấm tự động ngay; essay chờ creator nhấn AI Grade.
// Dùng chung cho cả nộp thủ công lẫn auto-submit (timeout / vắng mặt quá lâu).
// Không tự set status='submitted' — caller đảm nhiệm việc đó.
async function finalizeSubmission(studentId: number, examType: string): Promise<void> {
  if (examType === 'quiz') {
    const quizRows = await db.query(`
      SELECT eq.id, eq.answer, q.type, q.correct_answers, q.score
      FROM exam_questions eq
      JOIN question_bank q ON eq.question_id = q.id
      WHERE eq.student_id = ?
    `, [studentId]);

    const norm = (arr: string[]) => [...new Set(arr.map((s) => String(s).trim().toUpperCase()))].sort();

    const scored: Array<{ id: number; score: number; feedback: string }> = [];
    for (const row of quizRows.rows) {
      let correct: string[] = [];
      try { correct = row.correct_answers ? JSON.parse(row.correct_answers) : []; } catch (_) {}
      let chosen: string[] = [];
      try { chosen = row.answer ? JSON.parse(row.answer) : []; } catch (_) {
        if (typeof row.answer === 'string' && row.answer.trim()) chosen = [row.answer.trim()];
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

type SubmitReason = 'manual' | 'timeout' | 'violation' | 'recording_stopped' | 'concurrent_session' | 'absent_too_long';

interface AnswerInput {
  question_order: number;
  answer: string;
}

async function persistAnswerBatch(tx: DbExecutor, studentId: number, rawAnswers: unknown): Promise<number> {
  if (!Array.isArray(rawAnswers)) return 0;
  if (rawAnswers.length > 100) {
    const error: any = new Error('Too many answers');
    error.code = 'INVALID_ANSWERS';
    throw error;
  }

  const deduped = new Map<number, string>();
  for (const item of rawAnswers as AnswerInput[]) {
    const order = Number(item?.question_order);
    if (!Number.isInteger(order) || order <= 0 || typeof item?.answer !== 'string') {
      const error: any = new Error('Invalid answer payload');
      error.code = 'INVALID_ANSWERS';
      throw error;
    }
    if (item.answer.length > 100_000) {
      const error: any = new Error('Answer is too large');
      error.code = 'INVALID_ANSWERS';
      throw error;
    }
    deduped.set(order, item.answer);
  }
  if (deduped.size === 0) return 0;

  const orders = [...deduped.keys()];
  const placeholders = orders.map(() => '?').join(', ');
  const assignedResult = await tx.query(`
    SELECT eq.question_order, q.type, q.options
    FROM exam_questions eq
    JOIN question_bank q ON q.id = eq.question_id
    WHERE eq.student_id = ? AND eq.question_order IN (${placeholders})
  `, [studentId, ...orders]);
  if (assignedResult.rows.length !== orders.length) {
    const error: any = new Error('One or more questions are not assigned to this student');
    error.code = 'INVALID_ANSWERS';
    throw error;
  }

  const assignedByOrder = new Map(assignedResult.rows.map((row: any) => [Number(row.question_order), row]));
  const normalized: Array<[number, string]> = [];
  for (const [order, originalAnswer] of deduped) {
    const assigned: any = assignedByOrder.get(order);
    let answer = originalAnswer;
    if (assigned.type === 'SingleChoice' || assigned.type === 'MultipleChoice') {
      let selected: string[];
      try { selected = JSON.parse(answer); } catch { selected = []; }
      if (!Array.isArray(selected) || selected.some((key) => typeof key !== 'string')) {
        const error: any = new Error('Invalid quiz answer');
        error.code = 'INVALID_ANSWERS';
        throw error;
      }
      const allowed = new Set<string>();
      try { for (const option of JSON.parse(assigned.options || '[]')) allowed.add(option.key); } catch {}
      selected = [...new Set(selected)];
      if (selected.some((key) => !allowed.has(key)) || (assigned.type === 'SingleChoice' && selected.length > 1)) {
        const error: any = new Error('Invalid quiz option');
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

async function submitExamAtomically(
  studentId: number,
  reason: SubmitReason,
  options: { answers?: unknown } = {}
): Promise<{ already: boolean; examType: string }> {
  const transition = await db.withTransaction(async (tx) => {
    const lockSql = `
      SELECT s.status, s.exam_deadline, s.recording_finalized_at, s.attempt_record_mode,
             b.record_mode, b.record_enabled,
             b.exam_type
      FROM students s JOIN batches b ON b.id = s.batch_id
      WHERE s.id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}
    `;
    const row = (await tx.query(lockSql, [studentId])).rows[0];
    if (!row) throw new Error('Student not found');
    if (row.status === 'submitted') return { already: true, examType: row.exam_type || 'essay' };
    if (row.status !== 'in_progress') throw new Error('Exam is not in progress');

    const recordMode = effectiveAttemptRecordMode(row);
    const deadlinePassed = row.exam_deadline
      && Date.now() >= timestampWithoutTimezoneUtcMs(row.exam_deadline);
    const finalReason: SubmitReason = deadlinePassed ? 'timeout' : reason;
    await persistAnswerBatch(tx, studentId, options.answers);

    await tx.query(
      `UPDATE students
       SET status = 'submitted', submitted_at = ?, submit_reason = ?,
           attempt_record_mode = COALESCE(attempt_record_mode, ?),
           recording_incomplete = CASE WHEN ? = 's3' AND recording_finalized_at IS NULL THEN TRUE ELSE recording_incomplete END
       WHERE id = ? AND status = 'in_progress'`,
      [new Date().toISOString(), finalReason, recordMode, recordMode, studentId]
    );

    return { already: false, examType: row.exam_type || 'essay' };
  });

  // Essay grading is triggered explicitly by the batch creator from Batches List.
  // Quiz scoring remains idempotent and immediate.
  if (transition.examType === 'quiz') await finalizeSubmission(studentId, transition.examType);
  return transition;
}

async function startExamAtomically(studentId: number): Promise<{ success: true; questions_count: number; resume?: boolean }> {
  return db.withTransaction(async (tx) => {
    const context = await getExamContext(studentId, tx);
    assertCanStart(context, new Date(), USE_SQLITE || process.env.SKIP_TIME_CHECK === 'true');

    const locked = (await tx.query(
      `SELECT s.*, b.duration, b.end_time, b.blueprint, b.exam_type,
              b.record_mode, b.record_enabled
       FROM students s JOIN batches b ON b.id = s.batch_id
       WHERE s.id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}`,
      [studentId]
    )).rows[0];
    assertCanStart({ ...context, status: locked.status }, new Date(), USE_SQLITE || process.env.SKIP_TIME_CHECK === 'true');
    const existing = await tx.query('SELECT COUNT(*) AS count FROM exam_questions WHERE student_id = ?', [studentId]);
    const existingCount = Number(existing.rows[0]?.count || 0);
    const attemptRecordMode = effectiveAttemptRecordMode(locked);
    if (locked.status === 'in_progress' && existingCount > 0) {
      await tx.query(
        `UPDATE students
         SET disconnected_at = NULL,
             attempt_record_mode = COALESCE(attempt_record_mode, ?)
         WHERE id = ?`,
        [attemptRecordMode, studentId],
      );
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
    const picked: { id: string; type: string; options: string | null }[] = [];

    for (const item of blueprintItems) {
      if (!item || typeof item.module !== 'string' || !item.module.trim()) {
        throw new ExamGuardError(422, 'invalid_blueprint', 'Exam blueprint contains an invalid module');
      }
      if (blueprintMode === 'type' && (typeof item.type !== 'string' || !item.type.trim())) {
        throw new ExamGuardError(422, 'invalid_blueprint', 'Exam blueprint contains an invalid question type');
      }
      for (const level of ['Easy', 'Medium', 'Hard'] as const) {
        const count = Number(item[level.toLowerCase()] || 0);
        if (count <= 0) continue;
        const blueprintTypeSql = blueprintMode === 'type' ? 'AND LOWER(type) = LOWER(?)' : '';
        const queryParams = blueprintMode === 'type'
          ? [item.module.trim(), level, item.type!.trim(), count]
          : [item.module.trim(), level, count];
        const available = await tx.query(`
          SELECT id, type, options FROM question_bank
          WHERE LOWER(module) = LOWER(?) AND LOWER(level) = LOWER(?) ${blueprintTypeSql} ${typeFilterSql}
          ORDER BY RANDOM() LIMIT ?
        `, queryParams);
        for (const q of available.rows) picked.push({ id: q.id, type: q.type, options: q.options ?? null });
      }
    }

    for (let i = picked.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    for (let i = 0; i < picked.length; i++) {
      const q = picked[i];
      let optionOrder: string | null = null;
      if ((q.type === 'SingleChoice' || q.type === 'MultipleChoice') && q.options) {
        try {
          const keys = (JSON.parse(q.options) as { key: string }[]).map((option) => option.key);
          for (let a = keys.length - 1; a > 0; a--) {
            const b = crypto.randomInt(a + 1);
            [keys[a], keys[b]] = [keys[b], keys[a]];
          }
          optionOrder = JSON.stringify(keys);
        } catch {}
      }
      await tx.query(
        'INSERT INTO exam_questions (student_id, question_id, question_order, option_order) VALUES (?, ?, ?, ?)',
        [studentId, q.id, i + 1, optionOrder]
      );
    }

    const now = new Date();
    const batchEnd = new Date(locked.end_time);
    const deadline = computeExamDeadline(now, Number(locked.duration || 30), batchEnd);
    await tx.query(
      `UPDATE students SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?,
       disconnected_at = NULL, recording_finalized_at = NULL, recording_final_part_index = NULL,
       recording_incomplete = FALSE, recording_manifest_sealed_at = NULL,
       recording_expected_part_count = NULL,
       attempt_record_mode = COALESCE(attempt_record_mode, ?) WHERE id = ?`,
      [now.toISOString(), deadline.toISOString(), attemptRecordMode, studentId]
    );
    return { success: true, questions_count: picked.length };
  });
}

// This is the only path allowed to conclude that a concurrent session exists.
// It consumes server-tracked evidence and submits directly, independently of
// the client-reportable violation counter thresholds.
const enforceConcurrentSession = createConcurrentSessionEnforcer({
  db,
  detect: detectConcurrentSession,
  submit: submitExamAtomically,
});

/**
 * [P1-2] Đường cưỡng chế lock DUY NHẤT, dùng chung cho cả event mới lẫn replay.
 * Nếu đạt ngưỡng khóa và student còn 'in_progress' thì auto-submit — kể cả khi request
 * TRƯỚC đã tính locked nhưng submitExamAtomically lỗi tạm thời rồi client retry vào nhánh
 * replay. Vì submitExamAtomically idempotent (return { already } nếu đã submitted), gọi lại
 * an toàn. Ném lỗi ra ngoài để caller trả 500 → client tiếp tục retry cho tới khi lock chốt.
 */
async function ensureViolationLock(
  studentId: number, type: string, currentCount: number, total: number, forensicOnly: boolean
): Promise<boolean> {
  const locked = computeViolationLock(type, currentCount, total, forensicOnly);
  if (!locked) return false;
  const statusRow = await db.query('SELECT status FROM students WHERE id = ?', [studentId]);
  if (statusRow.rows[0]?.status === 'in_progress') {
    await submitExamAtomically(studentId, type === 'recording_stopped' ? 'recording_stopped' : 'violation');
    console.log('[violation] Auto-submitted (locked) student:', studentId, 'type:', type);
  }
  return true;
}

router.post('/verify', verifyRateLimit, async (req: Request, res: Response) => {
  try {
    const { access_code } = req.body;

    if (!access_code) {
      return res.status(400).json({ error: 'Access code required' });
    }

    const result = await db.query(`
      SELECT s.*, b.name as batch_name, b.start_time, b.end_time, b.duration,
              b.record_enabled, b.record_mode, b.live_enabled
      FROM students s
      JOIN batches b ON s.batch_id = b.id
      WHERE s.access_code = ?
    `, [access_code]);

    const student = result.rows[0];

    if (!student) {
      return res.status(404).json({ error: 'Invalid access code' });
    }

    const recordingNextPartIndex = await findNextRecordingPartIndex(db, Number(student.id));

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
    // Freeze mode, password, and fresh jti under one row lock. Concurrent
    // verifies must return exactly the mode/password that won persisted state.
    const frozenAttempt = await db.withTransaction(async (tx) => {
      const current = (await tx.query(
        `SELECT s.attempt_record_mode, s.recording_password,
                 b.record_mode, b.record_enabled, b.live_enabled
         FROM students s JOIN batches b ON b.id = s.batch_id
         WHERE s.id = ?${USE_SQLITE ? '' : ' FOR UPDATE OF s'}`,
        [student.id],
      )).rows[0];
      if (!current) throw new Error('Student not found');
      const recordMode = effectiveAttemptRecordMode(current);
      const jti = crypto.randomUUID();
      const recordingPassword = recordMode === 'local'
        ? (current.recording_password || crypto.randomBytes(24).toString('base64url'))
        : null;
      await tx.query(
        `UPDATE students
         SET active_jti = ?, attempt_record_mode = ?,
             recording_password = COALESCE(recording_password, ?)
         WHERE id = ?`,
        [jti, recordMode, recordingPassword, student.id],
      );
       return { jti, recordMode, recordingPassword, liveEnabled: Boolean(current.live_enabled) };
    });
    const { jti, recordMode, recordingPassword, liveEnabled } = frozenAttempt;
    const studentToken = jwt.sign(
      { studentId: student.id, batchId: student.batch_id, jti } as StudentTokenPayload,
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
       record_enabled: recordMode === 's3', // giữ để tương thích ngược theo mode đã freeze
       record_mode: recordMode,
       live_enabled: liveEnabled,
      recording_next_part_index: recordingNextPartIndex,
      // chỉ trả pass khi local — client dùng ngầm để mã hóa, không hiển thị
      recording_password: recordMode === 'local' ? recordingPassword : undefined,
    });
  } catch (error: any) {
    if (sendExamGuardError(res, error)) return;
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

router.post('/exam/start', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    
    const student_id = req.studentPayload!.studentId;
    const startedExam = await startExamAtomically(student_id);
    return res.json(startedExam);

    /* Legacy implementation retained temporarily below for source compatibility; unreachable after atomic start. */
    console.log('[startExam] student_id:', student_id);

    const studentResult = await db.query(
      'SELECT s.*, b.duration, b.end_time FROM students s JOIN batches b ON s.batch_id = b.id WHERE s.id = ?',
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
    const picked: { id: string; type: string; options: string | null }[] = [];

    for (const item of blueprintItems) {
      for (const level of ['Easy', 'Medium', 'Hard'] as const) {
        const count = item[level.toLowerCase() as 'easy' | 'medium' | 'hard'];
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
      let optionOrder: string | null = null;
      if ((q.type === 'SingleChoice' || q.type === 'MultipleChoice') && q.options) {
        try {
          const opts = JSON.parse(q.options) as { key: string }[];
          const keys = opts.map((o) => o.key);
          for (let a = keys.length - 1; a > 0; a--) {
            const b = crypto.randomInt(a + 1);
            [keys[a], keys[b]] = [keys[b], keys[a]];
          }
          optionOrder = JSON.stringify(keys);
        } catch (_) { /* options lỗi → để NULL, client hiển thị theo thứ tự gốc */ }
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
    await db.query(
      `UPDATE students
       SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL,
           attempt_record_mode = COALESCE(attempt_record_mode, (
             SELECT COALESCE(NULLIF(b.record_mode, ''),
               CASE WHEN b.record_enabled THEN 's3' ELSE 'none' END)
             FROM batches b WHERE b.id = students.batch_id
           ))
       WHERE id = ?`,
      [now.toISOString(), deadline.toISOString(), student_id]
    );

    res.json({ success: true, questions_count: picked.length });
  } catch (error: any) {
    if (sendExamGuardError(res, error)) return;
    res.status(500).json({ error: error.message });
  }
});


router.get('/exam/questions', studentAuthMiddleware, sessionTracker, async (req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    // [C-4] Đọc studentId từ token đã xác thực, không tin x-student-id header
    const studentId = req.studentPayload!.studentId.toString();

    // === SERVER-SIDE TIMER GUARD ===
    const studentResult = await db.query(`
      SELECT s.status, s.exam_deadline, s.disconnected_at, b.duration, b.record_mode
      FROM students s
      JOIN batches b ON s.batch_id = b.id
      WHERE s.id = ?
    `, [parseInt(studentId)]);
    const student = studentResult.rows[0];

    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const recordingNextPartIndex = await findNextRecordingPartIndex(db, parseInt(studentId));

    if (student.status === 'submitted') {
      return res.status(410).json({ 
        error: 'Exam already submitted',
        reason: 'submitted'
      });
    }

    const nowMs = Date.now();

    // Nếu học viên mới bắt đầu truy cập bài thi lần đầu (status = pending)
    if (student.status === 'pending') {
      return res.json({
        questions: [],
        time_remaining: null,
        recording_next_part_index: recordingNextPartIndex,
      });
    }


    // Kiểm tra deadline đã qua chưa
    if (student.exam_deadline) {
      const deadlineMs = timestampWithoutTimezoneUtcMs(student.exam_deadline);
      if (Number.isFinite(deadlineMs) && nowMs >= deadlineMs) {
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
      const disconnectedAtMs = timestampWithoutTimezoneUtcMs(student.disconnected_at);
      const absentSeconds = (nowMs - disconnectedAtMs) / 1000;
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
    const autoLocked = await enforceConcurrentSession(parseInt(studentId), req.studentPayload!.batchId);
    if (autoLocked) {
      return res.status(410).json({
        error: 'Multiple concurrent sessions detected. Your exam has been automatically submitted.',
        reason: 'concurrent_session'
      });
    }

    // Tính time_remaining từ server
    let time_remaining: number | null = null;
    if (student.exam_deadline) {
      const deadlineMs = timestampWithoutTimezoneUtcMs(student.exam_deadline);
      time_remaining = Number.isFinite(deadlineMs)
        ? Math.max(0, Math.floor((deadlineMs - nowMs) / 1000))
        : 0;
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

    const questions = result.rows.map((q: any) => {
      const isQuiz = q.type === 'SingleChoice' || q.type === 'MultipleChoice';
      let options: { key: string; text: string }[] | undefined;
      if (isQuiz && q.options) {
        try {
          const parsed = JSON.parse(q.options) as { key: string; text: string }[];
          const order: string[] | null = q.option_order ? JSON.parse(q.option_order) : null;
          if (order && order.length) {
            const byKey = new Map(parsed.map((o) => [o.key, o]));
            options = order.map((k) => byKey.get(k)).filter(Boolean) as { key: string; text: string }[];
          } else {
            options = parsed;
          }
        } catch (_) { options = undefined; }
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

    res.json({
      questions,
      time_remaining,
      recording_next_part_index: recordingNextPartIndex,
    });
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

// A short-lived, topic-scoped Supabase Realtime token. This is signaling only:
// no screen video crosses this HTTP endpoint, Vercel, or the database.
router.post('/live/session', studentAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { studentId, batchId, jti } = req.studentPayload!;
    const active = await db.query(`
      SELECT s.id, b.record_mode, b.live_enabled
      FROM students s JOIN batches b ON b.id = s.batch_id
      WHERE s.id = ? AND s.batch_id = ? AND s.status = 'in_progress' AND s.active_jti = ?
    `, [studentId, batchId, jti]);
    if (!active.rows[0]) return res.status(409).json({ error: 'Exam is not active' });
    if (active.rows[0].record_mode === 'none' && !Boolean(active.rows[0].live_enabled)) {
      return res.json({ enabled: false });
    }
    const config = await issueLiveSession({
      actor: 'student', subject: `student:${studentId}:${jti}`,
      batchId, studentId, jti,
    });
    // Disabled is deliberately a normal response: an exam must never fail just
    // because an optional live-monitoring integration is not configured.
    return res.json(config);
  } catch (error: any) {
    console.error('[live-monitor] could not create student signaling session', error);
    return res.status(503).json({ error: 'Live monitoring is temporarily unavailable' });
  }
});

router.post('/exam/answers', studentAuthMiddleware, sessionTracker, async (req: Request, res: Response) => {
  try {
    const studentId = req.studentPayload!.studentId;
    const autoLocked = await enforceConcurrentSession(studentId, req.studentPayload!.batchId);
    if (autoLocked) {
      return res.status(410).json({ error: 'Multiple concurrent sessions detected', reason: 'concurrent_session' });
    }

    const saved = await db.withTransaction(async (tx) => {
      const row = (await tx.query(
        `SELECT status, exam_deadline FROM students WHERE id = ?${USE_SQLITE ? '' : ' FOR UPDATE'}`,
        [studentId]
      )).rows[0];
      if (!row || row.status !== 'in_progress') {
        const error: any = new Error('Exam is no longer accepting answers');
        error.code = 'NOT_ACCEPTING';
        throw error;
      }
      if (!row.exam_deadline || new Date() >= new Date(row.exam_deadline)) {
        const error: any = new Error('Deadline passed');
        error.code = 'DEADLINE_PASSED';
        throw error;
      }
      return persistAnswerBatch(tx, studentId, req.body?.answers);
    });
    return res.json({ success: true, persisted: saved });
  } catch (error: any) {
    if (error?.code === 'DEADLINE_PASSED') {
      await submitExamAtomically(req.studentPayload!.studentId, 'timeout');
      return res.status(410).json({ error: error.message, reason: 'timeout' });
    }
    if (error?.code === 'NOT_ACCEPTING') {
      return res.status(410).json({ error: error.message, reason: 'submitted_or_timeout' });
    }
    if (error?.code === 'INVALID_ANSWERS') return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }
});

router.post('/exam/answer', studentAuthMiddleware, sessionTracker, async (req: Request, res: Response) => {
  try {
    // [C-4] studentId từ token đã xác thực
    const studentId = req.studentPayload!.studentId.toString();

    const questionOrder = Number(req.body?.question_order);
    let answer = req.body?.answer;
    if (!Number.isInteger(questionOrder) || questionOrder <= 0 || typeof answer !== 'string') {
      return res.status(400).json({ error: 'Invalid answer payload' });
    }
    if (answer.length > 100_000) return res.status(413).json({ error: 'Answer is too large' });

    // [SEC] Không nhận answer sau khi đã nộp hoặc quá deadline.
    // Trước đây /answer chỉ buffer mù → sau khi bị khóa/auto-submit vẫn ghi đè được đáp án.
    const assigned = (await db.query(`
      SELECT q.type, q.options
      FROM exam_questions eq JOIN question_bank q ON q.id = eq.question_id
      WHERE eq.student_id = ? AND eq.question_order = ?
    `, [parseInt(studentId), questionOrder])).rows[0];
    if (!assigned) return res.status(404).json({ error: 'Question is not assigned to this student' });

    if (assigned.type === 'SingleChoice' || assigned.type === 'MultipleChoice') {
      let selected: string[];
      try { selected = JSON.parse(answer); } catch { return res.status(400).json({ error: 'Invalid quiz answer' }); }
      if (!Array.isArray(selected) || selected.some((key) => typeof key !== 'string')) {
        return res.status(400).json({ error: 'Invalid quiz answer' });
      }
      const allowed = new Set<string>();
      try { for (const option of JSON.parse(assigned.options || '[]')) allowed.add(option.key); } catch {}
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
      const autoLocked = await enforceConcurrentSession(parseInt(studentId), req.studentPayload!.batchId);
      if (autoLocked) {
        return res.status(410).json({
          error: 'Multiple concurrent sessions detected. Your exam has been automatically submitted.',
          reason: 'concurrent_session',
        });
      }
    } catch (concErr: any) {
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
  const startedAt = Date.now();
  try {
    // [C-4] studentId từ token đã xác thực
    const studentId = req.studentPayload!.studentId.toString();

    // [SEC] Idempotent: nếu đã submitted thì trả OK ngay, không flush/queue lại
    // (tránh re-queue chấm điểm trùng khi client gọi submit nhiều lần).
    const result = await submitExamAtomically(parseInt(studentId), 'manual', { answers: req.body?.answers });
    res.json({ success: true, already: result.already, message: 'Exam submitted. Results will be available shortly.' });
  } catch (error: any) {
    console.error('Submit error:', error);
    if (error?.code === 'INVALID_ANSWERS') return res.status(400).json({ error: error.message });
    res.status(500).json({ error: error.message });
  } finally {
    const pool: any = db.getPool();
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

router.post('/violation', studentAuthMiddleware, sessionTracker, async (req: Request, res: Response) => {
  try {
    // [C-4] studentId từ token đã xác thực
    const studentId = req.studentPayload!.studentId.toString();
    const batchId = req.studentPayload!.batchId;

    // [SEC] Kiểm tra phiên đồng thời trước — nếu chồng lấn thời gian, backend auto-lock ngay.
    const autoLocked = await enforceConcurrentSession(parseInt(studentId), batchId);
    if (autoLocked) {
      return res.json({ violation_count: 0, total_violations: 0, locked: true, reason: 'concurrent_session' });
    }

    const { type, content_preview, text_length, question_id, metadata } = req.body;

    // Validate violation type — chỉ chấp nhận các loại mà frontend được phép report.
    // suspicious_paste is accepted as forensic evidence but never auto-locks:
    // insertion size alone cannot prove clipboard use. focus_lost remains
    // lockable because it is measured through blur/focus with a grace period.
    if (!isClientReportableViolation(type)) {
      const error = isServerOwnedViolation(type)
        ? 'Violation type is server-owned'
        : 'Invalid violation type';
      return res.status(400).json({ error });
    }

    const forensicOnly = isForensicOnlyViolation(type);
    const eventId = typeof req.body?.event_id === 'string' ? req.body.event_id.slice(0, 64) : null;
    const preview = typeof content_preview === 'string' ? content_preview.slice(0, 500) : null;
    const textLen = Number.isFinite(text_length) ? Math.trunc(text_length) : null;
    const qId = typeof question_id === 'string' ? question_id : null;
    const metadataJson = metadata && typeof metadata === 'object'
      ? JSON.stringify(metadata).slice(0, 2000)
      : null;

    // [P1-1] Khóa/đọc status rồi claim event + upsert counter + đọc total/current TRONG
    // MỘT TRANSACTION, qua helper production dùng chung với regression test. Nguyên tử:
    // submit thắng race => request bị ignore; violation thắng => event + counter cùng commit.
    // KHÔNG có fallback non-idempotent: migration (event_id + 2 unique index) bắt buộc trước
    // deploy; transaction lỗi → propagate ra catch ngoài → 500 → client retry CÙNG event_id.
    const { ignored, replay, total, currentCount } = await db.withTransaction((tx) =>
      persistViolationIfInProgress(tx, {
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
      })
    );

    if (ignored) {
      return res.json({
        violation_count: 0,
        total_violations: 0,
        locked: false,
        forensic_only: forensicOnly,
        ignored: true,
        reason: 'exam_not_in_progress',
      });
    }

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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/exam/recording-seal', studentAuthMiddleware, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const studentId = req.studentPayload!.studentId;
  const batchId = req.studentPayload!.batchId;
  let outcome = 'rejected';
  let caughtError: any;
  try {
    if (!Array.isArray(req.body?.parts)) {
      return res.status(400).json({ error: 'Invalid recording manifest', reason: 'invalid_manifest' });
    }
    const result = await db.withTransaction((tx) => sealRecordingManifest(tx, {
      studentId,
      batchId,
      sessionId: req.studentPayload!.jti,
      parts: req.body.parts,
      useSqlite: USE_SQLITE,
    }));
    outcome = result.already ? 'already_sealed' : 'sealed';
    return res.json({
      success: true,
      state: result.state === 'finalized' ? 'finalized' : 'processing',
      recordMode: result.recordMode,
      expectedPartCount: result.expectedPartCount,
      completedPartCount: result.completedPartCount,
      parts: result.parts,
    });
  } catch (error: any) {
    caughtError = error;
    outcome = 'error';
    const status = error?.code === 'INVALID_MANIFEST' ? 400
      : error?.code === 'BAD_RECORD_MODE' ? 403
      : error?.code === 'NOT_IN_PROGRESS' ? 409
      : error?.code === 'MANIFEST_CONFLICT' ? 409
      : error?.code === 'RECORDING_PART_LIMIT' ? 409
      : error?.code === 'RECORDING_RESERVATION_CONFLICT' ? 409 : 500;
    const reason = error?.code === 'INVALID_MANIFEST' ? 'invalid_manifest'
      : error?.code === 'BAD_RECORD_MODE' ? 'bad_record_mode'
      : error?.code === 'NOT_IN_PROGRESS' ? 'not_in_progress'
      : ['MANIFEST_CONFLICT', 'RECORDING_RESERVATION_CONFLICT'].includes(error?.code)
        ? 'manifest_conflict'
        : error?.code === 'RECORDING_PART_LIMIT' ? 'manifest_conflict'
        : 'recording_seal_failed';
    return res.status(status).json(status < 500
      ? { error: error.message, reason }
      : { error: 'Could not seal the recording manifest', reason });
  } finally {
    logRecordingOperation({
      stage: 'seal', outcome, startedAt, statusCode: res.statusCode, studentId, batchId, error: caughtError,
    });
  }
});

router.get('/exam/recording-status', studentAuthMiddleware, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const studentId = req.studentPayload!.studentId;
  const batchId = req.studentPayload!.batchId;
  let outcome = 'read';
  let caughtError: any;
  try {
    const status = await readRecordingRecoveryStatusLocked(studentId, batchId);
    return res.json(status);
  } catch (error: any) {
    caughtError = error;
    outcome = 'error';
    return res.status(500).json({
      error: 'Could not read the recording status',
      reason: 'recording_status_failed',
    });
  } finally {
    logRecordingOperation({
      stage: 'status', outcome, startedAt, statusCode: res.statusCode, studentId, batchId, error: caughtError,
    });
  }
});

router.post('/exam/recording-reconcile', studentAuthMiddleware, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const studentId = req.studentPayload!.studentId;
  const batchId = req.studentPayload!.batchId;
  let outcome = 'rejected';
  let caughtError: any;
  try {
    const status = await db.withTransaction(async (tx) => {
      let current = await getRecordingRecoveryStatus(tx, {
        studentId,
        batchId,
        useSqlite: USE_SQLITE,
      });
      if (current.state !== 'processing') return current;

      // PutObject-only deployments cannot inspect S3. Reconciliation therefore
      // never invents a completed part: it only finalizes durable browser PUT-2xx
      // acknowledgements already committed in recording_parts. Keep the status
      // decision, finalize and read-back under one student-row lock so reset/JTI
      // rotation cannot turn a deterministic lifecycle result into a 503 race.
      if (
        current.expectedPartCount > 0
        && current.completedPartCount === current.expectedPartCount
      ) {
        await finalizeRecordingManifest(tx, {
          studentId,
          batchId,
          useSqlite: USE_SQLITE,
        });
        current = await getRecordingRecoveryStatus(tx, {
          studentId,
          batchId,
          useSqlite: USE_SQLITE,
        });
      }
      return current;
    });
    outcome = status.state;
    return res.json(status);
  } catch (error: any) {
    caughtError = error;
    outcome = 'error';
    if (error?.code === 'BAD_RECORD_MODE') {
      return res.status(403).json({ error: error.message, reason: 'bad_record_mode' });
    }
    if (error?.code === 'NOT_IN_PROGRESS') {
      return res.status(409).json({ error: error.message, reason: 'not_in_progress' });
    }
    if (error?.code === 'RECORDING_INCOMPLETE') {
      return res.status(409).json({ error: error.message, reason: 'recording_incomplete' });
    }
    const manifestConflict = [
      'MANIFEST_CONFLICT',
      'MANIFEST_NOT_SEALED',
      'RECORDING_RESERVATION_CONFLICT',
    ].includes(error?.code);
    if (manifestConflict) {
      return res.status(409).json({ error: error.message, reason: 'manifest_conflict' });
    }
    return res.status(503).json({
      error: 'Could not reconcile the recording',
      reason: 'recording_reconcile_failed',
    });
  } finally {
    logRecordingOperation({
      stage: 'reconcile', outcome, startedAt, statusCode: res.statusCode, studentId, batchId, error: caughtError,
    });
  }
});

// Cấp presigned PUT URL để client upload 1 phần video record thẳng lên S3.
// batchId/studentId lấy từ JWT — client KHÔNG thể chỉ định để ghi đè video người khác.
router.post('/exam/recording-url', studentAuthMiddleware, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const studentId = req.studentPayload!.studentId;
  const batchId = req.studentPayload!.batchId;
  const requestedPartIndex = Number(req.body?.partIndex);
  const uploadId = recordingUploadId(req, requestedPartIndex);
  let operationPartIndex = requestedPartIndex;
  let outcome = 'rejected';
  let caughtError: any;
  try {
    if (!Number.isInteger(requestedPartIndex) || requestedPartIndex < 0 || requestedPartIndex > 1000) {
      return res.status(400).json({ error: 'Invalid partIndex' });
    }
    if (!isValidRecordingUploadId(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId' });
    }

    // Reserve under the student row lock before issuing a URL. The client uploadId
    // is the idempotency identity; a stale requested cursor can be reassigned, but
    // two logical blobs can never receive the same part/key.
    const reservation = await db.withTransaction((tx) => reserveRecordingUpload(tx, {
      studentId,
      batchId,
      uploadId,
      sessionId: req.studentPayload!.jti,
      useSqlite: USE_SQLITE,
    }));
    operationPartIndex = reservation.partIndex;

    if (reservation.completed) {
      outcome = 'already_complete';
      return res.json({
        success: true,
        alreadyComplete: true,
        completed: true,
        already: true,
        uploadId: reservation.uploadId,
        partIndex: reservation.partIndex,
        key: reservation.objectKey,
        byteSize: reservation.byteSize,
      });
    }

    const { createRecordingUploadUrl, isS3Configured } = await loadS3Service();
    if (!isS3Configured()) {
      return res.status(424).json({
        error: 'Recording storage requires administrator configuration',
        reason: 'recording_storage_not_configured',
      });
    }

    const { url, key } = await createRecordingUploadUrl({
      batchId,
      studentId,
      partIndex: reservation.partIndex,
      objectKey: reservation.objectKey,
      contentType: typeof req.body?.contentType === 'string' ? req.body.contentType : undefined,
    });

    outcome = reservation.already ? 'reservation_replayed' : 'issued';
    res.json({
      url,
      key,
      uploadId: reservation.uploadId,
      partIndex: reservation.partIndex,
      already: reservation.already,
      completed: false,
    });
  } catch (error: any) {
    caughtError = error;
    outcome = 'error';
    const status = error?.code === 'INVALID_UPLOAD_ID' ? 400
      : error?.code === 'BAD_RECORD_MODE' ? 403
      : error?.code === 'NOT_IN_PROGRESS' ? 409
      : error?.code === 'RECORDING_PART_LIMIT' ? 409
      : error?.code === 'MANIFEST_SEALED' ? 409
      : error?.code === 'RECORDING_RESERVATION_CONFLICT' ? 409 : 500;
    res.status(status).json(status < 500
      ? { error: error.message, reason: String(error.code).toLowerCase() }
      : { error: 'Could not prepare the recording upload', reason: 'recording_presign_failed' });
  } finally {
    logRecordingOperation({
      stage: 'presign',
      outcome,
      startedAt,
      statusCode: res.statusCode,
      studentId,
      batchId,
      partIndex: operationPartIndex,
      error: caughtError,
    });
  }
});

router.post('/exam/recording-complete', studentAuthMiddleware, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const studentId = req.studentPayload!.studentId;
  const batchId = req.studentPayload!.batchId;
  const requestedPartIndex = Number(req.body?.partIndex);
  const acknowledgedByteSize = Number(req.body?.byteSize);
  const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId : '';
  let operationPartIndex = requestedPartIndex;
  let outcome = 'rejected';
  let caughtError: any;
  try {
    if (!isRecordingPutAcknowledgementPayload(req.body)) {
      return res.status(426).json({
        error: 'Recording completion protocol upgrade required',
        reason: 'recording_protocol_upgrade_required',
      });
    }
    if (!Number.isInteger(requestedPartIndex) || requestedPartIndex < 0 || requestedPartIndex > 1000) {
      return res.status(400).json({ error: 'Invalid recording part metadata' });
    }
    if (!isValidRecordingUploadId(uploadId)) {
      return res.status(400).json({ error: 'Invalid uploadId' });
    }
    if (
      !Number.isSafeInteger(acknowledgedByteSize)
      || acknowledgedByteSize <= 0
      || acknowledgedByteSize > 2_147_483_647
    ) {
      return res.status(422).json({
        error: 'Invalid recording part size',
        reason: 'invalid_recording_part',
      });
    }

    // Reject non-S3 modes before looking up any stale reservation left by a
    // previous attempt/deployment. Local recording must never enter S3 recovery.
    const recordingStatus = await readRecordingRecoveryStatusLocked(studentId, batchId);
    if (recordingStatus.recordMode !== 's3') {
      return res.status(403).json({ error: 'S3 recording is not enabled', reason: 'bad_record_mode' });
    }

    // The browser calls this endpoint only after observing a successful S3 PUT
    // response. With a PutObject-only principal this acknowledgement is the
    // operational completion signal; the transaction derives all object metadata
    // from the authenticated server reservation and rechecks lifecycle.
    const completion = await db.withTransaction((tx) => acknowledgeReservedRecordingPart(tx, {
      studentId,
      batchId,
      uploadId,
      byteSize: acknowledgedByteSize,
      useSqlite: USE_SQLITE,
      sessionId: req.studentPayload!.jti,
    }));
    operationPartIndex = completion.partIndex;
    outcome = completion.already ? 'already_complete' : 'stored';
    res.json({
      success: true,
      already: completion.already,
      ...(completion.already ? { alreadyComplete: true } : {}),
      completed: true,
      uploadId: completion.uploadId,
      partIndex: completion.partIndex,
      key: completion.objectKey,
      byteSize: completion.byteSize,
    });
  } catch (error: any) {
    caughtError = error;
    outcome = 'error';
    const status = error?.code === 'NOT_IN_PROGRESS' ? 409
      : error?.code === 'BAD_RECORD_MODE' ? 403
      : error?.code === 'RESERVATION_NOT_FOUND' ? 409
      : error?.code === 'RECORDING_RESERVATION_CONFLICT' ? 409
      : error?.code === 'INVALID_RECORDING_PART' ? 422 : 500;
    res.status(status).json(status < 500
      ? { error: error.message, reason: error.code.toLowerCase() }
      : { error: 'Could not acknowledge the uploaded recording part', reason: 'recording_complete_failed' });
  } finally {
    logRecordingOperation({
      stage: 'complete',
      outcome,
      startedAt,
      statusCode: res.statusCode,
      studentId,
      batchId,
      partIndex: operationPartIndex,
      error: caughtError,
    });
  }
});

router.post('/exam/recording-finalize', studentAuthMiddleware, async (req: Request, res: Response) => {
  const startedAt = Date.now();
  const studentId = req.studentPayload!.studentId;
  const batchId = req.studentPayload!.batchId;
  let operationPartIndex: number | undefined;
  let outcome = 'rejected';
  let caughtError: any;
  try {
    const result = await db.withTransaction((tx) => finalizeRecordingManifest(tx, {
      studentId,
      batchId,
      useSqlite: USE_SQLITE,
    }));
    operationPartIndex = result.finalPartIndex;
    outcome = result.already ? 'already_finalized' : 'finalized';
    res.json({ success: true, already: result.already, finalPartIndex: result.finalPartIndex });
  } catch (error: any) {
    caughtError = error;
    outcome = 'error';
    const status = error?.code === 'RECORDING_INCOMPLETE' ? 409
      : error?.code === 'MANIFEST_CONFLICT' ? 409
      : error?.code === 'MANIFEST_NOT_SEALED' ? 409
      : error?.code === 'RECORDING_RESERVATION_CONFLICT' ? 409
      : error?.code === 'NOT_IN_PROGRESS' ? 409
      : error?.code === 'BAD_RECORD_MODE' ? 403 : 500;
    res.status(status).json(status < 500
      ? { error: error.message, reason: error?.code?.toLowerCase() }
      : { error: 'Could not finalize the recording', reason: 'recording_finalize_failed' });
  } finally {
    logRecordingOperation({
      stage: 'finalize',
      outcome,
      startedAt,
      statusCode: res.statusCode,
      studentId,
      batchId,
      partIndex: operationPartIndex,
      error: caughtError,
    });
  }
});

export default router;
