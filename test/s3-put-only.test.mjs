import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let bundledS3Source;
let importSequence = 0;

before(async () => {
  const entryPoint = fileURLToPath(new URL('../src/server/services/s3.ts', import.meta.url));
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [{
      name: 's3-put-only-test-stubs',
      setup(esbuild) {
        esbuild.onResolve({ filter: /^@aws-sdk\/client-s3$/ }, () => ({
          path: 'client-s3',
          namespace: 's3-put-only-test',
        }));
        esbuild.onResolve({ filter: /^@aws-sdk\/s3-request-presigner$/ }, () => ({
          path: 'presigner',
          namespace: 's3-put-only-test',
        }));
        esbuild.onLoad({ filter: /^client-s3$/, namespace: 's3-put-only-test' }, () => ({
          loader: 'js',
          contents: `
            export class PutObjectCommand {
              constructor(input) { this.input = input; this.kind = 'put'; }
            }
            export class S3Client {
              constructor(config) { this.config = config; }
              send() { throw new Error('PutObject-only presigning must not call S3'); }
            }
          `,
        }));
        esbuild.onLoad({ filter: /^presigner$/, namespace: 's3-put-only-test' }, () => ({
          loader: 'js',
          contents: `
            export function getSignedUrl(client, command, options) {
              return globalThis.__s3PutOnlySign(client, command, options);
            }
          `,
        }));
      },
    }],
  });
  bundledS3Source = result.outputFiles[0].text;
});

afterEach(() => {
  delete globalThis.__s3PutOnlySign;
  delete process.env.AWS_REGION;
  delete process.env.S3_RECORDINGS_BUCKET;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

async function importFreshS3({ configured = true, sign } = {}) {
  process.env.AWS_REGION = 'ap-southeast-1';
  if (configured) {
    process.env.S3_RECORDINGS_BUCKET = 'recording-bucket';
    process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';
  }
  globalThis.__s3PutOnlySign = sign || (async () => 'https://s3.test/upload');
  const encoded = Buffer.from(bundledS3Source).toString('base64');
  importSequence += 1;
  return import(`data:text/javascript;base64,${encoded}#s3-put-only-${importSequence}`);
}

test('presigning uses only PutObject and never sends Head/List requests', async () => {
  const signed = [];
  const s3 = await importFreshS3({
    sign: async (client, command, options) => {
      signed.push({ client, command, options });
      return 'https://s3.test/signed-upload';
    },
  });

  const result = await s3.createRecordingUploadUrl({
    batchId: 7,
    studentId: 9,
    partIndex: 3,
    objectKey: 'recordings/7/9/session-jti/part003-upload.webm',
    contentType: 'video/webm',
  });

  assert.deepEqual(result, {
    url: 'https://s3.test/signed-upload',
    key: 'recordings/7/9/session-jti/part003-upload.webm',
  });
  assert.equal(signed.length, 1);
  assert.equal(signed[0].command.kind, 'put');
  assert.deepEqual(signed[0].command.input, {
    Bucket: 'recording-bucket',
    Key: 'recordings/7/9/session-jti/part003-upload.webm',
    ContentType: 'video/webm',
  });
  assert.equal(signed[0].options.expiresIn, 15 * 60);
  assert.equal(signed[0].client.config.region, 'ap-southeast-1');
  assert.equal(signed[0].client.config.requestChecksumCalculation, 'WHEN_REQUIRED');
});

test('missing PutObject credentials fails before a URL is signed', async () => {
  let signCalls = 0;
  const s3 = await importFreshS3({
    configured: false,
    sign: async () => {
      signCalls += 1;
      return 'https://s3.test/should-not-exist';
    },
  });

  assert.equal(s3.isS3Configured(), false);
  await assert.rejects(
    s3.createRecordingUploadUrl({ batchId: 7, studentId: 9, partIndex: 0 }),
    (error) => error?.code === 'S3_NOT_CONFIGURED',
  );
  assert.equal(signCalls, 0);
});

test('real presigned browser PUT URL does not pin an empty-body CRC32 checksum', async () => {
  process.env.AWS_REGION = 'ap-southeast-1';
  process.env.S3_RECORDINGS_BUCKET = 'recording-bucket';
  process.env.AWS_ACCESS_KEY_ID = 'test-access-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-key';

  // Import the compiled module with the real AWS SDK. Presigning is local and
  // makes no S3 request; the stubbed test above separately guards against send().
  const moduleUrl = new URL('../dist/server/services/s3.js', import.meta.url);
  const s3 = await import(`${moduleUrl.href}?real-presign=${Date.now()}`);
  const result = await s3.createRecordingUploadUrl({
    batchId: 7,
    studentId: 9,
    partIndex: 3,
    objectKey: 'recordings/7/9/session-jti/part003.webm',
    contentType: 'video/webm',
  });
  const signedUrl = new URL(result.url);
  const queryNames = new Set(
    [...signedUrl.searchParams.keys()].map((name) => name.toLowerCase()),
  );

  assert.equal(queryNames.has('x-amz-checksum-crc32'), false);
  assert.equal(queryNames.has('x-amz-sdk-checksum-algorithm'), false);
});
