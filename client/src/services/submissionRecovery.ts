export interface FinalAnswerPayload {
  question_order: number;
  answer: string;
}

interface SubmissionRecoveryDependencies {
  submit: (answers: FinalAnswerPayload[]) => Promise<unknown>;
  probeExam: () => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  retryBaseMs?: number;
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function isAmbiguousSubmitFailure(error: unknown): boolean {
  const status = httpStatus(error);
  return status === undefined
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Submit is idempotent server-side. If its response is lost, probe the
 * authoritative exam lifecycle before retrying the exact same answer payload.
 * A 410 from either call means the server already closed the attempt and the
 * caller must immediately stop/finalize recording.
 */
export async function submitAnswersWithRecovery(
  answers: FinalAnswerPayload[],
  dependencies: SubmissionRecoveryDependencies,
): Promise<{ confirmedBy: 'submit' | 'probe' }> {
  const maxAttempts = Math.max(1, Math.trunc(dependencies.maxAttempts ?? 3));
  const retryBaseMs = Math.max(0, Math.trunc(dependencies.retryBaseMs ?? 1000));
  const wait = dependencies.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await dependencies.submit(answers);
      return { confirmedBy: 'submit' };
    } catch (error) {
      lastError = error;
      if (httpStatus(error) === 410) return { confirmedBy: 'probe' };
      if (!isAmbiguousSubmitFailure(error)) throw error;

      try {
        await dependencies.probeExam();
      } catch (probeError) {
        if (httpStatus(probeError) === 410) return { confirmedBy: 'probe' };
        // A definitive auth/permission rejection cannot be repaired by another
        // submit retry. Preserve that classification for the caller.
        const probeStatus = httpStatus(probeError);
        if (probeStatus === 400 || probeStatus === 401 || probeStatus === 403) {
          throw probeError;
        }
      }

      if (attempt < maxAttempts) {
        await wait(retryBaseMs * Math.pow(2, attempt - 1));
      }
    }
  }

  throw lastError;
}
