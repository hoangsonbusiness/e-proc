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
  const recordEnabled = !!location.state?.recordEnabled; // batch có bật ghi màn hình S3

  useEffect(() => {
    // Redirect to login if no state or missing token
    if (!studentId || !email || !studentToken) {
      navigate('/');
    }
  }, [studentId, email, studentToken, navigate]);

  const handleStartExam = async () => {
    setError('');
    setLoading(true);

    // Chỉ yêu cầu ghi màn hình khi batch được bật record. Batch không bật → thi thẳng.
    if (recordEnabled) {
      if (!examRecorder.isSupported()) {
        setError('Trình duyệt của bạn không hỗ trợ ghi màn hình. Vui lòng dùng Google Chrome hoặc Microsoft Edge phiên bản mới để làm bài.');
        setLoading(false);
        return;
      }

      // QUAN TRỌNG — thứ tự: chia sẻ màn hình TRƯỚC, fullscreen SAU.
      // getDisplayMedia đòi "user activation" của cú click; nếu gọi requestFullscreen
      // trước, gesture bị tiêu thụ → getDisplayMedia bị chặn (SecurityError).
      const setup = await examRecorder.requestSetup();
      if (!setup.ok) {
        const messages: Record<string, string> = {
          unsupported: 'Trình duyệt không hỗ trợ ghi màn hình. Vui lòng dùng Chrome hoặc Edge.',
          no_screen: 'Bạn cần cho phép chia sẻ màn hình để bắt đầu bài thi.',
          not_fullscreen: 'Vui lòng chọn chia sẻ "Toàn bộ màn hình" (Entire Screen), không phải một tab hay cửa sổ.',
        };
        setError(messages[setup.reason || ''] || 'Không thể bắt đầu ghi màn hình. Vui lòng thử lại.');
        setLoading(false);
        return;
      }
      examRecorder.start();
    }

    localStorage.setItem('recordEnabled', recordEnabled ? '1' : '0'); // để /exam biết có gate recorder không
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
        <h2 style={{ textAlign: 'center', marginBottom: 10 }}>Xác nhận thông tin</h2>
        
        <div style={{ 
          background: 'var(--background)', 
          padding: 20, 
          borderRadius: 8,
          marginBottom: 20 
        }}>
          <p style={{ color: 'var(--text-light)', fontSize: 14, marginBottom: 8 }}>
            Email đăng ký:
          </p>
          <p style={{ fontSize: 18, fontWeight: 'bold' }}>
            {email}
          </p>
        </div>

        <p style={{ color: 'var(--text-light)', fontSize: 14, marginBottom: 12 }}>
          Vui lòng xác nhận email của bạn trước khi bắt đầu làm bài thi.
        </p>

        {recordEnabled && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 13, color: '#92400e' }}>
            ⚠️ Bài thi này <b>bắt buộc ghi màn hình</b>. Khi bấm bắt đầu, bạn sẽ được yêu cầu
            chia sẻ <b>Toàn bộ màn hình</b> (Entire Screen). Video được lưu tự động lên hệ thống
            trong lúc thi.
            <br />Vui lòng dùng <b>Google Chrome</b> hoặc <b>Microsoft Edge</b>. Nếu tự dừng chia sẻ giữa chừng, bài thi sẽ bị khóa.
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
          {loading ? 'Đang chuẩn bị ghi màn hình...' : 'Bắt đầu làm bài'}
        </button>

        <button 
          onClick={() => {
            localStorage.clear();
            navigate('/');
          }}
          className="btn btn-secondary" 
          style={{ width: '100%', marginTop: 10 }}
        >
          Huỷ
        </button>
      </div>
    </div>
  );
}

export default StudentConfirm;