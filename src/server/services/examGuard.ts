import db, { type DbExecutor } from '../db/postgres.js';

export interface ExamContext {
  id: number;
  batch_id: number;
  status: string;
  exam_started_at: string | null;
  exam_deadline: string | null;
  active_jti: string | null;
  start_time: string;
  end_time: string;
  duration: number;
  record_mode: 'none' | 'local' | 's3';
  record_enabled: boolean;
}

export class ExamGuardError extends Error {
  constructor(public statusCode: number, public reason: string, message: string) {
    super(message);
  }
}

export async function getExamContext(studentId: number, executor: DbExecutor = db): Promise<ExamContext> {
  const result = await executor.query(`
    SELECT s.id, s.batch_id, s.status, s.exam_started_at, s.exam_deadline, s.active_jti,
           b.start_time, b.end_time, b.duration, b.record_mode, b.record_enabled
    FROM students s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.id = ?
  `, [studentId]);
  const row = result.rows[0];
  if (!row) throw new ExamGuardError(404, 'student_not_found', 'Student not found');
  row.record_mode = row.record_mode || (row.record_enabled ? 's3' : 'none');
  return row as ExamContext;
}

export function assertActiveSession(context: ExamContext, jti?: string): void {
  if (!jti || !context.active_jti || context.active_jti !== jti) {
    throw new ExamGuardError(401, 'session_revoked', 'This exam session is no longer active');
  }
}

export function assertCanStart(context: ExamContext, now = new Date(), skipTimeCheck = false): void {
  if (context.status === 'submitted') {
    throw new ExamGuardError(410, 'submitted', 'Exam already submitted');
  }
  if (!skipTimeCheck && (now < new Date(context.start_time) || now >= new Date(context.end_time))) {
    throw new ExamGuardError(403, 'outside_schedule', 'Exam is not available at this time');
  }
}

export function assertInProgress(context: ExamContext, now = new Date()): void {
  if (context.status === 'submitted') {
    throw new ExamGuardError(410, 'submitted', 'Exam already submitted');
  }
  if (context.status !== 'in_progress') {
    throw new ExamGuardError(409, 'not_started', 'Exam has not started');
  }
  if (context.exam_deadline && now >= new Date(context.exam_deadline)) {
    throw new ExamGuardError(410, 'timeout', 'Exam deadline has passed');
  }
}

export function computeExamDeadline(startedAt: Date, durationMinutes: number, batchEnd: Date): Date {
  const durationDeadline = new Date(startedAt.getTime() + durationMinutes * 60_000);
  return durationDeadline < batchEnd ? durationDeadline : batchEnd;
}

export function sendExamGuardError(res: any, error: unknown): boolean {
  if (!(error instanceof ExamGuardError)) return false;
  res.status(error.statusCode).json({ error: error.message, reason: error.reason });
  return true;
}
