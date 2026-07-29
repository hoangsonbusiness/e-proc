// examRecorder.ts — Ghi màn hình bài thi ra file local qua File System Access API.
//
// Singleton ngoài React: phải sống xuyên qua navigate từ /confirm sang /exam nên
// không dùng state của component. Ghi thẳng từng file .webm vào một thư mục do thí
// sinh chọn 1 lần ở đầu bài — KHÔNG popup "tải nhiều file", không mất focus giữa bài.
//
// Vòng đời: requestSetup() (chọn thư mục + chia sẻ toàn màn hình) → start() →
// tự cắt file mỗi 10 phút → stopAndSave() lúc submit (flush file cuối).

const FPS = 5;
const VIDEO_BITRATE = 600_000;           // ~600 kbps
const SPLIT_INTERVAL_MS = 10 * 60 * 1000; // cắt file mỗi 10 phút (~45MB/file)
const TIMESLICE_MS = 1000;                // ondataavailable mỗi giây

interface StudentInfo {
  studentId: string;
  email: string;
}

// ── State module-level ───────────────────────────────────────────────────
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let dirHandle: any = null;              // FileSystemDirectoryHandle
let studentInfo: StudentInfo | null = null;
let chunkBuffer: Blob[] = [];
let partIndex = 0;
let sessionStamp = '';
let splitTimer: ReturnType<typeof setInterval> | null = null;
let onRecordingStopped: (() => void) | null = null;
let active = false;

// ── Helpers ──────────────────────────────────────────────────────────────

/** Trình duyệt có đủ API để ghi hình không (File System Access + getDisplayMedia + MediaRecorder). */
export function isSupported(): boolean {
  return (
    typeof (window as any).showDirectoryPicker === 'function' &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== 'undefined'
  );
}

export function isActive(): boolean {
  return active;
}

// Cho phép StudentExam đăng ký handler thật SAU khi start() (trang /exam mount sau
// bước confirm). Nếu track đã ended trước đó, gọi handler ngay để không bỏ sót.
let recordingStoppedFired = false;
export function setOnRecordingStopped(cb: () => void): void {
  onRecordingStopped = cb;
  if (recordingStoppedFired) cb();
}

function makeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Ghi buffer hiện tại thành 1 file .webm vào thư mục đã chọn, rồi reset buffer. */
async function flushPart(): Promise<void> {
  if (chunkBuffer.length === 0 || !dirHandle) return;
  const blob = new Blob(chunkBuffer, { type: 'video/webm' });
  chunkBuffer = [];
  partIndex += 1;

  const safeEmail = (studentInfo?.email || studentInfo?.studentId || 'unknown')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const name = `exam_${studentInfo?.studentId ?? 'x'}_${safeEmail}_${sessionStamp}_part${String(partIndex).padStart(2, '0')}.webm`;

  try {
    const fileHandle = await dirHandle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (err) {
    // Không để lỗi ghi file làm hỏng bài thi — chỉ log.
    console.error('[examRecorder] flushPart failed:', err);
  }
}

// ── API công khai ────────────────────────────────────────────────────────

/**
 * Xin thí sinh (1) chọn thư mục lưu video, (2) chia sẻ TOÀN MÀN HÌNH.
 * Trả về { ok, reason }. ok=false nghĩa là KHÔNG được vào thi.
 * Gọi trước khi navigate sang /exam.
 */
export async function requestSetup(): Promise<{ ok: boolean; reason?: string }> {
  if (!isSupported()) {
    return { ok: false, reason: 'unsupported' };
  }

  // 1) Chọn thư mục lưu (một lần duy nhất).
  // LƯU Ý: showDirectoryPicker() đòi "user activation" — phải được gọi trong cùng
  // chuỗi user gesture của cú click. KHÔNG được await gì tiêu thụ gesture (vd
  // requestFullscreen) trước nó, nếu không Chrome ném SecurityError và dialog không hiện.
  try {
    dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  } catch (err: any) {
    // AbortError = user tự bấm Cancel; còn lại (SecurityError…) = bị chặn do mất gesture
    console.error('[examRecorder] showDirectoryPicker failed:', err?.name, err?.message);
    return { ok: false, reason: 'no_directory' };
  }

  // 2) Chia sẻ màn hình — ép toàn màn hình
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: FPS, displaySurface: 'monitor' } as MediaTrackConstraints,
      audio: false,
    });
  } catch (err: any) {
    console.error('[examRecorder] getDisplayMedia failed:', err?.name, err?.message);
    dirHandle = null;
    return { ok: false, reason: 'no_screen' };
  }

  const track = stream.getVideoTracks()[0];
  const surface = (track.getSettings() as any).displaySurface;
  if (surface && surface !== 'monitor') {
    // Chỉ chia sẻ tab/window → không đạt yêu cầu giám sát → hủy.
    track.stop();
    stream = null;
    dirHandle = null;
    return { ok: false, reason: 'not_fullscreen' };
  }

  return { ok: true };
}

/**
 * Bắt đầu ghi. Phải gọi sau requestSetup() thành công.
 * onStopped: gọi khi thí sinh tự dừng chia sẻ giữa bài (track ended) —
 * StudentExam dùng để report violation 'recording_stopped' + khóa bài.
 */
export function start(info: StudentInfo): void {
  if (!stream) {
    console.error('[examRecorder] start() gọi khi chưa có stream');
    return;
  }
  studentInfo = info;
  chunkBuffer = [];
  partIndex = 0;
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

  // Cắt file định kỳ mỗi 10 phút
  splitTimer = setInterval(() => {
    void flushPart();
  }, SPLIT_INTERVAL_MS);

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
 * Dừng ghi và lưu nốt file cuối. Gọi ở đầu handleSubmit (mọi đường: thủ công /
 * cheating / timeout). Idempotent — gọi nhiều lần vô hại.
 */
export async function stopAndSave(): Promise<void> {
  if (splitTimer) {
    clearInterval(splitTimer);
    splitTimer = null;
  }

  if (recorder && recorder.state !== 'inactive') {
    // Chờ recorder flush hết dữ liệu còn đệm trước khi ghi file cuối.
    await new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
      try {
        recorder!.requestData();
      } catch { /* ignore */ }
      recorder!.stop();
    });
  }

  await flushPart();

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  recorder = null;
  active = false;
}
