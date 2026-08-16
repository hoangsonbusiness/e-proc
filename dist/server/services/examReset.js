export class ExamResetError extends Error {
    statusCode;
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}
/** Reopen an attempt without replacing its assigned questions or saved answers. */
export async function reopenExamAttempt(tx, studentId, durationMinutes, now = new Date(), lockStudentRow = false) {
    if (!Number.isInteger(studentId) || studentId <= 0) {
        throw new ExamResetError(400, 'Invalid student id');
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 480) {
        throw new ExamResetError(400, 'Duration must be an integer between 1 and 480 minutes');
    }
    const student = (await tx.query(`SELECT s.id, s.status, b.end_time
     FROM students s JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ?${lockStudentRow ? ' FOR UPDATE' : ''}`, [studentId])).rows[0];
    if (!student)
        throw new ExamResetError(404, 'Student not found');
    const questionsCount = Number((await tx.query('SELECT COUNT(*) AS count FROM exam_questions WHERE student_id = ?', [studentId])).rows[0]?.count || 0);
    if (questionsCount === 0) {
        throw new ExamResetError(409, 'Cannot continue: this student has no saved exam questions');
    }
    const batchEnd = new Date(student.end_time);
    if (!Number.isFinite(batchEnd.getTime()) || batchEnd <= now) {
        throw new ExamResetError(409, 'Cannot continue: the batch has already ended');
    }
    const requestedDeadline = new Date(now.getTime() + durationMinutes * 60_000);
    const deadline = requestedDeadline < batchEnd ? requestedDeadline : batchEnd;
    // Scores and queue jobs from the previous submission are stale once answers can change.
    await tx.query('DELETE FROM ai_queue WHERE student_id = ?', [studentId]);
    await tx.query(`UPDATE exam_questions
     SET ai_score = NULL, ai_feedback = NULL, trainer_score = NULL, trainer_feedback = NULL
     WHERE student_id = ?`, [studentId]);
    await tx.query('DELETE FROM exam_sessions WHERE student_id = ?', [studentId]);
    await tx.query('DELETE FROM recording_parts WHERE student_id = ?', [studentId]);
    await tx.query(`UPDATE students
     SET status = 'in_progress', exam_started_at = ?, exam_deadline = ?, disconnected_at = NULL,
         submitted_at = NULL, submit_reason = NULL, active_jti = NULL,
         recording_finalized_at = NULL, recording_final_part_index = NULL,
         recording_incomplete = FALSE, ai_final_score = NULL, ai_summary_feedback = NULL,
         ai_grading_status = 'pending', ai_grading_error = NULL, ai_graded_at = NULL,
         ai_grading_started_at = NULL, ai_grading_attempt_token = NULL
     WHERE id = ?`, [now.toISOString(), deadline.toISOString(), studentId]);
    return { studentId, questionsCount, deadline: deadline.toISOString() };
}
