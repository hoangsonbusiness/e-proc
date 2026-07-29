// examRecorder.ts — Ghi màn hình bài thi và upload thẳng lên AWS S3.
//
// Singleton ngoài React: phải sống xuyên qua navigate từ /confirm sang /exam nên
// không dùng state của component.
//
// Luồng upload: mỗi ~5 phút cắt 1 phần video → xin presigned PUT URL từ backend →
// PUT blob THẲNG lên S3 (không qua backend → né payload/timeout Vercel). Upload lỗi
// (mạng yếu) → đưa vào retry queue, thử lại nền, KHÔNG chặn thi. Video không nằm
// trên máy thí sinh → không có bản local để lộ đề. Xóa qua S3 Lifecycle rule.

import { studentApi } from './api';

const FPS = 5;
const VIDEO_BITRATE = 600_000;             // ~600 kbps
const PART_INTERVAL_MS = 5 * 60 * 1000;    // cắt & upload 1 phần mỗi 5 phút (~22MB)
const TIMESLICE_MS = 1000;                 // ondataavailable mỗi giây
const MAX_RETRY = 5;                       // số lần thử lại tối đa cho 1 phần
const RETRY_BASE_MS = 3000;                // backoff cơ sở

interface PendingPart {
  partIndex: number;
  blob: Blob;
  attempts: number;
}

// ── State module-level ───────────────────────────────────────────────────
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunkBuffer: Blob[] = [];
let partIndex = 0;
let partTimer: ReturnType<typeof setInterval> | null = null;
let onRecordingStopped: (() => void) | null = null;
let recordingStoppedFired = false;
let active = false;

// Hàng đợi upload lỗi cần thử lại
let retryQueue: PendingPart[] = [];
let retryTimer: ReturnType<typeof setTimeout> | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Trình duyệt có đủ API để ghi hình + upload không. */
export function isSupported(): boolean {
  return (
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof fetch === 'function'
  );
}

export function isActive(): boolean {
  return active;
}

// Cho phép StudentExam đăng ký handler thật SAU khi start() (trang /exam mount sau
// bước confirm). Nếu track đã ended trước đó, gọi handler ngay để không bỏ sót.
export function setOnRecordingStopped(cb: () => void): void {
  onRecordingStopped = cb;
  if (recordingStoppedFired) cb();
}

/** Upload 1 phần lên S3: xin presigned URL rồi PUT thẳng. Trả về thành công/thất bại. */
async function uploadPart(part: PendingPart): Promise<boolean> {
  try {
    const res = await studentApi.getRecordingUploadUrl(part.partIndex, part.blob.type || 'video/webm');
    const { url } = res.data;
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': part.blob.type || 'video/webm' },
      body: part.blob,
    });
    return putRes.ok;
  } catch (err) {
    console.error('[examRecorder] uploadPart failed:', err);
    return false;
  }
}

/** Đưa 1 phần vào hàng đợi và thử upload; lỗi thì lên lịch retry nền. */
function enqueueAndUpload(part: PendingPart): void {
  void (async () => {
    const ok = await uploadPart(part);
    if (!ok) {
      part.attempts += 1;
      if (part.attempts <= MAX_RETRY) {
        retryQueue.push(part);
        scheduleRetry();
      } else {
        console.error(`[examRecorder] bỏ phần ${part.partIndex} sau ${MAX_RETRY} lần thử`);
      }
    }
  })();
}

/** Lên lịch xử lý hàng đợi retry với backoff tăng dần. */
function scheduleRetry(): void {
  if (retryTimer || retryQueue.length === 0) return;
  const next = retryQueue[0];
  const delay = RETRY_BASE_MS * Math.pow(2, Math.min(next.attempts - 1, 4)); // tối đa ~48s
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    const part = retryQueue.shift();
    if (!part) return;
    const ok = await uploadPart(part);
    if (!ok) {
      part.attempts += 1;
      if (part.attempts <= MAX_RETRY) retryQueue.push(part);
    }
    if (retryQueue.length > 0) scheduleRetry();
  }, delay);
}

/** Gộp buffer hiện tại thành 1 phần và upload; reset buffer. */
function flushPart(): void {
  if (chunkBuffer.length === 0) return;
  const blob = new Blob(chunkBuffer, { type: 'video/webm' });
  chunkBuffer = [];
  const idx = partIndex;
  partIndex += 1;
  enqueueAndUpload({ partIndex: idx, blob, attempts: 0 });
}

// ── API công khai ────────────────────────────────────────────────────────

/**
 * Xin chia sẻ TOÀN MÀN HÌNH. Trả về { ok, reason }. ok=false → KHÔNG được vào thi.
 * Gọi trong cùng user gesture của cú click (không await gì tiêu thụ gesture trước đó).
 */
export async function requestSetup(): Promise<{ ok: boolean; reason?: string }> {
  if (!isSupported()) {
    return { ok: false, reason: 'unsupported' };
  }

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: FPS, displaySurface: 'monitor' } as MediaTrackConstraints,
      audio: false,
    });
  } catch (err: any) {
    console.error('[examRecorder] getDisplayMedia failed:', err?.name, err?.message);
    return { ok: false, reason: 'no_screen' };
  }

  const track = stream.getVideoTracks()[0];
  const surface = (track.getSettings() as any).displaySurface;
  if (surface && surface !== 'monitor') {
    track.stop();
    stream = null;
    return { ok: false, reason: 'not_fullscreen' };
  }

  return { ok: true };
}

/**
 * Bắt đầu ghi. Phải gọi sau requestSetup() thành công.
 */
export function start(): void {
  if (!stream) {
    console.error('[examRecorder] start() gọi khi chưa có stream');
    return;
  }
  chunkBuffer = [];
  partIndex = 0;
  retryQueue = [];

  let mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm;codecs=vp8';
  }

  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITRATE });
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) chunkBuffer.push(ev.data);
  };
  recorder.start(TIMESLICE_MS);
  active = true;

  // Cắt & upload 1 phần mỗi 5 phút
  partTimer = setInterval(() => flushPart(), PART_INTERVAL_MS);

  // Thí sinh bấm "Stop sharing" của trình duyệt giữa bài
  recordingStoppedFired = false;
  const track = stream.getVideoTracks()[0];
  track.onended = () => {
    active = false;
    recordingStoppedFired = true;
    if (onRecordingStopped) onRecordingStopped();
  };
}

/**
 * Dừng ghi và upload nốt phần cuối. Gọi ở đầu handleSubmit (mọi đường: thủ công /
 * cheating / timeout). Idempotent. Chờ recorder flush dữ liệu còn đệm trước khi upload.
 */
export async function stopAndSave(): Promise<void> {
  if (partTimer) {
    clearInterval(partTimer);
    partTimer = null;
  }

  if (recorder && recorder.state !== 'inactive') {
    await new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
      try {
        recorder!.requestData();
      } catch { /* ignore */ }
      recorder!.stop();
    });
  }

  // Upload phần cuối và chờ (best-effort) để tăng khả năng nó lên được S3 trước khi rời trang.
  flushPart();

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  recorder = null;
  active = false;
}
