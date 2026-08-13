import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { claimQueueJob, enqueueStudentQueueJobs } from '../dist/server/services/queueStore.js';

function createDb(enabled) {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE batches (id INTEGER PRIMARY KEY, ai_grading_enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE students (id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL);
    CREATE TABLE exam_questions (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL);
    CREATE TABLE ai_queue (
      id INTEGER PRIMARY KEY, exam_question_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO batches (id, ai_grading_enabled) VALUES (1, ${enabled ? 1 : 0});
    INSERT INTO students (id, batch_id) VALUES (7, 1);
    INSERT INTO exam_questions (id, student_id) VALUES (101, 7), (102, 7);
  `);
  const executor = {
    async query(text, params = []) {
      const bound = params.map((value) => value instanceof Date ? value.toISOString() : value);
      const statement = sqlite.prepare(text);
      if (/^\s*(SELECT|WITH)\b/i.test(text)) {
        return { rows: statement.all(...bound), rowCount: 0 };
      }
      const result = statement.run(...bound);
      return { rows: [], rowCount: result.changes };
    },
  };
  return { sqlite, executor };
}

test('batch OFF creates no AI grading jobs', async () => {
  const { sqlite, executor } = createDb(false);
  try {
    const inserted = await enqueueStudentQueueJobs(executor, 7, new Date());
    assert.equal(inserted, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM ai_queue').get().count, 0);
  } finally {
    sqlite.close();
  }
});

test('batch ON bulk-enqueues all questions in one idempotent operation', async () => {
  const { sqlite, executor } = createDb(true);
  try {
    assert.equal(await enqueueStudentQueueJobs(executor, 7, new Date()), 2);
    assert.equal(await enqueueStudentQueueJobs(executor, 7, new Date()), 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM ai_queue').get().count, 2);
  } finally {
    sqlite.close();
  }
});

test('worker claim cancels a pending job when its batch has been switched OFF', async () => {
  const { sqlite, executor } = createDb(true);
  try {
    await enqueueStudentQueueJobs(executor, 7, new Date());
    sqlite.prepare('UPDATE batches SET ai_grading_enabled = 0 WHERE id = 1').run();
    assert.equal(await claimQueueJob(executor, 101, new Date()), false);
    assert.deepEqual(
      sqlite.prepare('SELECT status, attempts FROM ai_queue WHERE id = 101').get(),
      { status: 'cancelled', attempts: 0 }
    );
  } finally {
    sqlite.close();
  }
});
