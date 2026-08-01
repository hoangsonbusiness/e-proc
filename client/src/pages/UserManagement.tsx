import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface AdminUserRow {
  id: number;
  username: string;
  role: 'admin' | 'superadmin';
  created_at: string;
}

function UserManagement() {
  const { role: currentRole } = useAuth();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'superadmin'>('admin');
  const [creating, setCreating] = useState(false);

  const [resetPasswordId, setResetPasswordId] = useState<number | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');

  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    try {
      const res = await adminApi.listUsers();
      setUsers(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load admin users');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!newUsername.trim() || newPassword.length < 8) {
      setError('Username is required and password must be at least 8 characters');
      return;
    }

    setCreating(true);
    try {
      await adminApi.createUser(newUsername.trim(), newPassword, newRole);
      setSuccess(`Account "${newUsername.trim()}" created`);
      setNewUsername('');
      setNewPassword('');
      setNewRole('admin');
      loadUsers();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to create account');
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (user: AdminUserRow, role: 'admin' | 'superadmin') => {
    setError('');
    setSuccess('');
    try {
      await adminApi.updateUser(user.id, { role });
      setSuccess(`Updated role for "${user.username}"`);
      loadUsers();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update role');
    }
  };

  const handleResetPassword = async (userId: number) => {
    if (resetPasswordValue.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }
    setError('');
    setSuccess('');
    try {
      await adminApi.updateUser(userId, { password: resetPasswordValue });
      setSuccess('Password reset successfully');
      setResetPasswordId(null);
      setResetPasswordValue('');
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to reset password');
    }
  };

  const handleDelete = async (user: AdminUserRow) => {
    if (!confirm(`Delete admin account "${user.username}"? This cannot be undone.`)) {
      return;
    }
    setError('');
    setSuccess('');
    try {
      await adminApi.deleteUser(user.id);
      setSuccess(`Deleted "${user.username}"`);
      loadUsers();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete account');
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>User Management</h1>
        <Link to="/admin/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/practice">Practice</Link>
        <Link to="/admin/settings">AI Settings</Link>
        <Link to="/admin/users" className="active">User Management</Link>
      </div>

      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}

      <div className="card" style={{ maxWidth: 600, marginBottom: 24 }}>
        <h3>Create Admin Account</h3>
        <form onSubmit={handleCreate}>
          <div className="form-group">
            <label>Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={creating}
            />
          </div>
          <div className="form-group">
            <label>Password <span style={{ color: 'var(--text-light)', fontWeight: 400, fontSize: 12 }}>(min 8 characters)</span></label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={creating}
            />
          </div>
          <div className="form-group">
            <label>Role</label>
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'admin' | 'superadmin')} disabled={creating}>
              <option value="admin">Admin</option>
              <option value="superadmin">Superadmin</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Creating...' : 'Create Account'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Admin Accounts</h3>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.username}</td>
                <td>
                  <select
                    value={user.role}
                    onChange={(e) => handleRoleChange(user, e.target.value as 'admin' | 'superadmin')}
                  >
                    <option value="admin">Admin</option>
                    <option value="superadmin">Superadmin</option>
                  </select>
                </td>
                <td>{new Date(user.created_at).toLocaleString()}</td>
                <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {resetPasswordId === user.id ? (
                    <>
                      <input
                        type="password"
                        placeholder="New password"
                        value={resetPasswordValue}
                        onChange={(e) => setResetPasswordValue(e.target.value)}
                        style={{ width: 140 }}
                      />
                      <button className="btn btn-primary" onClick={() => handleResetPassword(user.id)}>Save</button>
                      <button className="btn btn-secondary" onClick={() => { setResetPasswordId(null); setResetPasswordValue(''); }}>Cancel</button>
                    </>
                  ) : (
                    <button className="btn btn-secondary" onClick={() => { setResetPasswordId(user.id); setResetPasswordValue(''); }}>
                      Reset Password
                    </button>
                  )}
                  <button className="btn btn-danger" onClick={() => handleDelete(user)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ color: 'var(--text-light)', fontSize: 12, marginTop: 16 }}>
        You are signed in as: <strong>{currentRole}</strong>
      </p>
    </div>
  );
}

export default UserManagement;
