export type ReadinessState =
  | 'idle'
  | 'initializing'
  | 'ready'
  | 'retry_wait'
  | 'permanent_failure';

export interface ReadinessSnapshot {
  state: ReadinessState;
  failureCount: number;
  nextRetryAt: number | null;
  retryAfterMs: number;
  lastError: Error | null;
}

export interface ReadinessControllerOptions {
  initialize: () => Promise<void>;
  cleanup?: () => Promise<void>;
  isPermanentError: (error: Error) => boolean;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  onFailure?: (error: Error, snapshot: ReadinessSnapshot) => void;
}

export class ReadinessRetryPendingError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Readiness retry available in ${retryAfterMs}ms`);
    this.name = 'ReadinessRetryPendingError';
    this.retryAfterMs = retryAfterMs;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Single-flight readiness state machine. A transient failure enters a bounded
 * cooldown and can be retried by a later request; a permanent failure remains
 * blocked until the process/deployment is replaced.
 */
export class ReadinessController {
  private readonly initialize: () => Promise<void>;
  private readonly cleanup?: () => Promise<void>;
  private readonly isPermanentError: (error: Error) => boolean;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly now: () => number;
  private readonly onFailure?: (error: Error, snapshot: ReadinessSnapshot) => void;

  private state: ReadinessState = 'idle';
  private failureCount = 0;
  private nextRetryAt: number | null = null;
  private lastError: Error | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(options: ReadinessControllerOptions) {
    this.initialize = options.initialize;
    this.cleanup = options.cleanup;
    this.isPermanentError = options.isPermanentError;
    this.baseRetryDelayMs = Math.max(0, options.baseRetryDelayMs ?? 1_000);
    this.maxRetryDelayMs = Math.max(this.baseRetryDelayMs, options.maxRetryDelayMs ?? 30_000);
    this.now = options.now ?? Date.now;
    this.onFailure = options.onFailure;
  }

  ensureReady(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'permanent_failure') {
      return Promise.reject(this.lastError ?? new Error('Readiness permanently failed'));
    }
    if (this.inFlight) return this.inFlight;

    const now = this.now();
    if (this.nextRetryAt !== null && now < this.nextRetryAt) {
      return Promise.reject(new ReadinessRetryPendingError(this.nextRetryAt - now));
    }

    this.state = 'initializing';
    this.inFlight = this.runAttempt();
    return this.inFlight;
  }

  getSnapshot(): ReadinessSnapshot {
    const now = this.now();
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextRetryAt: this.nextRetryAt,
      retryAfterMs: this.nextRetryAt === null ? 0 : Math.max(0, this.nextRetryAt - now),
      lastError: this.lastError,
    };
  }

  private async runAttempt(): Promise<void> {
    try {
      await this.initialize();
      this.state = 'ready';
      this.failureCount = 0;
      this.nextRetryAt = null;
      this.lastError = null;
    } catch (rawError) {
      const error = asError(rawError);
      this.lastError = error;

      if (this.cleanup) {
        try {
          await this.cleanup();
        } catch (cleanupError) {
          console.error('[readiness] Failed to clean up after initialization error:', asError(cleanupError).message);
        }
      }

      if (this.isPermanentError(error)) {
        this.state = 'permanent_failure';
        this.nextRetryAt = null;
      } else {
        this.failureCount += 1;
        const exponent = Math.min(this.failureCount - 1, 10);
        const retryDelay = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** exponent));
        this.nextRetryAt = this.now() + retryDelay;
        this.state = 'retry_wait';
      }

      this.onFailure?.(error, this.getSnapshot());
      throw error;
    } finally {
      this.inFlight = null;
    }
  }
}

const PERMANENT_DATABASE_ERROR_CODES = new Set([
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
  '3D000', // invalid_catalog_name
  '42501', // insufficient_privilege
  'ERR_INVALID_URL',
  'ERR_INVALID_ARG_TYPE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export function isPermanentDatabaseStartupError(error: Error): boolean {
  if (error.message.startsWith('[schema]')) return true;
  const code = String((error as Error & { code?: unknown }).code ?? '');
  return PERMANENT_DATABASE_ERROR_CODES.has(code);
}
