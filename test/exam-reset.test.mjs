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
      recording_finalized_at TEXT, recording_final_part_index INTEGER, recording_incomplete INTEGER
    );
    CREATE TABLE exam_questions (
      id INTEGER PRIMARY KEY, student_id INTEGER, question_id TEXT, question_order INTEGER, answer TEXT,
      ai_score REAL, ai_feedback TEXT, trainer_score REAL, trainer_feedback TEXT
    );
    CREATE TABLE ai_queue (id INTEGER PRIMARY KEY, student_id INTEGER);
    CREATE TABLE exam_sessions (id INTEGER PRIMARY KEY, student_id INTEGER);
    CREATE TABLE recording_parts (id INTEGER PRIMARY KEY, student_id INTEGER);
  `);
  db.prepare('INSERT INTO batches (id, end_time) VALUES (1, ?)').run(batchEnd);
  db.prepare(`INSERT INTO students VALUES
    (7, 1, 'submitted', 'old-start', 'old-deadline', 'old-disconnect', 'old-submit', 'manual', 'old-jti', 'done', 2, 1)`).run();
  db.prepare(`INSERT INTO exam_questions VALUES
    (10, 7, 'q1', 1, 'saved answer', 8, 'old ai', 9, 'old trainer')`).run();
  db.prepare('INSERT INTO ai_queue VALUES (10, 7)').run();
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
  assert.equal(db.prepare('SELECT COUNT(*) count FROM ai_queue').get().count, 0);
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
