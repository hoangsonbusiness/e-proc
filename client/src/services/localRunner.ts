// =============================================================================
// Local code runner — chạy code NGAY TRONG TRÌNH DUYỆT của học viên, không gửi
// request lên server (tránh tắc nghẽn t3.micro khi 20 học viên bấm Run).
//
//   - python : Pyodide (CPython biên dịch sang WebAssembly) — Python thật, đầy đủ
//   - c/cpp  : JSCPP (interpreter C++ viết bằng JS) — hỗ trợ TẬP CON ngôn ngữ,
//              đủ cho bài tập junior (iostream/stdio, con trỏ, struct, vector...)
//              nhưng KHÔNG phải g++ đầy đủ
//   - cobol/java: không tồn tại runtime browser khả dụng → vẫn phải chạy server
//
// Kiến trúc: mỗi runtime chạy trong một Web Worker riêng để (1) không đơ UI và
// (2) có thể terminate() khi vượt timeout (vòng lặp vô hạn). Worker được TÁI SỬ
// DỤNG giữa các lần chạy — lần đầu tải runtime từ CDN hơi lâu (Pyodide ~5-10s),
// các lần sau chạy ngay lập tức.
// =============================================================================

export interface LocalRunResult {
  ok: boolean;
  phase: 'setup' | 'run';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  ranLocally: true;
}

export const LOCAL_RUN_LANGUAGES = ['python', 'c', 'cpp'] as const;
export type LocalRunLanguage = (typeof LOCAL_RUN_LANGUAGES)[number];

export function canRunLocally(language: string): language is LocalRunLanguage {
  return (LOCAL_RUN_LANGUAGES as readonly string[]).includes(language);
}

// Timeout: lần đầu phải tải runtime từ CDN nên cho rộng; các lần sau ngắn
const FIRST_RUN_TIMEOUT_MS = 60_000;
const WARM_RUN_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_CHARS = 64 * 1024;

// ─── Worker source code (inline qua Blob URL) ──────────────────────────────

const PYODIDE_WORKER_SRC = `
let pyodide = null;
self.onmessage = async (e) => {
  const { code } = e.data;
  let stdout = '';
  let stderr = '';
  try {
    if (!pyodide) {
      importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js');
      pyodide = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
    }
    pyodide.setStdout({ batched: (s) => { stdout += s + '\\n'; } });
    pyodide.setStderr({ batched: (s) => { stderr += s + '\\n'; } });
    // input() không có bàn phím trong worker — trả EOF để chương trình biết
    pyodide.setStdin({ stdin: () => null });
    await pyodide.runPythonAsync(code);
    self.postMessage({ ok: true, stdout, stderr, exitCode: 0 });
  } catch (err) {
    self.postMessage({ ok: false, stdout, stderr: (stderr ? stderr + '\\n' : '') + String(err), exitCode: 1 });
  }
};
`;

// ─── Worker manager: tái sử dụng worker giữa các lần chạy ──────────────────

type WorkerKind = 'python' | 'jscpp';

const workers: Partial<Record<WorkerKind, Worker>> = {};
const workerWarm: Partial<Record<WorkerKind, boolean>> = {};

function getWorker(kind: WorkerKind): Worker {
  const existing = workers[kind];
  if (existing) return existing;

  let worker: Worker;
  if (kind === 'python') {
    // Pyodide: classic worker tự tải runtime từ CDN qua importScripts
    // (không bundle được — runtime WASM ~10MB)
    const blobUrl = URL.createObjectURL(new Blob([PYODIDE_WORKER_SRC], { type: 'application/javascript' }));
    worker = new Worker(blobUrl);
    URL.revokeObjectURL(blobUrl);
  } else {
    // JSCPP: bundle thẳng vào app qua Vite module worker (package không còn
    // phát hành bản dist cho browser — CDN chỉ có bundle cũ đã hỏng)
    worker = new Worker(new URL('../workers/jscppWorker.ts', import.meta.url), { type: 'module' });
  }
  workers[kind] = worker;
  return worker;
}

function killWorker(kind: WorkerKind) {
  workers[kind]?.terminate();
  delete workers[kind];
  delete workerWarm[kind];
}

let runInFlight = false;

/**
 * Chạy code trong trình duyệt. Gọi tuần tự — nếu đang có lần chạy khác thì reject.
 */
export function runLocally(language: LocalRunLanguage, code: string): Promise<LocalRunResult> {
  const kind: WorkerKind = language === 'python' ? 'python' : 'jscpp';

  if (runInFlight) {
    return Promise.resolve({
      ok: false, phase: 'setup', stdout: '',
      stderr: 'A run is already in progress. Please wait.',
      exitCode: null, timedOut: false, durationMs: 0, ranLocally: true,
    });
  }

  runInFlight = true;
  const started = Date.now();
  const timeoutMs = workerWarm[kind] ? WARM_RUN_TIMEOUT_MS : FIRST_RUN_TIMEOUT_MS;

  return new Promise<LocalRunResult>((resolve) => {
    const worker = getWorker(kind);

    const finish = (result: LocalRunResult) => {
      runInFlight = false;
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Vượt timeout (thường là vòng lặp vô hạn) → giết worker; lần chạy sau
      // sẽ tự tạo worker mới (chấp nhận tải lại runtime)
      killWorker(kind);
      finish({
        ok: false, phase: 'run', stdout: '',
        stderr: `[Killed: exceeded ${Math.round(timeoutMs / 1000)}s time limit]`,
        exitCode: null, timedOut: true, durationMs: Date.now() - started, ranLocally: true,
      });
    }, timeoutMs);

    worker.onmessage = (e) => {
      clearTimeout(timer);
      workerWarm[kind] = true;
      const { ok, stdout, stderr, exitCode } = e.data as { ok: boolean; stdout: string; stderr: string; exitCode: number | null };
      finish({
        ok,
        phase: 'run',
        stdout: (stdout || '').slice(0, MAX_OUTPUT_CHARS),
        stderr: (stderr || '').slice(0, MAX_OUTPUT_CHARS),
        exitCode,
        timedOut: false,
        durationMs: Date.now() - started,
        ranLocally: true,
      });
    };

    worker.onerror = (e) => {
      clearTimeout(timer);
      killWorker(kind);
      finish({
        ok: false, phase: 'setup', stdout: '',
        stderr: `Failed to load the in-browser runtime: ${e.message || 'unknown error'}. Check your internet connection and retry.`,
        exitCode: null, timedOut: false, durationMs: Date.now() - started, ranLocally: true,
      });
    };

    worker.postMessage({ code });
  });
}
