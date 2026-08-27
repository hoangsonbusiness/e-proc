// s3.ts — Tạo presigned PUT URL để client upload video record THẲNG lên S3.
//
// Credential AWS chỉ nằm ở backend (env). Client không bao giờ chạm credential —
// chỉ nhận một URL đã ký, hết hạn ngắn. Video đi thẳng client → S3, không qua
// backend, nên né hoàn toàn giới hạn payload/timeout của Vercel serverless.
//
// Runtime principal intentionally needs only s3:PutObject. The browser treats a
// successful PUT response as the upload acknowledgement; the backend does not
// call HeadObject/ListObjects. For server-authoritative verification, connect an
// S3 ObjectCreated notification instead of granting read/list to this principal.
//
// Xóa video: dùng S3 Lifecycle rule trên bucket (tự xóa sau N ngày) — không cần
// script backend.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.S3_RECORDINGS_BUCKET || '';
const URL_EXPIRES_SECONDS = 15 * 60; // presigned URL hết hạn 15 phút

let s3Client: S3Client | null = null;

/** Cấu hình S3 đã đủ để tạo presigned URL chưa (chỉ kiểm tra env cục bộ). */
export function isS3Configured(): boolean {
  return !!(
    BUCKET
    && process.env.AWS_ACCESS_KEY_ID
    && process.env.AWS_SECRET_ACCESS_KEY
  );
}

function getClient(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      region: REGION,
      // Recent AWS SDK versions default to WHEN_SUPPORTED and can presign an
      // empty-body CRC32 for PutObject. The browser subsequently uploads a video
      // body to that URL and S3 rejects it with BadDigest. We do not require a
      // payload checksum for this presigned browser PUT.
      requestChecksumCalculation: 'WHEN_REQUIRED',
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
  if (!isS3Configured()) {
    throw Object.assign(new Error('Recording storage is not configured'), {
      code: 'S3_NOT_CONFIGURED',
    });
  }

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
