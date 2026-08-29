import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import * as examRecorder from '../services/examRecorder';
import { getExamEnvironmentSnapshot } from '../services/examEnvironment';
import {
  clearFullscreenBaselineWidth,
  storeFullscreenBaselineWidth,
} from '../services/sidePanelDetector';
import { UserCheck, AlertTriangle } from 'lucide-react';

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function StudentConfirm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [environment, setEnvironment] = useState(() => getExamEnvironmentSnapshot());

  const navigate = useNavigate();
  const location = useLocation();
  
  const studentId = location.state?.studentId;
  const studentToken = location.state?.studentToken; // [C-4]
  const email = location.state?.email;
  const duration = location.state?.duration;
  const recordMode: 'none' | 'local' | 's3' = location.state?.recordMode || 'none';
  const liveEnabled = Boolean(location.state?.liveEnabled);
  const screenShareRequired = recordMode !== 'none' || liveEnabled;
  const recordingPassword: string | undefined = location.state?.recordingPassword; // chỉ mode 'local'
  const recordingNextPartIndex = Number(location.state?.recordingNextPartIndex) || 0;

  useEffect(() => {
    // Redirect to login if no state or missing token
    if (!studentId || !email || !studentToken) {
      clearFullscreenBaselineWidth();
      navigate('/');
    }
  }, [studentId, email, studentToken, navigate]);

  useEffect(() => {
    const interval = setInterval(() => setEnvironment(getExamEnvironmentSnapshot()), 2000);
    return () => clearInterval(interval);
  }, []);

  const handleStartExam = async () => {
    setError('');
    setLoading(true);

    if (environment.screenExtended === true) {
      setError('An external or extended display was detected. Disconnect external displays and Sidecar, then try again.');
      setLoading(false);
      return;
    }

    // [#6] Fail-closed: nếu trình duyệt KHÔNG hỗ trợ screen.isExtended thì ta không thể
    // xác minh chỉ có một màn hình → trước đây trả null và vẫn cho thi (lọt).
    // Chrome/Edge desktop đều hỗ trợ field này, nên chặn ở đây cũng ép HV dùng đúng browser.
    if (environment.screenExtended === null) {
      setError('Your browser cannot verify your display setup. Please use a recent version of Google Chrome or Microsoft Edge on a desktop to take the exam.');
      setLoading(false);
      return;
    }

    // Local/S3 record and capture-only Live both require one full-screen share.
    if (screenShareRequired) {
      const captureMode = recordMode === 'none' ? 'live' : recordMode;
      if (!examRecorder.isSupported(captureMode)) {
        setError('Your browser does not support full-screen sharing. Please use a recent version of Google Chrome or Microsoft Edge to take the exam.');
        setLoading(false);
        return;
      }

      // QUAN TRỌNG — thứ tự: chia sẻ màn hình (và chọn thư mục nếu local) TRƯỚC, fullscreen SAU.
      // getDisplayMedia đòi "user activation" của cú click; nếu gọi requestFullscreen
      // trước, gesture bị tiêu thụ → getDisplayMedia bị chặn (SecurityError).
      const setup = await examRecorder.requestSetup(captureMode);
      if (!setup.ok) {
        const messages: Record<string, string> = {
          unsupported: 'Your browser does not support screen recording. Please use Chrome or Edge.',
          no_directory: 'You must choose a folder to save the exam video.',
          no_screen: 'You must allow screen sharing to start the exam.',
          not_fullscreen: 'Please share your "Entire Screen", not a single tab or window.',
        };
        setError(messages[setup.reason || ''] || 'Could not start screen sharing. Please try again.');
        setLoading(false);
        return;
      }
      if (recordMode === 'none') {
        examRecorder.startLiveCapture();
      } else {
        examRecorder.start({
          mode: recordMode,
          password: recordingPassword,
          initialPartIndex: recordMode === 's3' ? recordingNextPartIndex : 0,
        });
      }
    }

    // A new attempt must never inherit a baseline from an older attempt in the same tab.
    clearFullscreenBaselineWidth();

    // Keep fullscreen request before any network call so the original click still supplies user activation.
    try {
      await document.documentElement.requestFullscreen();
      if (!document.fullscreenElement) throw new Error('Fullscreen was not activated');
    } catch (e) {
      if (screenShareRequired) await examRecorder.stopAndDiscard().catch(() => undefined);
      setError('Fullscreen is required. Allow fullscreen access to start the exam.');
      setLoading(false);
      return;
    }

    // Fullscreen is activated on /confirm before /exam mounts. Wait for the browser to
    // finish the transition, then capture the canonical width exactly once for this attempt.
    // StudentExam only reads this value; it never re-captures it after reload/re-entry.
    await waitForNextPaint();
    await waitForNextPaint();
    const fullscreenBaselineWidth = document.documentElement.getBoundingClientRect().width;
    if (!storeFullscreenBaselineWidth(fullscreenBaselineWidth)) {
      if (screenShareRequired) await examRecorder.stopAndDiscard().catch(() => undefined);
      await document.exitFullscreen().catch(() => undefined);
      setError('Could not initialize the secure fullscreen session. Please allow session storage and try again.');
      setLoading(false);
      return;
    }

    localStorage.setItem('recordMode', recordMode); // để /exam biết mode (none/local/s3)
    localStorage.setItem('liveEnabled', String(liveEnabled));
    if (recordMode === 'local' && recordingPassword) {
      localStorage.setItem('recordingPassword', recordingPassword); // dùng ngầm cho resume-after-reload
    }
    localStorage.setItem('studentId', studentId.toString());
    localStorage.setItem('studentToken', studentToken); // [C-4] Lưu JWT học viên
    localStorage.setItem('duration', duration.toString());
    localStorage.setItem('studentEmail', email); // lưu email cho watermark forensic

    navigate('/exam');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
        <div className="bg-slate-900 px-6 py-6 text-center border-b border-slate-800">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-400 mb-3">
            <UserCheck size={24} />
          </div>
          <h2 className="text-xl font-bold text-white">Confirm Information</h2>
        </div>
        
        <div className="p-8">
          <div className="bg-slate-50 p-6 rounded-xl border border-slate-200 mb-6 text-center">
            <p className="text-slate-500 text-sm mb-1 uppercase tracking-wider font-semibold">
              Registered email
            </p>
            <p className="text-lg font-bold text-slate-900 break-all">
              {email}
            </p>
          </div>

          <p className="text-slate-500 text-sm mb-6 text-center">
            Please confirm your email before starting the assessment.
          </p>

          {environment.screenExtended === true && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6 text-sm">
              <p className="mt-3 text-red-700 font-semibold">
                Multiple displays detected. Disconnect the additional display or Sidecar before continuing.
              </p>
            </div>
          )}

          {screenShareRequired && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800 shadow-sm">
              <div className="flex gap-2 mb-2">
                <AlertTriangle className="text-amber-600 shrink-0" size={18} />
                <span className="font-semibold text-amber-900">Screen Sharing Required</span>
              </div>
              <p className="ml-6 leading-relaxed opacity-90">
                When you start, you will be asked to
                {recordMode === 'local' && <> choose a <b>folder to save the video</b> and</>} share your <b>Entire Screen</b>.
                {recordMode === 'none'
                  ? <> Your screen is shared only for authorised live monitoring; no recording is saved.</>
                  : recordMode === 'local'
                  ? <> The video is saved to the folder you choose. After the exam, commit this folder to GitLab as instructed.</>
                  : <> The video is uploaded automatically to the system during the exam.</>}
                <br /><br />Please use <b>Google Chrome</b> or <b>Microsoft Edge</b>. If you stop sharing during the exam, it will be locked.
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl mb-6 text-sm font-medium text-center">
              {error}
            </div>
          )}

          <div className="space-y-3">
            <button
              onClick={handleStartExam}
              disabled={loading || environment.screenExtended === true}
              className="w-full bg-blue-600 text-white font-medium text-base py-3 rounded-xl hover:bg-blue-700 focus:ring-4 focus:ring-blue-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
            >
              {loading ? 'Preparing screen recording...' : 'Start Exam'}
            </button>

            <button 
              onClick={() => {
                localStorage.clear();
                clearFullscreenBaselineWidth();
                navigate('/');
              }}
              className="w-full bg-white text-slate-700 border-2 border-slate-200 font-medium text-base py-3 rounded-xl hover:bg-slate-50 focus:ring-4 focus:ring-slate-100 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StudentConfirm;
