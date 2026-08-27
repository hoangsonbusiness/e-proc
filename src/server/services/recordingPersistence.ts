import { createHash } from 'node:crypto';
import type { DbExecutor } from '../db/postgres.js';

// One S3 stage can consume several bounded retries (including a 120s PUT), and
// multiple queued parts are drained serially after answer submission. Keep the
// recording-only window comfortably above one complete retry pipeline while
// answers/questions remain closed by the submitted status.
export const SUBMITTED_RECORDING_GRACE_MS = 60 * 60_000;
export const MAX_RECORDING_PART_INDEX = 1000;

function recordingError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export interface CompletedRecordingPart {
  objectKey: string;
  byteSize: number;
}

export async function findCompletedRecordingPart(
  executor: DbExecutor,
  studentId: number,
  partIndex: number,
): Promise<CompletedRecordingPart | null> {
  const result = await executor.query(
    `SELECT object_key, byte_size
     FROM recording_parts
     WHERE student_id = ? AND part_index = ?`,
    [studentId, partIndex],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    objectKey: String(row.object_key),
    byteSize: Number(row.byte_size),
  };
}

export interface RecordCompletedRecordingPartInput {
  studentId: number;
  batchId: number;
  partIndex: number;
  objectKey: string;
  byteSize: number;
  uploadedAt: string;
}

export async function recordCompletedRecordingPart(
  executor: DbExecutor,
  input: RecordCompletedRecordingPartInput,
): Promise<CompletedRecordingPart & { already: boolean }> {
  const inserted = await executor.query(
    `INSERT INTO recording_parts (student_id, batch_id, part_index, object_key, byte_size, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (student_id, part_index) DO NOTHING`,
    [
      input.studentId,
      input.batchId,
      input.partIndex,
      input.objectKey,
      input.byteSize,
      input.uploadedAt,
    ],
  );

  if (inserted.rowCount > 0) {
    return { already: false, objectKey: input.objectKey, byteSize: input.byteSize };
  }

  // A concurrent completion (or a lost prior response) won the unique key.
  // Read back the committed metadata so the response explicitly describes an
  // idempotent replay instead of assuming ON CONFLICT was successful.
  const existing = await findCompletedRecordingPart(executor, input.studentId, input.partIndex);
  if (!existing) {
    const error: any = new Error('Recording part completion could not be confirmed');
    error.code = 'RECORDING_PART_CONFLICT';
    throw error;
  }
  return { already: true, ...existing };
}

export interface RecordingUploadReservation {
  studentId: number;
  batchId: number;
  uploadId: string;
  partIndex: number;
  objectKey: string;
  createdAt: string | Date;
  completedAt: string | Date | null;
  completed: boolean;
  byteSize: number | null;
}

export function recordingObjectKey(
  batchId: number,
  studentId: number,
  sessionId: string,
  partIndex: number,
): string {
  // active_jti is generated and persisted by the backend. Hashing it keeps the
  // S3 namespace path-safe and, critically, prevents a presigned URL from a
  // reset/revoked attempt overwriting the same numeric part in a later attempt.
  const sessionNamespace = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return `recordings/${batchId}/${studentId}/session-${sessionNamespace}/part${String(partIndex).padStart(3, '0')}.webm`;
}

/** Read the stable reservation and its canonical completed-part metadata, if any. */
export async function findRecordingUploadReservation(
  executor: DbExecutor,
  studentId: number,
  uploadId: string,
): Promise<RecordingUploadReservation | null> {
  const result = await executor.query(
    `SELECT r.student_id, r.batch_id, r.upload_id, r.part_index, r.object_key,
            r.created_at, r.completed_at, p.id AS completed_part_id,
            p.object_key AS completed_object_key, p.byte_size AS completed_byte_size
     FROM recording_upload_reservations r
     LEFT JOIN recording_parts p
       ON p.student_id = r.student_id AND p.part_index = r.part_index
     WHERE r.student_id = ? AND r.upload_id = ?`,
    [studentId, uploadId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const hasCompletedPart = row.completed_part_id != null;
  const hasCompletionMarker = row.completed_at != null;
  if (hasCompletedPart !== hasCompletionMarker) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Recording upload reservation has incomplete completion metadata',
    );
  }
  const completed = hasCompletedPart && hasCompletionMarker;
  if (completed && String(row.completed_object_key) !== String(row.object_key)) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Reserved recording part points to conflicting completed metadata',
    );
  }

  return {
    studentId: Number(row.student_id),
    batchId: Number(row.batch_id),
    uploadId: String(row.upload_id),
    partIndex: Number(row.part_index),
    objectKey: String(row.object_key),
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    completed,
    byteSize: completed ? Number(row.completed_byte_size) : null,
  };
}

/**
 * Return the first non-negative index not occupied by either a durable logical
 * upload reservation or legacy/current completed recording metadata.
 */
export async function findNextRecordingPartIndex(
  executor: DbExecutor,
  studentId: number,
): Promise<number> {
  const occupied = await executor.query(
    `SELECT part_index FROM (
       SELECT part_index FROM recording_parts WHERE student_id = ?
       UNION
       SELECT part_index FROM recording_upload_reservations WHERE student_id = ?
     ) occupied_parts
     ORDER BY part_index`,
    [studentId, studentId],
  );
  let next = 0;
  for (const row of occupied.rows) {
    const index = Number(row.part_index);
    if (!Number.isInteger(index) || index < next) continue;
    if (index > next) break;
    next += 1;
  }
  return next;
}

export interface RecordingExamRow {
  status?: string;
  active_jti?: string | null;
  exam_deadline?: string | Date | null;
  submitted_at?: string | Date | null;
  recording_incomplete?: boolean | number | null;
  recording_finalized_at?: string | Date | null;
  recording_final_part_index?: number | string | null;
  recording_manifest_sealed_at?: string | Date | null;
  recording_expected_part_count?: number | string | null;
  attempt_record_mode?: string | null;
  record_mode?: string | null;
  record_enabled?: boolean | number | null;
}

export function effectiveAttemptRecordMode(row: RecordingExamRow): string {
  return String(row.attempt_record_mode || row.record_mode || (row.record_enabled ? 's3' : 'none'));
}

/**
 * PostgreSQL `TIMESTAMP WITHOUT TIME ZONE` is parsed by node-postgres as a Date
 * in the Node process timezone. The application stores these columns as UTC
 * wall-clock values, so reconstruct Date instances from their local fields.
 * SQLite returns the original ISO string, which is parsed normally.
 */
export function timestampWithoutTimezoneUtcMs(value: string | Date): number {
  if (value instanceof Date) {
    return Date.UTC(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
      value.getMilliseconds(),
    );
  }

  const timestamp = value.trim();
  if (!timestamp) return Number.NaN;
  const hasTimezone = /(?:z|[+-]\d{2}(?::?\d{2})?)$/i.test(timestamp);
  const isoLike = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T');
  return Date.parse(hasTimezone ? isoLike : `${isoLike}Z`);
}

export function isWithinSubmittedRecordingGrace(row: RecordingExamRow, nowMs: number): boolean {
  if (row.status !== 'submitted' || !row.recording_incomplete || !row.submitted_at) return false;
  const submittedAtMs = timestampWithoutTimezoneUtcMs(row.submitted_at);
  return Number.isFinite(submittedAtMs)
    && nowMs >= submittedAtMs
    && nowMs - submittedAtMs <= SUBMITTED_RECORDING_GRACE_MS;
}

export function acceptsRecordingWrites(row: RecordingExamRow, nowMs: number): boolean {
  if (row.recording_finalized_at) return false;
  return row.status === 'in_progress' || isWithinSubmittedRecordingGrace(row, nowMs);
}

export function acceptsRecordingReservation(row: RecordingExamRow, nowMs: number): boolean {
  if (!acceptsRecordingWrites(row, nowMs)) return false;
  if (row.recording_manifest_sealed_at) return false;
  if (row.status !== 'in_progress' || !row.exam_deadline) return true;
  const deadlineMs = timestampWithoutTimezoneUtcMs(row.exam_deadline);
  return Number.isFinite(deadlineMs) && nowMs < deadlineMs;
}

export interface ReserveRecordingUploadInput {
  studentId: number;
  batchId: number;
  uploadId: string;
  /** Authenticated JWT jti observed for this request. */
  sessionId: string;
  useSqlite: boolean;
  nowMs?: number;
}

/**
 * Allocate one stable part index for a logical client blob. Call this helper
 * inside `withTransaction`: PostgreSQL serializes allocators for the same
 * student with FOR UPDATE; SQLite uses BEGIN IMMEDIATE.
 */
export async function reserveRecordingUpload(
  tx: DbExecutor,
  input: ReserveRecordingUploadInput,
): Promise<RecordingUploadReservation & { already: boolean }> {
  if (
    typeof input.uploadId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.uploadId)
  ) {
    throw recordingError('INVALID_UPLOAD_ID', 'Recording uploadId is invalid');
  }
  if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam recording session is not active');
  }

  const row: RecordingExamRow | undefined = (await tx.query(
    `SELECT s.status, s.active_jti, s.exam_deadline, s.submitted_at, s.recording_incomplete, s.recording_finalized_at,
            s.recording_manifest_sealed_at, s.recording_expected_part_count,
            s.attempt_record_mode,
            b.record_mode, b.record_enabled
     FROM students s JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND b.id = ?${input.useSqlite ? '' : ' FOR UPDATE OF s'}`,
    [input.studentId, input.batchId],
  )).rows[0];
  if (!row) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording uploads');
  }
  const recordMode = effectiveAttemptRecordMode(row);
  if (recordMode !== 's3') {
    throw recordingError('BAD_RECORD_MODE', 'S3 recording is not enabled');
  }
  // Re-check the request jti while holding the student-row lock. A request can
  // pass auth and then wait while /verify or reset rotates active_jti; it must
  // never reserve into the newly-active session after that revocation.
  if (row.active_jti !== input.sessionId) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam recording session is no longer active');
  }

  const existing = await findRecordingUploadReservation(tx, input.studentId, input.uploadId);
  if (existing) {
    if (existing.batchId !== input.batchId) {
      throw recordingError(
        'RECORDING_RESERVATION_CONFLICT',
        'Recording uploadId belongs to a different batch',
      );
    }
    // A completed reservation is a canonical replay even after finalization.
    const canReplayPending = row.recording_manifest_sealed_at
      ? acceptsRecordingWrites(row, input.nowMs ?? Date.now())
      : acceptsRecordingReservation(row, input.nowMs ?? Date.now());
    if (existing.completed || canReplayPending) {
      return { ...existing, already: true };
    }
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording uploads');
  }

  if (!acceptsRecordingReservation(row, input.nowMs ?? Date.now())) {
    if (row.recording_manifest_sealed_at) {
      throw recordingError('MANIFEST_SEALED', 'Recording manifest is already sealed');
    }
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording uploads');
  }
  const nextPartIndex = await findNextRecordingPartIndex(tx, input.studentId);
  if (nextPartIndex > MAX_RECORDING_PART_INDEX) {
    throw recordingError('RECORDING_PART_LIMIT', 'Recording part limit exceeded');
  }
  const objectKey = recordingObjectKey(
    input.batchId,
    input.studentId,
    input.sessionId,
    nextPartIndex,
  );
  const createdAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const inserted = await tx.query(
    `INSERT INTO recording_upload_reservations
       (student_id, batch_id, upload_id, part_index, object_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (student_id, upload_id) DO NOTHING`,
    [
      input.studentId,
      input.batchId,
      input.uploadId,
      nextPartIndex,
      objectKey,
      createdAt,
    ],
  );

  const reservation = await findRecordingUploadReservation(tx, input.studentId, input.uploadId);
  if (!reservation) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Recording upload reservation could not be confirmed',
    );
  }
  if (reservation.batchId !== input.batchId) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Recording uploadId belongs to a different batch',
    );
  }
  return { ...reservation, already: inserted.rowCount === 0 };
}

export interface SealRecordingManifestPartInput {
  uploadId: string;
  partIndex: number;
}

export interface RecordingManifestPartStatus {
  uploadId: string;
  partIndex: number;
  completed: boolean;
}

export type RecordingRecoveryState =
  | 'not_required'
  | 'awaiting_seal'
  | 'processing'
  | 'finalized'
  | 'incomplete';

export interface RecordingRecoveryStatus {
  state: RecordingRecoveryState;
  recordMode: string;
  expectedPartCount: number;
  completedPartCount: number;
  finalPartIndex?: number;
}

interface RecordingManifestSnapshot {
  row: RecordingExamRow;
  recordMode: string;
  reservations: Array<{
    uploadId: string;
    partIndex: number;
    objectKey: string;
    completedAt: string | Date | null;
    completedPartId: number | string | null;
    completedObjectKey: string | null;
  }>;
  parts: Array<{ partIndex: number; objectKey: string }>;
}

async function readRecordingManifestSnapshot(
  executor: DbExecutor,
  studentId: number,
  batchId: number,
  lockStudentRow = false,
): Promise<RecordingManifestSnapshot> {
  const row: RecordingExamRow | undefined = (await executor.query(
    `SELECT s.status, s.active_jti, s.exam_deadline, s.submitted_at,
            s.recording_incomplete, s.recording_finalized_at,
            s.recording_final_part_index, s.recording_manifest_sealed_at,
            s.recording_expected_part_count, s.attempt_record_mode,
            b.record_mode, b.record_enabled
     FROM students s JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND b.id = ?${lockStudentRow ? ' FOR UPDATE OF s' : ''}`,
    [studentId, batchId],
  )).rows[0];
  if (!row) throw recordingError('NOT_IN_PROGRESS', 'Recording exam was not found');

  const reservationResult = await executor.query(
    `SELECT r.upload_id, r.part_index, r.object_key, r.completed_at,
            p.id AS completed_part_id, p.object_key AS completed_object_key
     FROM recording_upload_reservations r
     LEFT JOIN recording_parts p
       ON p.student_id = r.student_id AND p.part_index = r.part_index
     WHERE r.student_id = ?
     ORDER BY r.part_index`,
    [studentId],
  );
  const partResult = await executor.query(
    `SELECT part_index, object_key
     FROM recording_parts
     WHERE student_id = ?
     ORDER BY part_index`,
    [studentId],
  );

  return {
    row,
    recordMode: effectiveAttemptRecordMode(row),
    reservations: reservationResult.rows.map((reservation) => ({
      uploadId: String(reservation.upload_id),
      partIndex: Number(reservation.part_index),
      objectKey: String(reservation.object_key),
      completedAt: reservation.completed_at ?? null,
      completedPartId: reservation.completed_part_id ?? null,
      completedObjectKey: reservation.completed_object_key == null
        ? null
        : String(reservation.completed_object_key),
    })),
    parts: partResult.rows.map((part) => ({
      partIndex: Number(part.part_index),
      objectKey: String(part.object_key),
    })),
  };
}

function inspectManifestIntegrity(
  snapshot: RecordingManifestSnapshot,
  expectedPartCount: number,
): { valid: boolean; completedPartCount: number } {
  if (
    !Number.isInteger(expectedPartCount)
    || expectedPartCount < 1
    || expectedPartCount > MAX_RECORDING_PART_INDEX + 1
    || snapshot.reservations.length !== expectedPartCount
  ) {
    return { valid: false, completedPartCount: 0 };
  }

  let completedPartCount = 0;
  for (let index = 0; index < snapshot.reservations.length; index += 1) {
    const reservation = snapshot.reservations[index];
    if (reservation.partIndex !== index) return { valid: false, completedPartCount };
    const hasCompletionMarker = reservation.completedAt != null;
    const hasCompletedPart = reservation.completedPartId != null;
    if (hasCompletionMarker !== hasCompletedPart) return { valid: false, completedPartCount };
    if (hasCompletedPart && reservation.completedObjectKey !== reservation.objectKey) {
      return { valid: false, completedPartCount };
    }
    if (hasCompletedPart) completedPartCount += 1;
  }

  // Every persisted part must be represented by the exact reservation/key.
  // This detects legacy/orphan metadata instead of silently counting it toward
  // a sealed manifest that did not authorize that S3 object.
  for (const part of snapshot.parts) {
    const reservation = snapshot.reservations[part.partIndex];
    if (!reservation || reservation.objectKey !== part.objectKey || reservation.completedPartId == null) {
      return { valid: false, completedPartCount };
    }
  }
  if (snapshot.parts.length !== completedPartCount) {
    return { valid: false, completedPartCount };
  }
  return { valid: true, completedPartCount };
}

function statusFromSnapshot(snapshot: RecordingManifestSnapshot, nowMs: number): RecordingRecoveryStatus {
  if (snapshot.recordMode !== 's3') {
    return {
      state: 'not_required',
      recordMode: snapshot.recordMode,
      expectedPartCount: 0,
      completedPartCount: 0,
    };
  }

  const persistedExpected = Number(snapshot.row.recording_expected_part_count);
  const finalizedIndex = Number(snapshot.row.recording_final_part_index);
  const expectedPartCount = Number.isInteger(persistedExpected) && persistedExpected > 0
    ? persistedExpected
    : (snapshot.row.recording_finalized_at && Number.isInteger(finalizedIndex) && finalizedIndex >= 0
      ? finalizedIndex + 1
      : 0);
  const integrity = expectedPartCount > 0
    ? inspectManifestIntegrity(snapshot, expectedPartCount)
    : { valid: false, completedPartCount: 0 };

  if (snapshot.row.recording_finalized_at) {
    return {
      state: 'finalized',
      recordMode: snapshot.recordMode,
      expectedPartCount,
      completedPartCount: integrity.valid ? integrity.completedPartCount : expectedPartCount,
      ...(Number.isInteger(finalizedIndex) && finalizedIndex >= 0
        ? { finalPartIndex: finalizedIndex }
        : {}),
    };
  }

  if (!snapshot.row.recording_manifest_sealed_at) {
    const submittedExpired = snapshot.row.status === 'submitted'
      && !isWithinSubmittedRecordingGrace(snapshot.row, nowMs);
    return {
      state: submittedExpired ? 'incomplete' : 'awaiting_seal',
      recordMode: snapshot.recordMode,
      expectedPartCount: 0,
      completedPartCount: snapshot.reservations.filter((reservation) => (
        reservation.completedAt != null && reservation.completedPartId != null
      )).length,
    };
  }

  const writable = acceptsRecordingWrites(snapshot.row, nowMs);
  return {
    state: integrity.valid && writable ? 'processing' : 'incomplete',
    recordMode: snapshot.recordMode,
    expectedPartCount,
    completedPartCount: integrity.completedPartCount,
    ...(expectedPartCount > 0 ? { finalPartIndex: expectedPartCount - 1 } : {}),
  };
}

export async function getRecordingRecoveryStatus(
  executor: DbExecutor,
  input: { studentId: number; batchId: number; useSqlite: boolean; nowMs?: number },
): Promise<RecordingRecoveryStatus> {
  // Contract: production callers wrap this helper in db.withTransaction().
  // FOR UPDATE serializes the dependent reservation/part reads with every
  // writer that uses the same student-row lock, preventing a mixed snapshot.
  const snapshot = await readRecordingManifestSnapshot(
    executor,
    input.studentId,
    input.batchId,
    !input.useSqlite,
  );
  return statusFromSnapshot(snapshot, input.nowMs ?? Date.now());
}

export interface SealRecordingManifestInput {
  studentId: number;
  batchId: number;
  sessionId: string;
  parts: SealRecordingManifestPartInput[];
  useSqlite: boolean;
  nowMs?: number;
}

export interface SealRecordingManifestResult extends RecordingRecoveryStatus {
  parts: RecordingManifestPartStatus[];
  already: boolean;
}

/**
 * Atomically reserves every not-yet-presigned logical blob and seals the exact
 * server manifest. No S3 request happens under this transaction/row lock.
 */
export async function sealRecordingManifest(
  tx: DbExecutor,
  input: SealRecordingManifestInput,
): Promise<SealRecordingManifestResult> {
  if (!Array.isArray(input.parts) || input.parts.length > MAX_RECORDING_PART_INDEX + 1) {
    throw recordingError('INVALID_MANIFEST', 'Recording manifest is invalid');
  }
  const uploadIds = new Set<string>();
  const requestedIndexes = new Set<number>();
  for (const part of input.parts) {
    if (
      !part
      || typeof part.uploadId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(part.uploadId)
      || !Number.isInteger(part.partIndex)
      || part.partIndex < 0
      || part.partIndex > MAX_RECORDING_PART_INDEX
      || uploadIds.has(part.uploadId)
      || requestedIndexes.has(part.partIndex)
    ) {
      throw recordingError('INVALID_MANIFEST', 'Recording manifest is invalid');
    }
    uploadIds.add(part.uploadId);
    requestedIndexes.add(part.partIndex);
  }

  let snapshot = await readRecordingManifestSnapshot(
    tx,
    input.studentId,
    input.batchId,
    !input.useSqlite,
  );
  if (snapshot.recordMode !== 's3') {
    throw recordingError('BAD_RECORD_MODE', 'S3 recording is not enabled');
  }
  if (snapshot.row.active_jti !== input.sessionId) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam recording session is no longer active');
  }

  const nowMs = input.nowMs ?? Date.now();
  if (snapshot.row.recording_manifest_sealed_at) {
    const knownUploadIds = new Set(snapshot.reservations.map((part) => part.uploadId));
    if ([...uploadIds].some((uploadId) => !knownUploadIds.has(uploadId))) {
      throw recordingError('MANIFEST_CONFLICT', 'Recording manifest is already sealed');
    }
    const status = statusFromSnapshot(snapshot, nowMs);
    if (status.state === 'incomplete') {
      throw recordingError('MANIFEST_CONFLICT', 'Sealed recording manifest is inconsistent');
    }
    return {
      ...status,
      already: true,
      parts: snapshot.reservations.map((part) => ({
        uploadId: part.uploadId,
        partIndex: part.partIndex,
        completed: part.completedAt != null && part.completedPartId != null,
      })),
    };
  }

  // The answer submission is authoritative and must precede sealing. This
  // prevents a client from closing the manifest while capture is still active.
  if (!isWithinSubmittedRecordingGrace(snapshot.row, nowMs)) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording manifest sealing');
  }

  const sortedParts = [...input.parts].sort((a, b) => (
    a.partIndex - b.partIndex || a.uploadId.localeCompare(b.uploadId)
  ));
  for (const part of sortedParts) {
    await reserveRecordingUpload(tx, {
      studentId: input.studentId,
      batchId: input.batchId,
      uploadId: part.uploadId,
      sessionId: input.sessionId,
      useSqlite: input.useSqlite,
      nowMs,
    });
  }

  snapshot = await readRecordingManifestSnapshot(tx, input.studentId, input.batchId);
  const expectedPartCount = snapshot.reservations.length;
  const integrity = inspectManifestIntegrity(snapshot, expectedPartCount);
  if (!integrity.valid) {
    throw recordingError('MANIFEST_CONFLICT', 'Recording manifest must be exact and contiguous');
  }

  await tx.query(
    `UPDATE students
     SET recording_manifest_sealed_at = ?, recording_expected_part_count = ?
     WHERE id = ?`,
    [new Date(nowMs).toISOString(), expectedPartCount, input.studentId],
  );
  snapshot.row.recording_manifest_sealed_at = new Date(nowMs).toISOString();
  snapshot.row.recording_expected_part_count = expectedPartCount;

  return {
    state: snapshot.row.recording_finalized_at ? 'finalized' : 'processing',
    recordMode: snapshot.recordMode,
    expectedPartCount,
    completedPartCount: integrity.completedPartCount,
    finalPartIndex: expectedPartCount - 1,
    already: false,
    parts: snapshot.reservations.map((part) => ({
      uploadId: part.uploadId,
      partIndex: part.partIndex,
      completed: part.completedAt != null && part.completedPartId != null,
    })),
  };
}

/** Return only sealed, incomplete, server-owned reservations for S3 inspection. */
export async function listPendingRecordingReservations(
  executor: DbExecutor,
  input: { studentId: number; batchId: number; useSqlite: boolean; nowMs?: number },
): Promise<RecordingUploadReservation[]> {
  // Same transaction contract as getRecordingRecoveryStatus; routes must not
  // call this against the pool-level executor in PostgreSQL.
  const snapshot = await readRecordingManifestSnapshot(
    executor,
    input.studentId,
    input.batchId,
    !input.useSqlite,
  );
  const status = statusFromSnapshot(snapshot, input.nowMs ?? Date.now());
  if (status.state !== 'processing') return [];
  return snapshot.reservations
    .filter((part) => part.completedAt == null && part.completedPartId == null)
    .map((part) => ({
      studentId: input.studentId,
      batchId: input.batchId,
      uploadId: part.uploadId,
      partIndex: part.partIndex,
      objectKey: part.objectKey,
      createdAt: '',
      completedAt: null,
      completed: false,
      byteSize: null,
    }));
}

export interface CommitInspectedRecordingPartInput extends RecordCompletedRecordingPartInput {
  useSqlite: boolean;
  nowMs?: number;
}

/**
 * Re-check lifecycle and persist a HeadObject-verified part while holding the
 * same student-row lock used by manifest finalization. S3 inspection deliberately
 * happens before this helper so no database lock is held across network I/O.
 */
export async function commitInspectedRecordingPart(
  tx: DbExecutor,
  input: CommitInspectedRecordingPartInput,
): Promise<CompletedRecordingPart & { already: boolean }> {
  const row: RecordingExamRow | undefined = (await tx.query(
    `SELECT s.status, s.submitted_at, s.recording_incomplete, s.recording_finalized_at,
            s.attempt_record_mode,
            b.record_mode, b.record_enabled
     FROM students s JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND b.id = ?${input.useSqlite ? '' : ' FOR UPDATE OF s'}`,
    [input.studentId, input.batchId],
  )).rows[0];

  if (!row) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording parts');
  }
  const recordMode = effectiveAttemptRecordMode(row);
  if (recordMode !== 's3') {
    throw recordingError('BAD_RECORD_MODE', 'S3 recording is not enabled');
  }

  // Replays remain successful even after finalization has closed new writes.
  const existing = await findCompletedRecordingPart(tx, input.studentId, input.partIndex);
  if (existing) return { already: true, ...existing };

  if (!acceptsRecordingWrites(row, input.nowMs ?? Date.now())) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording parts');
  }
  return recordCompletedRecordingPart(tx, input);
}

export interface CommitInspectedReservedRecordingPartInput {
  studentId: number;
  batchId: number;
  uploadId: string;
  objectKey: string;
  byteSize: number;
  uploadedAt: string;
  useSqlite: boolean;
  nowMs?: number;
}

export interface CommittedReservedRecordingPart extends CompletedRecordingPart {
  uploadId: string;
  partIndex: number;
  already: boolean;
}

/**
 * Persist HeadObject-inspected metadata only for the exact upload reservation
 * that produced the S3 key. The reservation and recording_parts marker commit
 * atomically under the same student row lock as manifest finalization.
 */
export async function commitInspectedReservedRecordingPart(
  tx: DbExecutor,
  input: CommitInspectedReservedRecordingPartInput,
): Promise<CommittedReservedRecordingPart> {
  if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) {
    throw recordingError('INVALID_RECORDING_PART', 'Uploaded recording part is empty');
  }

  const row: RecordingExamRow | undefined = (await tx.query(
    `SELECT s.status, s.submitted_at, s.recording_incomplete, s.recording_finalized_at,
            s.attempt_record_mode,
            b.record_mode, b.record_enabled
     FROM students s JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND b.id = ?${input.useSqlite ? '' : ' FOR UPDATE OF s'}`,
    [input.studentId, input.batchId],
  )).rows[0];
  if (!row) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording parts');
  }
  const recordMode = effectiveAttemptRecordMode(row);
  if (recordMode !== 's3') {
    throw recordingError('BAD_RECORD_MODE', 'S3 recording is not enabled');
  }

  const reservation = await findRecordingUploadReservation(tx, input.studentId, input.uploadId);
  if (!reservation || reservation.batchId !== input.batchId) {
    throw recordingError('RESERVATION_NOT_FOUND', 'Recording upload reservation was not found');
  }
  if (reservation.objectKey !== input.objectKey) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Inspected S3 key does not match the recording upload reservation',
    );
  }

  if (reservation.completed) {
    await tx.query(
      `UPDATE recording_upload_reservations
       SET completed_at = COALESCE(completed_at, ?)
       WHERE student_id = ? AND upload_id = ?`,
      [input.uploadedAt, input.studentId, input.uploadId],
    );
    return {
      uploadId: reservation.uploadId,
      partIndex: reservation.partIndex,
      objectKey: reservation.objectKey,
      byteSize: Number(reservation.byteSize),
      already: true,
    };
  }

  if (!acceptsRecordingWrites(row, input.nowMs ?? Date.now())) {
    throw recordingError('NOT_IN_PROGRESS', 'Exam is not accepting recording parts');
  }

  const completion = await recordCompletedRecordingPart(tx, {
    studentId: input.studentId,
    batchId: input.batchId,
    partIndex: reservation.partIndex,
    objectKey: reservation.objectKey,
    byteSize: input.byteSize,
    uploadedAt: input.uploadedAt,
  });
  if (completion.objectKey !== reservation.objectKey) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Reserved recording part conflicts with existing completed metadata',
    );
  }

  await tx.query(
    `UPDATE recording_upload_reservations
     SET completed_at = COALESCE(completed_at, ?)
     WHERE student_id = ? AND upload_id = ?`,
    [input.uploadedAt, input.studentId, input.uploadId],
  );
  return {
    uploadId: reservation.uploadId,
    partIndex: reservation.partIndex,
    objectKey: completion.objectKey,
    byteSize: completion.byteSize,
    already: completion.already,
  };
}

export type RecordingFinalizationDecision =
  | { action: 'finalize' }
  | { action: 'already' }
  | {
      action: 'reject';
      code: 'NOT_IN_PROGRESS' | 'BAD_RECORD_MODE' | 'MANIFEST_CONFLICT' | 'MANIFEST_NOT_SEALED';
      message: string;
    };

export function decideRecordingFinalization(
  row: RecordingExamRow | undefined,
  finalPartIndex: number,
  nowMs: number,
): RecordingFinalizationDecision {
  if (!row) {
    return {
      action: 'reject',
      code: 'NOT_IN_PROGRESS',
      message: 'Exam is not accepting recording finalization',
    };
  }

  // This intentionally precedes the grace check because a successful finalize
  // clears recording_incomplete. A same-manifest retry must remain successful.
  if (row.recording_finalized_at) {
    if (Number(row.recording_final_part_index) !== finalPartIndex) {
      return {
        action: 'reject',
        code: 'MANIFEST_CONFLICT',
        message: 'Recording was already finalized with a different manifest',
      };
    }
    return { action: 'already' };
  }

  const mode = effectiveAttemptRecordMode(row);
  if (mode !== 's3') {
    return {
      action: 'reject',
      code: 'BAD_RECORD_MODE',
      message: 'S3 recording is not enabled',
    };
  }

  if (!row.recording_manifest_sealed_at) {
    return {
      action: 'reject',
      code: 'MANIFEST_NOT_SEALED',
      message: 'Recording manifest has not been sealed',
    };
  }
  const expectedPartCount = Number(row.recording_expected_part_count);
  if (!Number.isInteger(expectedPartCount) || expectedPartCount < 1
      || finalPartIndex !== expectedPartCount - 1) {
    return {
      action: 'reject',
      code: 'MANIFEST_CONFLICT',
      message: 'Recording manifest does not match the sealed part count',
    };
  }

  // First-time finalization is legal only after the authoritative answer
  // submission transaction marked the S3 recording incomplete. Allowing this
  // while in_progress would let a client seal a truncated manifest early.
  if (!isWithinSubmittedRecordingGrace(row, nowMs)) {
    return {
      action: 'reject',
      code: 'NOT_IN_PROGRESS',
      message: 'Exam is not accepting recording finalization',
    };
  }
  return { action: 'finalize' };
}

export interface FinalizeRecordingManifestInput {
  studentId: number;
  batchId: number;
  // Legacy callers may still provide this, but current routes derive the
  // authoritative manifest from durable reservations/completed rows.
  finalPartIndex?: number;
  useSqlite: boolean;
  nowMs?: number;
}

export async function finalizeRecordingManifest(
  tx: DbExecutor,
  input: FinalizeRecordingManifestInput,
): Promise<{ already: boolean; finalPartIndex: number }> {
  const row: RecordingExamRow | undefined = (await tx.query(
    `SELECT s.status, s.submitted_at, s.recording_incomplete,
            s.recording_finalized_at, s.recording_final_part_index,
            s.recording_manifest_sealed_at, s.recording_expected_part_count,
            s.attempt_record_mode,
            b.record_mode, b.record_enabled
     FROM students s JOIN batches b ON b.id = s.batch_id
     WHERE s.id = ? AND b.id = ?${input.useSqlite ? '' : ' FOR UPDATE OF s'}`,
    [input.studentId, input.batchId],
  )).rows[0];

  const nowMs = input.nowMs ?? Date.now();
  // A completed manifest replay is fully identified by the persisted student
  // marker. Return before touching part/reservation tables so it stays
  // idempotent even after the submission grace window and during cleanup.
  if (row?.recording_finalized_at) {
    const replayFinalPartIndex = input.finalPartIndex
      ?? Number(row.recording_final_part_index);
    if (!Number.isInteger(replayFinalPartIndex) || replayFinalPartIndex < 0) {
      throw recordingError('RECORDING_INCOMPLETE', 'Recording parts are incomplete');
    }
    const replayDecision = decideRecordingFinalization(row, replayFinalPartIndex, nowMs);
    if (replayDecision.action === 'reject') {
      throw recordingError(replayDecision.code, replayDecision.message);
    }
    return { already: true, finalPartIndex: replayFinalPartIndex };
  }

  const expectedPartCount = Number(row?.recording_expected_part_count);
  const finalPartIndex = expectedPartCount - 1;
  if (input.finalPartIndex !== undefined && input.finalPartIndex !== finalPartIndex) {
    throw recordingError('MANIFEST_CONFLICT', 'Recording manifest differs from the sealed manifest');
  }
  const decision = decideRecordingFinalization(row, finalPartIndex, nowMs);
  if (decision.action === 'reject') {
    throw recordingError(decision.code, decision.message);
  }
  if (decision.action === 'already') {
    return { already: true, finalPartIndex };
  }

  const parts = await tx.query(
    'SELECT part_index FROM recording_parts WHERE student_id = ? ORDER BY part_index',
    [input.studentId],
  );
  const reservations = await tx.query(
    `SELECT r.part_index, r.completed_at, r.object_key AS reservation_object_key,
            p.id AS completed_part_id, p.object_key AS completed_object_key
     FROM recording_upload_reservations r
     LEFT JOIN recording_parts p
       ON p.student_id = r.student_id AND p.part_index = r.part_index
     WHERE r.student_id = ?
     ORDER BY r.part_index`,
    [input.studentId],
  );
  const reservationConflict = reservations.rows.some((reservation) => {
    const hasCompletedPart = reservation.completed_part_id != null;
    const hasCompletionMarker = reservation.completed_at != null;
    return hasCompletedPart !== hasCompletionMarker
      || (hasCompletedPart
        && String(reservation.completed_object_key) !== String(reservation.reservation_object_key));
  });
  if (reservationConflict) {
    throw recordingError(
      'RECORDING_RESERVATION_CONFLICT',
      'Recording upload reservation conflicts with completed part metadata',
    );
  }

  if (
    parts.rows.length !== expectedPartCount
    || parts.rows.some((part, index) => Number(part.part_index) !== index)
    || reservations.rows.length !== expectedPartCount
    || reservations.rows.some((reservation, index) => Number(reservation.part_index) !== index)
    || reservations.rows.some((reservation) => (
      reservation.completed_part_id == null || reservation.completed_at == null
    ))
  ) {
    throw recordingError('RECORDING_INCOMPLETE', 'Recording parts are incomplete');
  }

  await tx.query(
    'UPDATE recording_parts SET is_final = TRUE WHERE student_id = ? AND part_index = ?',
    [input.studentId, finalPartIndex],
  );
  await tx.query(
    `UPDATE students
     SET recording_finalized_at = ?, recording_final_part_index = ?, recording_incomplete = FALSE
     WHERE id = ?`,
    [new Date(nowMs).toISOString(), finalPartIndex, input.studentId],
  );
  return { already: false, finalPartIndex };
}
