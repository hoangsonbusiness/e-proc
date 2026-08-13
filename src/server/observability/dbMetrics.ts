import { AsyncLocalStorage } from 'node:async_hooks';

export interface DbRequestMetrics {
  queryCount: number;
  dbMs: number;
}

const storage = new AsyncLocalStorage<DbRequestMetrics>();

export function runWithDbMetrics<T>(work: (metrics: DbRequestMetrics) => T): T {
  const metrics: DbRequestMetrics = { queryCount: 0, dbMs: 0 };
  return storage.run(metrics, () => work(metrics));
}

export function recordDbQuery(durationMs: number): void {
  const metrics = storage.getStore();
  if (!metrics) return;
  metrics.queryCount += 1;
  metrics.dbMs += durationMs;
}

