import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let hasServerConfirmedTerminalSubmission;
let shouldSuppressClientViolation;

before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(
      new URL('../client/src/services/violationLifecycle.ts', import.meta.url),
    )],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  ({
    hasServerConfirmedTerminalSubmission,
    shouldSuppressClientViolation,
  } = await import(`data:text/javascript;base64,${encoded}`));
});

const active = {
  started: true,
  locked: false,
  submitting: false,
  submitCommitted: false,
};

test('recording_stopped remains reportable while submit is pending but uncommitted', () => {
  assert.equal(shouldSuppressClientViolation('recording_stopped', {
    ...active,
    submitting: true,
  }), false);
});

test('ordinary violations are suppressed while submit is pending', () => {
  assert.equal(shouldSuppressClientViolation('focus_lost', {
    ...active,
    submitting: true,
  }), true);
});

test('all violation reports are suppressed after submit commits', () => {
  assert.equal(shouldSuppressClientViolation('recording_stopped', {
    ...active,
    submitting: true,
    submitCommitted: true,
  }), true);
});

test('pre-start and locked attempts suppress recording reports', () => {
  assert.equal(shouldSuppressClientViolation('recording_stopped', {
    ...active,
    started: false,
  }), true);
  assert.equal(shouldSuppressClientViolation('recording_stopped', {
    ...active,
    locked: true,
  }), true);
});

test('a backend lock keeps the client on the terminal finalization path when manual submit transport fails', () => {
  assert.equal(hasServerConfirmedTerminalSubmission({
    locked: true,
    submitCommitted: false,
  }), true);
  assert.equal(hasServerConfirmedTerminalSubmission({
    locked: false,
    submitCommitted: false,
  }), false);
});
