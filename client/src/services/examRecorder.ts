// examRecorder.ts — Ghi màn hình bài thi. Hỗ trợ 2 chế độ:
//   - 's3'   : upload thẳng lên AWS S3 qua presigned PUT URL (video không nằm trên máy HV).
//   - 'local': ghi ra thư mục HV chọn, mỗi phần nén + MÃ HÓA AES-256 thành .zip. Password
//              do server sinh & giữ (HV không thấy) → dù HV commit file zip lên GitLab cũng
//              không tự mở lại được đề. Dùng File System Access API (Chrome/Edge).
//
// Singleton ngoài React: phải sống xuyên qua navigate từ /confirm sang /exam nên không
// dùng state của component.
//
// Luồng chung: mỗi ~5 phút cắt 1 phần video → (s3) xin presigned URL + PUT thẳng / (local)
// nén-mã hóa zip rồi ghi file. Upload S3 lỗi → retry queue nền, KHÔNG chặn thi.

import { studentApi } from './api';
import { ZipWriter, BlobWriter, BlobReader } from '@zip.js/zip.js';

const FPS = 5;
const VIDEO_BITRATE = 600_000;             // ~600 kbps
const PART_INTERVAL_MS = 5 * 60 * 1000;    // cắt & xử lý 1 phần mỗi 5 phút (~22MB)
const TIMESLICE_MS = 1000;                 // ondataavailable mỗi giây
const MAX_RETRY = 5;                       // số lần thử lại tối đa cho 1 phần (s3)
const RETRY_BASE_MS = 3000;                // backoff cơ sở

type RecordMode = 's3' | 'local';

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

// Cấu hình chế độ ghi (đặt khi start)
let mode: RecordMode = 's3';
let dirHandle: any = null;              // FileSystemDirectoryHandle (chỉ mode 'local')
let localPassword: string | null = null; // password mã hóa zip (chỉ mode 'local')
let sessionStamp = '';

let uploadChain: Promise<void> = Promise.resolve();

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * [#6] Chỉ cho phép Chromium desktop (Chrome/Edge). Tài liệu nói chặn Safari/Firefox
 * nhưng trước đây code chỉ kiểm tra sự tồn tại API — Firefox có getDisplayMedia nên lọt.
 * Firefox không hỗ trợ displaySurface constraint đáng tin và không có showDirectoryPicker.
 * Loại luôn mobile (không thể ghi toàn màn hình đúng nghĩa).
 */
export function isChromeOrEdgeDesktop(): boolean {
  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (isMobile) return false;

  // [P2-5] Chỉ chấp nhận ĐÍCH DANH Google Chrome hoặc Microsoft Edge. Brand "Chromium"
  // chung KHÔNG đủ — Brave/Opera/Vivaldi đều là Chromium fork và sẽ lọt nếu chỉ khớp
  // "Chromium". uaData.brands là đáng tin nhất (Brave báo brand riêng, không có "Google Chrome").
  const brands = (navigator as any).userAgentData?.brands as { brand: string }[] | undefined;
  if (brands && brands.length) {
    const names = brands.map((b) => b.brand.toLowerCase());
    // Loại các fork có brand riêng lộ diện (Brave đôi khi thêm "Brave"; Opera "Opera").
    const isFork = names.some((n) => n.includes('brave') || n.includes('opera') || n.includes('opr') || n.includes('vivaldi'));
    if (isFork) return false;
    return names.some((n) => n.includes('google chrome') || n.includes('microsoft edge'));
  }

  // Fallback UA (trình duyệt không hỗ trợ userAgentData): loại fork lộ diện trong UA,
  // rồi yêu cầu chuỗi "Chrome/" (Chrome) hoặc "Edg/" (Edge). Không hoàn hảo — UA có thể
  // spoof — nhưng đây chỉ là client-side signal, không phải bảo đảm (xem ghi chú dưới).
  const isFork = /(Brave|OPR\/|Opera|Vivaldi|SamsungBrowser|YaBrowser)/i.test(ua);
  if (isFork) return false;
  const isFirefox = /Firefox\//.test(ua);
  const isChromeOrEdge = /Edg\//.test(ua) || /Chrome\//.test(ua);
  return isChromeOrEdge && !isFirefox;
}

/** Trình duyệt có đủ API để ghi hình cho mode tương ứng không. */
export function isSupported(forMode: RecordMode = 's3'): boolean {
  // [#6][P2-5] Bắt buộc Chrome/Edge desktop — không chỉ dựa vào sự tồn tại của API,
  // và không chấp nhận Chromium fork (Brave/Opera/Vivaldi).
  if (!isChromeOrEdgeDesktop()) return false;
  const base =
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined' &&
    typeof fetch === 'function';
  if (forMode === 'local') {
    return base && typeof (window as any).showDirectoryPicker === 'function';
  }
  return base;
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

function makeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ── Mode S3: upload phần ───────────────────────────────────────────────────

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
    if (!putRes.ok) return false;
    await studentApi.completeRecordingPart(part.partIndex, part.blob.size);
    return true;
  } catch (err) {
    console.error('[examRecorder] uploadPart failed:', err);
    return false;
  }
}

// ── Mode Local: nén + mã hóa AES rồi ghi file .zip ─────────────────────────

/**
 * Nén blob .webm thành .zip mã hóa AES-256 (password server cấp) rồi ghi vào thư mục
 * HV đã chọn. Không nén thêm (level 0) vì webm đã nén sẵn — chỉ tốn CPU vô ích.
 */
async function saveLocalPart(partIdx: number, blob: Blob): Promise<void> {
  if (!dirHandle || !localPassword) {
    console.error('[examRecorder] saveLocalPart: thiếu dirHandle/password');
    return;
  }
  const part = String(partIdx).padStart(3, '0');
  const webmName = `exam_${sessionStamp}_part${part}.webm`;
  const zipName = `exam_${sessionStamp}_part${part}.zip`;

  try {
    // Tạo zip mã hóa AES-256 chứa 1 file .webm
    const zipWriter = new ZipWriter(new BlobWriter('application/zip'), {
      password: localPassword,
      encryptionStrength: 3, // AES-256
      level: 0,              // webm đã nén → không nén lại
    });
    await zipWriter.add(webmName, new BlobReader(blob));
    const zipBlob = await zipWriter.close();

    // Ghi file .zip vào thư mục
    const fileHandle = await dirHandle.getFileHandle(zipName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(zipBlob);
    await writable.close();
  } catch (err) {
    // Không để lỗi ghi/nén làm hỏng bài thi — chỉ log.
    console.error('[examRecorder] saveLocalPart failed:', err);
  }
}

// ── Cắt phần & định tuyến theo mode ────────────────────────────────────────

/** Gộp buffer hiện tại thành 1 phần và xử lý (s3 upload / local zip); reset buffer. */
async function flushPart(): Promise<void> {
  if (chunkBuffer.length === 0) return;
  const blob = new Blob(chunkBuffer, { type: 'video/webm' });
  chunkBuffer = [];
  const idx = partIndex;
  partIndex += 1;

  if (mode === 'local') {
    await saveLocalPart(idx, blob);
  } else {
    const pending = { partIndex: idx, blob, attempts: 0 };
    let uploaded = false;
    for (let attempt = 0; attempt <= MAX_RETRY && !uploaded; attempt++) {
      uploaded = await uploadPart(pending);
      if (!uploaded && attempt < MAX_RETRY) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * Math.pow(2, Math.min(attempt, 4))));
      }
    }
    if (!uploaded) throw new Error(`Recording part ${idx} failed to upload`);
  }
}

// ── API công khai ────────────────────────────────────────────────────────

/**
 * Chuẩn bị ghi. Với mode 'local' cũng xin HV chọn thư mục lưu.
 * Trả về { ok, reason }. ok=false → KHÔNG được vào thi.
 * Gọi trong cùng user gesture của cú click (không await gì tiêu thụ gesture trước đó).
 */
export async function requestSetup(forMode: RecordMode = 's3'): Promise<{ ok: boolean; reason?: string }> {
  if (!isSupported(forMode)) {
    return { ok: false, reason: 'unsupported' };
  }

  // Mode local: chọn thư mục lưu TRƯỚC (còn gesture). getDisplayMedia gọi sau vẫn trong gesture.
  if (forMode === 'local') {
    try {
      dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    } catch {
      return { ok: false, reason: 'no_directory' };
    }
  }

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: FPS, displaySurface: 'monitor' } as MediaTrackConstraints,
      audio: false,
    });
  } catch (err: any) {
    console.error('[examRecorder] getDisplayMedia failed:', err?.name, err?.message);
    dirHandle = forMode === 'local' ? null : dirHandle;
    return { ok: false, reason: 'no_screen' };
  }

  const track = stream.getVideoTracks()[0];
  const surface = (track.getSettings() as any).displaySurface;
  // [#6] Fail-closed: chỉ chấp nhận đúng 'monitor'. Trước đây `surface && surface !== 'monitor'`
  // cho lọt khi displaySurface undefined (một số cấu hình/trình duyệt không báo cáo field này),
  // nghĩa là HV chia sẻ tab/cửa sổ vẫn vào thi được. Giờ thiếu/không phải monitor đều bị chặn.
  if (surface !== 'monitor') {
    track.stop();
    stream = null;
    dirHandle = forMode === 'local' ? null : dirHandle;
    return { ok: false, reason: 'not_fullscreen' };
  }

  return { ok: true };
}

/**
 * Bắt đầu ghi. Phải gọi sau requestSetup() thành công.
 * opts.mode: 's3' | 'local'; opts.password: bắt buộc khi 'local'.
 */
export function start(opts?: { mode?: RecordMode; password?: string | null }): void {
  if (!stream) {
    console.error('[examRecorder] start() gọi khi chưa có stream');
    return;
  }
  mode = opts?.mode || 's3';
  localPassword = opts?.password || null;
  if (mode === 'local' && !localPassword) {
    console.error('[examRecorder] start() mode=local nhưng thiếu password');
  }

  chunkBuffer = [];
  partIndex = 0;
  uploadChain = Promise.resolve();
  sessionStamp = makeStamp();

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

  // Cắt & xử lý 1 phần mỗi 5 phút
  partTimer = setInterval(() => {
    uploadChain = uploadChain.then(() => flushPart());
  }, PART_INTERVAL_MS);

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
 * Dừng ghi và xử lý nốt phần cuối. Gọi ở đầu handleSubmit (mọi đường: thủ công /
 * cheating / timeout). Idempotent. Chờ recorder flush dữ liệu còn đệm trước khi xử lý.
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

  // Xử lý phần cuối. Mode local: await để đảm bảo file zip cuối được ghi xong trước khi rời trang.
  if (mode === 'local') {
    if (chunkBuffer.length > 0) {
      const blob = new Blob(chunkBuffer, { type: 'video/webm' });
      chunkBuffer = [];
      const idx = partIndex;
      partIndex += 1;
      await saveLocalPart(idx, blob);
    }
  } else {
    await uploadChain;
    await flushPart();
    if (partIndex > 0) await studentApi.finalizeRecording(partIndex - 1);
  }

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  recorder = null;
  active = false;
}
