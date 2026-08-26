import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReadinessController,
  ReadinessRetryPendingError,
  isPermanentDatabaseStartupError,
} from '../dist/server/db/readiness.js';

test('transient startup failures cool down and recover in the same process', async () => {
  let now = 1_000;
  let attempts = 0;
  let cleanups = 0;
  const controller = new ReadinessController({
    now: () => now,
    baseRetryDelayMs: 100,
    maxRetryDelayMs: 1_000,
    initialize: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error('Connection terminated due to connection timeout');
    },
    cleanup: async () => { cleanups += 1; },
    isPermanentError: isPermanentDatabaseStartupError,
  });

  await assert.rejects(controller.ensureReady(), /connection timeout/);
  assert.deepEqual(controller.getSnapshot(), {
    state: 'retry_wait',
    failureCount: 1,
    nextRetryAt: 1_100,
    retryAfterMs: 100,
    lastError: controller.getSnapshot().lastError,
  });

  await assert.rejects(
    controller.ensureReady(),
    (error) => error instanceof ReadinessRetryPendingError && error.retryAfterMs === 100,
  );
  assert.equal(attempts, 1, 'cooldown requests must not start another connection attempt');

  now = 1_100;
  await assert.rejects(controller.ensureReady(), /connection timeout/);
  assert.equal(controller.getSnapshot().retryAfterMs, 200);

  now = 1_300;
  await controller.ensureReady();
  assert.equal(controller.getSnapshot().state, 'ready');
  assert.equal(attempts, 3);
  assert.equal(cleanups, 2);

  await controller.ensureReady();
  assert.equal(attempts, 3, 'ready state must reuse the established connection');
});

test('concurrent requests share one initialization attempt', async () => {
  let attempts = 0;
  let releaseInitialization;
  const initializationBlocked = new Promise((resolve) => {
    releaseInitialization = resolve;
  });
  const controller = new ReadinessController({
    initialize: async () => {
      attempts += 1;
      await initializationBlocked;
    },
    isPermanentError: isPermanentDatabaseStartupError,
  });

  const requests = Array.from({ length: 25 }, () => controller.ensureReady());
  assert.equal(attempts, 1);
  assert.equal(controller.getSnapshot().state, 'initializing');

  releaseInitialization();
  await Promise.all(requests);
  assert.equal(attempts, 1);
  assert.equal(controller.getSnapshot().state, 'ready');
});

test('schema and authentication failures remain permanently blocked', async () => {
  for (const startupError of [
    new Error('[schema] required column students.status missing'),
    Object.assign(new Error('password authentication failed'), { code: '28P01' }),
  ]) {
    let attempts = 0;
    const controller = new ReadinessController({
      initialize: async () => {
        attempts += 1;
        throw startupError;
      },
      isPermanentError: isPermanentDatabaseStartupError,
    });

    await assert.rejects(controller.ensureReady(), (error) => error === startupError);
    assert.equal(controller.getSnapshot().state, 'permanent_failure');
    await assert.rejects(controller.ensureReady(), (error) => error === startupError);
    assert.equal(attempts, 1, 'permanent errors must not hammer the database');
  }
});
