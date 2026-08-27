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

import {
  studentApi,
  type RecordingSealResponse,
  type RecordingStatusResponse,
} from './api';
import { ZipWriter, BlobWriter, BlobReader } from '@zip.js/zip.js';

const FPS = 5;
const VIDEO_BITRATE = 600_000;             // ~600 kbps
const PART_INTERVAL_MS = 5 * 60 * 1000;    // cắt & xử lý 1 phần mỗi 5 phút (~22MB)
const TIMESLICE_MS = 1000;                 // ondataavailable mỗi giây
const MAX_ATTEMPTS = 5;                    // tổng số lần thử tối đa cho mỗi stage S3
const RETRY_BASE_MS = 3000;                // backoff cơ sở
// Axios aborts recording control calls at 20s; this outer guard is a final safety
// net for test doubles or alternate clients that ignore Axios' timeout.
const API_STAGE_TIMEOUT_MS = 25_000;       // presign / complete / finalize safety net
const S3_PUT_TIMEOUT_MS = 120_000;         // một part có thể ~22MB trên mạng chậm
const RECORDER_STOP_TIMEOUT_MS = 10_000;   // browser phải phát dataavailable + stop

type RecordMode = 's3' | 'local';
type RecordingFailureStage = 'capture' | 'seal' | 'presign' | 'upload' | 'complete' | 'local-save' | 'finalize';
type RecorderLifecycle =
  | 'idle'
  | 'ready'
  | 'capturing'
  | 'interrupted'
  | 'stopping'
  | 'discarding'
  | 'finalizing'
  | 'failed'
  | 'finalized';

interface PendingPart {
  partIndex: number;
  uploadId: string;
  blob: Blob;
  reservationPromise?: Promise<void>;
  serverCompleted?: boolean;
}

interface BufferedPartIdentity {
  partIndex: number;
  uploadId: string;
  reservationPromise?: Promise<void>;
  serverCompleted?: boolean;
}

interface UploadTarget {
  alreadyComplete: boolean;
  partIndex: number;
  url?: string;
}

class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

class RecordingFinalizationError extends Error {
  readonly stage: RecordingFailureStage;
  readonly partIndex?: number;
  readonly retryable: boolean;

  constructor(stage: RecordingFailureStage, cause: unknown, partIndex?: number, retryable = true) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Recording ${stage}${partIndex === undefined ? '' : ` for part ${partIndex}`} failed: ${detail}`);
    this.name = 'RecordingFinalizationError';
    this.stage = stage;
    this.partIndex = partIndex;
    this.retryable = retryable;
  }
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
let lifecycle: RecorderLifecycle = 'idle';
let captureReadyForFinalization = false;
let capturedAnyPartThisSession = false;
let lastFailureRetryable = false;

// Cấu hình chế độ ghi (đặt khi start)
let mode: RecordMode = 's3';
let dirHandle: any = null;              // FileSystemDirectoryHandle (chỉ mode 'local')
let localPassword: string | null = null; // password mã hóa zip (chỉ mode 'local')
let sessionStamp = '';

// Key by the stable logical upload identity rather than the mutable server-assigned
// part index. This lets the backend safely move a resumed part when an older request
// won the same index without losing the new blob.
let pendingParts = new Map<string, PendingPart>();
// Kept after successful uploads so the final seal contains every logical blob
// captured by this browser session, not only blobs that are still pending I/O.
let manifestParts = new Map<string, number>();
// Reserve the logical identity at the beginning of a recording interval, not
// only after its blob reaches the serial upload queue. If the page reloads while
// a prior PUT is slow, the backend still knows that this interval must exist and
// cannot silently finalize a truncated manifest.
let bufferedPartIdentity: BufferedPartIdentity | null = null;
let reservationTrackingActive = false;
let uploadChain: Promise<void> = Promise.resolve();
let finalizationPromise: Promise<void> | null = null;
let discardPromise: Promise<void> | null = null;
// Short handoff barrier used only by /exam before SPA navigation. It always
// resolves (including capture/seal failure) so terminal submission can never be
// trapped on the exam page; the full finalization Promise retains the error.
let submitHandoffPromise: Promise<void> | null = null;
let resolveSubmitHandoff: (() => void) | null = null;

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

/**
 * Reconcile the next part cursor returned by the backend after /exam loads.
 * Safe while the current chunk is still only buffered; never re-index a part
 * that has already entered the pending/upload queue.
 */
export function setNextPartIndex(nextPartIndex: number): boolean {
  if (!Number.isInteger(nextPartIndex) || nextPartIndex < 0) return false;
  if (
    !['idle', 'ready', 'capturing'].includes(lifecycle)
    || pendingParts.size > 0
    || capturedAnyPartThisSession
    || reservationTrackingActive
    || bufferedPartIdentity?.reservationPromise
  ) return false;
  // The backend cursor is authoritative and may intentionally point to a lower
  // historical gap (for example completed parts 0 and 2 -> cursor 1). No blob has
  // entered the queue yet, so replacing the provisional /confirm cursor is safe.
  if (bufferedPartIdentity) {
    manifestParts.delete(bufferedPartIdentity.uploadId);
    bufferedPartIdentity.partIndex = nextPartIndex;
    manifestParts.set(bufferedPartIdentity.uploadId, nextPartIndex);
    partIndex = nextPartIndex + 1;
  } else {
    partIndex = nextPartIndex;
  }
  return true;
}

/**
 * Called only after the backend confirms this attempt is in progress. From that
 * point, reserve the currently recording interval immediately and do the same
 * for every later interval, independently from the serial blob upload queue.
 */
export function activateS3ReservationTracking(): void {
  if (mode !== 's3' || !['capturing', 'interrupted'].includes(lifecycle)) return;
  reservationTrackingActive = true;
  if (bufferedPartIdentity) startEarlyReservation(bufferedPartIdentity);
  for (const part of pendingParts.values()) startEarlyReservation(part);
}

// Cho phép StudentExam đăng ký handler thật SAU khi start() (trang /exam mount sau
// bước confirm). Nếu track đã ended trước đó, gọi handler ngay để không bỏ sót.
export function setOnRecordingStopped(cb: (() => void) | null): () => void {
  onRecordingStopped = cb;
  if (cb && recordingStoppedFired) cb();

  // React effect cleanup: callback cũ không được sống tiếp trên trang /submit.
  return () => {
    if (onRecordingStopped === cb) onRecordingStopped = null;
  };
}

function makeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function beginSubmitHandoff(): void {
  if (submitHandoffPromise) return;
  submitHandoffPromise = new Promise<void>((resolve) => {
    resolveSubmitHandoff = resolve;
  });
}

function settleSubmitHandoff(): void {
  const resolve = resolveSubmitHandoff;
  resolveSubmitHandoff = null;
  resolve?.();
}

function createUploadId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

function getHttpStatus(error: unknown): number | undefined {
  if (error instanceof HttpStatusError) return error.status;
  const responseStatus = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

function isRetryable(error: unknown): boolean {
  const explicit = (error as { retryable?: unknown } | null)?.retryable;
  if (typeof explicit === 'boolean') return explicit;
  const status = getHttpStatus(error);
  if (status === undefined) return true; // timeout, offline, DNS, browser/network error
  if (status === 409) {
    const reason = (error as { response?: { data?: { reason?: unknown } } } | null)
      ?.response?.data?.reason;
    if (
      reason === 'manifest_conflict'
      || reason === 'not_in_progress'
      || reason === 'recording_incomplete'
      || reason === 'reservation_not_found'
      || reason === 'recording_reservation_conflict'
      || reason === 'recording_part_limit'
    ) return false;
    return true;
  }
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isRetryableFinalizationFailure(error: unknown): boolean {
  return isRetryable(error);
}

function isAlreadyCompleteError(error: unknown): boolean {
  const candidate = error as {
    response?: { data?: { alreadyComplete?: unknown; uploadId?: unknown } };
  };
  return candidate?.response?.data?.alreadyComplete === true
    && typeof candidate.response.data.uploadId === 'string';
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Recording ${stage} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function asFinalizationError(
  stage: RecordingFailureStage,
  error: unknown,
  partIndex?: number,
  retryable = isRetryable(error),
): RecordingFinalizationError {
  if (error instanceof RecordingFinalizationError) return error;
  return new RecordingFinalizationError(stage, error, partIndex, retryable);
}

async function retryStage<T>(
  stage: RecordingFailureStage,
  partIndex: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) break;
      await sleep(RETRY_BASE_MS * Math.pow(2, Math.min(attempt - 1, 4)));
    }
  }

  // An expired/invalid presigned URL cannot be repaired by retrying the same URL,
  // but a manual whole-pipeline retry can request a fresh URL and recover safely.
  const status = getHttpStatus(lastError);
  const wholePipelineRetryable = stage === 'upload' && (status === 403 || status === 404)
    ? true
    : isRetryable(lastError);
  throw asFinalizationError(stage, lastError, partIndex, wholePipelineRetryable);
}

// ── Mode S3: upload phần ───────────────────────────────────────────────────

async function requestUploadTarget(
  part: Pick<PendingPart, 'partIndex' | 'uploadId'> & { blob?: Blob },
): Promise<UploadTarget> {
  try {
    const res = await withTimeout(
      studentApi.getRecordingUploadUrl(part.partIndex, part.blob?.type || 'video/webm', part.uploadId),
      API_STAGE_TIMEOUT_MS,
      `part ${part.partIndex} presign`,
    );
    const data = res.data as {
      url?: unknown;
      partIndex?: unknown;
      uploadId?: unknown;
      alreadyComplete?: unknown;
      completed?: unknown;
    };
    const assignedPartIndex = data?.partIndex === undefined
      ? part.partIndex
      : Number(data.partIndex);
    if (!Number.isInteger(assignedPartIndex) || assignedPartIndex < 0) {
      throw new Error('Recording presign response contained an invalid assigned part index');
    }
    if (data.uploadId !== part.uploadId) {
      throw Object.assign(
        new Error('Recording reservation identity did not match the requested upload'),
        { retryable: true },
      );
    }
    part.partIndex = assignedPartIndex;
    manifestParts.set(part.uploadId, assignedPartIndex);
    partIndex = Math.max(partIndex, assignedPartIndex + 1);
    // `already` only means that the reservation itself was replayed. The blob
    // may still need PUT + completion after a lost presign response, so skip it
    // exclusively when the backend confirms completed evidence.
    if (data?.alreadyComplete === true || data?.completed === true) {
      return { alreadyComplete: true, partIndex: assignedPartIndex };
    }
    if (typeof data?.url !== 'string' || !data.url) {
      throw new Error(`Recording part ${part.partIndex} presign response did not contain a URL`);
    }
    return { alreadyComplete: false, partIndex: assignedPartIndex, url: data.url };
  } catch (error) {
    // Backward-compatible replay response from a server deployed before the
    // structured `alreadyComplete` body. The stable uploadId still identifies
    // this exact logical blob on current servers.
    const responseUploadId = (error as {
      response?: { data?: { uploadId?: unknown } };
    } | null)?.response?.data?.uploadId;
    if (isAlreadyCompleteError(error) && responseUploadId === part.uploadId) {
      return { alreadyComplete: true, partIndex: part.partIndex };
    }
    throw error;
  }
}

async function putPart(url: string, part: PendingPart): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), S3_PUT_TIMEOUT_MS);
  try {
    const putRes = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': part.blob.type || 'video/webm' },
      body: part.blob,
      signal: controller.signal,
    });
    if (!putRes.ok) {
      throw new HttpStatusError(`S3 PUT returned HTTP ${putRes.status}`, putRes.status);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Recording part ${part.partIndex} S3 PUT timed out after ${S3_PUT_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateCompletionResponse(part: PendingPart, completion: unknown): void {
  const data = (completion as {
    data?: { success?: unknown; uploadId?: unknown; partIndex?: unknown };
  } | null)?.data;
  if (
    data?.success !== true
    || data.uploadId !== part.uploadId
    || Number(data.partIndex) !== part.partIndex
  ) {
    throw Object.assign(
      new Error('Recording completion identity could not be confirmed'),
      { retryable: true },
    );
  }
}

async function confirmPartCompletion(part: PendingPart): Promise<void> {
  const completion = await withTimeout(
    studentApi.completeRecordingPart(part.partIndex, part.blob.size, part.uploadId),
    API_STAGE_TIMEOUT_MS,
    `part ${part.partIndex} completion`,
  );
  validateCompletionResponse(part, completion);
}

/** Upload một part theo các stage độc lập. Blob chỉ được bỏ sau complete thành công. */
async function uploadPart(part: PendingPart): Promise<void> {
  // A best-effort early reservation starts as soon as the backend confirms the
  // exam is in progress. It deliberately discards its presigned URL; the actual
  // upload asks for a fresh URL so a queued 5-minute part cannot inherit an
  // expired signature.
  await part.reservationPromise;
  if (part.serverCompleted) return;

  const target = await retryStage('presign', part.partIndex, () => requestUploadTarget(part));
  if (target.alreadyComplete) return;

  const url = target.url;
  if (!url) throw new Error(`Recording part ${part.partIndex} has no upload URL`);
  let confirmedDuringAmbiguousPut = false;
  await retryStage('upload', part.partIndex, async () => {
    try {
      await putPart(url, part);
    } catch (uploadError) {
      // Probe after every ambiguous PUT failure, before uploading the same 22 MB
      // blob again. HeadObject through the authenticated completion endpoint is
      // the authority when S3 stored the body but the browser lost the response.
      try {
        await confirmPartCompletion(part);
        confirmedDuringAmbiguousPut = true;
        return;
      } catch {
        throw uploadError;
      }
    }
  });
  if (confirmedDuringAmbiguousPut) return;
  await retryStage('complete', part.partIndex, () => confirmPartCompletion(part));
}

function normalizeRecordingStatus(data: unknown): RecordingStatusResponse {
  const candidate = data as Partial<RecordingStatusResponse> | null;
  const validStates = new Set([
    'not_required',
    'awaiting_seal',
    'processing',
    'finalized',
    'incomplete',
  ]);
  const expectedPartCount = Number(candidate?.expectedPartCount);
  const completedPartCount = Number(candidate?.completedPartCount);
  if (
    !candidate
    || !validStates.has(String(candidate.state))
    || !['none', 'local', 's3'].includes(String(candidate.recordMode))
    || !Number.isInteger(expectedPartCount)
    || expectedPartCount < 0
    || !Number.isInteger(completedPartCount)
    || completedPartCount < 0
    // Before sealing, expectedPartCount is intentionally unknown (0) while
    // already-uploaded periodic parts may still be reported as completed.
    || (expectedPartCount > 0 && completedPartCount > expectedPartCount)
  ) {
    throw Object.assign(new Error('Recording status response was invalid'), { retryable: true });
  }
  const finalPartIndex = candidate.finalPartIndex === undefined
    ? undefined
    : Number(candidate.finalPartIndex);
  if (finalPartIndex !== undefined && (!Number.isInteger(finalPartIndex) || finalPartIndex < 0)) {
    throw Object.assign(new Error('Recording status final part index was invalid'), { retryable: true });
  }
  return {
    state: candidate.state as RecordingStatusResponse['state'],
    recordMode: candidate.recordMode as RecordingStatusResponse['recordMode'],
    expectedPartCount,
    completedPartCount,
    ...(finalPartIndex === undefined ? {} : { finalPartIndex }),
  };
}

async function sealRecordingManifest(): Promise<RecordingStatusResponse> {
  const requestedParts = [...manifestParts.entries()]
    .map(([uploadId, requestedPartIndex]) => ({ uploadId, partIndex: requestedPartIndex }))
    .sort((a, b) => a.partIndex - b.partIndex);
  if (requestedParts.length === 0) {
    throw Object.assign(new Error('Recording manifest contains no captured parts'), { retryable: false });
  }

  let firstAttemptSettled = false;
  const response = await retryStage('seal', undefined, async () => {
    try {
      return await withTimeout(
        studentApi.sealRecordingManifest(requestedParts),
        API_STAGE_TIMEOUT_MS,
        'manifest seal',
      );
    } finally {
      // `/exam` only waits for one bounded seal attempt. If it fails transiently,
      // the same finalization Promise keeps retrying on `/submit` while the user
      // can see recovery progress instead of an apparently hung submit screen.
      if (!firstAttemptSettled) {
        firstAttemptSettled = true;
        settleSubmitHandoff();
      }
    }
  });
  const data = response?.data as RecordingSealResponse | undefined;
  if (data?.success !== true || !Array.isArray(data.parts)) {
    throw Object.assign(new Error('Recording seal response was invalid'), { retryable: true });
  }
  const status = normalizeRecordingStatus(data);
  if (status.recordMode !== 's3' || !['processing', 'finalized'].includes(status.state)) {
    throw Object.assign(new Error('Recording seal returned an invalid S3 state'), { retryable: true });
  }

  const returnedByUploadId = new Map<string, { partIndex: number; completed: boolean }>();
  for (const assignment of data.parts) {
    if (
      !assignment
      || typeof assignment.uploadId !== 'string'
      || !Number.isInteger(Number(assignment.partIndex))
      || Number(assignment.partIndex) < 0
      || typeof assignment.completed !== 'boolean'
      || returnedByUploadId.has(assignment.uploadId)
    ) {
      throw Object.assign(new Error('Recording seal assignments were invalid'), { retryable: true });
    }
    returnedByUploadId.set(assignment.uploadId, {
      partIndex: Number(assignment.partIndex),
      completed: assignment.completed,
    });
  }

  for (const requested of requestedParts) {
    const assignment = returnedByUploadId.get(requested.uploadId);
    if (!assignment) {
      throw Object.assign(new Error('Recording seal omitted a requested upload'), { retryable: true });
    }
    manifestParts.set(requested.uploadId, assignment.partIndex);
    partIndex = Math.max(partIndex, assignment.partIndex + 1);
    const pending = pendingParts.get(requested.uploadId);
    if (pending) pending.partIndex = assignment.partIndex;
    if (assignment.completed) pendingParts.delete(requested.uploadId);
  }

  if (status.state === 'finalized' && pendingParts.size > 0) {
    throw Object.assign(
      new Error('Finalized recording still contained unacknowledged browser parts'),
      { retryable: true },
    );
  }
  return status;
}

/**
 * Recover server truth after a lost browser Promise/response. A non-terminal
 * state is always reconciled through S3 HeadObject and then read back once more
 * before the UI may classify the recording as incomplete.
 */
export async function recoverRecordingFinalization(): Promise<RecordingStatusResponse> {
  const initial = normalizeRecordingStatus((await withTimeout(
    studentApi.getRecordingStatus(),
    API_STAGE_TIMEOUT_MS,
    'status check',
  )).data);
  if (initial.state === 'finalized' || initial.state === 'not_required') return initial;

  await withTimeout(
    studentApi.reconcileRecording(),
    API_STAGE_TIMEOUT_MS,
    'reconciliation',
  );
  return normalizeRecordingStatus((await withTimeout(
    studentApi.getRecordingStatus(),
    API_STAGE_TIMEOUT_MS,
    'status confirmation',
  )).data);
}

// ── Mode Local: nén + mã hóa AES rồi ghi file .zip ─────────────────────────

/**
 * Nén blob .webm thành .zip mã hóa AES-256 (password server cấp) rồi ghi vào thư mục
 * HV đã chọn. Không nén thêm (level 0) vì webm đã nén sẵn — chỉ tốn CPU vô ích.
 */
async function saveLocalPart(partIdx: number, blob: Blob): Promise<void> {
  if (!dirHandle || !localPassword) {
    throw Object.assign(
      new Error('Recording folder or encryption password is unavailable'),
      { retryable: false },
    );
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
    console.error('[examRecorder] saveLocalPart failed:', err);
    throw err;
  }
}

// ── Cắt phần & định tuyến theo mode ────────────────────────────────────────

function beginBufferedPartIdentity(): BufferedPartIdentity {
  if (bufferedPartIdentity) return bufferedPartIdentity;
  const identity: BufferedPartIdentity = {
    partIndex,
    uploadId: createUploadId(),
  };
  partIndex += 1;
  bufferedPartIdentity = identity;
  manifestParts.set(identity.uploadId, identity.partIndex);
  startEarlyReservation(identity);
  return identity;
}

function startEarlyReservation(part: BufferedPartIdentity | PendingPart): void {
  if (mode !== 's3' || !reservationTrackingActive || part.reservationPromise) return;
  part.reservationPromise = requestUploadTarget(part)
    .then((target) => {
      part.serverCompleted = target.alreadyComplete;
    })
    .catch((error) => {
      // Best effort only: submit-time seal and the normal presign stage remain
      // authoritative retries. Keeping this Promise resolved avoids blocking the
      // upload queue after a transient early-reservation failure.
      console.error('[examRecorder] early recording reservation failed; will retry later:', error);
    });
}

/** Snapshot đồng bộ để ranh giới part không bị lệch theo thời gian upload. */
function captureBufferedPart(): PendingPart | null {
  if (chunkBuffer.length === 0) return null;
  const blob = new Blob(chunkBuffer, { type: 'video/webm' });
  chunkBuffer = [];
  const identity = beginBufferedPartIdentity();
  // Preserve the same object identity used by an in-flight early reservation so
  // a server-assigned index/completion result cannot land on a stale copy.
  const part = Object.assign(identity, { blob }) as PendingPart;
  bufferedPartIdentity = null;
  pendingParts.set(part.uploadId, part);
  capturedAnyPartThisSession = true;
  return part;
}

/** Drain tuần tự; part chỉ bị xóa sau khi S3/backend hoặc local filesystem xác nhận. */
async function processPendingParts(): Promise<void> {
  const parts = [...pendingParts.values()].sort((a, b) => a.partIndex - b.partIndex);
  for (const part of parts) {
    // Một drain khác không chạy song song, nhưng part có thể đã được xử lý bởi lần retry trước.
    if (!pendingParts.has(part.uploadId)) continue;
    if (mode === 'local') {
      try {
        await saveLocalPart(part.partIndex, part.blob);
      } catch (error) {
        throw asFinalizationError('local-save', error, part.partIndex);
      }
    } else {
      await uploadPart(part);
    }
    pendingParts.delete(part.uploadId);
  }
}

/** Background queue luôn phục hồi sau reject; blob lỗi vẫn nằm trong pendingParts. */
function queuePendingProcessing(): void {
  uploadChain = uploadChain
    .then(() => processPendingParts())
    .catch((error) => {
      console.error('[examRecorder] background part processing failed; retained for retry:', error);
    });
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
      lifecycle = 'idle';
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
    lifecycle = 'idle';
    return { ok: false, reason: 'no_screen' };
  }

  const track = stream.getVideoTracks()[0];
  const surface = (track.getSettings() as any).displaySurface;
  // [#6] Fail-closed: chỉ chấp nhận đúng 'monitor'. Trước đây `surface && surface !== 'monitor'`
  // cho lọt khi displaySurface undefined (một số cấu hình/trình duyệt không báo cáo field này),
  // nghĩa là HV chia sẻ tab/cửa sổ vẫn vào thi được. Giờ thiếu/không phải monitor đều bị chặn.
  if (surface !== 'monitor') {
    stream.getTracks().forEach((candidate) => candidate.stop());
    stream = null;
    dirHandle = forMode === 'local' ? null : dirHandle;
    lifecycle = 'idle';
    return { ok: false, reason: 'not_fullscreen' };
  }

  lifecycle = 'ready';
  active = false;
  return { ok: true };
}

/**
 * Bắt đầu ghi. Phải gọi sau requestSetup() thành công.
 * opts.mode: 's3' | 'local'; opts.password: bắt buộc khi 'local'.
 */
export function start(opts?: {
  mode?: RecordMode;
  password?: string | null;
  initialPartIndex?: number;
}): void {
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
  partIndex = Number.isInteger(opts?.initialPartIndex) && Number(opts?.initialPartIndex) >= 0
    ? Number(opts?.initialPartIndex)
    : 0;
  pendingParts = new Map<string, PendingPart>();
  manifestParts = new Map<string, number>();
  bufferedPartIdentity = null;
  reservationTrackingActive = false;
  uploadChain = Promise.resolve();
  finalizationPromise = null;
  discardPromise = null;
  submitHandoffPromise = null;
  resolveSubmitHandoff = null;
  captureReadyForFinalization = false;
  capturedAnyPartThisSession = false;
  lastFailureRetryable = false;
  recordingStoppedFired = false;
  sessionStamp = makeStamp();

  let mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm;codecs=vp8';
  }

  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: VIDEO_BITRATE });
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data && ev.data.size > 0) {
      beginBufferedPartIdentity();
      chunkBuffer.push(ev.data);
    }
  };
  recorder.start(TIMESLICE_MS);
  active = true;
  lifecycle = 'capturing';

  // Cắt & xử lý 1 phần mỗi 5 phút
  partTimer = setInterval(() => {
    captureBufferedPart();
    queuePendingProcessing();
  }, PART_INTERVAL_MS);

  // Thí sinh bấm "Stop sharing" của trình duyệt giữa bài
  const track = stream.getVideoTracks()[0];
  track.onended = () => {
    // stopAndSave/stopAndDiscard đặt lifecycle đồng bộ trước track.stop(). Kể cả browser
    // fixture phát `ended` cho programmatic stop, đây vẫn không phải vi phạm.
    if (lifecycle !== 'capturing') return;
    active = false;
    lifecycle = 'interrupted';
    recordingStoppedFired = true;
    if (onRecordingStopped) onRecordingStopped();
  };
}

function clearPartTimer(): void {
  if (partTimer) {
    clearInterval(partTimer);
    partTimer = null;
  }
}

/** Chờ final dataavailable + stop của MediaRecorder, không thực hiện filesystem/network I/O. */
async function stopMediaRecorder(): Promise<void> {
  const current = recorder;
  if (!current || current.state === 'inactive') return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      current.onstop = null;
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(
      () => finish(new Error(`MediaRecorder did not stop within ${RECORDER_STOP_TIMEOUT_MS}ms`)),
      RECORDER_STOP_TIMEOUT_MS,
    );

    current.onstop = () => finish();
    try {
      // requestData bảo đảm chunk ngay trước submit được đưa vào ondataavailable.
      try {
        current.requestData();
      } catch {
        // Một số browser tự flush trong stop(); vẫn tiếp tục để nhận event stop.
      }
      current.stop();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Tách callback rồi đóng browser sharing. Không await bất kỳ S3/local I/O nào ở đây. */
function releaseCapture(): void {
  const currentStream = stream;
  stream = null;
  active = false;

  if (currentStream) {
    currentStream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
  }
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
  }
  recorder = null;
}

async function performEvidenceFinalization(): Promise<void> {
  if (!captureReadyForFinalization) {
    throw new Error('Recording capture is not ready for finalization');
  }

  lifecycle = 'finalizing';
  lastFailureRetryable = false;
  try {
    if (mode === 's3') {
      // Seal only after stopMediaRecorder captured the final bytes. The backend
      // atomically assigns every uploadId before the final pending blobs upload,
      // so finalize can never infer a truncated manifest from “highest part”.
      const sealed = await sealRecordingManifest();
      if (sealed.state === 'finalized') {
        lifecycle = 'finalized';
        lastFailureRetryable = false;
        return;
      }
    }

    // Background chain luôn resolve sau khi log lỗi; pendingParts là source of truth.
    await uploadChain;
    await processPendingParts();

    if (mode === 's3') {
      // Same-manifest finalize là idempotent nên retry tự động an toàn. Không re-upload
      // part đã complete vì chúng đã được xóa khỏi pendingParts.
      await retryStage('finalize', undefined, () =>
        withTimeout(
          studentApi.finalizeRecording(),
          API_STAGE_TIMEOUT_MS,
          'manifest finalization',
        )
      );
    }

    lifecycle = 'finalized';
    lastFailureRetryable = false;
    dirHandle = null;
    localPassword = null;
  } catch (error) {
    lifecycle = 'failed';
    lastFailureRetryable = isRetryable(error);
    throw error;
  }
}

/**
 * Dừng capture sau khi answers đã commit. Final chunk được snapshot rồi browser sharing được
 * đóng TRƯỚC khi chờ upload/zip/finalize. Idempotent xuyên suốt trang /exam -> /submit.
 */
async function performStopAndSave(): Promise<void> {
  const hadCaptureSession = recorder !== null
    && (lifecycle === 'capturing' || lifecycle === 'interrupted');
  lifecycle = 'stopping';
  clearPartTimer();

  if (!hadCaptureSession) {
    releaseCapture();
    settleSubmitHandoff();
    lifecycle = 'failed';
    captureReadyForFinalization = false;
    lastFailureRetryable = false;
    throw asFinalizationError(
      'capture',
      new Error('No active recording capture exists to finalize'),
      undefined,
      false,
    );
  }

  let captureError: unknown = null;
  try {
    await stopMediaRecorder();
  } catch (error) {
    captureError = error;
  } finally {
    // stop event diễn ra sau final dataavailable. Snapshot trước khi detach recorder,
    // nhưng luôn release track kể cả browser không phát stop và timeout.
    try {
      captureBufferedPart();
    } catch (error) {
      captureError = captureError || error;
    } finally {
      releaseCapture();
    }
  }

  if (!captureError && !capturedAnyPartThisSession) {
    captureError = new Error('MediaRecorder produced no recording data');
  }

  if (captureError) {
    settleSubmitHandoff();
    lifecycle = 'failed';
    captureReadyForFinalization = false;
    capturedAnyPartThisSession = false;
    lastFailureRetryable = false;
    throw asFinalizationError('capture', captureError, undefined, false);
  }
  captureReadyForFinalization = true;
  // Local mode has no server manifest. Once browser sharing is released, SPA
  // navigation is safe while encrypted ZIP I/O continues on /submit.
  if (mode === 'local') settleSubmitHandoff();
  await performEvidenceFinalization();
}

export function stopAndSave(): Promise<void> {
  if (!finalizationPromise) {
    beginSubmitHandoff();
    finalizationPromise = performStopAndSave();
  }
  return finalizationPromise;
}

/** Retry phần I/O/finalize với các blob còn giữ trong RAM; không khởi động capture lại. */
export function retryFinalization(): Promise<void> {
  if (lifecycle === 'finalized') return finalizationPromise || Promise.resolve();
  if ((lifecycle === 'stopping' || lifecycle === 'finalizing') && finalizationPromise) {
    return finalizationPromise;
  }
  if (!captureReadyForFinalization) {
    return Promise.reject(new Error('Recording capture is not ready for retry'));
  }
  if (lifecycle === 'failed' && !lastFailureRetryable) {
    return Promise.reject(new Error('Recording finalization failure is not retryable'));
  }

  finalizationPromise = performEvidenceFinalization();
  return finalizationPromise;
}

/** UI chỉ nên hiển thị Retry khi capture đã đóng sạch và evidence còn trong RAM. */
export function canRetryFinalization(): boolean {
  return lifecycle === 'failed' && captureReadyForFinalization && lastFailureRetryable;
}

/**
 * Hủy capture trước khi attempt thật sự bắt đầu (vd fullscreen setup thất bại). Không upload,
 * không ghi local, và không phát recording_stopped. Không dùng API này sau khi submit.
 */
async function performStopAndDiscard(): Promise<void> {
  lifecycle = 'discarding';
  clearPartTimer();
  try {
    await stopMediaRecorder();
  } finally {
    chunkBuffer = [];
    pendingParts.clear();
    manifestParts.clear();
    bufferedPartIdentity = null;
    reservationTrackingActive = false;
    partIndex = 0;
    captureReadyForFinalization = false;
    capturedAnyPartThisSession = false;
    lastFailureRetryable = false;
    releaseCapture();
    uploadChain = Promise.resolve();
    finalizationPromise = null;
    settleSubmitHandoff();
    submitHandoffPromise = null;
    recordingStoppedFired = false;
    dirHandle = null;
    localPassword = null;
    lifecycle = 'idle';
  }
}

export function stopAndDiscard(): Promise<void> {
  if (discardPromise) return discardPromise;
  if ((lifecycle === 'stopping' || lifecycle === 'finalizing') && finalizationPromise) {
    return finalizationPromise;
  }
  if (lifecycle === 'failed' && captureReadyForFinalization) {
    return Promise.reject(new Error('Cannot discard recording evidence after finalization has started'));
  }

  discardPromise = performStopAndDiscard().finally(() => {
    discardPromise = null;
  });
  return discardPromise;
}

export function getFinalizationPromise(): Promise<void> | null {
  return finalizationPromise;
}

/**
 * Resolves when it is safe for /exam to navigate away: capture has been
 * released, and S3 has accepted/rejected the sealed manifest. Upload/finalize
 * intentionally continue through getFinalizationPromise() on /submit.
 */
export function getSubmitHandoffPromise(): Promise<void> | null {
  return submitHandoffPromise;
}
