import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateExamEnvironment } from '../dist/server/services/examEnvironment.js';

test('blocks only when both browser-reported resources are below the batch minimum', () => {
  assert.deepEqual(
    evaluateExamEnvironment({ ramGiB: 4, logicalCpuCores: 2 }),
    { allowed: false, reason: 'insufficient_exam_environment' },
  );
  assert.deepEqual(
    evaluateExamEnvironment({ ramGiB: 8, logicalCpuCores: 2 }),
    { allowed: true, ramGiB: 8, logicalCpuCores: 2 },
  );
  assert.deepEqual(
    evaluateExamEnvironment({ ramGiB: 4, logicalCpuCores: 4 }),
    { allowed: true, ramGiB: 4, logicalCpuCores: 4 },
  );
});

test('fails closed when the browser does not expose a valid resource signal', () => {
  assert.deepEqual(
    evaluateExamEnvironment({ ramGiB: null, logicalCpuCores: 8 }),
    { allowed: false, reason: 'environment_unavailable' },
  );
});
