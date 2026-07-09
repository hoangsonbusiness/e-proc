import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { adminApi } from '../services/api';

function AdminSetup() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [alreadyInit, setAlreadyInit] = useState(false);
  const navigate = useNavigate();

  // Kiểm tra xem admin đã được tạo chưa bằng cách thử gọi setup với body rỗng
  // Nếu server trả 403 → đã init rồi
  useEffect(() => {
    adminApi.setup('', '').catch((err) => {
      if (err.response?.status === 403) {
        setAlreadyInit(true);
      }
    });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim()) {
      return setError('Username is required');
    }
    if (password.length < 8) {
      return setError('Password must be at least 8 characters');
    }
    if (password !== confirmPassword) {
      return setError('Passwords do not match');
    }

    setLoading(true);
    try {
      await adminApi.setup(username.trim(), password);
      navigate('/admin');
    } catch (err: any) {
      const msg = err.response?.data?.error || 'Setup failed. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (alreadyInit) {
    return (
      <div className="container" style={{ maxWidth: 440, marginTop: 100 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
          <h2 style={{ marginBottom: 12 }}>Already Initialized</h2>
          <p style={{ color: 'var(--text-light)', marginBottom: 24, lineHeight: 1.6 }}>
            An admin account already exists. This setup page is no longer available.
          </p>
          <button
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={() => navigate('/admin')}
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ maxWidth: 440, marginTop: 80 }}>
      <div className="card">
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>⚙️</div>
          <h2 style={{ marginBottom: 6 }}>Admin Setup</h2>
          <p style={{ color: 'var(--text-light)', fontSize: 14, lineHeight: 1.5 }}>
            Create the administrator account for this platform.
            This page will be locked after setup completes.
          </p>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off">
          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. admin"
              autoFocus
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Password <span style={{ color: 'var(--text-light)', fontWeight: 400, fontSize: 12 }}>(min 8 characters)</span></label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter password"
              disabled={loading}
            />
          </div>

          {error && (
            <p className="error" style={{ marginBottom: 16 }}>{error}</p>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%' }}
            disabled={loading}
          >
            {loading ? 'Creating account...' : 'Create Admin Account'}
          </button>
        </form>

        <p style={{
          marginTop: 20,
          fontSize: 12,
          color: 'var(--text-light)',
          textAlign: 'center',
          lineHeight: 1.5,
          borderTop: '1px solid var(--border)',
          paddingTop: 16
        }}>
          Already have an account?{' '}
          <span
            style={{ color: 'var(--primary)', cursor: 'pointer' }}
            onClick={() => navigate('/admin')}
          >
            Login here
          </span>
        </p>
      </div>
    </div>
  );
}

export default AdminSetup;
