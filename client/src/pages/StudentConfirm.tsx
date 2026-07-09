import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

function StudentConfirm() {
  const [loading] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  
  const studentId = location.state?.studentId;
  const email = location.state?.email;
  const duration = location.state?.duration;

  useEffect(() => {
    // Redirect to login if no state
    if (!studentId || !email) {
      navigate('/');
    }
  }, [studentId, email, navigate]);

  const handleStartExam = async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch (e) {
      console.log('Fullscreen not supported or denied');
    }
    localStorage.setItem('studentId', studentId.toString());
    localStorage.setItem('duration', duration.toString());
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

        <p style={{ color: 'var(--text-light)', fontSize: 14, marginBottom: 20 }}>
          Vui lòng xác nhận email của bạn trước khi bắt đầu làm bài thi.
        </p>

        <button 
          onClick={handleStartExam}
          disabled={loading}
          className="btn btn-primary" 
          style={{ width: '100%', marginTop: 20 }}
        >
          {loading ? 'Đang chuyển...' : 'Bắt đầu làm bài'}
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