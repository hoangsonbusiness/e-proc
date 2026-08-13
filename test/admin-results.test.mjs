import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  loadBatchExportData,
  loadBatchResultsLegacy,
  loadBatchResultsSummary,
  loadStudentResultDetail,
} from '../dist/server/services/adminResults.js';

function executor(database) {
  let queryCount = 0;
  return {
    get queryCount() { return queryCount; },
    async query(sql, params = []) {
      queryCount += 1;
      const statement = database.prepare(sql);
      return { rows: statement.all(...params), rowCount: 0 };
    },
  };
}

function fixture(studentCount = 2) {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE students (
      id INTEGER PRIMARY KEY, batch_id INTEGER, email TEXT, status TEXT, recording_password TEXT,
      exam_started_at TEXT, exam_deadline TEXT, submitted_at TEXT, submit_reason TEXT,
      recording_finalized_at TEXT, recording_final_part_index INTEGER, recording_incomplete INTEGER,
      created_at TEXT
    );
    CREATE TABLE question_bank (
      id TEXT PRIMARY KEY, type TEXT, level TEXT, module TEXT, question_sample TEXT,
      rubric_must_have TEXT, rubric_nice_to_have TEXT, rubric_optional TEXT
    );
    CREATE TABLE exam_questions (
      id INTEGER PRIMARY KEY, student_id INTEGER, question_id TEXT, question_order INTEGER,
      answer TEXT, ai_score REAL, ai_feedback TEXT, trainer_score REAL, trainer_feedback TEXT,
      created_at TEXT
    );
    CREATE TABLE violations (id INTEGER PRIMARY KEY, student_id INTEGER, type TEXT, count INTEGER);
    CREATE TABLE violation_events (
      id INTEGER PRIMARY KEY, student_id INTEGER, type TEXT, text_length INTEGER,
      content_preview TEXT, question_id TEXT, metadata_json TEXT, created_at TEXT
    );
    CREATE TABLE recording_parts (
      id INTEGER PRIMARY KEY, student_id INTEGER, part_index INTEGER, object_key TEXT,
      byte_size INTEGER, uploaded_at TEXT
    );
    INSERT INTO question_bank VALUES ('q1', 'Coding', 'Easy', 'Java', 'Question', 'must', 'nice', 'optional');
  `);
  for (let id = 1; id <= studentCount; id += 1) {
    database.prepare(`INSERT INTO students VALUES (?, 1, ?, 'submitted', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?)`)
      .run(id, `student${id}@example.com`, `2026-08-13T00:00:${String(id).padStart(2, '0')}Z`);
    database.prepare(`INSERT INTO exam_questions VALUES (?, ?, 'q1', 1, 'answer', 6, 'ai', 8, 'trainer', CURRENT_TIMESTAMP)`)
      .run(id, id);
  }
  database.prepare("INSERT INTO violations VALUES (1, 1, 'tab_switch', 2)").run();
  database.prepare("INSERT INTO violation_events VALUES (1, 2, 'rapid_text_insertion', 300, NULL, 'q1', '{}', CURRENT_TIMESTAMP)").run();
  database.prepare("INSERT INTO recording_parts VALUES (1, 1, 1, 'part1', 1234, CURRENT_TIMESTAMP)").run();
  return database;
}

test('summary query count stays constant as student count grows', async () => {
  for (const count of [1, 20]) {
    const db = executor(fixture(count));
    const result = await loadBatchResultsSummary(db, 1, { page: 1, pageSize: 25 });
    assert.equal(result.total, count);
    assert.equal(result.items.length, count);
    assert.equal(db.queryCount, 5);
  }
});

test('summary exposes forensic-only events independently of counted violations', async () => {
  const db = executor(fixture());
  const result = await loadBatchResultsSummary(db, 1, { page: 1, pageSize: 25 });
  const forensicOnly = result.items.find(item => item.student.id === 2);
  assert.equal(forensicOnly.violations, 0);
  assert.equal(forensicOnly.violation_event_count, 1);
});

test('detail is lazy and ordered', async () => {
  const db = executor(fixture());
  const result = await loadStudentResultDetail(db, 1);
  assert.equal(db.queryCount, 4);
  assert.equal(result.questions[0].answer, 'answer');
  assert.equal(result.recording_parts[0].byte_size, 1234);
});

test('legacy and export loaders use fixed query counts', async () => {
  const legacyDb = executor(fixture(20));
  const legacy = await loadBatchResultsLegacy(legacyDb, 1);
  assert.equal(legacy.length, 20);
  assert.equal(legacyDb.queryCount, 5);
  assert.equal(legacy.find(item => item.student.id === 1).violations, 2);

  const exportDb = executor(fixture(20));
  const exported = await loadBatchExportData(exportDb, 1);
  assert.equal(exported.length, 20);
  assert.equal(exportDb.queryCount, 3);
});

