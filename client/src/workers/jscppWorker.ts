// Web Worker chạy C/C++ bằng JSCPP (interpreter JS, bundle vào app qua Vite).
// Chạy trong worker để không đơ UI và để main thread có thể terminate() khi
// vượt timeout (vòng lặp vô hạn). Được tái sử dụng giữa các lần chạy.
import JSCPP from 'JSCPP';

self.onmessage = (e: MessageEvent<{ code: string }>) => {
  const { code } = e.data;
  let stdout = '';
  try {
    const exitCode = JSCPP.run(code, '', { stdio: { write: (s: string) => { stdout += s; } } });
    self.postMessage({ ok: exitCode === 0, stdout, stderr: '', exitCode });
  } catch (err) {
    self.postMessage({
      ok: false,
      stdout,
      stderr:
        String(err) +
        '\n\n[Ghi chú: trình chạy C/C++ trong trình duyệt hỗ trợ tập con ngôn ngữ.' +
        ' Nếu bạn tin code đúng chuẩn mà vẫn báo lỗi, hãy hỏi trainer.]',
      exitCode: 1,
    });
  }
};
