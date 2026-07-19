import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// =============================================================================
// Code runner — biên dịch & chạy code học viên để tự kiểm tra tính đúng đắn.
//
// AN TOÀN TÀI NGUYÊN (server t3.micro chỉ có 1GB RAM, dùng chung với app thi):
//   - Tối đa MAX_CONCURRENT lần chạy đồng thời trên toàn server (hàng đợi có giới hạn)
//   - Mỗi học viên chỉ 1 lần chạy tại một thời điểm
//   - Compile timeout 10s, run timeout 5s — kill cả process group
//   - Linux: ulimit RAM 256MB / 64 process / file 10MB cho tiến trình học viên
//   - Output cắt ở 64KB
//
// AN TOÀN THÔNG TIN:
//   - Tiến trình học viên chạy với ENV SẠCH (không có DATABASE_URL, JWT_SECRET...)
//   - Mỗi lần chạy trong thư mục tạm riêng, xoá ngay sau khi xong
//
// GIỚI HẠN (chấp nhận được cho lớp training nội bộ, KHÔNG đủ cho thi công khai):
//   đây không phải sandbox tuyệt đối — code học viên vẫn chạy cùng user với app.
//   Nếu nâng mức bảo mật: chuyển sang Docker/nsjail hoặc Judge0.
// =============================================================================

const MAX_CONCURRENT = 2;
const MAX_QUEUE = 10;
const COMPILE_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CODE_BYTES = 100 * 1024;
const MAX_STDIN_BYTES = 10 * 1024;

const IS_LINUX = process.platform === 'linux';

export interface RunResult {
  ok: boolean;
  phase: 'setup' | 'compile' | 'run';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

interface LangConfig {
  file: string;
  compile?: (dir: string, file: string) => { cmd: string; args: string[] };
  run: (dir: string, file: string) => { cmd: string; args: string[] };
}

const PY = process.platform === 'win32' ? 'python' : 'python3';

const LANGS: Record<string, LangConfig> = {
  c: {
    file: 'main.c',
    compile: (_d, f) => ({ cmd: 'gcc', args: [f, '-o', 'main', '-O0', '-std=c11', '-lm'] }),
    run: (d) => ({ cmd: path.join(d, 'main'), args: [] }),
  },
  cpp: {
    file: 'main.cpp',
    compile: (_d, f) => ({ cmd: 'g++', args: [f, '-o', 'main', '-O0', '-std=c++17'] }),
    run: (d) => ({ cmd: path.join(d, 'main'), args: [] }),
  },
  python: {
    file: 'main.py',
    run: (_d, f) => ({ cmd: PY, args: [f] }),
  },
  cobol: {
    file: 'main.cob',
    // -free trước (code gõ trong editor thường không canh cột); retry fixed nếu fail — xem runCode()
    compile: (_d, f) => ({ cmd: 'cobc', args: ['-x', '-free', f, '-o', 'main'] }),
    run: (d) => ({ cmd: path.join(d, 'main'), args: [] }),
  },
  java: {
    file: 'Main.java', // tên file được đổi theo public class — xem prepareJava()
    compile: (_d, f) => ({ cmd: 'javac', args: [f] }),
    run: (_d, f) => ({ cmd: 'java', args: ['-Xmx128m', f.replace(/\.java$/, '')] }),
  },
};

export const SUPPORTED_RUN_LANGUAGES = Object.keys(LANGS);

// ─── Semaphore toàn server + khoá theo học viên ────────────────────────────

let active = 0;
const waitQueue: Array<() => void> = [];
const studentRunning = new Set<number>();

function acquireSlot(): Promise<void> | null {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  if (waitQueue.length >= MAX_QUEUE) return null; // quá tải — từ chối
  return new Promise((resolve) => waitQueue.push(() => { active++; resolve(); }));
}

function releaseSlot() {
  active--;
  const next = waitQueue.shift();
  if (next) next();
}

// ─── Spawn có timeout + giới hạn tài nguyên ────────────────────────────────

function spawnLimited(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  stdin?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Env sạch — tuyệt đối không truyền env của app (DATABASE_URL, JWT_SECRET...)
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: cwd,
      TMPDIR: cwd,
      LANG: 'C.UTF-8',
    };
    if (process.platform === 'win32') {
      // Windows (chỉ local dev): python cần SystemRoot
      cleanEnv.SystemRoot = process.env.SystemRoot;
      cleanEnv.TEMP = cwd;
      cleanEnv.TMP = cwd;
    }

    let realCmd = cmd;
    let realArgs = args;
    if (IS_LINUX) {
      // ulimit: RAM ảo 256MB, tối đa 64 process (chặn fork bomb), file ghi tối đa 10MB
      const quoted = [cmd, ...args].map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      realCmd = '/bin/sh';
      realArgs = ['-c', `ulimit -v 262144 -u 64 -f 10240; exec ${quoted}`];
    }

    const child = spawn(realCmd, realArgs, {
      cwd,
      env: cleanEnv,
      detached: IS_LINUX, // Linux: tạo process group riêng để kill được cả cây tiến trình
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killAll = () => {
      try {
        if (IS_LINUX && child.pid) {
          process.kill(-child.pid, 'SIGKILL'); // kill cả process group
        } else {
          child.kill('SIGKILL');
        }
      } catch (_) { /* đã chết */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killAll();
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d.toString('utf8');
      if (stdout.length >= MAX_OUTPUT_BYTES) killAll(); // spam output → dừng luôn
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT = compiler chưa cài trên server
      resolve({ stdout: '', stderr: `Cannot start "${cmd}": ${err.message}`, exitCode: null, timedOut: false });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        exitCode: code,
        timedOut,
      });
    });

    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

// ─── Java: tên file phải trùng tên public class ────────────────────────────

function prepareJava(code: string): string {
  const m = code.match(/public\s+(?:final\s+|abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  return m ? `${m[1]}.java` : 'Main.java';
}

// ─── API chính ─────────────────────────────────────────────────────────────

export async function runCode(
  studentId: number,
  language: string,
  code: string,
  stdin?: string
): Promise<{ status: number; body: RunResult | { error: string } }> {
  const lang = LANGS[language];
  if (!lang) {
    return { status: 400, body: { error: `Language "${language}" is not runnable. Supported: ${SUPPORTED_RUN_LANGUAGES.join(', ')}` } };
  }
  if (!code || Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    return { status: 400, body: { error: `Code is empty or exceeds ${MAX_CODE_BYTES / 1024}KB` } };
  }
  if (stdin && Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES) {
    return { status: 400, body: { error: `Stdin exceeds ${MAX_STDIN_BYTES / 1024}KB` } };
  }

  // Mỗi học viên 1 lần chạy tại một thời điểm
  if (studentRunning.has(studentId)) {
    return { status: 429, body: { error: 'You already have a run in progress. Please wait.' } };
  }

  const slot = acquireSlot();
  if (!slot) {
    return { status: 429, body: { error: 'Server is busy running other submissions. Please retry in a few seconds.' } };
  }

  studentRunning.add(studentId);
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderun-'));

  try {
    await slot;

    const fileName = language === 'java' ? prepareJava(code) : lang.file;
    fs.writeFileSync(path.join(dir, fileName), code, 'utf8');

    // ── Compile (nếu ngôn ngữ cần) ──
    if (lang.compile) {
      let { cmd, args } = lang.compile(dir, fileName);
      let compileRes = await spawnLimited(cmd, args, dir, COMPILE_TIMEOUT_MS);

      // COBOL: thử -free trước, nếu fail thử lại fixed-format (code canh cột truyền thống)
      if (language === 'cobol' && compileRes.exitCode !== 0 && !compileRes.timedOut) {
        const fixedArgs = args.filter(a => a !== '-free');
        const retry = await spawnLimited(cmd, fixedArgs, dir, COMPILE_TIMEOUT_MS);
        if (retry.exitCode === 0) compileRes = retry;
      }

      if (compileRes.exitCode !== 0) {
        return {
          status: 200,
          body: {
            ok: false,
            phase: 'compile',
            stdout: compileRes.stdout,
            stderr: compileRes.stderr || (compileRes.timedOut ? 'Compilation timed out' : 'Compilation failed'),
            exitCode: compileRes.exitCode,
            timedOut: compileRes.timedOut,
            durationMs: Date.now() - started,
          },
        };
      }
    }

    // ── Run ──
    const { cmd, args } = lang.run(dir, fileName);
    const runRes = await spawnLimited(cmd, args, dir, RUN_TIMEOUT_MS, stdin);

    return {
      status: 200,
      body: {
        ok: runRes.exitCode === 0 && !runRes.timedOut,
        phase: 'run',
        stdout: runRes.stdout,
        stderr: runRes.timedOut ? `${runRes.stderr}\n[Killed: exceeded ${RUN_TIMEOUT_MS / 1000}s time limit]`.trim() : runRes.stderr,
        exitCode: runRes.exitCode,
        timedOut: runRes.timedOut,
        durationMs: Date.now() - started,
      },
    };
  } catch (err: any) {
    return {
      status: 200,
      body: { ok: false, phase: 'setup', stdout: '', stderr: err.message, exitCode: null, timedOut: false, durationMs: Date.now() - started },
    };
  } finally {
    studentRunning.delete(studentId);
    releaseSlot();
    fs.rm(dir, { recursive: true, force: true }, () => { /* best-effort cleanup */ });
  }
}
