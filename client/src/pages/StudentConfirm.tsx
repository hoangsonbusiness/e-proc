import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import * as examRecorder from '../services/examRecorder';

function StudentConfirm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const navigate = useNavigate();
  const location = useLocation();
  
  const studentId = location.state?.studentId;
  const studentToken = location.state?.studentToken; // [C-4]
  const email = location.state?.email;
  const duration = location.state?.duration;
  const recordMode: 'none' | 'local' | 's3' = location.state?.recordMode || 'none';
  const recordingPassword: string | undefined = location.state?.recordingPassword; // chỉ mode 'local'

  useEffect(() => {
    // Redirect to login if no state or missing token
    if (!studentId || !email || !studentToken) {
      navigate('/');
    }
  }, [studentId, email, studentToken, navigate]);

  const handleStartExam = async () => {
    setError('');
    setLoading(true);

    // Chỉ yêu cầu ghi màn hình khi batch bật record (local/s3). Mode 'none' → thi thẳng.
    if (recordMode !== 'none') {
      if (!examRecorder.isSupported(recordMode)) {
        setError('Your browser does not support screen recording. Please use a recent version of Google Chrome or Microsoft Edge to take the exam.');
        setLoading(false);
        return;
      }

      // QUAN TRỌNG — thứ tự: chia sẻ màn hình (và chọn thư mục nếu local) TRƯỚC, fullscreen SAU.
      // getDisplayMedia đòi "user activation" của cú click; nếu gọi requestFullscreen
      // trước, gesture bị tiêu thụ → getDisplayMedia bị chặn (SecurityError).
      const setup = await examRecorder.requestSetup(recordMode);
      if (!setup.ok) {
        const messages: Record<string, string> = {
          unsupported: 'Your browser does not support screen recording. Please use Chrome or Edge.',
          no_directory: 'You must choose a folder to save the exam video.',
          no_screen: 'You must allow screen sharing to start the exam.',
          not_fullscreen: 'Please share your "Entire Screen", not a single tab or window.',
        };
        setError(messages[setup.reason || ''] || 'Could not start screen recording. Please try again.');
        setLoading(false);
        return;
      }
      examRecorder.start({ mode: recordMode, password: recordingPassword });
    }

    localStorage.setItem('recordMode', recordMode); // để /exam biết mode (none/local/s3)
    if (recordMode === 'local' && recordingPassword) {
      localStorage.setItem('recordingPassword', recordingPassword); // dùng ngầm cho resume-after-reload
    }
    localStorage.setItem('studentId', studentId.toString());
    localStorage.setItem('studentToken', studentToken); // [C-4] Lưu JWT học viên
    localStorage.setItem('duration', duration.toString());
    localStorage.setItem('studentEmail', email); // lưu email cho watermark forensic

    // Fullscreen sau cùng (không còn cần user gesture cho picker nữa).
    try {
      await document.documentElement.requestFullscreen();
    } catch (e) {
      console.log('Fullscreen not supported or denied');
    }

    navigate('/exam');
  };

  return (
    <div style={{ 
      minHeight: '100vh', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
    }}>
      <div className="card" style={{ maxWidth: 400, width: '100%' }}>
        <h2 style={{ textAlign: 'center', marginBottom: 10 }}>Confirm Information</h2>
        
        <div style={{ 
          background: 'var(--background)', 
          padding: 20, 
          borderRadius: 8,
          marginBottom: 20 
        }}>
          <p style={{ color: 'var(--text-light)', fontSize: 14, marginBottom: 8 }}>
            Registered email:
          </p>
          <p style={{ fontSize: 18, fontWeight: 'bold' }}>
            {email}
          </p>
        </div>

        <p style={{ color: 'var(--text-light)', fontSize: 14, marginBottom: 12 }}>
          Please confirm your email before starting the exam.
        </p>

        {recordMode !== 'none' && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13, color: '#92400e' }}>
            ⚠️ This exam <b>requires screen recording</b>. When you start, you will be asked to
            {recordMode === 'local' && <> choose a <b>folder to save the video</b> and</>} share your <b>Entire Screen</b>.
            {recordMode === 'local'
              ? <> The video is saved to the folder you choose. After the exam, commit this folder to GitLab as instructed.</>
              : <> The video is uploaded automatically to the system during the exam.</>}
            <br />Please use <b>Google Chrome</b> or <b>Microsoft Edge</b>. If you stop sharing during the exam, it will be locked.
          </div>
        )}

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13, color: '#991b1b' }}>
            {error}
          </div>
        )}

        <button
          onClick={handleStartExam}
          disabled={loading}
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 8 }}
        >
          {loading ? 'Preparing screen recording...' : 'Start Exam'}
        </button>

        <button 
          onClick={() => {
            localStorage.clear();
            navigate('/');
          }}
          className="btn btn-secondary" 
          style={{ width: '100%', marginTop: 10 }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default StudentConfirm;