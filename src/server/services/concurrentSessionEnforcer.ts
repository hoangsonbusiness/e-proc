import type { DbExecutor } from '../db/postgres.js';
import type { ConcurrentEvidence } from '../middleware/sessionTracker.js';

const FORENSIC_DEDUP_MS = 60_000;

export interface ConcurrentSessionEnforcerDependencies {
  db: DbExecutor;
  detect: (studentId: number) => Promise<ConcurrentEvidence>;
  submit: (studentId: number, reason: 'concurrent_session') => Promise<unknown>;
  now?: () => number;
  logger?: Pick<Console, 'log' | 'error'>;
}

/**
 * Creates the server-owned concurrent-session enforcement path.
 * Client violation payloads never enter this service: evidence comes only from
 * session tracking, and an overlap submits directly without using counters.
 */
export function createConcurrentSessionEnforcer({
  db,
  detect,
  submit,
  now = Date.now,
  logger = console,
}: ConcurrentSessionEnforcerDependencies) {
  const lastForensic = new Map<string, number>();
  const inflightForensic = new Set<string>();

  return async function enforceConcurrentSession(studentId: number, batchId: number): Promise<boolean> {
    try {
      const statusRow = await db.query('SELECT status FROM students WHERE id = ?', [studentId]);
      if (statusRow.rows[0]?.status !== 'in_progress') return false;

      const evidence = await detect(studentId);
      if (!evidence.suspicious) return false;

      const fingerprint = JSON.stringify({
        ips: [...evidence.ips].sort(),
        userAgents: [...evidence.userAgents].sort(),
        jtis: [...evidence.jtis].sort(),
        overlap: evidence.overlap,
      });
      const dedupKey = `${studentId}:${fingerprint}`;
      const nowMs = now();
      const lastMs = lastForensic.get(dedupKey) || 0;
      const shouldLog =
        !inflightForensic.has(dedupKey) &&
        (nowMs - lastMs >= FORENSIC_DEDUP_MS || lastMs === 0);

      if (shouldLog) {
        inflightForensic.add(dedupKey);
        try {
          const metadataJson = JSON.stringify({
            ips: evidence.ips,
            userAgents: evidence.userAgents,
            jtis: evidence.jtis,
            overlap: evidence.overlap,
          }).slice(0, 2000);
          await db.query(
            'INSERT INTO violation_events (student_id, batch_id, type, text_length, content_preview, question_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              studentId,
              batchId,
              'concurrent_session',
              evidence.ips.length,
              `IPs: ${evidence.ips.join(', ')}`.slice(0, 500),
              null,
              metadataJson,
            ],
          );
          lastForensic.set(dedupKey, nowMs);
        } catch (error: any) {
          logger.error('[concurrent_session] forensic log failed (non-fatal):', error?.message);
        } finally {
          inflightForensic.delete(dedupKey);
        }
      }

      if (evidence.lockable) {
        await submit(studentId, 'concurrent_session');
        logger.log('[concurrent_session] Auto-submitted (overlap) student:', studentId, 'ips:', evidence.ips);
        return true;
      }
      return false;
    } catch (error: any) {
      logger.error('[enforceConcurrentSession] failed:', error?.message);
      throw error;
    }
  };
}
