import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConcurrentSessionEnforcer } from '../dist/server/services/concurrentSessionEnforcer.js';

const overlapEvidence = {
  suspicious: true,
  lockable: true,
  ips: ['203.0.113.10', '198.51.100.20'],
  userAgents: ['browser-a', 'browser-b'],
  jtis: ['session-a', 'session-b'],
  overlap: true,
};

function fixture(evidence = overlapEvidence, status = 'in_progress') {
  const inserts = [];
  const submissions = [];
  let detectCalls = 0;
  const db = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT status')) return { rows: [{ status }], rowCount: 0 };
      if (sql.startsWith('INSERT INTO violation_events')) {
        inserts.push(params);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const enforce = createConcurrentSessionEnforcer({
    db,
    detect: async () => {
      detectCalls += 1;
      return evidence;
    },
    submit: async (studentId, reason) => submissions.push({ studentId, reason }),
    now: () => 123_456,
    logger: { log() {}, error() {} },
  });
  return { enforce, inserts, submissions, get detectCalls() { return detectCalls; } };
}

test('server-detected IP overlap writes forensic evidence and auto-submits directly', async () => {
  const state = fixture();

  assert.equal(await state.enforce(7, 3), true);
  assert.equal(state.detectCalls, 1);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0][0], 7);
  assert.equal(state.inserts[0][1], 3);
  assert.equal(state.inserts[0][2], 'concurrent_session');
  assert.deepEqual(state.submissions, [{ studentId: 7, reason: 'concurrent_session' }]);
});

test('suspicious evidence without overlap is logged but does not submit', async () => {
  const state = fixture({ ...overlapEvidence, lockable: false, overlap: false });

  assert.equal(await state.enforce(7, 3), false);
  assert.equal(state.inserts.length, 1);
  assert.deepEqual(state.submissions, []);
});

test('a completed exam is not evaluated or logged again', async () => {
  const state = fixture(overlapEvidence, 'submitted');

  assert.equal(await state.enforce(7, 3), false);
  assert.equal(state.detectCalls, 0);
  assert.equal(state.inserts.length, 0);
  assert.deepEqual(state.submissions, []);
});
