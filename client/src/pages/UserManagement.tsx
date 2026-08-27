import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { Users, ArrowLeft, ShieldAlert, Plus, Trash2, UserCog, Clock, KeyRound } from 'lucide-react';
import AdminNav from '../components/AdminNav';

function UserManagement() {
  const { isAdmin, isLoading } = useAuth();
  const navigate = useNavigate();

  const [users, setUsers] = useState<any[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'mod'>('mod');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetTarget, setResetTarget] = useState<{ id: number; username: string } | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirm, setResetPasswordConfirm] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState('');
  const [resetSaving, setResetSaving] = useState(false);

  // Chặn mod truy cập trang này (backend cũng chặn — đây chỉ là UX).
  useEffect(() => {
    if (!isLoading && !isAdmin) {
      navigate('/admin/dashboard');
    }
  }, [isAdmin, isLoading, navigate]);

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin]);

  useEffect(() => {
    if (!resetTarget) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !resetSaving) {
        setResetTarget(null);
        setResetPassword('');
        setResetPasswordConfirm('');
        setResetError('');
        setResetSuccess('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [resetTarget, resetSaving]);

  const loadUsers = async () => {
    try {
      const res = await adminApi.getUsers();
      setUsers(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await adminApi.createUser(username.trim(), password, role);
      setUsername('');
      setPassword('');
      setRole('mod');
      await loadUsers();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create user');
    }
    setSaving(false);
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`Delete user "${name}"?`)) return;
    try {
      await adminApi.deleteUser(id);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Failed to delete user');
    }
  };

  const openResetPassword = (user: { id: number; username: string }) => {
    setResetTarget(user);
    setResetPassword('');
    setResetPasswordConfirm('');
    setResetError('');
    setResetSuccess('');
    setResetSaving(false);
  };

  const closeResetPassword = () => {
    if (resetSaving) return;
    setResetTarget(null);
    setResetPassword('');
    setResetPasswordConfirm('');
    setResetError('');
    setResetSuccess('');
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;

    setResetError('');
    setResetSuccess('');
    if (resetPassword.length < 8) {
      setResetError('New password must be at least 8 characters.');
      return;
    }
    if (resetPassword !== resetPasswordConfirm) {
      setResetError('Password confirmation does not match.');
      return;
    }

    setResetSaving(true);
    try {
      await adminApi.resetUserPassword(resetTarget.id, resetPassword);
      setResetPassword('');
      setResetPasswordConfirm('');
      setResetSuccess(`Password reset successfully for "${resetTarget.username}".`);
    } catch (err: any) {
      setResetError(err.response?.data?.error || 'Failed to reset password.');
    } finally {
      setResetSaving(false);
    }
  };

  if (isLoading || !isAdmin) return null;

  return (
    <div className="container">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-100 text-purple-600 rounded-lg">
            <Users size={24} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">User Management</h1>
        </div>
        <Link 
          to="/admin/dashboard" 
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={16} />
          <span className="hidden sm:inline">Back to Dashboard</span>
        </Link>
      </div>

      <AdminNav />

      {resetTarget && (
        <div
          onClick={closeResetPassword}
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-password-title"
            aria-describedby="reset-password-description"
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-2xl shadow-xl max-w-md w-full overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <h3 id="reset-password-title" className="font-bold text-lg text-slate-800 m-0 border-none pb-0">
                Reset Password
              </h3>
              <button
                type="button"
                aria-label="Close reset password dialog"
                disabled={resetSaving}
                className="text-slate-400 hover:text-slate-600 hover:bg-slate-200 p-1 rounded-md transition-colors disabled:opacity-50"
                onClick={closeResetPassword}
              >
                &#10005;
              </button>
            </div>

            <form onSubmit={handleResetPassword} aria-busy={resetSaving} className="p-6 space-y-4">
              <p id="reset-password-description" className="text-sm text-slate-600 m-0">
                Set a new password for <span className="font-semibold text-slate-900">{resetTarget.username}</span>.
              </p>

              <div>
                <label htmlFor="reset-new-password" className="block text-sm font-medium text-slate-700 mb-1.5">
                  New Password <span className="text-slate-400 font-normal">(min 8 chars)</span>
                </label>
                <input
                  id="reset-new-password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={resetSaving}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-60"
                />
              </div>

              <div>
                <label htmlFor="reset-confirm-password" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Confirm New Password
                </label>
                <input
                  id="reset-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  value={resetPasswordConfirm}
                  onChange={(e) => setResetPasswordConfirm(e.target.value)}
                  required
                  minLength={8}
                  disabled={resetSaving}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-60"
                />
              </div>

              <div aria-live="polite">
                {resetError && (
                  <div role="alert" className="bg-red-50 text-red-600 px-3 py-2 rounded-lg text-sm font-medium">
                    {resetError}
                  </div>
                )}
                {resetSuccess && (
                  <div role="status" className="bg-emerald-50 text-emerald-600 px-3 py-2 rounded-lg text-sm font-medium">
                    {resetSuccess}
                  </div>
                )}
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeResetPassword}
                  disabled={resetSaving}
                  className="px-4 py-2.5 bg-white text-slate-700 border border-slate-300 font-medium rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetSaving}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  <KeyRound size={16} />
                  {resetSaving ? 'Resetting...' : 'Reset Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-8">
        <div className="lg:col-span-1">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden sticky top-8">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center gap-2">
              <UserCog size={18} className="text-slate-500" />
              <h3 className="font-bold text-slate-900 m-0 border-none pb-0 text-base">Create User</h3>
            </div>
            
            <div className="p-5">
              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Username</label>
                  <input 
                    value={username} 
                    onChange={(e) => setUsername(e.target.value)} 
                    required 
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500 text-sm"
                    placeholder="Enter username"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Password</label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <KeyRound size={14} className="text-slate-400" />
                    </div>
                    <input 
                      type="password" 
                      value={password} 
                      onChange={(e) => setPassword(e.target.value)} 
                      required 
                      minLength={6}
                      className="block w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500 text-sm"
                      placeholder="Min 6 chars"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">Role</label>
                  <select 
                    value={role} 
                    onChange={(e) => setRole(e.target.value as 'admin' | 'mod')}
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 focus:ring-2 focus:ring-blue-500 text-sm"
                  >
                    <option value="mod">Mod</option>
                    <option value="admin">Admin (Full Access)</option>
                  </select>
                  {role === 'mod' && (
                    <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                      Mods cannot manage users or enable screen recording.
                    </p>
                  )}
                </div>
                
                {error && (
                  <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-start gap-2 border border-red-100">
                    <ShieldAlert size={16} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                
                <button 
                  type="submit" 
                  disabled={saving}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 mt-2"
                >
                  <Plus size={16} />
                  {saving ? 'Creating...' : 'Create user'}
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 xl:col-span-3 min-w-0">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
              <h3 className="font-bold text-slate-900 m-0 border-none pb-0 text-base flex items-center gap-2">
                <Users size={18} className="text-slate-500" />
                System Users
                <span className="bg-slate-200 text-slate-700 py-0.5 px-2 rounded-full text-xs ml-2">{users.length}</span>
              </h3>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-5 py-3 font-semibold text-slate-600 w-16">ID</th>
                    <th className="px-5 py-3 font-semibold text-slate-600">Username</th>
                    <th className="px-5 py-3 font-semibold text-slate-600">Role</th>
                    <th className="px-5 py-3 font-semibold text-slate-600">Created At</th>
                    <th className="px-5 py-3 font-semibold text-slate-600 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-5 py-3 text-slate-500 font-mono text-xs">{u.id}</td>
                      <td className="px-5 py-3 font-medium text-slate-900">{u.username}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          u.role === 'admin' 
                            ? 'bg-purple-100 text-purple-700 border border-purple-200' 
                            : 'bg-slate-100 text-slate-700 border border-slate-200'
                        }`}>
                          {u.role === 'admin' && <ShieldAlert size={12} />}
                          {u.role}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-500">
                        <div className="flex items-center gap-1.5">
                          <Clock size={14} className="text-slate-400" />
                          {u.created_at ? new Date(u.created_at).toLocaleString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          }) : '-'}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => openResetPassword({ id: u.id, username: u.username })}
                            aria-label={`Reset password for ${u.username}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-blue-600 border border-blue-200 rounded-lg text-sm font-medium hover:bg-blue-50 hover:border-blue-300 transition-colors"
                          >
                            <KeyRound size={14} />
                            <span className="hidden sm:inline">Reset Password</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(u.id, u.username)}
                            aria-label={`Delete user ${u.username}`}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-50 hover:border-red-300 transition-colors"
                          >
                            <Trash2 size={14} />
                            <span className="hidden sm:inline">Delete</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-12 text-center text-slate-500">
                        <Users size={32} className="mx-auto text-slate-300 mb-3" />
                        <p>No users found in the system.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default UserManagement;
