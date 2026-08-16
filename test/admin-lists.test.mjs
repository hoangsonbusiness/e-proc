import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { loadPagedBatches, loadPagedStudents } from '../dist/server/services/adminLists.js';

function fixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE batches (
      id INTEGER PRIMARY KEY, name TEXT, start_time TEXT, end_time TEXT, duration INTEGER,
      blueprint TEXT, record_enabled INTEGER, record_mode TEXT, exam_type TEXT,
      created_by INTEGER, ai_grading_status TEXT, created_at TEXT
    );
    CREATE TABLE students (
      id INTEGER PRIMARY KEY, batch_id INTEGER, email TEXT, access_code TEXT,
      status TEXT, created_at TEXT
    );
    INSERT INTO batches VALUES
      (1, 'Older', '', '', 30, '[{"module":"Java"}]', 0, 'none', 'essay', 1, 'idle', '2026-01-01'),
      (2, 'Newer', '', '', 45, '[{"module":"Spring"}]', 0, 'none', 'quiz', 1, 'idle', '2026-01-02');
    INSERT INTO students VALUES
      (1, 2, 'alice@example.com', 'AAA111', 'pending', '2026-01-01'),
      (2, 2, 'bob@example.com', 'BBB222', 'submitted', '2026-01-02');
  `);
  let queryCount = 0;
  return {
    get queryCount() { return queryCount; },
    async query(sql, params = []) {
      queryCount += 1;
      return { rows: database.prepare(sql).all(...params), rowCount: 0 };
    },
  };
}

test('paged batches bound the response and omit blueprint for dashboard callers', async () => {
  const db = fixture();
  const result = await loadPagedBatches(db, { page: 1, pageSize: 1, includeBlueprint: false });
  assert.equal(db.queryCount, 2);
  assert.equal(result.total, 2);
  assert.equal(result.totalStudents, 2);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'Newer');
  assert.equal('blueprint' in result.items[0], false);
});

test('paged batches include parsed blueprint only when requested', async () => {
  const db = fixture();
  const result = await loadPagedBatches(db, { page: 1, pageSize: 10, includeBlueprint: true });
  assert.deepEqual(result.items[0].blueprint, [{ module: 'Spring' }]);
});

test('paged students return a minimal searchable page plus batch header', async () => {
  const db = fixture();
  const result = await loadPagedStudents(db, 2, { page: 1, pageSize: 10, search: 'ALICE' });
  assert.equal(db.queryCount, 3);
  assert.equal(result.batch.name, 'Newer');
  assert.equal(result.total, 1);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['access_code', 'email', 'id', 'status']);
  assert.equal(result.items[0].email, 'alice@example.com');
});
