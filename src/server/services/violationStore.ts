import type { DbExecutor } from '../db/postgres.js';

/**
 * Lõi persistence idempotent cho POST /api/student/violation, TÁCH RA để route production và
 * test dùng CHUNG một hàm (không sao chép SQL vào test). Nếu ai đó đổi SQL/logic ở đây, cả
 * route lẫn regression test đều thay đổi theo — test không còn kiểm bản sao.
 *
 * Bọc trong một transaction (caller truyền `tx` từ db.withTransaction):
 * - Claim forensic event bằng ON CONFLICT trên partial unique (student_id, event_id) — chỉ
 *   khi event_id NOT NULL. rowCount 0 ⇒ replay ⇒ KHÔNG tăng counter.
 * - UPSERT counter ON CONFLICT (student_id, type) DO UPDATE count = count + 1 (một row/type).
 * - Đọc lại total + current trong cùng tx ⇒ event và counter cùng commit/rollback.
 */

export interface PersistViolationInput {
  studentId: number;
  batchId: number | null;
  type: string;
  eventId: string | null;
  forensicOnly: boolean;
  textLength: number | null;
  contentPreview: string | null;
  questionId: string | null;
  metadataJson: string | null;
  // [P1-race] true trên PostgreSQL: khóa row student (FOR UPDATE) ngay đầu transaction để
  // serialize toàn bộ violation của cùng một student. Nếu không, hai violation KHÁC type chạy
  // song song sẽ upsert hai counter row khác nhau; mỗi transaction đọc SUM(count) trước khi
  // cái kia commit → cả hai thấy total=1 → cả hai bỏ qua ngưỡng "total>=2". SQLite không cần
  // (và không hỗ trợ FOR UPDATE) vì BEGIN IMMEDIATE đã serialize writer toàn cục.
  lockStudentRow: boolean;
}

export interface PersistViolationResult {
  replay: boolean;
  currentCount: number;
  total: number;
}

// These signals are useful for adjudication but are heuristic and must never
// contribute to automatic submission. suspicious_paste is based on insertion
// size and cannot prove that the text came from a clipboard.
export const FORENSIC_ONLY_VIOLATION_TYPES = new Set([
  'suspicious_paste',
  'rapid_text_insertion',
  'multiple_display_detected',
]);

export function isForensicOnlyViolation(type: string): boolean {
  return FORENSIC_ONLY_VIOLATION_TYPES.has(type);
}

const FORENSIC_ONLY_TYPES = [...FORENSIC_ONLY_VIOLATION_TYPES];
const SQL_LOCKABLE_TOTAL =
  `SELECT SUM(count) as total FROM violations
   WHERE student_id = ? AND type NOT IN (${FORENSIC_ONLY_TYPES.map(() => '?').join(', ')})`;

// ON CONFLICT PHẢI lặp lại predicate `WHERE event_id IS NOT NULL` để khớp partial unique index —
// cả SQLite lẫn PostgreSQL từ chối nếu thiếu ("ON CONFLICT clause does not match any ... UNIQUE
// constraint"). Với event_id NULL, partial index không áp dụng nên INSERT luôn thành công.
export const SQL_INSERT_EVENT =
  `INSERT INTO violation_events (student_id, batch_id, type, text_length, content_preview, question_id, metadata_json, event_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (student_id, event_id) WHERE event_id IS NOT NULL DO NOTHING`;

export const SQL_UPSERT_COUNTER =
  `INSERT INTO violations (student_id, type, count) VALUES (?, ?, 1)
   ON CONFLICT (student_id, type) DO UPDATE SET count = violations.count + 1`;

export async function persistViolation(tx: DbExecutor, input: PersistViolationInput): Promise<PersistViolationResult> {
  const { studentId, batchId, type, eventId, forensicOnly, textLength, contentPreview, questionId, metadataJson, lockStudentRow } = input;

  // [P1-race] Khóa row student TRƯỚC mọi thao tác — mọi violation của cùng student bị tuần tự
  // hóa, nên SUM(count) không bao giờ đọc trúng trạng thái nửa-commit của transaction song song.
  if (lockStudentRow) {
    await tx.query('SELECT id FROM students WHERE id = ? FOR UPDATE', [studentId]);
  }

  const ins = await tx.query(SQL_INSERT_EVENT, [
    studentId, batchId, type, textLength, contentPreview, questionId, metadataJson, eventId,
  ]);
  // rowCount 0 chỉ có nghĩa "replay" khi có event_id (ON CONFLICT mới kích hoạt được).
  const replay = !!eventId && ins.rowCount === 0;

  if (!replay && !forensicOnly) {
    await tx.query(SQL_UPSERT_COUNTER, [studentId, type]);
  }

  // Exclude forensic-only types from the aggregate as well as from new writes.
  // This is important after deployment because legacy suspicious_paste counters
  // may already exist and must not help a later lockable event reach total >= 2.
  const totalR = await tx.query(SQL_LOCKABLE_TOTAL, [studentId, ...FORENSIC_ONLY_TYPES]);
  const curR = await tx.query('SELECT count FROM violations WHERE student_id = ? AND type = ?', [studentId, type]);
  return {
    replay,
    total: parseInt(totalR.rows[0]?.total) || 0,
    currentCount: parseInt(curR.rows[0]?.count) || 0,
  };
}

/**
 * Ngưỡng khóa cho một loại vi phạm. forensic-only không bao giờ khóa.
 * recording_stopped: khóa NGAY lần đầu. Còn lại: 1 type >= 2 HOẶC tổng >= 2.
 */
export function computeViolationLock(type: string, currentCount: number, total: number, forensicOnly: boolean): boolean {
  return !forensicOnly && (type === 'recording_stopped' || currentCount >= 2 || total >= 2);
}
