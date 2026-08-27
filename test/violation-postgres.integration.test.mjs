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
import { persistViolationIfInProgress } from '../dist/server/services/violationRequestStore.js';
import {
  commitInspectedRecordingPart,
  commitInspectedReservedRecordingPart,
  finalizeRecordingManifest,
  reserveRecordingUpload,
  recordCompletedRecordingPart,
  sealRecordingManifest,
} from '../dist/server/services/recordingPersistence.js';

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
    CREATE TABLE test_violation.batches (
      id INTEGER PRIMARY KEY,
      record_mode TEXT NOT NULL DEFAULT 's3',
      record_enabled BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE test_violation.students (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER,
      status TEXT NOT NULL DEFAULT 'in_progress',
      active_jti TEXT,
      exam_deadline TIMESTAMP,
      submitted_at TIMESTAMP,
      recording_incomplete BOOLEAN NOT NULL DEFAULT FALSE,
      recording_finalized_at TIMESTAMP,
      recording_final_part_index INTEGER,
      recording_manifest_sealed_at TIMESTAMP,
      recording_expected_part_count INTEGER,
      attempt_record_mode TEXT
    );
    CREATE TABLE test_violation.exam_questions (id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL);
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
    CREATE TABLE test_violation.recording_parts (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      part_index INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      uploaded_at TIMESTAMP NOT NULL,
      is_final BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(student_id, part_index)
    );
    CREATE TABLE test_violation.recording_upload_reservations (
      id SERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      upload_id VARCHAR(64) NOT NULL,
      part_index INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP
    );
    CREATE UNIQUE INDEX ux_recording_upload_reservations_student_upload
      ON test_violation.recording_upload_reservations(student_id, upload_id);
    CREATE UNIQUE INDEX ux_recording_upload_reservations_student_part
      ON test_violation.recording_upload_reservations(student_id, part_index);
  `);
});

after(async () => {
  if (SKIP || !pool) return;
  await pool.query('DROP SCHEMA IF EXISTS test_violation CASCADE');
  await pool.end();
});

beforeEach(async () => {
  if (SKIP) return;
  await pool.query('TRUNCATE test_violation.violations, test_violation.violation_events, test_violation.exam_questions, test_violation.recording_upload_reservations, test_violation.recording_parts RESTART IDENTITY');
  await pool.query('DELETE FROM test_violation.students');
  await pool.query('DELETE FROM test_violation.batches');
  await pool.query('INSERT INTO test_violation.batches (id) VALUES (1)');
  await pool.query("INSERT INTO test_violation.students (id, batch_id, status, active_jti) VALUES (1, 1, 'in_progress', 'session-a')");
  await pool.query('INSERT INTO test_violation.exam_questions (id, student_id) VALUES (101, 1)');
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

test('recording_stopped đến sau submit bị bỏ qua trong transaction PostgreSQL', { skip: SKIP }, async () => {
  await pool.query("UPDATE test_violation.students SET status = 'submitted' WHERE id = 1");

  const result = await withTransaction((tx) =>
    persistViolationIfInProgress(tx, input('recording_stopped', 'after-submit')),
  );

  assert.deepEqual(result, {
    ignored: true,
    replay: false,
    currentCount: 0,
    total: 0,
  });
  const eventCount = (await pool.query(
    "SELECT COUNT(*)::int AS count FROM test_violation.violation_events WHERE event_id = 'after-submit'",
  )).rows[0].count;
  const counterCount = (await pool.query(
    "SELECT COUNT(*)::int AS count FROM test_violation.violations WHERE type = 'recording_stopped'",
  )).rows[0].count;
  assert.equal(eventCount, 0);
  assert.equal(counterCount, 0);
});

test('recording_stopped khi đang thi vẫn được ghi qua transaction gate', { skip: SKIP }, async () => {
  const result = await withTransaction((tx) =>
    persistViolationIfInProgress(tx, input('recording_stopped', 'during-exam')),
  );

  assert.equal(result.ignored, false);
  assert.equal(result.currentCount, 1);
  assert.equal(result.total, 1);
});

test('hai uploadId đồng thời được reserve index riêng và replay ổn định trên PostgreSQL', { skip: SKIP }, async () => {
  const reserve = (uploadId) => withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId,
    sessionId: 'session-a',
    useSqlite: false,
  }));

  const [first, second] = await Promise.all([reserve('upload-a'), reserve('upload-b')]);
  assert.deepEqual(
    [first.partIndex, second.partIndex].sort((a, b) => a - b),
    [0, 1],
    'the student row lock must serialize first-available allocation',
  );
  assert.notEqual(first.objectKey, second.objectKey);

  const replay = await reserve('upload-a');
  assert.equal(replay.already, true);
  assert.equal(replay.partIndex, first.partIndex);
  assert.equal(replay.objectKey, first.objectKey);
});

test('hai seal đồng thời serialize thành đúng một exact manifest trên PostgreSQL', { skip: SKIP }, async () => {
  const nowMs = Date.now();
  await pool.query(
    `UPDATE test_violation.students
     SET status = 'submitted', submitted_at = $1, recording_incomplete = TRUE
     WHERE id = 1`,
    [new Date(nowMs).toISOString()],
  );
  const seal = (uploadId) => withTransaction((tx) => sealRecordingManifest(tx, {
    studentId: 1,
    batchId: 1,
    sessionId: 'session-a',
    parts: [{ uploadId, partIndex: 0 }],
    useSqlite: false,
    nowMs,
  }));

  const outcomes = await Promise.allSettled([seal('seal-a'), seal('seal-b')]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'MANIFEST_CONFLICT');

  const state = (await pool.query(`
    SELECT recording_expected_part_count,
           (SELECT COUNT(*)::int FROM test_violation.recording_upload_reservations
            WHERE student_id = 1) AS reservations
    FROM test_violation.students WHERE id = 1
  `)).rows[0];
  assert.equal(state.recording_expected_part_count, 1);
  assert.equal(state.reservations, 1);
});

test('reset + jti mới tạo namespace S3 khác trên PostgreSQL', { skip: SKIP }, async () => {
  const first = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'same-upload-id',
    sessionId: 'session-a',
    useSqlite: false,
  }));
  await pool.query('DELETE FROM test_violation.recording_upload_reservations WHERE student_id = 1');
  await pool.query('DELETE FROM test_violation.recording_parts WHERE student_id = 1');
  await pool.query("UPDATE test_violation.students SET active_jti = 'session-b' WHERE id = 1");

  await assert.rejects(
    withTransaction((tx) => reserveRecordingUpload(tx, {
      studentId: 1,
      batchId: 1,
      uploadId: 'stale-request',
      sessionId: 'session-a',
      useSqlite: false,
    })),
    (error) => error?.code === 'NOT_IN_PROGRESS',
  );

  const second = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'same-upload-id',
    sessionId: 'session-b',
    useSqlite: false,
  }));
  assert.equal(first.partIndex, 0);
  assert.equal(second.partIndex, 0);
  assert.notEqual(second.objectKey, first.objectKey);

  await assert.rejects(
    withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
      studentId: 1,
      batchId: 1,
      uploadId: second.uploadId,
      objectKey: first.objectKey,
      byteSize: 100,
      uploadedAt: new Date().toISOString(),
      useSqlite: false,
    })),
    (error) => error?.code === 'RECORDING_RESERVATION_CONFLICT',
  );
});

test('reserved HeadObject completion persists only its canonical PostgreSQL key', { skip: SKIP }, async () => {
  const reservation = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'upload-a',
    sessionId: 'session-a',
    useSqlite: false,
  }));
  const input = {
    studentId: 1,
    batchId: 1,
    uploadId: 'upload-a',
    objectKey: reservation.objectKey,
    byteSize: 2048,
    uploadedAt: new Date().toISOString(),
    useSqlite: false,
  };

  const first = await withTransaction((tx) => commitInspectedReservedRecordingPart(tx, input));
  const replay = await withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
    ...input,
    byteSize: 9999,
  }));
  assert.equal(first.already, false);
  assert.equal(replay.already, true);
  assert.equal(replay.byteSize, 2048);
  assert.equal(replay.objectKey, reservation.objectKey);

  await assert.rejects(
    withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
      ...input,
      objectKey: 'recordings/1/1/part999.webm',
    })),
    (error) => error?.code === 'RECORDING_RESERVATION_CONFLICT',
  );
  const rows = (await pool.query(`
    SELECT p.part_index, p.object_key, p.byte_size, r.completed_at
    FROM test_violation.recording_parts p
    JOIN test_violation.recording_upload_reservations r
      ON r.student_id = p.student_id AND r.part_index = p.part_index
    WHERE p.student_id = 1
  `)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].part_index, reservation.partIndex);
  assert.equal(rows[0].object_key, reservation.objectKey);
  assert.equal(Number(rows[0].byte_size), 2048);
  assert.ok(rows[0].completed_at);
});

test('recording-complete replay idempotent trên PostgreSQL thật', { skip: SKIP }, async () => {
  const completion = {
    studentId: 1,
    batchId: 1,
    partIndex: 0,
    objectKey: 'recordings/1/1/part000.webm',
    byteSize: 2048,
    uploadedAt: new Date().toISOString(),
  };

  const first = await withTransaction((tx) => recordCompletedRecordingPart(tx, completion));
  const replay = await withTransaction((tx) => recordCompletedRecordingPart(tx, {
    ...completion,
    objectKey: 'must-not-replace-canonical-key',
    byteSize: 9999,
  }));

  assert.equal(first.already, false);
  assert.deepEqual(replay, {
    already: true,
    objectKey: completion.objectKey,
    byteSize: completion.byteSize,
  });
});

test('submitted S3 manifest finalize và same-manifest replay đều thành công', { skip: SKIP }, async () => {
  const nowMs = Date.now();
  const reservation = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'finalize-upload',
    sessionId: 'session-a',
    useSqlite: false,
    nowMs,
  }));
  await withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: reservation.uploadId,
    objectKey: reservation.objectKey,
    byteSize: 2048,
    uploadedAt: new Date(nowMs).toISOString(),
    useSqlite: false,
    nowMs,
  }));
  await pool.query(
    `UPDATE test_violation.students
     SET status = 'submitted', submitted_at = $1, recording_incomplete = TRUE
     WHERE id = 1`,
    [new Date(nowMs).toISOString()],
  );
  await withTransaction((tx) => sealRecordingManifest(tx, {
    studentId: 1,
    batchId: 1,
    sessionId: 'session-a',
    parts: [],
    useSqlite: false,
    nowMs,
  }));

  const finalized = await withTransaction((tx) => finalizeRecordingManifest(tx, {
    studentId: 1,
    batchId: 1,
    finalPartIndex: 0,
    useSqlite: false,
    nowMs,
  }));
  const replay = await withTransaction((tx) => finalizeRecordingManifest(tx, {
    studentId: 1,
    batchId: 1,
    finalPartIndex: 0,
    useSqlite: false,
    nowMs: nowMs + 60_000,
  }));

  assert.deepEqual(finalized, { already: false, finalPartIndex: 0 });
  assert.deepEqual(replay, { already: true, finalPartIndex: 0 });
  const row = (await pool.query(
    `SELECT recording_incomplete, recording_final_part_index
     FROM test_violation.students WHERE id = 1`,
  )).rows[0];
  assert.equal(row.recording_incomplete, false);
  assert.equal(row.recording_final_part_index, 0);
});

test('manifest hoàn chỉnh vẫn không được finalize trước khi submit', { skip: SKIP }, async () => {
  const nowMs = Date.now();
  const reservation = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'early-finalize',
    sessionId: 'session-a',
    useSqlite: false,
    nowMs,
  }));
  await withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: reservation.uploadId,
    objectKey: reservation.objectKey,
    byteSize: 2048,
    uploadedAt: new Date(nowMs).toISOString(),
    useSqlite: false,
    nowMs,
  }));

  await assert.rejects(
    withTransaction((tx) => finalizeRecordingManifest(tx, {
      studentId: 1,
      batchId: 1,
      useSqlite: false,
      nowMs: nowMs + 1000,
    })),
    (error) => error?.code === 'MANIFEST_NOT_SEALED',
  );
  const row = (await pool.query(`
    SELECT status, recording_finalized_at, recording_final_part_index
    FROM test_violation.students WHERE id = 1
  `)).rows[0];
  assert.equal(row.status, 'in_progress');
  assert.equal(row.recording_finalized_at, null);
  assert.equal(row.recording_final_part_index, null);
});

test('submitted recording grace vẫn đúng khi Node chạy timezone UTC+7', { skip: SKIP }, async () => {
  const nowMs = Date.UTC(2026, 7, 27, 1, 5, 0, 0);
  const reservation = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'timezone-upload',
    sessionId: 'session-a',
    useSqlite: false,
    nowMs: nowMs - 120_000,
  }));
  await withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: reservation.uploadId,
    objectKey: reservation.objectKey,
    byteSize: 2048,
    uploadedAt: new Date(nowMs - 90_000).toISOString(),
    useSqlite: false,
    nowMs: nowMs - 90_000,
  }));
  await pool.query(
    `UPDATE test_violation.students
     SET status = 'submitted', submitted_at = $1, recording_incomplete = TRUE
     WHERE id = 1`,
    [new Date(nowMs - 60_000).toISOString()],
  );
  await withTransaction((tx) => sealRecordingManifest(tx, {
    studentId: 1,
    batchId: 1,
    sessionId: 'session-a',
    parts: [],
    useSqlite: false,
    nowMs: nowMs - 30_000,
  }));

  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Bangkok';
  try {
    const result = await withTransaction((tx) => finalizeRecordingManifest(tx, {
      studentId: 1,
      batchId: 1,
      finalPartIndex: 0,
      useSqlite: false,
      nowMs,
    }));
    assert.deepEqual(result, { already: false, finalPartIndex: 0 });
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('recording-complete không thể chèn part mới sau khi manifest đồng thời đã finalize', { skip: SKIP }, async () => {
  const nowMs = Date.now();
  const reservation = await withTransaction((tx) => reserveRecordingUpload(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: 'race-upload',
    sessionId: 'session-a',
    useSqlite: false,
    nowMs,
  }));
  await withTransaction((tx) => commitInspectedReservedRecordingPart(tx, {
    studentId: 1,
    batchId: 1,
    uploadId: reservation.uploadId,
    objectKey: reservation.objectKey,
    byteSize: 2048,
    uploadedAt: new Date(nowMs).toISOString(),
    useSqlite: false,
    nowMs,
  }));
  await pool.query(
    `UPDATE test_violation.students
     SET status = 'submitted', submitted_at = $1, recording_incomplete = TRUE
     WHERE id = 1`,
    [new Date(nowMs).toISOString()],
  );
  await withTransaction((tx) => sealRecordingManifest(tx, {
    studentId: 1,
    batchId: 1,
    sessionId: 'session-a',
    parts: [],
    useSqlite: false,
    nowMs,
  }));

  const [finalizeResult, completionResult] = await Promise.allSettled([
    withTransaction((tx) => finalizeRecordingManifest(tx, {
      studentId: 1,
      batchId: 1,
      finalPartIndex: 0,
      useSqlite: false,
      nowMs,
    })),
    withTransaction((tx) => commitInspectedRecordingPart(tx, {
      studentId: 1,
      batchId: 1,
      partIndex: 1,
      objectKey: 'recordings/1/1/part001.webm',
      byteSize: 1024,
      uploadedAt: new Date(nowMs).toISOString(),
      useSqlite: false,
      nowMs,
    })),
  ]);

  assert.ok(
    finalizeResult.status === 'fulfilled' || completionResult.status === 'fulfilled',
    'one transaction must win the shared student-row lock',
  );
  const state = (await pool.query(
    `SELECT recording_finalized_at,
            (SELECT COUNT(*)::int FROM test_violation.recording_parts
             WHERE student_id = 1 AND part_index = 1) AS late_parts
     FROM test_violation.students WHERE id = 1`,
  )).rows[0];
  assert.equal(
    Boolean(state.recording_finalized_at) && state.late_parts > 0,
    false,
    'a finalized manifest must never coexist with a later committed part',
  );
});
