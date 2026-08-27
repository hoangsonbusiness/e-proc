import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let bundledRecorderSource;
let importSequence = 0;
let restoreBrowserGlobals = null;

before(async () => {
  const entryPoint = fileURLToPath(
    new URL('../client/src/services/examRecorder.ts', import.meta.url),
  );
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    plugins: [
      {
        name: 'exam-recorder-test-stubs',
        setup(esbuild) {
          esbuild.onResolve({ filter: /^\.\/api$/ }, () => ({
            path: 'student-api',
            namespace: 'exam-recorder-test',
          }));
          esbuild.onResolve({ filter: /^@zip\.js\/zip\.js$/ }, () => ({
            path: 'zip-js',
            namespace: 'exam-recorder-test',
          }));
          esbuild.onLoad(
            { filter: /^student-api$/, namespace: 'exam-recorder-test' },
            () => ({
              loader: 'js',
              contents: 'export const studentApi = globalThis.__examRecorderStudentApi;',
            }),
          );
          esbuild.onLoad(
            { filter: /^zip-js$/, namespace: 'exam-recorder-test' },
            () => ({
              loader: 'js',
              contents: `
                export class BlobWriter { constructor() {} }
                export class BlobReader { constructor() {} }
                export class ZipWriter {
                  constructor() {}
                  async add() {}
                  async close() { return new Blob([]); }
                }
              `,
            }),
          );
        },
      },
    ],
  });
  bundledRecorderSource = result.outputFiles[0].text;
});

afterEach(async () => {
  if (restoreBrowserGlobals) {
    restoreBrowserGlobals();
    restoreBrowserGlobals = null;
  }
  delete globalThis.__examRecorderStudentApi;
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function completedResponse(partIndex, byteSize, uploadId) {
  return { data: { success: true, partIndex, byteSize, uploadId } };
}

function replaceGlobal(name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  };
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

function installBrowserFixture({
  api,
  fetchImpl,
  fireEndedOnProgrammaticStop = true,
  recorderStopError = null,
  emitFinalData = true,
  emitTimesliceData = false,
  directoryHandle = null,
  fastRetryDelays = false,
  sessionStorageImpl = null,
  localStorageImpl = null,
}) {
  if (typeof api.sealRecordingManifest !== 'function') {
    api.sealRecordingManifest = async (parts) => ({
      data: {
        success: true,
        state: 'processing',
        recordMode: 's3',
        expectedPartCount: parts.length,
        completedPartCount: 0,
        parts: parts.map((part) => ({ ...part, completed: false })),
      },
    });
  }
  if (typeof api.getRecordingStatus !== 'function') {
    api.getRecordingStatus = async () => ({
      data: {
        state: 'processing',
        recordMode: 's3',
        expectedPartCount: 1,
        completedPartCount: 0,
      },
    });
  }
  if (typeof api.reconcileRecording !== 'function') {
    api.reconcileRecording = async () => ({
      data: {
        state: 'processing',
        recordMode: 's3',
        expectedPartCount: 1,
        completedPartCount: 0,
      },
    });
  }
  const events = [];
  const track = {
    onended: null,
    stopped: false,
    stopCalls: 0,
    getSettings: () => ({ displaySurface: 'monitor' }),
    stop() {
      this.stopped = true;
      this.stopCalls += 1;
      events.push('track.stop');
      // Browsers do not normally dispatch `ended` for a script-initiated stop(), but
      // firing it here proves the lifecycle guard is not dependent on that subtlety.
      if (fireEndedOnProgrammaticStop) this.onended?.();
    },
    simulateUserStop() {
      this.stopped = true;
      events.push('track.user-stop');
      this.onended?.();
    },
  };
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };

  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
    }

    start() {
      this.state = 'recording';
      events.push('recorder.start');
      if (emitTimesliceData) {
        queueMicrotask(() => this.ondataavailable?.({
          data: new Blob(['timeslice recording bytes'], { type: 'video/webm' }),
        }));
      }
    }

    requestData() {
      events.push('recorder.requestData');
      if (emitFinalData) {
        this.ondataavailable?.({
          data: new Blob(['final recording bytes'], { type: 'video/webm' }),
        });
      }
    }

    stop() {
      if (recorderStopError) throw recorderStopError;
      this.state = 'inactive';
      events.push('recorder.stop');
      queueMicrotask(() => this.onstop?.());
    }
  }

  const restores = [
    replaceGlobal('navigator', {
      userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36',
      userAgentData: { brands: [{ brand: 'Google Chrome' }] },
      mediaDevices: { getDisplayMedia: async () => stream },
    }),
    replaceGlobal('MediaRecorder', FakeMediaRecorder),
    replaceGlobal('fetch', fetchImpl),
  ];
  if (directoryHandle) {
    restores.push(replaceGlobal('window', {
      showDirectoryPicker: async () => directoryHandle,
    }));
  }
  if (sessionStorageImpl) restores.push(replaceGlobal('sessionStorage', sessionStorageImpl));
  if (localStorageImpl) restores.push(replaceGlobal('localStorage', localStorageImpl));
  if (fastRetryDelays) {
    const nativeSetTimeout = globalThis.setTimeout;
    const retryDelays = new Set([3000, 6000, 12000, 24000]);
    restores.push(replaceGlobal('setTimeout', (callback, delay, ...args) => (
      nativeSetTimeout(callback, retryDelays.has(Number(delay)) ? 0 : delay, ...args)
    )));
  }
  restoreBrowserGlobals = () => {
    for (const restore of restores.reverse()) restore();
  };
  globalThis.__examRecorderStudentApi = api;
  return { events, stream, track };
}

async function importFreshRecorder() {
  const encoded = Buffer.from(bundledRecorderSource).toString('base64');
  importSequence += 1;
  return import(`data:text/javascript;base64,${encoded}#fixture-${importSequence}`);
}

test('manual submit stops browser sharing before waiting for S3 finalization', async () => {
  const finalize = deferred();
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      fixture.events.push('presign');
      return { data: { url: 'https://s3.test/upload', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      fixture.events.push('complete');
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => {
      fixture.events.push('finalize');
      return finalize.promise;
    },
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => {
      fixture.events.push('put');
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();
  let stoppedViolations = 0;

  assert.deepEqual(await recorder.requestSetup('s3'), { ok: true });
  recorder.start({ mode: 's3' });
  recorder.setOnRecordingStopped(() => { stoppedViolations += 1; });

  const firstStop = recorder.stopAndSave();
  const repeatedStop = recorder.stopAndSave();
  try {
    assert.equal(repeatedStop, firstStop, 'stopAndSave must remain idempotent');

    await waitFor(
      () => fixture.events.includes('finalize'),
      'expected the recording manifest finalization request to start',
    );

    assert.equal(fixture.track.stopped, true, 'screen capture must already be released');
    assert.equal(recorder.isActive(), false);
    assert.equal(stoppedViolations, 0, 'intentional submit cleanup is not a violation');
    assert.ok(
      fixture.events.indexOf('track.stop') < fixture.events.indexOf('presign'),
      `expected track.stop before S3 work, got: ${fixture.events.join(' -> ')}`,
    );
    assert.deepEqual(fixture.events.slice(0, 4), [
      'recorder.start',
      'recorder.requestData',
      'recorder.stop',
      'track.stop',
    ]);
  } finally {
    finalize.resolve({ data: { ok: true } });
  }
  await firstStop;
});

test('submit handoff waits for S3 seal but not for the pending upload/finalize pipeline', async () => {
  const seal = deferred();
  const put = deferred();
  let sealedParts = null;
  let finalizationSettled = false;
  const api = {
    sealRecordingManifest: async (parts) => {
      sealedParts = parts;
      fixture.events.push('seal-start');
      return seal.promise;
    },
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      fixture.events.push('presign');
      return { data: { url: 'https://s3.test/handoff', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      fixture.events.push('complete');
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => { fixture.events.push('finalize'); },
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => {
      fixture.events.push('put-start');
      return put.promise;
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  const finalization = recorder.stopAndSave().finally(() => {
    finalizationSettled = true;
  });
  const handoff = recorder.getSubmitHandoffPromise();
  assert.ok(handoff, 'terminal recording must expose a navigation handoff barrier');

  let handoffSettled = false;
  void handoff.then(() => {
    handoffSettled = true;
    fixture.events.push('handoff');
  });
  await waitFor(() => fixture.events.includes('seal-start'), 'expected seal request to start');
  assert.equal(fixture.track.stopped, true, 'capture must be released before sealing');
  assert.equal(handoffSettled, false, 'navigation must wait while seal is unresolved');
  assert.equal(fixture.events.includes('presign'), false, 'pending upload must wait for seal assignment');

  seal.resolve({
    data: {
      success: true,
      state: 'processing',
      recordMode: 's3',
      expectedPartCount: sealedParts.length,
      completedPartCount: 0,
      parts: sealedParts.map((part) => ({ ...part, completed: false })),
    },
  });

  await handoff;
  await waitFor(() => fixture.events.includes('put-start'), 'expected upload to continue after seal');
  assert.equal(handoffSettled, true);
  assert.equal(finalizationSettled, false, 'navigation barrier must not wait for the full S3 pipeline');
  assert.ok(
    fixture.events.indexOf('handoff') < fixture.events.indexOf('put-start'),
    `expected handoff before pending upload, got: ${fixture.events.join(' -> ')}`,
  );

  put.resolve({ ok: true, status: 200 });
  await finalization;
  assert.equal(fixture.events.at(-1), 'finalize');
});

test('a failed S3 seal still releases the submit handoff so navigation cannot be stranded', async () => {
  const api = {
    sealRecordingManifest: async () => {
      throw Object.assign(new Error('sealed manifest conflict'), {
        response: { status: 409, data: { reason: 'manifest_conflict' } },
      });
    },
    getRecordingUploadUrl: async () => assert.fail('failed seal must not start pending upload'),
    completeRecordingPart: async () => assert.fail('failed seal must not complete a part'),
    finalizeRecording: async () => assert.fail('failed seal must not finalize'),
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => assert.fail('failed seal must not PUT to S3'),
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  const finalization = recorder.stopAndSave();
  const handoff = recorder.getSubmitHandoffPromise();

  await handoff;
  assert.equal(fixture.track.stopped, true);
  await assert.rejects(finalization, (error) => error?.stage === 'seal');
});

test('submit handoff is released after the first transient seal attempt while retries continue', async () => {
  let sealCalls = 0;
  let finalizationSettled = false;
  const api = {
    sealRecordingManifest: async (parts) => {
      sealCalls += 1;
      if (sealCalls === 1) {
        throw Object.assign(new Error('temporary seal outage'), { response: { status: 503 } });
      }
      return {
        data: {
          success: true,
          state: 'processing',
          recordMode: 's3',
          expectedPartCount: parts.length,
          completedPartCount: 0,
          parts: parts.map((part) => ({ ...part, completed: false })),
        },
      };
    },
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: { url: 'https://s3.test/seal-retry', partIndex: index, uploadId },
    }),
    completeRecordingPart: async (...args) => completedResponse(...args),
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  const finalization = recorder.stopAndSave().finally(() => { finalizationSettled = true; });
  const handoff = recorder.getSubmitHandoffPromise();

  await handoff;
  assert.equal(sealCalls, 1, 'navigation must not wait for the second seal attempt');
  assert.equal(finalizationSettled, false, 'seal retry continues on the submit page');
  await finalization;
  assert.equal(sealCalls, 2);
});

test('recording-stopped subscriptions can be removed when the exam page unmounts', async () => {
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: { url: 'https://s3.test/upload', partIndex: index, uploadId },
    }),
    completeRecordingPart: async (...args) => completedResponse(...args),
    finalizeRecording: async () => undefined,
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => ({ ok: true }),
    fireEndedOnProgrammaticStop: false,
  });
  const recorder = await importFreshRecorder();
  let callbackCalls = 0;

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  const unsubscribe = recorder.setOnRecordingStopped(() => { callbackCalls += 1; });
  try {
    assert.equal(typeof unsubscribe, 'function');

    unsubscribe();
    fixture.track.simulateUserStop();
    assert.equal(callbackCalls, 0, 'an unmounted exam page must not report a stale violation');
  } finally {
    if (typeof unsubscribe === 'function') unsubscribe();
    await recorder.stopAndSave().catch(() => undefined);
  }
});

test('a real recording_incomplete manifest response is not offered as an endless retry', async () => {
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  let finalizeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: 'https://s3.test/upload', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => {
      finalizeCalls += 1;
      if (finalizeCalls === 1) {
        throw Object.assign(new Error('recording manifest has a durable gap'), {
          response: { status: 409, data: { reason: 'recording_incomplete' } },
        });
      }
    },
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(
    recorder.stopAndSave(),
    (error) => error?.stage === 'finalize' && /durable gap/.test(error.message),
  );

  assert.equal(fixture.track.stopped, true, 'failure must not keep browser sharing alive');
  assert.equal(recorder.isActive(), false);
  assert.equal(recorder.canRetryFinalization(), false);
  assert.equal(typeof recorder.retryFinalization, 'function');
  await assert.rejects(recorder.retryFinalization(), /not retryable/);
  assert.equal(recorder.canRetryFinalization(), false);

  assert.equal(finalizeCalls, 1);
  assert.equal(presignCalls, 1, 'an acknowledged part must not be presigned again');
  assert.equal(putCalls, 1, 'an acknowledged part must not be uploaded again');
  assert.equal(completeCalls, 1, 'an acknowledged part must not be completed again');
});

test('a transient manifest failure is retried automatically without re-uploading parts', async () => {
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  let finalizeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: 'https://s3.test/upload', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => {
      finalizeCalls += 1;
      if (finalizeCalls === 1) {
        throw Object.assign(new Error('temporary finalize outage'), {
          response: { status: 503 },
        });
      }
    },
  };
  installBrowserFixture({
    api,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await recorder.stopAndSave();

  assert.equal(finalizeCalls, 2);
  assert.equal(presignCalls, 1);
  assert.equal(putCalls, 1);
  assert.equal(completeCalls, 1);
});

test('a resumed capture uses the server cursor instead of colliding with old parts', async () => {
  const presignedParts = [];
  const completedParts = [];
  const uploadIds = [];
  let finalizeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignedParts.push(index);
      uploadIds.push(uploadId);
      return { data: { url: `https://s3.test/upload/${index}`, partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, _size, uploadId) => {
      completedParts.push(index);
      assert.equal(uploadId, uploadIds[0]);
      return completedResponse(index, _size, uploadId);
    },
    finalizeRecording: async () => { finalizeCalls += 1; },
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  // Mirrors /confirm starting capture before /exam receives the fresh DB cursor.
  recorder.start({ mode: 's3' });
  assert.equal(recorder.setNextPartIndex(3), true);
  await recorder.stopAndSave();

  assert.deepEqual(presignedParts, [3]);
  assert.deepEqual(completedParts, [3]);
  assert.equal(finalizeCalls, 1);
  assert.match(uploadIds[0], /^[0-9a-f-]{36}$/i);
});

test('server reservation can move a colliding resumed blob without discarding it', async () => {
  const calls = [];
  let logicalUploadId;
  const api = {
    sealRecordingManifest: async (parts) => {
      logicalUploadId = parts[0].uploadId;
      calls.push(['seal', parts[0].partIndex, logicalUploadId]);
      // Part 0 was reserved by a request that won after this client read its
      // cursor. Sealing atomically gives this logical blob the final assignment.
      return {
        data: {
          success: true,
          state: 'processing',
          recordMode: 's3',
          expectedPartCount: 2,
          completedPartCount: 1,
          parts: [{ uploadId: logicalUploadId, partIndex: 1, completed: false }],
        },
      };
    },
    getRecordingUploadUrl: async (requestedIndex, _contentType, uploadId) => {
      calls.push(['presign', requestedIndex, uploadId]);
      assert.equal(requestedIndex, 1, 'presign must use the sealed assignment');
      return { data: { url: 'https://s3.test/upload/part1', partIndex: 1, uploadId } };
    },
    completeRecordingPart: async (assignedIndex, _size, uploadId) => {
      calls.push(['complete', assignedIndex, uploadId]);
      return completedResponse(assignedIndex, _size, uploadId);
    },
    finalizeRecording: async () => { calls.push(['finalize']); },
  };
  installBrowserFixture({
    api,
    fetchImpl: async (_url, init) => {
      calls.push(['put', await init.body.text()]);
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3', initialPartIndex: 0 });
  await recorder.stopAndSave();

  assert.equal(calls.filter(([stage]) => stage === 'put').length, 1);
  assert.equal(calls[0][0], 'seal', 'the final manifest must be sealed before pending S3 work');
  assert.deepEqual(calls.find(([stage]) => stage === 'put'), ['put', 'final recording bytes']);
  assert.deepEqual(calls.find(([stage]) => stage === 'complete'), ['complete', 1, logicalUploadId]);
  assert.equal(calls.at(-1)[0], 'finalize');
});

test('a mismatched completion identity cannot acknowledge and delete the pending blob', async () => {
  let completeCalls = 0;
  let uploadedBody = '';
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: { url: 'https://s3.test/identity-check', partIndex: index, uploadId },
    }),
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      if (completeCalls === 1) {
        return { data: { success: true, partIndex: index, uploadId: 'wrong-upload-id' } };
      }
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    fetchImpl: async (_url, init) => {
      uploadedBody = await init.body.text();
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await recorder.stopAndSave();

  assert.equal(completeCalls, 2, 'the wrong identity must not count as completion');
  assert.equal(uploadedBody, 'final recording bytes');
});

test('a replayed but incomplete reservation still uploads and completes its blob', async () => {
  let putCalls = 0;
  let completeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: {
        url: 'https://s3.test/replayed-reservation',
        partIndex: index,
        uploadId,
        already: true,
        completed: false,
      },
    }),
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await recorder.stopAndSave();

  assert.equal(putCalls, 1, 'reservation replay is not completed evidence');
  assert.equal(completeCalls, 1);
});

test('an ambiguous S3 PUT never acknowledges completion until the browser observes 2xx', async () => {
  let putCalls = 0;
  let completeCalls = 0;
  let finalizeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: { url: 'https://s3.test/ambiguous-put', partIndex: index, uploadId },
    }),
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => { finalizeCalls += 1; },
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    fetchImpl: async () => {
      putCalls += 1;
      if (putCalls === 1) throw new Error('S3 response was lost');
      return { ok: true, status: 200 };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await recorder.stopAndSave();

  assert.equal(putCalls, 2, 'the same blob/key must be PUT again after an ambiguous response');
  assert.equal(completeCalls, 1, 'completion is sent only after an observed PUT 2xx');
  assert.equal(finalizeCalls, 1);
});

test('a PUT-2xx acknowledgement survives completion failure and reload without another PUT', async () => {
  const sessionStorageImpl = createMemoryStorage();
  const localStorageImpl = createMemoryStorage({ studentToken: 'header.payload.attempt-signature' });
  let allowCompletion = false;
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  let reconcileCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: 'https://s3.test/receipt-reload', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      if (!allowCompletion) {
        throw Object.assign(new Error('completion response unavailable'), {
          response: { status: 503 },
        });
      }
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => assert.fail('the first module must not reach finalize'),
    getRecordingStatus: async () => ({ data: {
      state: 'processing',
      recordMode: 's3',
      expectedPartCount: 1,
      completedPartCount: allowCompletion ? 1 : 0,
      finalPartIndex: 0,
    } }),
    reconcileRecording: async () => {
      reconcileCalls += 1;
      return { data: {
        state: 'finalized',
        recordMode: 's3',
        expectedPartCount: 1,
        completedPartCount: 1,
        finalPartIndex: 0,
      } };
    },
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    sessionStorageImpl,
    localStorageImpl,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true, status: 200 };
    },
  });
  const firstRecorder = await importFreshRecorder();

  await firstRecorder.requestSetup('s3');
  firstRecorder.start({ mode: 's3' });
  await assert.rejects(firstRecorder.stopAndSave(), (error) => error?.stage === 'complete');

  assert.equal(presignCalls, 1);
  assert.equal(putCalls, 1);
  assert.equal(completeCalls, 5);
  assert.equal(firstRecorder.hasStoredUploadAcknowledgements(), true);

  allowCompletion = true;
  const reloadedRecorder = await importFreshRecorder();
  const recovered = await reloadedRecorder.recoverRecordingFinalization();

  assert.equal(recovered.state, 'finalized');
  assert.equal(presignCalls, 1, 'reload recovery must not request another URL');
  assert.equal(putCalls, 1, 'reload recovery must not upload the 5-minute blob again');
  assert.equal(completeCalls, 6, 'reload replays only the idempotent completion acknowledgement');
  assert.equal(reconcileCalls, 1);
  assert.equal(reloadedRecorder.hasStoredUploadAcknowledgements(), false);
});

test('terminal status failure quarantines a stored PUT receipt after reload', async () => {
  const sessionStorageImpl = createMemoryStorage();
  const localStorageImpl = createMemoryStorage({ studentToken: 'header.payload.expiring-attempt' });
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: { url: 'https://s3.test/receipt-expired-auth', partIndex: index, uploadId },
    }),
    completeRecordingPart: async () => {
      throw Object.assign(new Error('completion temporarily unavailable'), {
        response: { status: 503 },
      });
    },
    finalizeRecording: async () => assert.fail('failed completion must not finalize'),
    getRecordingStatus: async () => {
      throw Object.assign(new Error('student session expired'), {
        response: { status: 401, data: { reason: 'invalid_student_token' } },
      });
    },
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    sessionStorageImpl,
    localStorageImpl,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const firstRecorder = await importFreshRecorder();

  await firstRecorder.requestSetup('s3');
  firstRecorder.start({ mode: 's3' });
  await assert.rejects(firstRecorder.stopAndSave(), (error) => error?.stage === 'complete');
  assert.equal(firstRecorder.hasStoredUploadAcknowledgements(), true);

  const reloadedRecorder = await importFreshRecorder();
  await assert.rejects(
    reloadedRecorder.recoverRecordingFinalization(),
    (error) => reloadedRecorder.isRetryableFinalizationFailure(error) === false,
  );
  assert.equal(reloadedRecorder.hasStoredUploadAcknowledgements(), false);
});

test('hardened sessionStorage failures never crash receipt inspection', async () => {
  const throwingStorage = {
    getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    clear: () => { throw new DOMException('blocked', 'SecurityError'); },
  };
  installBrowserFixture({
    api: {},
    sessionStorageImpl: throwingStorage,
    fetchImpl: async () => ({ ok: true }),
  });
  const recorder = await importFreshRecorder();

  assert.doesNotThrow(() => recorder.hasStoredUploadAcknowledgements());
  assert.equal(recorder.hasStoredUploadAcknowledgements(), false);
});

test('same-tab retry replays completion after PUT 2xx without presigning or uploading again', async () => {
  const sessionStorageImpl = createMemoryStorage();
  let allowCompletion = false;
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  let finalizeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: 'https://s3.test/receipt-same-tab', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      if (!allowCompletion) {
        throw Object.assign(new Error('completion temporarily unavailable'), {
          response: { status: 503 },
        });
      }
      return completedResponse(index, size, uploadId);
    },
    finalizeRecording: async () => { finalizeCalls += 1; },
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    sessionStorageImpl,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true, status: 200 };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(recorder.stopAndSave(), (error) => error?.stage === 'complete');
  assert.equal(recorder.canRetryFinalization(), true);
  assert.equal(completeCalls, 5);

  allowCompletion = true;
  await recorder.retryFinalization();

  assert.equal(presignCalls, 1);
  assert.equal(putCalls, 1);
  assert.equal(completeCalls, 6);
  assert.equal(finalizeCalls, 1);
  assert.equal(recorder.hasStoredUploadAcknowledgements(), false);
});

test('a terminal completion rejection removes its receipt instead of offering endless retry', async () => {
  const sessionStorageImpl = createMemoryStorage();
  let completeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => ({
      data: { url: 'https://s3.test/terminal-receipt', partIndex: index, uploadId },
    }),
    completeRecordingPart: async () => {
      completeCalls += 1;
      throw Object.assign(new Error('reservation no longer exists'), {
        response: { status: 409, data: { reason: 'reservation_not_found' } },
      });
    },
    finalizeRecording: async () => assert.fail('terminal acknowledgement must not finalize'),
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    sessionStorageImpl,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(recorder.stopAndSave(), (error) => (
    error?.stage === 'complete' && error?.retryable === false
  ));

  assert.equal(completeCalls, 1);
  assert.equal(recorder.hasStoredUploadAcknowledgements(), false);
  assert.equal(recorder.canRetryFinalization(), false);
});

test('a mismatched completion byte size cannot discard the PUT acknowledgement or blob', async () => {
  const sessionStorageImpl = createMemoryStorage();
  let returnCorrectSize = false;
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: 'https://s3.test/size-mismatch', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (index, size, uploadId) => {
      completeCalls += 1;
      return completedResponse(index, returnCorrectSize ? size : size + 1, uploadId);
    },
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    sessionStorageImpl,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true, status: 200 };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(recorder.stopAndSave(), (error) => error?.stage === 'complete');
  assert.equal(recorder.hasStoredUploadAcknowledgements(), true);

  returnCorrectSize = true;
  await recorder.retryFinalization();

  assert.equal(presignCalls, 1);
  assert.equal(putCalls, 1);
  assert.equal(completeCalls, 6);
  assert.equal(recorder.hasStoredUploadAcknowledgements(), false);
});

test('an active S3 interval is reserved before its blob enters the upload queue', async () => {
  let presignCalls = 0;
  let putCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: `https://s3.test/early-${presignCalls}`, partIndex: index, uploadId } };
    },
    completeRecordingPart: async (...args) => completedResponse(...args),
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    emitTimesliceData: true,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3', initialPartIndex: 0 });
  recorder.activateS3ReservationTracking();
  await waitFor(() => presignCalls === 1, 'current interval was not reserved promptly');
  assert.equal(putCalls, 0, 'early reservation must not upload an unfinished blob');

  await recorder.stopAndSave();
  assert.equal(presignCalls, 2, 'actual upload must request a fresh presigned URL');
  assert.equal(putCalls, 1);
});

test('status recovery trusts a finalized reconcile response without a redundant status request', async () => {
  const calls = [];
  let statusCalls = 0;
  const api = {
    getRecordingStatus: async () => {
      statusCalls += 1;
      calls.push(`status-${statusCalls}`);
      if (statusCalls > 1) throw new Error('redundant status confirmation was lost');
      return { data: {
        state: 'processing',
        recordMode: 's3',
        expectedPartCount: 1,
        completedPartCount: 1,
        finalPartIndex: 0,
      } };
    },
    reconcileRecording: async () => {
      calls.push('reconcile');
      return {
        data: {
          state: 'finalized',
          recordMode: 's3',
          expectedPartCount: 1,
          completedPartCount: 1,
          finalPartIndex: 0,
        },
      };
    },
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  const status = await recorder.recoverRecordingFinalization();

  assert.deepEqual(calls, ['status-1', 'reconcile']);
  assert.equal(status.state, 'finalized');
  assert.equal(status.completedPartCount, 1);
});

test('status recovery confirms server truth after the reconcile response is lost', async () => {
  const calls = [];
  let statusCalls = 0;
  const api = {
    getRecordingStatus: async () => {
      statusCalls += 1;
      calls.push(`status-${statusCalls}`);
      return { data: statusCalls === 1
        ? {
            state: 'processing',
            recordMode: 's3',
            expectedPartCount: 1,
            completedPartCount: 1,
            finalPartIndex: 0,
          }
        : {
            state: 'finalized',
            recordMode: 's3',
            expectedPartCount: 1,
            completedPartCount: 1,
            finalPartIndex: 0,
          } };
    },
    reconcileRecording: async () => {
      calls.push('reconcile');
      throw Object.assign(new Error('response was lost'), { response: { status: 503 } });
    },
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  const status = await recorder.recoverRecordingFinalization();

  assert.deepEqual(calls, ['status-1', 'reconcile', 'status-2']);
  assert.equal(status.state, 'finalized');
});

test('an uncommitted DB finalization keeps N/N status retryable after reload', async () => {
  let statusCalls = 0;
  let reconcileCalls = 0;
  const api = {
    getRecordingStatus: async () => {
      statusCalls += 1;
      return { data: {
        state: 'processing',
        recordMode: 's3',
        expectedPartCount: 1,
        completedPartCount: 1,
        finalPartIndex: 0,
      } };
    },
    reconcileRecording: async () => {
      reconcileCalls += 1;
      throw Object.assign(new Error('database temporarily unavailable'), {
        response: { status: 503 },
      });
    },
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  await assert.rejects(
    recorder.recoverRecordingFinalization(),
    (error) => recorder.isRetryableFinalizationFailure(error),
  );
  assert.equal(statusCalls, 2);
  assert.equal(reconcileCalls, 1);
});

test('status recovery does not call DB finalization while upload acknowledgements are missing', async () => {
  let reconcileCalls = 0;
  const api = {
    getRecordingStatus: async () => ({ data: {
      state: 'processing',
      recordMode: 's3',
      expectedPartCount: 2,
      completedPartCount: 1,
      finalPartIndex: 1,
    } }),
    reconcileRecording: async () => {
      reconcileCalls += 1;
      throw new Error('DB finalization cannot recover a missing PUT acknowledgement');
    },
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  const status = await recorder.recoverRecordingFinalization();

  assert.equal(status.state, 'processing');
  assert.equal(status.completedPartCount, 1);
  assert.equal(reconcileCalls, 0);
});

test('recording storage configuration failures are not offered as endless retries', async () => {
  installBrowserFixture({ api: {}, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();
  const error = Object.assign(new Error('storage unavailable'), {
    response: {
      status: 503,
      data: { reason: 'recording_storage_not_configured' },
    },
  });

  assert.equal(recorder.isRetryableFinalizationFailure(error), false);
  assert.equal(recorder.isRetryableFinalizationFailure(Object.assign(new Error('upload blocked'), {
    response: {
      status: 424,
      data: { reason: 'recording_upload_blocked' },
    },
  })), false);
});

test('an administrator-repaired storage configuration can manually upload blobs still in this tab', async () => {
  let presignCalls = 0;
  let putCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      if (presignCalls === 1) {
        throw Object.assign(new Error('IAM read-back permission is missing'), {
          response: {
            status: 424,
            data: { reason: 'recording_storage_misconfigured' },
          },
        });
      }
      return { data: { url: 'https://s3.test/repaired', partIndex: index, uploadId } };
    },
    completeRecordingPart: async (...args) => completedResponse(...args),
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    fetchImpl: async () => {
      putCalls += 1;
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(
    recorder.stopAndSave(),
    (error) => error?.stage === 'presign' && error?.retryable === false,
  );

  assert.equal(presignCalls, 1, 'a permanent configuration error must not back off automatically');
  assert.equal(putCalls, 0);
  assert.equal(recorder.canRetryFinalization(), true, 'the in-memory blob must remain manually recoverable');

  await recorder.retryFinalization();
  assert.equal(presignCalls, 2);
  assert.equal(putCalls, 1);
  assert.equal(recorder.canRetryFinalization(), false);
});

test('a CORS-like Failed to fetch becomes bounded manual recovery and retains the blob', async () => {
  let uploadAllowed = false;
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: `https://s3.test/upload/${presignCalls}`, partIndex: index, uploadId } };
    },
    completeRecordingPart: async (...args) => {
      completeCalls += 1;
      return completedResponse(...args);
    },
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    fastRetryDelays: true,
    fetchImpl: async () => {
      putCalls += 1;
      if (!uploadAllowed) throw new TypeError('Failed to fetch');
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(
    recorder.stopAndSave(),
    (error) => error?.stage === 'upload'
      && error?.retryable === false
      && error?.cause?.response?.data?.reason === 'recording_upload_blocked',
  );

  assert.equal(presignCalls, 1);
  assert.equal(putCalls, 5, 'CORS/network ambiguity must use only the bounded retry budget');
  assert.equal(completeCalls, 0, 'a failed/ambiguous PUT must never be acknowledged');
  assert.equal(recorder.canRetryFinalization(), true);

  uploadAllowed = true;
  await recorder.retryFinalization();
  assert.equal(presignCalls, 2, 'manual retry must obtain a fresh URL after CORS/network repair');
  assert.equal(putCalls, 6);
  assert.equal(completeCalls, 1);
  assert.equal(recorder.canRetryFinalization(), false);
});

test('local recording keeps its encrypted file path and never calls S3 seal or finalize', async () => {
  const writtenFiles = [];
  const directoryHandle = {
    async getFileHandle(name) {
      return {
        async createWritable() {
          return {
            async write(blob) { writtenFiles.push({ name, size: blob.size }); },
            async close() {},
          };
        },
      };
    },
  };
  const api = {
    sealRecordingManifest: async () => assert.fail('local mode must not seal an S3 manifest'),
    getRecordingUploadUrl: async () => assert.fail('local mode must not presign S3'),
    completeRecordingPart: async () => assert.fail('local mode must not complete S3'),
    finalizeRecording: async () => assert.fail('local mode must not finalize S3'),
  };
  const fixture = installBrowserFixture({
    api,
    directoryHandle,
    fetchImpl: async () => assert.fail('local mode must not PUT to S3'),
  });
  const recorder = await importFreshRecorder();

  assert.deepEqual(await recorder.requestSetup('local'), { ok: true });
  recorder.start({ mode: 'local', password: 'server-generated-password' });
  await recorder.stopAndSave();

  assert.equal(fixture.track.stopped, true);
  assert.equal(writtenFiles.length, 1);
  assert.match(writtenFiles[0].name, /^exam_\d{8}-\d{6}_part000\.zip$/);
});

test('the authoritative server cursor can repair a lower historical gap before capture is queued', async () => {
  const presignedParts = [];
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignedParts.push(index);
      return { data: { url: `https://s3.test/upload/${index}`, partIndex: index, uploadId } };
    },
    completeRecordingPart: async (...args) => completedResponse(...args),
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3', initialPartIndex: 3 });
  assert.equal(recorder.setNextPartIndex(1), true);
  await recorder.stopAndSave();

  assert.deepEqual(presignedParts, [1]);
});

test('an expired presigned URL allows whole-pipeline retry with a fresh URL', async () => {
  let presignCalls = 0;
  let putCalls = 0;
  let completeCalls = 0;
  const api = {
    getRecordingUploadUrl: async (index, _contentType, uploadId) => {
      presignCalls += 1;
      return { data: { url: `https://s3.test/upload/${presignCalls}`, partIndex: index, uploadId } };
    },
    completeRecordingPart: async (...args) => {
      completeCalls += 1;
      return completedResponse(...args);
    },
    finalizeRecording: async () => undefined,
  };
  installBrowserFixture({
    api,
    fetchImpl: async () => {
      putCalls += 1;
      return putCalls === 1 ? { ok: false, status: 403 } : { ok: true, status: 200 };
    },
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(recorder.stopAndSave(), (error) => error?.stage === 'upload');
  assert.equal(recorder.canRetryFinalization(), true);

  await recorder.retryFinalization();
  assert.equal(presignCalls, 2, 'manual retry must request a fresh presigned URL');
  assert.equal(putCalls, 2);
  assert.equal(completeCalls, 1, 'the failed PUT is never acknowledged');
});

test('pre-exam discard releases sharing without uploading or reporting a violation', async () => {
  let apiCalls = 0;
  const api = {
    getRecordingUploadUrl: async () => { apiCalls += 1; },
    completeRecordingPart: async () => { apiCalls += 1; },
    finalizeRecording: async () => { apiCalls += 1; },
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => {
      apiCalls += 1;
      return { ok: true };
    },
  });
  const recorder = await importFreshRecorder();
  let stoppedViolations = 0;

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  recorder.setOnRecordingStopped(() => { stoppedViolations += 1; });
  await recorder.stopAndDiscard();

  assert.equal(fixture.track.stopped, true);
  assert.equal(recorder.isActive(), false);
  assert.equal(stoppedViolations, 0);
  assert.equal(apiCalls, 0);
  assert.equal(recorder.getFinalizationPromise(), null);
});

test('capture failure still releases sharing and is explicitly non-retryable', async () => {
  const api = {
    getRecordingUploadUrl: async () => assert.fail('capture failure must not upload'),
    completeRecordingPart: async () => assert.fail('capture failure must not complete'),
    finalizeRecording: async () => assert.fail('capture failure must not finalize'),
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => assert.fail('capture failure must not PUT'),
    recorderStopError: new Error('browser recorder stop failed'),
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3' });
  await assert.rejects(
    recorder.stopAndSave(),
    (error) => error?.stage === 'capture' && /browser recorder stop failed/.test(error.message),
  );

  assert.equal(fixture.track.stopped, true);
  assert.equal(recorder.isActive(), false);
  assert.equal(recorder.canRetryFinalization(), false);
});

test('stopAndSave fails closed when no recording capture exists', async () => {
  let apiCalls = 0;
  const api = {
    getRecordingUploadUrl: async () => { apiCalls += 1; },
    completeRecordingPart: async () => { apiCalls += 1; },
    finalizeRecording: async () => { apiCalls += 1; },
  };
  installBrowserFixture({ api, fetchImpl: async () => ({ ok: true }) });
  const recorder = await importFreshRecorder();

  await assert.rejects(
    recorder.stopAndSave(),
    (error) => error?.stage === 'capture' && error?.retryable === false,
  );
  assert.equal(apiCalls, 0);
  assert.equal(recorder.canRetryFinalization(), false);
});

test('a recorder that emits no bytes cannot report successful finalization', async () => {
  let apiCalls = 0;
  const api = {
    getRecordingUploadUrl: async () => { apiCalls += 1; },
    completeRecordingPart: async () => { apiCalls += 1; },
    finalizeRecording: async () => { apiCalls += 1; },
  };
  const fixture = installBrowserFixture({
    api,
    fetchImpl: async () => {
      apiCalls += 1;
      return { ok: true };
    },
    emitFinalData: false,
  });
  const recorder = await importFreshRecorder();

  await recorder.requestSetup('s3');
  recorder.start({ mode: 's3', initialPartIndex: 4 });
  await assert.rejects(
    recorder.stopAndSave(),
    (error) => error?.stage === 'capture' && /produced no recording data/.test(error.message),
  );

  assert.equal(fixture.track.stopped, true);
  assert.equal(apiCalls, 0);
  assert.equal(recorder.canRetryFinalization(), false);
});
