import type { DbExecutor } from '../db/postgres.js';

export interface QueueRecordInput {
  id: number;
  examQuestionId: number;
  studentId: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Persist every essay grading job in one statement. The batch flag is checked in SQL. */
export async function enqueueStudentQueueJobs(db: DbExecutor, studentId: number, now: Date): Promise<number> {
  const inserted = await db.query(
    `INSERT INTO ai_queue (id, exam_question_id, student_id, status, attempts, created_at, updated_at)
     SELECT eq.id, eq.id, eq.student_id, 'pending', 0, ?, ?
     FROM exam_questions eq
     JOIN students s ON s.id = eq.student_id
     JOIN batches b ON b.id = s.batch_id
     WHERE eq.student_id = ? AND b.ai_grading_enabled = TRUE
     ON CONFLICT (id) DO NOTHING`,
    [now, now, studentId]
  );
  return inserted.rowCount;
}

export async function enqueueQueueJob(db: DbExecutor, job: QueueRecordInput): Promise<void> {
  await db.query(
    `INSERT INTO ai_queue (id, exam_question_id, student_id, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    [job.id, job.examQuestionId, job.studentId, job.status, job.attempts, job.createdAt, job.updatedAt]
  );
}

/** Chỉ một worker được phép chuyển một job pending sang processing. */
export async function claimQueueJob(db: DbExecutor, id: number, now: Date): Promise<boolean> {
  await db.query(
    `UPDATE ai_queue
     SET status = 'cancelled', updated_at = ?
     WHERE id = ? AND status = 'pending'
       AND NOT EXISTS (
         SELECT 1
         FROM exam_questions eq
         JOIN students s ON s.id = eq.student_id
         JOIN batches b ON b.id = s.batch_id
         WHERE eq.id = ai_queue.exam_question_id
           AND b.ai_grading_enabled = TRUE
       )`,
    [now, id]
  );
  const claimed = await db.query(
    `UPDATE ai_queue
     SET status = 'processing', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'pending'
       AND EXISTS (
         SELECT 1
         FROM exam_questions eq
         JOIN students s ON s.id = eq.student_id
         JOIN batches b ON b.id = s.batch_id
         WHERE eq.id = ai_queue.exam_question_id
           AND b.ai_grading_enabled = TRUE
       )`,
    [now, id]
  );
  return claimed.rowCount === 1;
}

export async function updateQueueJob(
  db: DbExecutor,
  input: Pick<QueueRecordInput, 'id' | 'status' | 'attempts' | 'updatedAt'>
): Promise<void> {
  await db.query(
    `UPDATE ai_queue
     SET status = ?, attempts = ?, updated_at = ?
     WHERE id = ? AND status <> 'cancelled'`,
    [input.status, input.attempts, input.updatedAt, input.id]
  );
}

export async function recoverStaleQueueJobs(db: DbExecutor, cutoff: Date, now: Date): Promise<number> {
  const recovered = await db.query(
    `UPDATE ai_queue SET status = 'pending', updated_at = ?
     WHERE status = 'processing' AND updated_at < ?`,
    [now, cutoff]
  );
  return recovered.rowCount;
}
