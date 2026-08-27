// s3.ts — Tạo presigned PUT URL để client upload video record THẲNG lên S3.
//
// Credential AWS chỉ nằm ở backend (env). Client không bao giờ chạm credential —
// chỉ nhận một URL đã ký, hết hạn ngắn. Video đi thẳng client → S3, không qua
// backend, nên né hoàn toàn giới hạn payload/timeout của Vercel serverless.
//
// Xóa video: dùng S3 Lifecycle rule trên bucket (tự xóa sau N ngày) — không cần
// script backend.

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RECORDINGS_BUCKET || '';
const URL_EXPIRES_SECONDS = 15 * 60; // presigned URL hết hạn 15 phút

let s3Client: S3Client | null = null;

/** Cấu hình S3 đã đủ để hoạt động chưa (env có mặt). */
export function isS3Configured(): boolean {
  return !!(
    BUCKET &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  );
}

function getClient(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: REGION,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      },
    });
  }
  return s3Client;
}

/**
 * Tạo presigned PUT URL cho một phần video của một thí sinh.
 * Key được backend dựng từ batchId/studentId (lấy từ JWT — KHÔNG tin client),
 * nên thí sinh không thể ghi đè video của người khác.
 */
export async function createRecordingUploadUrl(params: {
  batchId: number;
  studentId: number;
  partIndex: number;
  objectKey?: string;
  contentType?: string;
}): Promise<{ url: string; key: string }> {
  const { batchId, studentId, partIndex, objectKey, contentType } = params;
  const part = String(partIndex).padStart(3, '0');
  // Current routes always provide an authenticated, session-namespaced
  // reservation key. The fallback only supports legacy internal callers; it
  // does not provide cross-attempt isolation by itself.
  const key = objectKey || `recordings/${batchId}/${studentId}/part${part}.webm`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'video/webm',
  });

  const url = await getSignedUrl(getClient(), command, { expiresIn: URL_EXPIRES_SECONDS });
  return { url, key };
}

export async function inspectRecordingObject(key: string): Promise<{ byteSize: number }> {
  const result = await getClient().send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  return { byteSize: Number(result.ContentLength || 0) };
}

/**
 * Reconciliation treats a genuine 404 as "not uploaded yet". Authentication,
 * throttling and transport failures must still propagate so the caller retries
 * instead of falsely declaring the evidence incomplete.
 */
export async function inspectRecordingObjectIfExists(
  key: string,
): Promise<{ byteSize: number } | null> {
  try {
    return await inspectRecordingObject(key);
  } catch (error: any) {
    const status = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode);
    if (status === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey') return null;
    throw error;
  }
}
