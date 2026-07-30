import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

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
      setError(err.response?.data?.error || 'Không tạo được user');
    }
    setSaving(false);
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`Xóa user "${name}"?`)) return;
    try {
      await adminApi.deleteUser(id);
      await loadUsers();
    } catch (err: any) {
      alert(err.response?.data?.error || 'Không xóa được user');
    }
  };

  if (isLoading || !isAdmin) return null;

  return (
    <div className="container">
      <div className="header">
        <h1>Quản lý User</h1>
        <Link to="/admin/dashboard" className="btn btn-secondary">← Dashboard</Link>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <h3 style={{ marginBottom: 16 }}>Tạo user mới</h3>
        <form onSubmit={handleCreate} style={{ display: 'grid', gap: 12, maxWidth: 420 }}>
          <div className="form-group">
            <label>Tên đăng nhập</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Mật khẩu (tối thiểu 6 ký tự)</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
          </div>
          <div className="form-group">
            <label>Vai trò</label>
            <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'mod')}>
              <option value="mod">Mod (no user management, cannot enable screen recording)</option>
              <option value="admin">Admin (full access)</option>
            </select>
          </div>
          {error && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Đang tạo...' : 'Tạo user'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 16 }}>Danh sách user</h3>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Tên đăng nhập</th>
              <th>Vai trò</th>
              <th>Ngày tạo</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.username}</td>
                <td>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 12,
                    background: u.role === 'admin' ? '#dbeafe' : '#f3f4f6',
                    color: u.role === 'admin' ? '#1e40af' : '#374151',
                  }}>
                    {u.role}
                  </span>
                </td>
                <td>{u.created_at ? new Date(u.created_at).toLocaleString('vi-VN') : '-'}</td>
                <td>
                  <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => handleDelete(u.id, u.username)}>
                    Xóa
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-light)' }}>Chưa có user</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default UserManagement;
