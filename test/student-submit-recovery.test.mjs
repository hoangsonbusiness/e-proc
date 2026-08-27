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
}

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

test('a rejected in-memory finalization checks server truth before showing failure', async () => {
  const fixture = installFixture(Promise.reject(new Error('finalize response was lost')));
  await renderFreshSubmit(fixture);

  assert.equal(fixture.recoveryCalls, 1);
  assert.equal(fixture.storageCleared, true);
  assert.equal(fixture.navigateCalls.length, 1);
});

test('a refreshed tab does not claim endless processing when no uploader remains', async () => {
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
  for (let attempt = 0; attempt < 60 && fixture.recoveryCalls < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(fixture.recoveryCalls, 3, 'recovery must be bounded');
  assert.equal(fixture.navigateCalls.length, 0);
  assert.ok(fixture.stateUpdates.some(([index, value]) => index === 1 && value === 'failed'));
  assert.ok(fixture.stateUpdates.some(([index, value]) => (
    index === 2 && typeof value === 'string' && value.includes('no longer has an uploader')
  )));
});
