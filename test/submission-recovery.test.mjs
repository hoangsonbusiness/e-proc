import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let modulePromise;

async function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const result = await build({
        entryPoints: [fileURLToPath(new URL('../client/src/services/submissionRecovery.ts', import.meta.url))],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node20',
        write: false,
      });
      return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    })();
  }
  return modulePromise;
}

const responseError = (status, message) => Object.assign(new Error(message), {
  response: { status },
});

test('lost submit response is confirmed by authoritative 410 probe without leaving capture pending', async () => {
  const { submitAnswersWithRecovery } = await loadModule();
  let submitCalls = 0;
  let probeCalls = 0;
  const result = await submitAnswersWithRecovery(
    [{ question_order: 1, answer: 'saved' }],
    {
      submit: async () => {
        submitCalls += 1;
        throw new Error('response lost after commit');
      },
      probeExam: async () => {
        probeCalls += 1;
        throw responseError(410, 'already submitted');
      },
      sleep: async () => undefined,
    },
  );

  assert.deepEqual(result, { confirmedBy: 'probe' });
  assert.equal(submitCalls, 1);
  assert.equal(probeCalls, 1);
});

test('transient pre-commit submit failure retries the same idempotent payload', async () => {
  const { submitAnswersWithRecovery } = await loadModule();
  const seenPayloads = [];
  let submitCalls = 0;
  const answers = [{ question_order: 1, answer: 'same payload' }];
  const result = await submitAnswersWithRecovery(answers, {
    submit: async (payload) => {
      seenPayloads.push(payload);
      submitCalls += 1;
      if (submitCalls === 1) throw responseError(503, 'temporary database outage');
    },
    probeExam: async () => ({ status: 'in_progress' }),
    sleep: async () => undefined,
  });

  assert.deepEqual(result, { confirmedBy: 'submit' });
  assert.equal(submitCalls, 2);
  assert.equal(seenPayloads[0], answers);
  assert.equal(seenPayloads[1], answers);
});

test('non-retryable submit validation failure is not hidden by a lifecycle probe', async () => {
  const { submitAnswersWithRecovery } = await loadModule();
  let probeCalls = 0;
  await assert.rejects(
    submitAnswersWithRecovery([], {
      submit: async () => { throw responseError(400, 'invalid answers'); },
      probeExam: async () => { probeCalls += 1; },
      sleep: async () => undefined,
    }),
    /invalid answers/,
  );
  assert.equal(probeCalls, 0);
});
