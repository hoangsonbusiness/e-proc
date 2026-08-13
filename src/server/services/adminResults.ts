import type { DbExecutor } from '../db/postgres.js';

export interface ResultsPagination {
  page: number;
  pageSize: number;
}

export interface BatchResultsSummary {
  items: any[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function rowsByStudent(rows: any[]): Map<number, any[]> {
  const grouped = new Map<number, any[]>();
  for (const row of rows) {
    const studentId = Number(row.student_id);
    const existing = grouped.get(studentId) || [];
    existing.push(row);
    grouped.set(studentId, existing);
  }
  return grouped;
}

function violationBreakdowns(rows: any[]): Map<number, Record<string, number>> {
  const grouped = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const studentId = Number(row.student_id);
    const breakdown = grouped.get(studentId) || {};
    breakdown[row.type] = Number(row.count) || 0;
    grouped.set(studentId, breakdown);
  }
  return grouped;
}

function violationTotal(breakdown: Record<string, number>): number {
  return Object.values(breakdown).reduce((sum, count) => sum + count, 0);
}

export async function loadBatchResultsSummary(
  db: DbExecutor,
  batchId: number,
  pagination: ResultsPagination,
): Promise<BatchResultsSummary> {
  const countResult = await db.query('SELECT COUNT(*) AS total FROM students WHERE batch_id = ?', [batchId]);
  const total = Number(countResult.rows[0]?.total) || 0;
  const totalPages = Math.max(1, Math.ceil(total / pagination.pageSize));
  const page = Math.min(Math.max(1, pagination.page), totalPages);
  const offset = (page - 1) * pagination.pageSize;

  const studentsResult = await db.query(`
    SELECT
      s.id, s.batch_id, s.email, s.status, s.recording_password,
      s.exam_started_at, s.exam_deadline, s.submitted_at, s.submit_reason,
      s.recording_finalized_at, s.recording_final_part_index, s.recording_incomplete,
      s.created_at,
      AVG(CASE WHEN eq.ai_score IS NOT NULL THEN COALESCE(eq.trainer_score, eq.ai_score) END) AS avg_score,
      COUNT(eq.id) AS questions_count
    FROM students s
    LEFT JOIN exam_questions eq ON eq.student_id = s.id
    WHERE s.batch_id = ?
    GROUP BY s.id
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ? OFFSET ?
  `, [batchId, pagination.pageSize, offset]);

  if (studentsResult.rows.length === 0) {
    return { items: [], total, page, pageSize: pagination.pageSize, totalPages };
  }

  const studentIds = studentsResult.rows.map((student: any) => Number(student.id));
  const idsSql = placeholders(studentIds.length);
  const [violationsResult, eventSummaryResult, recordingSummaryResult] = await Promise.all([
    db.query(`
      SELECT student_id, type, count
      FROM violations
      WHERE student_id IN (${idsSql})
      ORDER BY student_id, count DESC, type
    `, studentIds),
    db.query(`
      SELECT student_id,
        COUNT(*) AS event_count,
        SUM(CASE WHEN type = 'concurrent_session' THEN 1 ELSE 0 END) AS concurrent_session_count
      FROM violation_events
      WHERE student_id IN (${idsSql})
      GROUP BY student_id
    `, studentIds),
    db.query(`
      SELECT student_id, COUNT(*) AS part_count, COALESCE(SUM(byte_size), 0) AS total_bytes
      FROM recording_parts
      WHERE student_id IN (${idsSql})
      GROUP BY student_id
    `, studentIds),
  ]);

  const breakdowns = violationBreakdowns(violationsResult.rows);
  const eventSummaries = new Map(eventSummaryResult.rows.map((row: any) => [Number(row.student_id), row]));
  const recordingSummaries = new Map(recordingSummaryResult.rows.map((row: any) => [Number(row.student_id), row]));

  const items = studentsResult.rows.map((student: any) => {
    const studentId = Number(student.id);
    const breakdown = breakdowns.get(studentId) || {};
    const eventSummary: any = eventSummaries.get(studentId);
    const recordingSummary: any = recordingSummaries.get(studentId);
    return {
      student: {
        ...student,
        id: studentId,
        questions_count: Number(student.questions_count) || 0,
        avg_score: student.avg_score == null ? null : Number(student.avg_score),
      },
      violations: violationTotal(breakdown),
      violations_breakdown: breakdown,
      violation_event_count: Number(eventSummary?.event_count) || 0,
      concurrent_session_count: Number(eventSummary?.concurrent_session_count) || 0,
      recording_part_count: Number(recordingSummary?.part_count) || 0,
      recording_total_bytes: Number(recordingSummary?.total_bytes) || 0,
    };
  });

  return { items, total, page, pageSize: pagination.pageSize, totalPages };
}

export async function loadStudentResultDetail(db: DbExecutor, studentId: number): Promise<any | null> {
  const studentResult = await db.query('SELECT id, email FROM students WHERE id = ?', [studentId]);
  if (studentResult.rows.length === 0) return null;

  const [questionsResult, violationEventsResult, recordingPartsResult] = await Promise.all([
    db.query(`
      SELECT eq.*, q.type, q.level, q.module, q.question_sample,
        q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
      FROM exam_questions eq
      JOIN question_bank q ON eq.question_id = q.id
      WHERE eq.student_id = ?
      ORDER BY eq.question_order
    `, [studentId]),
    db.query(`
      SELECT type, text_length, content_preview, question_id, metadata_json, created_at
      FROM violation_events
      WHERE student_id = ?
      ORDER BY created_at DESC, id DESC
    `, [studentId]),
    db.query(`
      SELECT part_index, object_key, byte_size, uploaded_at
      FROM recording_parts
      WHERE student_id = ?
      ORDER BY part_index
    `, [studentId]),
  ]);

  return {
    student: studentResult.rows[0],
    questions: questionsResult.rows,
    violation_events: violationEventsResult.rows,
    recording_parts: recordingPartsResult.rows,
  };
}

export async function loadBatchResultsLegacy(db: DbExecutor, batchId: number): Promise<any[]> {
  const [studentsResult, questionsResult, violationsResult, violationEventsResult, recordingPartsResult] = await Promise.all([
    db.query(`
      SELECT s.*, AVG(eq.ai_score) AS avg_ai_score, COUNT(eq.id) AS questions_count
      FROM students s
      LEFT JOIN exam_questions eq ON s.id = eq.student_id
      WHERE s.batch_id = ?
      GROUP BY s.id
      ORDER BY s.created_at DESC, s.id DESC
    `, [batchId]),
    db.query(`
      SELECT eq.*, q.type, q.level, q.module, q.question_sample,
        q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
      FROM exam_questions eq
      JOIN students s ON s.id = eq.student_id
      JOIN question_bank q ON eq.question_id = q.id
      WHERE s.batch_id = ?
      ORDER BY eq.student_id, eq.question_order
    `, [batchId]),
    db.query(`
      SELECT v.student_id, v.type, v.count
      FROM violations v
      JOIN students s ON s.id = v.student_id
      WHERE s.batch_id = ?
      ORDER BY v.student_id, v.count DESC, v.type
    `, [batchId]),
    db.query(`
      SELECT ve.student_id, ve.type, ve.text_length, ve.content_preview,
        ve.question_id, ve.metadata_json, ve.created_at
      FROM violation_events ve
      JOIN students s ON s.id = ve.student_id
      WHERE s.batch_id = ?
      ORDER BY ve.student_id, ve.created_at DESC, ve.id DESC
    `, [batchId]),
    db.query(`
      SELECT rp.student_id, rp.part_index, rp.object_key, rp.byte_size, rp.uploaded_at
      FROM recording_parts rp
      JOIN students s ON s.id = rp.student_id
      WHERE s.batch_id = ?
      ORDER BY rp.student_id, rp.part_index
    `, [batchId]),
  ]);

  const questions = rowsByStudent(questionsResult.rows);
  const breakdowns = violationBreakdowns(violationsResult.rows);
  const events = rowsByStudent(violationEventsResult.rows);
  const recordings = rowsByStudent(recordingPartsResult.rows);

  return studentsResult.rows.map((student: any) => {
    const studentId = Number(student.id);
    const breakdown = breakdowns.get(studentId) || {};
    return {
      student,
      questions: questions.get(studentId) || [],
      violations: violationTotal(breakdown),
      violations_breakdown: breakdown,
      violation_events: events.get(studentId) || [],
      recording_parts: recordings.get(studentId) || [],
    };
  });
}

export async function loadBatchExportData(db: DbExecutor, batchId: number): Promise<any[]> {
  const [studentsResult, questionsResult, violationsResult] = await Promise.all([
    db.query('SELECT id, email FROM students WHERE batch_id = ? ORDER BY id', [batchId]),
    db.query(`
      SELECT eq.*, q.type, q.level, q.module, q.question_sample,
        q.rubric_must_have, q.rubric_nice_to_have, q.rubric_optional
      FROM exam_questions eq
      JOIN students s ON s.id = eq.student_id
      JOIN question_bank q ON eq.question_id = q.id
      WHERE s.batch_id = ?
      ORDER BY eq.student_id, eq.question_order
    `, [batchId]),
    db.query(`
      SELECT v.student_id, SUM(v.count) AS total
      FROM violations v
      JOIN students s ON s.id = v.student_id
      WHERE s.batch_id = ?
      GROUP BY v.student_id
    `, [batchId]),
  ]);

  const questions = rowsByStudent(questionsResult.rows);
  const violations = new Map(violationsResult.rows.map((row: any) => [Number(row.student_id), Number(row.total) || 0]));
  return studentsResult.rows.map((student: any) => ({
    student,
    questions: questions.get(Number(student.id)) || [],
    violations: violations.get(Number(student.id)) || 0,
  }));
}

