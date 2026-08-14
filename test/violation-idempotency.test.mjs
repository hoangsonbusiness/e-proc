// Regression test cho idempotency + UPSERT counter của POST /api/student/violation.
//
// Chạy CHÍNH hàm production `persistViolation` / `computeViolationLock`
// (src/server/services/violationStore.ts) — KHÔNG sao chép SQL vào test. Nếu handler đổi SQL
// hoặc logic lock, test đổi theo và bắt được hồi quy (vd từng vỡ vì thiếu
// `WHERE event_id IS NOT NULL` trong ON CONFLICT).
//
// Dùng `better-sqlite3` — dependency SẴN CÓ của project (khác node:sqlite vốn cần Node 22).
// Adapter DbExecutor bên dưới mô phỏng đúng hành vi SQLite branch của src/server/db/postgres.ts
// (SELECT → rows; ghi → rowCount = changes) để hàm production chạy nguyên trạng trên DB test.
//
// LƯU Ý: SQLite serialize writer bằng BEGIN IMMEDIATE nên KHÔNG tái hiện được race giữa hai
// violation khác type dưới concurrency — trường hợp đó nằm ở test/violation-postgres.integration.test.mjs
// (chạy khi có TEST_DATABASE_URL). File này lo idempotency/rollback/logic-lock, chạy nhanh.
//
// Chạy: npm test (node --test, tự discover thư mục test/ theo convention của Node)

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  persistViolation,
  computeViolationLock,
  isForensicOnlyViolation,
} from '../dist/server/services/violationStore.js';

let raw; // better-sqlite3 instance

// Adapter khớp interface DbExecutor.query của postgres.ts (SQLite branch).
function makeExecutor(d) {
  return {
    async query(text, params = []) {
      const stmt = d.prepare(text);
      if (text.trim().toUpperCase().startsWith('SELECT')) {
        return { rows: stmt.all(...params), rowCount: 0 };
      }
      const r = stmt.run(...params);
      return { rows: [], rowCount: r.changes, lastInsertRowid: r.lastInsertRowid };
    },
  };
}

// withTransaction thật cũng dùng BEGIN IMMEDIATE / COMMIT / ROLLBACK — mô phỏng để test rollback.
async function withTransaction(d, work) {
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = await work(makeExecutor(d));
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

function setupSchema(d) {
  d.exec(`
    CREATE TABLE violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, type TEXT NOT NULL, count INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX ux_violations_student_type ON violations(student_id, type);
    CREATE TABLE violation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL, batch_id INTEGER, type TEXT,
      text_length INTEGER, content_preview TEXT, question_id TEXT, metadata_json TEXT, event_id TEXT
    );
    CREATE UNIQUE INDEX ux_violation_events_student_event
      ON violation_events(student_id, event_id) WHERE event_id IS NOT NULL;
  `);
}

// Gọi persistViolation thật trong một transaction, kèm tính lock như route.
async function report(d, { studentId = 1, type, eventId = null, forensicOnly = false } = {}) {
  const res = await withTransaction(d, (tx) =>
    persistViolation(tx, {
      studentId, batchId: 1, type, eventId, forensicOnly,
      textLength: null, contentPreview: null, questionId: null, metadataJson: null,
      lockStudentRow: false, // SQLite: BEGIN IMMEDIATE đã serialize; FOR UPDATE không hỗ trợ
    })
  );
  const locked = computeViolationLock(type, res.currentCount, res.total, forensicOnly);
  return { ...res, locked };
}

beforeEach(() => {
  raw = new Database(':memory:');
  setupSchema(raw);
});

test('event mới làm tăng counter', async () => {
  const r = await report(raw, { type: 'tab_switch', eventId: 'e1' });
  assert.deepEqual(
    { replay: r.replay, currentCount: r.currentCount, total: r.total, locked: r.locked },
    { replay: false, currentCount: 1, total: 1, locked: false }
  );
});

test('retry cùng event_id KHÔNG tăng counter (idempotent)', async () => {
  await report(raw, { type: 'tab_switch', eventId: 'e1' });
  const r = await report(raw, { type: 'tab_switch', eventId: 'e1' });
  assert.equal(r.replay, true);
  assert.equal(r.currentCount, 1); // không double-count
});

test('hai event_id khác nhau cùng type tích lũy và chạm ngưỡng khóa', async () => {
  await report(raw, { type: 'tab_switch', eventId: 'e1' });
  const r = await report(raw, { type: 'tab_switch', eventId: 'e2' });
  assert.equal(r.currentCount, 2);
  assert.equal(r.locked, true);
});

test('event_id NULL (client cũ) luôn ghi, không dedupe', async () => {
  const r1 = await report(raw, { type: 'copy_attempt', eventId: null });
  const r2 = await report(raw, { type: 'copy_attempt', eventId: null });
  assert.equal(r1.currentCount, 1);
  assert.equal(r2.currentCount, 2);
});

test('forensic-only không tăng counter, replay vẫn nhận diện', async () => {
  const r1 = await report(raw, { type: 'rapid_text_insertion', eventId: 'e9', forensicOnly: true });
  assert.equal(r1.currentCount, 0);
  const r2 = await report(raw, { type: 'rapid_text_insertion', eventId: 'e9', forensicOnly: true });
  assert.equal(r2.replay, true);
  assert.equal(r2.currentCount, 0);
});

test('UPSERT giữ đúng MỘT row counter mỗi (student, type)', async () => {
  await report(raw, { type: 'tab_switch', eventId: 'e1' });
  await report(raw, { type: 'tab_switch', eventId: 'e2' });
  const rows = raw.prepare("SELECT COUNT(*) c FROM violations WHERE student_id = 1 AND type = 'tab_switch'").get().c;
  assert.equal(rows, 1);
});

test('recording_stopped khóa ngay lần đầu', async () => {
  const r = await report(raw, { type: 'recording_stopped', eventId: 'e1' });
  assert.equal(r.locked, true);
});

test('rollback: nếu transaction lỗi SAU khi ghi event thì cả event lẫn counter cùng biến mất', async () => {
  // Ghi một event thành công trước để có state nền.
  await report(raw, { type: 'tab_switch', eventId: 'e1' });
  // Transaction cố ý ném lỗi sau persistViolation → phải rollback toàn bộ thao tác trong tx.
  await assert.rejects(
    withTransaction(raw, async (tx) => {
      await persistViolation(tx, {
        studentId: 1, batchId: 1, type: 'tab_switch', eventId: 'e2', forensicOnly: false,
        textLength: null, contentPreview: null, questionId: null, metadataJson: null,
        lockStudentRow: false,
      });
      throw new Error('boom after persist');
    })
  );
  // Sau rollback: counter vẫn 1 (không tăng), và event 'e2' KHÔNG tồn tại.
  const count = raw.prepare("SELECT count c FROM violations WHERE student_id = 1 AND type = 'tab_switch'").get().c;
  assert.equal(count, 1, 'counter phải giữ nguyên sau rollback');
  const e2 = raw.prepare("SELECT COUNT(*) c FROM violation_events WHERE student_id = 1 AND event_id = 'e2'").get().c;
  assert.equal(e2, 0, 'event e2 phải bị rollback');
});

test('ON CONFLICT khớp partial index — thiếu WHERE sẽ ném lỗi (chống hồi quy cú pháp)', () => {
  // Nếu ai bỏ `WHERE event_id IS NOT NULL`, SQLite/PG từ chối. Test chốt cú pháp đúng.
  assert.throws(() =>
    raw.prepare(`INSERT INTO violation_events (student_id, type, event_id) VALUES (?, ?, ?)
      ON CONFLICT (student_id, event_id) DO NOTHING`).run(2, 't', 'x')
  );
});

test('suspicious_paste is forensic-only and can never lock an exam', async () => {
  const forensicOnly = isForensicOnlyViolation('suspicious_paste');
  assert.equal(forensicOnly, true);

  const r1 = await report(raw, { type: 'suspicious_paste', eventId: 'paste-1', forensicOnly });
  const r2 = await report(raw, { type: 'suspicious_paste', eventId: 'paste-2', forensicOnly });

  assert.equal(r1.locked, false);
  assert.equal(r2.locked, false);
  assert.equal(r2.currentCount, 0);
  assert.equal(r2.total, 0);
  assert.equal(
    raw.prepare("SELECT COUNT(*) c FROM violation_events WHERE type = 'suspicious_paste'").get().c,
    2
  );
});

test('legacy suspicious_paste counters are excluded from the lockable total', async () => {
  raw.prepare("INSERT INTO violations (student_id, type, count) VALUES (1, 'suspicious_paste', 5)").run();

  const r = await report(raw, { type: 'tab_switch', eventId: 'tab-after-legacy' });

  assert.equal(r.currentCount, 1);
  assert.equal(r.total, 1);
  assert.equal(r.locked, false);
});

test('concurrent_session is forensic-only in counter logic', async () => {
  const forensicOnly = isForensicOnlyViolation('concurrent_session');
  assert.equal(forensicOnly, true);

  const result = await report(raw, {
    type: 'concurrent_session',
    eventId: 'server-evidence-1',
    forensicOnly,
  });

  assert.equal(result.currentCount, 0);
  assert.equal(result.total, 0);
  assert.equal(result.locked, false);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM violations WHERE type = 'concurrent_session'").get().c, 0);
  assert.equal(raw.prepare("SELECT COUNT(*) c FROM violation_events WHERE type = 'concurrent_session'").get().c, 1);
});

test('legacy concurrent_session counters are excluded from the lockable total', async () => {
  raw.prepare("INSERT INTO violations (student_id, type, count) VALUES (1, 'concurrent_session', 9)").run();

  const result = await report(raw, { type: 'tab_switch', eventId: 'tab-after-concurrent-legacy' });

  assert.equal(result.currentCount, 1);
  assert.equal(result.total, 1);
  assert.equal(result.locked, false);
});
