import type { DbExecutor } from '../db/postgres.js';
import {
  persistViolation,
  type PersistViolationInput,
  type PersistViolationResult,
} from './violationStore.js';

export type PersistViolationIfInProgressResult = PersistViolationResult & {
  ignored: boolean;
};

/**
 * Atomically gates a client-reported violation on the current exam state.
 *
 * The student row is checked while holding the same transaction/row lock used
 * for the event and counter writes. This prevents a request that races with
 * submit from appending evidence after the attempt has transitioned away from
 * `in_progress`.
 */
export async function persistViolationIfInProgress(
  tx: DbExecutor,
  input: PersistViolationInput,
): Promise<PersistViolationIfInProgressResult> {
  const statusResult = await tx.query(
    `SELECT status FROM students WHERE id = ?${input.lockStudentRow ? ' FOR UPDATE' : ''}`,
    [input.studentId],
  );
  const student = statusResult.rows[0];
  if (!student) {
    const error: any = new Error('Student not found');
    error.code = 'STUDENT_NOT_FOUND';
    throw error;
  }

  if (student.status !== 'in_progress') {
    return {
      ignored: true,
      replay: false,
      currentCount: 0,
      total: 0,
    };
  }

  // The row is already locked above on PostgreSQL. SQLite's BEGIN IMMEDIATE
  // serializes the transaction, so persistViolation must not issue FOR UPDATE.
  const result = await persistViolation(tx, { ...input, lockStudentRow: false });
  return { ignored: false, ...result };
}
