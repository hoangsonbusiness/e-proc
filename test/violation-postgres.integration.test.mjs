// Integration test PostgreSQL cho persistViolation — chứng minh các hành vi KHÔNG thể kiểm
// trên SQLite: partial-index conflict target trên PG thật, chuyển ? → $1 (executor thật), và
// QUAN TRỌNG NHẤT là race giữa hai violation KHÁC type dưới concurrency (P1).
//
// SQLite serialize writer bằng BEGIN IMMEDIATE nên không bao giờ tái hiện được race này; chỉ
// PostgreSQL với hai transaction đồng thời mới lộ ra. Fix (lockStudentRow → SELECT ... FOR UPDATE)
// được kiểm ở đây.
//
// Test tự SKIP khi không có TEST_DATABASE_URL. Chạy local:
//   TEST_DATABASE_URL=postgres://... npm test
//
// Bảng dùng schema tách biệt (test_violation) tạo/huỷ trong before/after để không đụng dữ liệu thật.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { persistViolation, computeViolationLock } from '../dist/server/services/violationStore.js';
import { claimQueueJob, enqueueQueueJob } from '../dist/server/services/queueStore.js';

const CONN = process.env.TEST_DATABASE_URL;
const SKIP = !CONN;

let pool;

// DbExecutor thật cho PG: chuyển ? → $n giống postgresText() trong postgres.ts.
function pgText(text, params) {
  if (!params?.length || text.includes('$1')) return text;
  let i = 1;
  return text.replace(/\?/g, () => '$' + i++);
}
function makeExecutor(client) {
  return {
    async query(text, params = []) {
      const r = await client.query(pgText(text, params), params);
      return { rows: r.rows, rowCount: r.rowCount || 0 };
    },
  };
}
async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL áp dụng đúng physical connection của transaction. pool.query('SET ...') có
    // thể chạy trên connection khác và khiến SQL production không-qualified chạm public schema.
    await client.query('SET LOCAL search_path TO test_violation');
    const result = await work(makeExecutor(client), client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

before(async () => {
  if (SKIP) return;
  pool = new pg.Pool({ connectionString: CONN, max: 5 });
  await pool.query('DROP SCHEMA IF EXISTS test_violation CASCADE');
  await pool.query('CREATE SCHEMA test_violation');
  // Bảng tối thiểu khớp production (students cần có để FOR UPDATE khóa được row).
  await pool.query(`
    CREATE TABLE test_violation.students (id INTEGER PRIMARY KEY);
    CREATE TABLE test_violation.violations (
      id SERIAL PRIMARY KEY, student_id INTEGER NOT NULL, type TEXT NOT NULL, count INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX ux_violations_student_type ON test_violation.violations(student_id, type);
    CREATE TABLE test_violation.violation_events (
      id SERIAL PRIMARY KEY, student_id INTEGER NOT NULL, batch_id INTEGER, type TEXT,
      text_length INTEGER, content_preview VARCHAR(500), question_id VARCHAR(50),
      metadata_json TEXT, event_id VARCHAR(64)
    );
    CREATE UNIQUE INDEX ux_violation_events_student_event
      ON test_violation.violation_events(student_id, event_id) WHERE event_id IS NOT NULL;
    CREATE TABLE test_violation.ai_queue (
      id INTEGER PRIMARY KEY, exam_question_id INTEGER NOT NULL, student_id INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL
    );
  `);
});

after(async () => {
  if (SKIP || !pool) return;
  await pool.query('DROP SCHEMA IF EXISTS test_violation CASCADE');
  await pool.end();
});

beforeEach(async () => {
  if (SKIP) return;
  await pool.query('TRUNCATE test_violation.violations, test_violation.violation_events, test_violation.ai_queue RESTART IDENTITY');
  await pool.query('DELETE FROM test_violation.students');
  await pool.query('INSERT INTO test_violation.students (id) VALUES (1)');
});

function input(type, eventId, forensicOnly = false) {
  return {
    studentId: 1, batchId: 1, type, eventId, forensicOnly,
    textLength: null, contentPreview: null, questionId: null, metadataJson: null,
    lockStudentRow: true, // ĐÚNG chế độ production trên Postgres
  };
}

test('partial-index conflict target chạy trên PostgreSQL thật (idempotent)', { skip: SKIP }, async () => {
  const r1 = await withTransaction((tx) => persistViolation(tx, input('tab_switch', 'e1')));
  const r2 = await withTransaction((tx) => persistViolation(tx, input('tab_switch', 'e1')));
  assert.equal(r1.replay, false);
  assert.equal(r2.replay, true);
  assert.equal(r2.currentCount, 1); // không double-count trên PG
});

test('hai event_id khác nhau cùng type → counter = 2', { skip: SKIP }, async () => {
  await withTransaction((tx) => persistViolation(tx, input('tab_switch', 'e1')));
  const r = await withTransaction((tx) => persistViolation(tx, input('tab_switch', 'e2')));
  assert.equal(r.currentCount, 2);
});

test('[P1] hai violation KHÁC type chạy ĐỒNG THỜI → total=2 và bài bị khóa', { skip: SKIP }, async () => {
  // Chạy song song thực sự: mở hai transaction, cùng persist rồi cùng commit. Với FOR UPDATE,
  // transaction thứ hai chờ transaction đầu commit nên đọc được total=2 → locked. Nếu ai bỏ
  // lockStudentRow, một trong hai (hoặc cả hai) sẽ thấy total=1 và test này đỏ.
  const [a, b] = await Promise.all([
    withTransaction((tx) => persistViolation(tx, input('tab_switch', 'ea'))),
    withTransaction((tx) => persistViolation(tx, input('copy_attempt', 'eb'))),
  ]);
  const lockedA = computeViolationLock('tab_switch', a.currentCount, a.total, false);
  const lockedB = computeViolationLock('copy_attempt', b.currentCount, b.total, false);
  const maxTotal = Math.max(a.total, b.total);

  // DB thực sự có 2 violation.
  const dbTotal = (await pool.query('SELECT COALESCE(SUM(count),0)::int AS t FROM test_violation.violations WHERE student_id = 1')).rows[0].t;
  assert.equal(dbTotal, 2, 'DB phải có tổng = 2');
  // Ít nhất request commit sau phải thấy total=2 và khóa — ngưỡng total>=2 KHÔNG bị bỏ qua.
  assert.equal(maxTotal, 2, 'ít nhất một request phải thấy total=2 (FOR UPDATE serialize)');
  assert.ok(lockedA || lockedB, 'ít nhất một request phải khóa bài');
});

test('rollback: event + counter cùng biến mất', { skip: SKIP }, async () => {
  await withTransaction((tx) => persistViolation(tx, input('tab_switch', 'e1')));
  await assert.rejects(withTransaction(async (tx) => {
    await persistViolation(tx, input('tab_switch', 'e2'));
    throw new Error('boom');
  }));
  const count = (await pool.query("SELECT count FROM test_violation.violations WHERE student_id=1 AND type='tab_switch'")).rows[0].count;
  assert.equal(count, 1);
  const e2 = (await pool.query("SELECT COUNT(*)::int c FROM test_violation.violation_events WHERE event_id='e2'")).rows[0].c;
  assert.equal(e2, 0);
});

test('[queue] hai worker đồng thời chỉ một worker claim được job', { skip: SKIP }, async () => {
  const now = new Date();
  await withTransaction((tx) => enqueueQueueJob(tx, {
    id: 101,
    examQuestionId: 101,
    studentId: 1,
    status: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }));

  const [a, b] = await Promise.all([
    withTransaction((tx) => claimQueueJob(tx, 101, new Date())),
    withTransaction((tx) => claimQueueJob(tx, 101, new Date())),
  ]);
  assert.equal(Number(a) + Number(b), 1, 'chính xác một worker phải claim thành công');

  const row = (await pool.query(
    'SELECT status, attempts FROM test_violation.ai_queue WHERE id = 101'
  )).rows[0];
  assert.equal(row.status, 'processing');
  assert.equal(row.attempts, 1);
});
