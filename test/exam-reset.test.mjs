import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { reopenExamAttempt, ExamResetError } from '../dist/server/services/examReset.js';

function executor(db) {
  return {
    async query(sql, params = []) {
      const stmt = db.prepare(sql);
      if (sql.trim().toUpperCase().startsWith('SELECT')) return { rows: stmt.all(...params), rowCount: 0 };
      const result = stmt.run(...params);
      return { rows: [], rowCount: result.changes };
    },
  };
}

function database(batchEnd = '2030-01-01T12:00:00.000Z') {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE batches (id INTEGER PRIMARY KEY, end_time TEXT NOT NULL);
    CREATE TABLE students (
      id INTEGER PRIMARY KEY, batch_id INTEGER, status TEXT, exam_started_at TEXT, exam_deadline TEXT,
      disconnected_at TEXT, submitted_at TEXT, submit_reason TEXT, active_jti TEXT,
      recording_finalized_at TEXT, recording_final_part_index INTEGER, recording_incomplete INTEGER,
      ai_final_score REAL, ai_summary_feedback TEXT, ai_grading_status TEXT DEFAULT 'pending',
      ai_grading_error TEXT, ai_graded_at TEXT, ai_grading_started_at TEXT,
      ai_grading_attempt_token TEXT
    );
    CREATE TABLE exam_questions (
      id INTEGER PRIMARY KEY, student_id INTEGER, question_id TEXT, question_order INTEGER, answer TEXT,
      ai_score REAL, ai_feedback TEXT, trainer_score REAL, trainer_feedback TEXT
    );
    CREATE TABLE exam_sessions (id INTEGER PRIMARY KEY, student_id INTEGER);
    CREATE TABLE recording_parts (id INTEGER PRIMARY KEY, student_id INTEGER);
  `);
  db.prepare('INSERT INTO batches (id, end_time) VALUES (1, ?)').run(batchEnd);
  db.prepare(`INSERT INTO students (
    id, batch_id, status, exam_started_at, exam_deadline, disconnected_at, submitted_at,
    submit_reason, active_jti, recording_finalized_at, recording_final_part_index,
    recording_incomplete, ai_final_score, ai_summary_feedback, ai_grading_status, ai_grading_error, ai_graded_at,
    ai_grading_started_at, ai_grading_attempt_token
  ) VALUES
    (7, 1, 'submitted', 'old-start', 'old-deadline', 'old-disconnect', 'old-submit', 'manual',
     'old-jti', 'done', 2, 1, 9.5, 'old summary', 'completed', NULL, 'old-graded',
     'old-ai-start', 'old-ai-attempt')`).run();
  db.prepare(`INSERT INTO exam_questions VALUES
    (10, 7, 'q1', 1, 'saved answer', 8, 'old ai', 9, 'old trainer')`).run();
  db.prepare('INSERT INTO exam_sessions VALUES (1, 7)').run();
  db.prepare('INSERT INTO recording_parts VALUES (1, 7)').run();
  return db;
}

test('reopens an attempt while preserving questions and answers', async () => {
  const db = database();
  const result = await reopenExamAttempt(executor(db), 7, 30, new Date('2030-01-01T10:00:00.000Z'), false);
  assert.equal(result.questionsCount, 1);
  assert.equal(result.deadline, '2030-01-01T10:30:00.000Z');
  const question = db.prepare('SELECT * FROM exam_questions WHERE id = 10').get();
  assert.equal(question.answer, 'saved answer');
  assert.equal(question.question_id, 'q1');
  assert.equal(question.ai_score, null);
  assert.equal(question.trainer_score, null);
  const student = db.prepare('SELECT * FROM students WHERE id = 7').get();
  assert.equal(student.status, 'in_progress');
  assert.equal(student.active_jti, null);
  assert.equal(student.submitted_at, null);
  assert.equal(student.ai_final_score, null);
  assert.equal(student.ai_summary_feedback, null);
  assert.equal(student.ai_grading_status, 'pending');
  assert.equal(student.ai_grading_started_at, null);
  assert.equal(student.ai_grading_attempt_token, null);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM exam_sessions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM recording_parts').get().count, 0);
});

test('caps the new deadline at the batch end', async () => {
  const db = database('2030-01-01T10:20:00.000Z');
  const result = await reopenExamAttempt(executor(db), 7, 60, new Date('2030-01-01T10:00:00.000Z'), false);
  assert.equal(result.deadline, '2030-01-01T10:20:00.000Z');
});

test('refuses to reopen when no saved questions exist', async () => {
  const db = database();
  db.prepare('DELETE FROM exam_questions WHERE student_id = 7').run();
  await assert.rejects(
    reopenExamAttempt(executor(db), 7, 30, new Date('2030-01-01T10:00:00.000Z'), false),
    (error) => error instanceof ExamResetError && error.statusCode === 409,
  );
});
