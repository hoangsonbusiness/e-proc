import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';

function AdminDashboard() {
  const [batches, setBatches] = useState<any[]>([]);
  const [stats, setStats] = useState({ totalBatches: 0, activeBatches: 0, totalStudents: 0 });

  useEffect(() => {
    const auth = localStorage.getItem('adminAuth');
    if (!auth) {
      window.location.href = '/admin';
      return;
    }
    loadBatches();
  }, []);

  const loadBatches = async () => {
    try {
      const res = await adminApi.getBatches();
      setBatches(res.data);
      const active = res.data.filter((b: any) => b.status === 'active').length;
      const students = res.data.reduce((sum: number, b: any) => sum + Number(b.students_count || 0), 0);
      setStats({ totalBatches: res.data.length, activeBatches: active, totalStudents: students });
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Admin Dashboard</h1>
        <button className="btn btn-secondary" onClick={() => { localStorage.removeItem('adminAuth'); window.location.href = '/admin'; }}>
          Logout
        </button>
      </div>
      
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 30 }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ color: 'var(--text-light)' }}>Total Batches</h3>
          <p style={{ fontSize: 32, fontWeight: 600 }}>{stats.totalBatches}</p>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ color: 'var(--text-light)' }}>Active Batches</h3>
          <p style={{ fontSize: 32, fontWeight: 600, color: 'var(--success)' }}>{stats.activeBatches}</p>
        </div>
        <div className="card" style={{ textAlign: 'center' }}>
          <h3 style={{ color: 'var(--text-light)' }}>Total Students</h3>
          <p style={{ fontSize: 32, fontWeight: 600, color: 'var(--primary)' }}>{stats.totalStudents}</p>
        </div>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/settings">AI Settings</Link>
      </div>

      <div className="card">
        <h3>Recent Batches</h3>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batches.map(batch => (
              <tr key={batch.id}>
                <td>{batch.name}</td>
                <td>
                  <span style={{ 
                    padding: '4px 8px', 
                    borderRadius: 4, 
                    background: batch.status === 'active' ? '#dcfce7' : '#f1f5f9',
                    color: batch.status === 'active' ? '#166534' : '#64748b'
                  }}>
                    {batch.status}
                  </span>
                </td>
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
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text-light)' }}>No batches yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default AdminDashboard;