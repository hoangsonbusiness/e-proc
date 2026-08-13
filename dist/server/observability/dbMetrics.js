import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
export function runWithDbMetrics(work) {
    const metrics = { queryCount: 0, dbMs: 0 };
    return storage.run(metrics, () => work(metrics));
}
export function recordDbQuery(durationMs) {
    const metrics = storage.getStore();
    if (!metrics)
        return;
    metrics.queryCount += 1;
    metrics.dbMs += durationMs;
}
