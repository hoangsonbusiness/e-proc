import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import AdminNav from '../components/AdminNav';

function AdminDashboard() {
  const [batches, setBatches] = useState<any[]>([]);
  const [stats, setStats] = useState({ totalBatches: 0, totalStudents: 0 });
  const { logout } = useAuth();

  // Đổi mật khẩu (admin & mod đều dùng được — backend dùng id từ token)
  const [showChangePw, setShowChangePw] = useState(false);
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSuccess, setPwSuccess] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  const resetPwForm = () => {
    setPwCurrent(''); setPwNew(''); setPwConfirm('');
    setPwError(''); setPwSuccess(''); setPwSaving(false);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError(''); setPwSuccess('');
    if (pwNew.length < 8) {
      setPwError('New password must be at least 8 characters.');
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError('Password confirmation does not match.');
      return;
    }
    setPwSaving(true);
    try {
      await adminApi.changePassword(pwCurrent, pwNew);
      setPwSuccess('Password changed successfully.');
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
    } catch (err: any) {
      setPwError(err.response?.data?.error || 'Failed to change password.');
    }
    setPwSaving(false);
  };

  useEffect(() => {
    loadBatches();
  }, []);


  const loadBatches = async () => {
    try {
      const res = await adminApi.getBatches();
      setBatches(res.data);
      const students = res.data.reduce((sum: number, b: any) => sum + Number(b.students_count || 0), 0);
      setStats({ totalBatches: res.data.length, totalStudents: students });
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Admin Dashboard</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-secondary" onClick={() => { resetPwForm(); setShowChangePw(true); }}>
            Change password
          </button>
          <button className="btn btn-secondary" onClick={logout}>
            Logout
          </button>
        </div>
      </div>

      {showChangePw && (
        <div
          onClick={() => setShowChangePw(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ maxWidth: 420, width: '90%' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>Change password</h3>
              <button className="btn btn-secondary" style={{ fontSize: 14 }} onClick={() => setShowChangePw(false)}>✕</button>
            </div>
            <form onSubmit={handleChangePassword} style={{ display: 'grid', gap: 12 }}>
              <div className="form-group">
                <label>Current password</label>
                <input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>New password (minimum 8 characters)</label>
                <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} required minLength={8} />
              </div>
              <div className="form-group">
                <label>Confirm new password</label>
                <input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} required />
              </div>
              {pwError && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{pwError}</div>}
              {pwSuccess && <div style={{ color: 'var(--success, #16a34a)', fontSize: 14 }}>{pwSuccess}</div>}
              <button type="submit" className="btn btn-primary" disabled={pwSaving}>
                {pwSaving ? 'Saving...' : 'Change password'}
              </button>
            </form>
          </div>
        </div>
      )}
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20, marginBottom: 30 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ color: 'var(--text-light)' }}>Total Batches</h3>
          <p style={{ fontSize: 32, fontWeight: 600 }}>{stats.totalBatches}</p>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ color: 'var(--text-light)' }}>Total Students</h3>
          <p style={{ fontSize: 32, fontWeight: 600, color: 'var(--primary)' }}>{stats.totalStudents}</p>
        </div>
      </div>

      <AdminNav />

      <div className="card">
        <h3>Recent Batches</h3>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(batch => (
              <tr key={batch.id}>
                <td>{batch.name}</td>
                <td>{batch.duration} min</td>
                <td>
                  <Link to={`/admin/batches/${batch.id}/students`} className="btn btn-primary" style={{ marginRight: 10, fontSize: 12 }}>
                    Students
                  </Link>
                  <Link to={`/admin/batches/${batch.id}/results`} className="btn btn-secondary" style={{ fontSize: 12 }}>
                    Results
                  </Link>
                </td>
              </tr>
            ))}
            {batches.length === 0 && (
              <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-light)' }}>No batches yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default AdminDashboard;