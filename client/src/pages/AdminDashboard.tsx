import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import AdminNav from '../components/AdminNav';

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function AdminDashboard() {
  const [batches, setBatches] = useState<any[]>([]);
  const [stats, setStats] = useState({ totalBatches: 0, totalStudents: 0 });
  const { logout } = useAuth();

  // Phân trang
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [currentPage, setCurrentPage] = useState(1);

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

  // ── Pagination ──────────────────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(batches.length / pageSize));

  const paginatedBatches = useMemo(() =>
    batches.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [batches, currentPage, pageSize]
  );

  const handlePageSizeChange = (size: PageSize) => {
    setPageSize(size);
    setCurrentPage(1);
  };

  const getPageNumbers = () => {
    const delta = 2;
    const range: (number | '...')[] = [];
    const left = Math.max(2, currentPage - delta);
    const right = Math.min(totalPages - 1, currentPage + delta);

    range.push(1);
    if (left > 2) range.push('...');
    for (let i = left; i <= right; i++) range.push(i);
    if (right < totalPages - 1) range.push('...');
    if (totalPages > 1) range.push(totalPages);
    return range;
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
        {/* Header + page size */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>
            Recent Batches&nbsp;
            <span style={{ color: 'var(--text-light)', fontWeight: 400, fontSize: 15 }}>
              ({batches.length} total)
            </span>
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--text-light)', whiteSpace: 'nowrap' }}>Show:</label>
            <select
              id="dashboard-page-size"
              value={pageSize}
              onChange={e => handlePageSizeChange(Number(e.target.value) as PageSize)}
              style={{ fontSize: 13, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }}
            >
              {PAGE_SIZE_OPTIONS.map(s => (
                <option key={s} value={s}>{s} / page</option>
              ))}
            </select>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginatedBatches.map(batch => (
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

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-light)' }}>
              Page {currentPage} of {totalPages}&nbsp;·&nbsp;
              {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, batches.length)} of {batches.length}
            </span>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="btn btn-secondary"
                style={{ fontSize: 13, padding: '4px 10px' }}
              >
                ←
              </button>
              {getPageNumbers().map((p, i) =>
                p === '...' ? (
                  <span key={`ellipsis-${i}`} style={{ padding: '0 6px', color: 'var(--text-light)' }}>…</span>
                ) : (
                  <button
                    key={p}
                    onClick={() => setCurrentPage(p as number)}
                    className={`btn ${currentPage === p ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ fontSize: 13, padding: '4px 10px', minWidth: 34 }}
                  >
                    {p}
                  </button>
                )
              )}
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="btn btn-secondary"
                style={{ fontSize: 13, padding: '4px 10px' }}
              >
                →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminDashboard;