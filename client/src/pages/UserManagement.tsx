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

  // Chặn mod truy cập trang này (backend cũng chặn — đây chỉ là UX).
  useEffect(() => {
    if (!isLoading && !isAdmin) {
      navigate('/admin/dashboard');
    }
  }, [isAdmin, isLoading, navigate]);

  useEffect(() => {
    if (isAdmin) loadUsers();
  }, [isAdmin]);

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
                        <button 
                          onClick={() => handleDelete(u.id, u.username)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-50 hover:border-red-300 transition-colors"
                        >
                          <Trash2 size={14} />
                          <span className="hidden sm:inline">Delete</span>
                        </button>
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
