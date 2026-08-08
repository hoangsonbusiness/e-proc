import db from '../db/postgres.js';
export class ExamGuardError extends Error {
    statusCode;
    reason;
    constructor(statusCode, reason, message) {
        super(message);
        this.statusCode = statusCode;
        this.reason = reason;
    }
}
export async function getExamContext(studentId, executor = db) {
    const result = await executor.query(`
    SELECT s.id, s.batch_id, s.status, s.exam_started_at, s.exam_deadline, s.active_jti,
           b.start_time, b.end_time, b.duration, b.record_mode, b.record_enabled
    FROM students s
    JOIN batches b ON b.id = s.batch_id
    WHERE s.id = ?
  `, [studentId]);
    const row = result.rows[0];
    if (!row)
        throw new ExamGuardError(404, 'student_not_found', 'Student not found');
    row.record_mode = row.record_mode || (row.record_enabled ? 's3' : 'none');
    return row;
}
export function assertActiveSession(context, jti) {
    if (!jti || !context.active_jti || context.active_jti !== jti) {
        throw new ExamGuardError(401, 'session_revoked', 'This exam session is no longer active');
    }
}
export function assertCanStart(context, now = new Date(), skipTimeCheck = false) {
    if (context.status === 'submitted') {
        throw new ExamGuardError(410, 'submitted', 'Exam already submitted');
    }
    if (!skipTimeCheck && (now < new Date(context.start_time) || now >= new Date(context.end_time))) {
        throw new ExamGuardError(403, 'outside_schedule', 'Exam is not available at this time');
    }
}
export function assertInProgress(context, now = new Date()) {
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
export function computeExamDeadline(startedAt, durationMinutes, batchEnd) {
    const durationDeadline = new Date(startedAt.getTime() + durationMinutes * 60_000);
    return durationDeadline < batchEnd ? durationDeadline : batchEnd;
}
export function sendExamGuardError(res, error) {
    if (!(error instanceof ExamGuardError))
        return false;
    res.status(error.statusCode).json({ error: error.message, reason: error.reason });
    return true;
}
