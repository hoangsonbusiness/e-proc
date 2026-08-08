import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { Settings, Lock } from 'lucide-react';

function AdminSetup() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [alreadyInit, setAlreadyInit] = useState(false);
  const navigate = useNavigate();

  // Kiểm tra xem admin đã được tạo chưa qua endpoint chuyên dụng
  useEffect(() => {
    adminApi.isInitialized()
      .then((res) => {
        if (res.data.initialized) {
          setAlreadyInit(true);
        }
      })
      .catch(() => {
        // Nếu endpoint lỗi → giữ nguyên form setup (safe default)
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
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden p-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-amber-50 text-amber-500 mb-6">
            <Lock size={32} />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-3">Already Initialized</h2>
          <p className="text-slate-500 text-base mb-8 leading-relaxed">
            An admin account already exists. This setup page is no longer available.
          </p>
          <button
            className="w-full bg-blue-600 text-white font-medium py-3 rounded-xl hover:bg-blue-700 transition-colors shadow-sm"
            onClick={() => navigate('/admin')}
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
        <div className="p-8">
          <div className="flex flex-col items-center mb-8 text-center">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 mb-4">
              <Settings size={24} />
            </div>
            <h2 className="text-2xl font-bold text-slate-900">Admin Setup</h2>
            <p className="text-slate-500 text-sm mt-2 leading-relaxed">
              Create the administrator account for this platform. This page will be locked after setup completes.
            </p>
          </div>

          <form onSubmit={handleSubmit} autoComplete="off" className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. admin"
                autoFocus
                disabled={loading}
                className="block w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Password <span className="text-slate-400 font-normal ml-1">(min 8 characters)</span>
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                disabled={loading}
                className="block w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                disabled={loading}
                className="block w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
              />
            </div>

            {error && (
              <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg text-sm font-medium">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 text-white font-medium py-3 rounded-xl hover:bg-indigo-700 focus:ring-4 focus:ring-indigo-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm mt-2"
            >
              {loading ? 'Creating account...' : 'Create Admin Account'}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-slate-100 text-center">
            <p className="text-sm text-slate-500">
              Already have an account?{' '}
              <Link to="/admin" className="font-semibold text-indigo-600 hover:text-indigo-700 hover:underline">
                Login here
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminSetup;
