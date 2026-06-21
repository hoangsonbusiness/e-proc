import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { studentApi } from '../services/api';

function StudentLogin() {
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessCode.trim()) {
      setError('Please enter access code');
      return;
    }

    // Clear localStorage trước khi verify để tránh dùng lại student_id cũ
    localStorage.clear();

    setLoading(true);
    setError('');

    try {
      const res = await studentApi.verify(accessCode.trim());
      if (res.data.valid) {
        // Clear localStorage first
        localStorage.clear();
        // Navigate to confirm page with state (not localStorage)
        navigate('/confirm', {
          state: {
            studentId: res.data.student_id,
            email: res.data.emails[0],
            duration: res.data.duration
          }
        });
      }
    } catch (err: any) {
      if (err.response?.data?.scheduled_start && err.response?.data?.scheduled_end) {
        const start = new Date(err.response.data.scheduled_start).toLocaleString();
        const end = new Date(err.response.data.scheduled_end).toLocaleString();
        setError(`Exam is not active. Scheduled (your local time): ${start} - ${end}`);
      } else {
        setError(err.response?.data?.error || 'Invalid access code');
      }
    }
    setLoading(false);
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
        <h2 style={{ textAlign: 'center', marginBottom: 10 }}>E-Audit Platform</h2>
        <p style={{ textAlign: 'center', color: 'var(--text-light)', marginBottom: 30 }}>
          Enter your access code to begin the exam
        </p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <input 
              type="text" 
              value={accessCode}
              onChange={e => setAccessCode(e.target.value.toUpperCase())}
              placeholder="Enter 6-character code"
              maxLength={6}
              style={{ 
                textAlign: 'center', 
                fontSize: 24, 
                letterSpacing: 8,
                fontFamily: 'monospace'
              }}
            />
          </div>
          {error && <p className="error" style={{ textAlign: 'center' }}>{error}</p>}
          <button 
            type="submit" 
            disabled={loading || accessCode.length !== 6}
            className="btn btn-primary" 
            style={{ width: '100%', marginTop: 20 }}
          >
            {loading ? 'Verifying...' : 'Verify Code'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default StudentLogin;