export async function enqueueQueueJob(db, job) {
    await db.query(`INSERT INTO ai_queue (id, exam_question_id, student_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`, [job.id, job.examQuestionId, job.studentId, job.status, job.attempts, job.createdAt, job.updatedAt]);
}
/** Chỉ một worker được phép chuyển một job pending sang processing. */
export async function claimQueueJob(db, id, now) {
    const claimed = await db.query(`UPDATE ai_queue
     SET status = 'processing', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'pending'`, [now, id]);
    return claimed.rowCount === 1;
}
export async function updateQueueJob(db, input) {
    await db.query(`UPDATE ai_queue SET status = ?, attempts = ?, updated_at = ? WHERE id = ?`, [input.status, input.attempts, input.updatedAt, input.id]);
}
export async function recoverStaleQueueJobs(db, cutoff, now) {
    const recovered = await db.query(`UPDATE ai_queue SET status = 'pending', updated_at = ?
     WHERE status = 'processing' AND updated_at < ?`, [now, cutoff]);
    return recovered.rowCount;
}
