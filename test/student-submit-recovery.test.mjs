import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let bundledSubmitSource;
let importSequence = 0;

before(async () => {
  const entryPoint = fileURLToPath(
    new URL('../client/src/pages/StudentSubmit.tsx', import.meta.url),
  );
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'student-submit-test-stubs',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'submit-test' }));
        esbuild.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'jsx', namespace: 'submit-test' }));
        esbuild.onResolve({ filter: /^react-router-dom$/ }, () => ({ path: 'router', namespace: 'submit-test' }));
        esbuild.onResolve({ filter: /^lucide-react$/ }, () => ({ path: 'icons', namespace: 'submit-test' }));
        esbuild.onResolve({ filter: /^\.\.\/services\/examRecorder$/ }, () => ({
          path: 'recorder',
          namespace: 'submit-test',
        }));
        esbuild.onLoad({ filter: /^react$/, namespace: 'submit-test' }, () => ({
          loader: 'js',
          contents: `
            const fixture = globalThis.__studentSubmitFixture;
            export const useCallback = (fn) => fn;
            export const useRef = (value) => ({ current: value });
            export const useState = (initial) => {
              const index = fixture.stateIndex++;
              const value = typeof initial === 'function' ? initial() : initial;
              fixture.initialStates.push([index, value]);
              return [value, (next) => fixture.stateUpdates.push([index, next])];
            };
            export const useEffect = (effect) => {
              const cleanup = effect();
              if (typeof cleanup === 'function') fixture.cleanups.push(cleanup);
            };
          `,
        }));
        esbuild.onLoad({ filter: /^jsx$/, namespace: 'submit-test' }, () => ({
          loader: 'js',
          contents: 'export const Fragment = Symbol(); export const jsx = () => null; export const jsxs = () => null;',
        }));
        esbuild.onLoad({ filter: /^router$/, namespace: 'submit-test' }, () => ({
          loader: 'js',
          contents: `
            const fixture = globalThis.__studentSubmitFixture;
            export const useLocation = () => fixture.location;
            export const useNavigate = () => (...args) => fixture.navigateCalls.push(args);
          `,
        }));
        esbuild.onLoad({ filter: /^icons$/, namespace: 'submit-test' }, () => ({
          loader: 'js',
          contents: 'export const AlertTriangle = () => null; export const CheckCircle2 = () => null; export const LoaderCircle = () => null;',
        }));
        esbuild.onLoad({ filter: /^recorder$/, namespace: 'submit-test' }, () => ({
          loader: 'js',
          contents: `
            const recorder = globalThis.__studentSubmitFixture.recorder;
            export const getFinalizationPromise = (...args) => recorder.getFinalizationPromise(...args);
            export const recoverRecordingFinalization = (...args) => recorder.recoverRecordingFinalization(...args);
            export const canRetryFinalization = (...args) => recorder.canRetryFinalization(...args);
            export const retryFinalization = (...args) => recorder.retryFinalization(...args);
            export const isRetryableFinalizationFailure = (...args) => recorder.isRetryableFinalizationFailure(...args);
            export const hasStoredUploadAcknowledgements = (...args) => recorder.hasStoredUploadAcknowledgements(...args);
          `,
        }));
      },
    }],
  });
  bundledSubmitSource = result.outputFiles[0].text;
});

function installFixture(finalizationPromise) {
  const values = new Map([
    ['recordMode', 's3'],
    ['studentToken', 'signed-student-token'],
  ]);
  const fixture = {
    storageValues: values,
    stateIndex: 0,
    initialStates: [],
    stateUpdates: [],
    cleanups: [],
    navigateCalls: [],
    eventListeners: [],
    storageCleared: false,
    recoveryCalls: 0,
    location: { state: { recordingFinalizing: true } },
    recorder: {
      getFinalizationPromise: () => finalizationPromise,
      recoverRecordingFinalization: async () => {
        fixture.recoveryCalls += 1;
        return {
          state: 'finalized',
          recordMode: 's3',
          expectedPartCount: 1,
          completedPartCount: 1,
          finalPartIndex: 0,
        };
      },
      canRetryFinalization: () => false,
      hasStoredUploadAcknowledgements: () => false,
      retryFinalization: () => Promise.reject(new Error('not available')),
      isRetryableFinalizationFailure: () => true,
    },
  };
  globalThis.__studentSubmitFixture = fixture;
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    clear: () => {
      values.clear();
      fixture.storageCleared = true;
    },
  };
  globalThis.window = {
    addEventListener: (name, handler) => fixture.eventListeners.push(['add', name, handler]),
    removeEventListener: (name, handler) => fixture.eventListeners.push(['remove', name, handler]),
  };
  return fixture;
}

async function renderFreshSubmit(fixture) {
  const encoded = Buffer.from(bundledSubmitSource).toString('base64');
  importSequence += 1;
  const module = await import(`data:text/javascript;base64,${encoded}#submit-${importSequence}`);
  module.default();
  for (let attempt = 0; attempt < 50 && fixture.navigateCalls.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return module;
}

test('unload warning covers recoverable browser evidence but not status-only retries', async () => {
  const fixture = installFixture(null);
  const submit = await renderFreshSubmit(fixture);

  assert.equal(submit.shouldWarnBeforeRecordingUnload('finalizing', false, false), true);
  assert.equal(submit.shouldWarnBeforeRecordingUnload('failed', true, true), true);
  assert.equal(submit.shouldWarnBeforeRecordingUnload('failed', true, false), false);
  assert.equal(submit.shouldWarnBeforeRecordingUnload('complete', false, false), false);
});

test('submit refresh with no in-memory Promise recovers finalized server state', async () => {
  const fixture = installFixture(null);
  await renderFreshSubmit(fixture);

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.storageCleared, true);
  assert.equal(fixture.navigateCalls.length, 1);
  assert.equal(fixture.navigateCalls[0][1].state.recordingFinalizing, false);
  assert.ok(
    fixture.eventListeners.some(([action, name]) => action === 'add' && name === 'beforeunload'),
    'the submit page must warn while recording status is finalizing',
  );
});

test('an authenticated S3 attempt recovers when router state is lost after PUT receipts were drained', async () => {
  const fixture = installFixture(null);
  fixture.location = { state: null };

  await renderFreshSubmit(fixture);

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.storageCleared, true);
  assert.equal(fixture.navigateCalls.length, 1);
});

test('a reloaded local recording attempt fails explicitly instead of reporting false completion', async () => {
  const fixture = installFixture(null);
  fixture.location = { state: null };
  fixture.storageValues.set('recordMode', 'local');

  await renderFreshSubmit(fixture);

  assert.equal(fixture.recoveryCalls, 0);
  assert.equal(fixture.storageCleared, false);
  assert.equal(fixture.navigateCalls.length, 0);
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 1 && value === 'failed'));
  assert.ok(fixture.stateUpdates.some(([index, value]) => (
    index === 2 && typeof value === 'string' && value.includes('no longer available')
  )));
});

test('a rejected in-memory finalization checks server truth before showing failure', async () => {
  const fixture = installFixture(Promise.reject(new Error('finalize response was lost')));
  await renderFreshSubmit(fixture);

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.storageCleared, true);
  assert.equal(fixture.navigateCalls.length, 1);
});

test('a refreshed tab stops immediately when no uploader or PUT acknowledgement remains', async () => {
  const fixture = installFixture(null);
  fixture.recorder.recoverRecordingFinalization = async () => {
    fixture.recoveryCalls += 1;
    return {
      state: 'processing',
      recordMode: 's3',
      expectedPartCount: 2,
      completedPartCount: 1,
      finalPartIndex: 1,
    };
  };

  await renderFreshSubmit(fixture);
  assert.equal(fixture.recoveryCalls, 1, 'PutObject-only recovery must not poll S3');
  assert.equal(fixture.navigateCalls.length, 0);
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 1 && value === 'failed'));
  assert.ok(fixture.stateUpdates.some(([index, value]) => (
    index === 2 && typeof value === 'string' && value.includes('no longer has recording data')
  )));
});

test('a permanent storage error without browser evidence does not offer a useless retry', async () => {
  const fixture = installFixture(null);
  const storageError = Object.assign(new Error('recording storage is misconfigured'), {
    response: {
      status: 424,
      data: { reason: 'recording_storage_misconfigured' },
    },
  });
  fixture.recorder.recoverRecordingFinalization = async () => {
    fixture.recoveryCalls += 1;
    throw storageError;
  };
  fixture.recorder.isRetryableFinalizationFailure = () => false;

  await renderFreshSubmit(fixture);
  for (let attempt = 0; attempt < 50 && fixture.stateUpdates.length < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.navigateCalls.length, 0);
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 1 && value === 'failed'));
  assert.ok(fixture.stateUpdates.some(([index, value]) => (
    index === 2 && typeof value === 'string' && value.includes('contact the administrator')
  )));
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 3 && value === false));
});

test('an expired session with a stored PUT receipt does not offer endless retry', async () => {
  const fixture = installFixture(null);
  const authError = Object.assign(new Error('student session expired'), {
    response: { status: 401, data: { reason: 'invalid_student_token' } },
  });
  fixture.recorder.hasStoredUploadAcknowledgements = () => true;
  fixture.recorder.recoverRecordingFinalization = async () => {
    fixture.recoveryCalls += 1;
    throw authError;
  };
  fixture.recorder.isRetryableFinalizationFailure = () => false;

  await renderFreshSubmit(fixture);
  for (let attempt = 0; attempt < 50 && fixture.stateUpdates.length < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.navigateCalls.length, 0);
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 1 && value === 'failed'));
  assert.equal(fixture.stateUpdates.some(([index, value]) => index === 3 && value === true), false);
});

test('a CORS-blocked browser PUT is explicit even while server state remains processing', async () => {
  const storageCause = Object.assign(new Error('browser upload was blocked'), {
    response: {
      status: 424,
      data: { reason: 'recording_upload_blocked' },
    },
  });
  const finalizationError = Object.assign(new Error('recording upload failed'), {
    stage: 'upload',
    partIndex: 0,
    retryable: false,
    cause: storageCause,
  });
  const fixture = installFixture(Promise.reject(finalizationError));
  fixture.recorder.recoverRecordingFinalization = async () => {
    fixture.recoveryCalls += 1;
    return {
      state: 'processing',
      recordMode: 's3',
      expectedPartCount: 1,
      completedPartCount: 0,
    };
  };
  fixture.recorder.canRetryFinalization = () => true;
  fixture.recorder.isRetryableFinalizationFailure = () => false;

  await renderFreshSubmit(fixture);
  for (let attempt = 0; attempt < 50 && fixture.stateUpdates.length < 3; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.navigateCalls.length, 0);
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 1 && value === 'failed'));
  assert.ok(fixture.stateUpdates.some(([index, value]) => (
    index === 2 && typeof value === 'string' && value.includes('CORS')
  )));
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 3 && value === true));
});
