import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { studentApi } from '../services/api';
import { clearStudentSession } from '../services/studentSession';
import { ShieldCheck } from 'lucide-react';

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

    // Student state is tab-scoped so parallel test/candidate tabs cannot replace
    // one another's JWT. Admin credentials remain untouched in localStorage.
    clearStudentSession();

    setLoading(true);
    setError('');

    try {
      const res = await studentApi.verify(accessCode.trim());
      if (res.data.valid) {
        clearStudentSession();
        // Navigate to confirm page with state (not localStorage)
        navigate('/confirm', {
          state: {
            studentId: res.data.student_id,
            studentToken: res.data.student_token, // [C-4] JWT xác thực học viên
            email: res.data.emails[0],
            duration: res.data.duration,
            recordMode: res.data.record_mode || (res.data.record_enabled ? 's3' : 'none'), // 'none' | 'local' | 's3'
            recordingPassword: res.data.recording_password // chỉ có khi mode 'local' (server cấp, HV không thấy)
          }
        });
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Invalid access code');
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
        <div className="bg-slate-900 px-6 py-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-500/10 text-blue-400 mb-4">
            <ShieldCheck size={32} />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">E-Audit Platform</h2>
          <p className="text-slate-400 text-sm">Secure Examination Environment</p>
        </div>
        
        <div className="p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2 text-center">
                Enter your 6- or 8-character access code
              </label>
              <input 
                type="text" 
                value={accessCode}
                onChange={e => setAccessCode(e.target.value.toUpperCase())}
                placeholder="XXXXXXXX"
                maxLength={8}
                className="block w-full text-center text-3xl tracking-[0.5em] font-mono uppercase bg-slate-50 border-2 border-slate-200 focus:border-blue-500 focus:ring-blue-500 rounded-xl py-4 transition-colors placeholder:text-slate-300"
              />
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm text-center font-medium">
                {error}
              </div>
            )}
            <button 
              type="submit" 
              disabled={loading || ![6, 8].includes(accessCode.length)}
              className="w-full bg-blue-600 text-white font-medium text-lg py-3 rounded-xl hover:bg-blue-700 focus:ring-4 focus:ring-blue-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-500/30"
            >
              {loading ? 'Verifying...' : 'Begin Assessment'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

export default StudentLogin;
