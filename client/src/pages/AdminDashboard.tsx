import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import AdminNav from '../components/AdminNav';
import { LayoutDashboard, Users, Clock, UsersRound, FileBarChart, Key, LogOut } from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function AdminDashboard() {
  const [batches, setBatches] = useState<any[]>([]);
  const [stats, setStats] = useState({ totalBatches: 0, totalStudents: 0 });
  const { logout } = useAuth();

  // Phân trang
  const [pageSize, setPageSize] = useState<PageSize>(10);
  const [currentPage, setCurrentPage] = useState(1);

  // Đổi mật khẩu
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
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
            <LayoutDashboard size={24} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">Admin Dashboard</h1>
        </div>
        <div className="flex gap-3">
          <button 
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 hover:text-slate-900 transition-colors shadow-sm"
            onClick={() => { resetPwForm(); setShowChangePw(true); }}
          >
            <Key size={16} />
            <span className="hidden sm:inline">Change Password</span>
          </button>
          <button 
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-red-600 rounded-lg font-medium text-sm hover:bg-red-50 transition-colors shadow-sm"
            onClick={logout}
          >
            <LogOut size={16} />
            <span className="hidden sm:inline">Logout</span>
          </button>
        </div>
      </div>

      {showChangePw && (
        <div
          onClick={() => setShowChangePw(false)}
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        >
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 className="font-bold text-lg text-slate-800 m-0">Change Password</h3>
              <button 
                className="text-slate-400 hover:text-slate-600 hover:bg-slate-200 p-1 rounded-md transition-colors"
                onClick={() => setShowChangePw(false)}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleChangePassword} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Current Password</label>
                <input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} required 
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">New Password <span className="text-slate-400 font-normal">(min 8 chars)</span></label>
                <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} required minLength={8} 
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Confirm New Password</label>
                <input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} required 
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />
              </div>
              
              {pwError && <div className="bg-red-50 text-red-600 px-3 py-2 rounded-lg text-sm font-medium">{pwError}</div>}
              {pwSuccess && <div className="bg-emerald-50 text-emerald-600 px-3 py-2 rounded-lg text-sm font-medium">{pwSuccess}</div>}
              
              <div className="pt-2">
                <button type="submit" className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50" disabled={pwSaving}>
                  {pwSaving ? 'Saving Changes...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex items-center gap-5">
          <div className="p-4 bg-indigo-50 text-indigo-600 rounded-2xl">
            <LayoutDashboard size={32} />
          </div>
          <div>
            <h3 className="text-slate-500 text-sm font-medium uppercase tracking-wider mb-1 m-0">Total Batches</h3>
            <p className="text-3xl font-bold text-slate-900 m-0">{stats.totalBatches}</p>
          </div>
        </div>
        
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex items-center gap-5">
          <div className="p-4 bg-emerald-50 text-emerald-600 rounded-2xl">
            <Users size={32} />
          </div>
          <div>
            <h3 className="text-slate-500 text-sm font-medium uppercase tracking-wider mb-1 m-0">Total Students</h3>
            <p className="text-3xl font-bold text-slate-900 m-0">{stats.totalStudents}</p>
          </div>
        </div>
      </div>

      <AdminNav />

      <div className="card mt-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4 border-b border-slate-100 pb-4 m-0">
          <h3 className="text-lg font-bold text-slate-800 flex items-center gap-2 m-0 border-none pb-0">
            Recent Assessment Batches
            <span className="bg-slate-100 text-slate-600 py-0.5 px-2.5 rounded-full text-xs font-medium">
              {batches.length} total
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-500 font-medium">Show:</label>
            <select
              value={pageSize}
              onChange={e => handlePageSizeChange(Number(e.target.value) as PageSize)}
              className="pl-3 pr-8 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
            >
              {PAGE_SIZE_OPTIONS.map(s => (
                <option key={s} value={s}>{s} rows</option>
              ))}
            </select>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/50">
                <th className="py-3 px-4 font-semibold text-slate-600 text-sm border-b border-slate-200 uppercase tracking-wider">Name</th>
                <th className="py-3 px-4 font-semibold text-slate-600 text-sm border-b border-slate-200 uppercase tracking-wider">Duration</th>
                <th className="py-3 px-4 font-semibold text-slate-600 text-sm border-b border-slate-200 uppercase tracking-wider text-right">Management</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paginatedBatches.map(batch => (
                <tr key={batch.id} className="hover:bg-slate-50/50 transition-colors">
                  <td className="py-4 px-4 text-slate-800 font-medium">{batch.name}</td>
                  <td className="py-4 px-4 text-slate-600">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 text-slate-700 rounded-md text-sm">
                      <Clock size={14} />
                      {batch.duration} min
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Link 
                        to={`/admin/batches/${batch.id}/students`} 
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 rounded-lg text-sm font-medium transition-colors"
                      >
                        <UsersRound size={16} />
                        <span className="hidden sm:inline">Students</span>
                      </Link>
                      <Link 
                        to={`/admin/batches/${batch.id}/results`} 
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg text-sm font-medium transition-colors"
                      >
                        <FileBarChart size={16} />
                        <span className="hidden sm:inline">Results</span>
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
              {batches.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-12 text-center text-slate-500 font-medium">
                    No assessment batches created yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-6 pt-4 border-t border-slate-100">
            <span className="text-sm text-slate-500">
              Showing <span className="font-medium text-slate-900">{(currentPage - 1) * pageSize + 1}</span> to <span className="font-medium text-slate-900">{Math.min(currentPage * pageSize, batches.length)}</span> of <span className="font-medium text-slate-900">{batches.length}</span> results
            </span>
            <div className="flex gap-1.5 items-center">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-md text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                Previous
              </button>
              
              <div className="hidden sm:flex gap-1">
                {getPageNumbers().map((p, i) =>
                  p === '...' ? (
                    <span key={`ellipsis-${i}`} className="px-2 py-1 text-slate-400">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setCurrentPage(p as number)}
                      className={`w-8 h-8 flex items-center justify-center rounded-md text-sm font-medium transition-colors ${
                        currentPage === p 
                          ? 'bg-blue-600 text-white shadow-sm' 
                          : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {p}
                    </button>
                  )
                )}
              </div>
              
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-md text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminDashboard;