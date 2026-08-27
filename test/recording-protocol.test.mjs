import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let protocol;

before(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(
      new URL('../src/server/services/recordingProtocol.ts', import.meta.url),
    )],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
  });
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64');
  protocol = await import(`data:text/javascript;base64,${encoded}`);
});

test('completion accepts only the explicit PutObject acknowledgement protocol v2', () => {
  assert.equal(protocol.isRecordingPutAcknowledgementPayload({
    protocolVersion: 2,
    putAcknowledged: true,
    uploadId: 'upload-a',
  }), true);
});

test('old HeadObject-era completion payloads cannot be mistaken for PUT success', () => {
  for (const payload of [
    { partIndex: 0, byteSize: 1024 },
    { uploadId: 'upload-a', partIndex: 0, byteSize: 1024 },
    { protocolVersion: '2', putAcknowledged: true, uploadId: 'upload-a' },
    { protocolVersion: 2, putAcknowledged: false, uploadId: 'upload-a' },
    { protocolVersion: 2, putAcknowledged: true },
  ]) {
    assert.equal(protocol.isRecordingPutAcknowledgementPayload(payload), false);
  }
});
