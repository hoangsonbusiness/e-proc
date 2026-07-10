import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { adminApi } from '../services/api';

function StudentManagement() {
  const { id } = useParams<{ id: string }>();
  const [students, setStudents] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [emails, setEmails] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    loadBatch();
    loadStudents();
  }, [id]);


  const loadBatch = async () => {
    try {
      const res = await adminApi.getBatch(parseInt(id!));
      setBatch(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const loadStudents = async () => {
    try {
      const res = await adminApi.getStudents(parseInt(id!));
      setStudents(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (!emails.trim()) return;
    setLoading(true);
    setMessage('');
    try {
      const emailList = emails.split('\n').map(e => e.trim()).filter(e => e);
      await adminApi.importStudents(parseInt(id!), emailList);
      setMessage(`Imported ${emailList.length} students`);
      setEmails('');
      loadStudents();
    } catch (error: any) {
      setMessage('Error: ' + (error.response?.data?.error || error.message));
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const res = await adminApi.exportStudents(parseInt(id!));
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `students-${id}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error(error);
    }
  };

  const handleDelete = async (studentId: number, email: string) => {
    if (!confirm(`Are you sure you want to delete ${email}? This will also delete all exam data associated with this student.`)) return;
    try {
      await adminApi.deleteStudent(studentId);
      loadStudents();
    } catch (error: any) {
      alert('Error: ' + (error.response?.data?.error || error.message));
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Student Management - {batch?.name}</h1>
        <Link to="/admin/batches" className="btn btn-secondary">Back to Batches</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/settings">AI Settings</Link>
      </div>

      <div className="card">
        <h3>Import Students</h3>
        <p style={{ color: 'var(--text-light)', marginBottom: 10 }}>
          Enter email addresses (one per line)
        </p>
        <textarea 
          rows={6}
          value={emails}
          onChange={e => setEmails(e.target.value)}
          placeholder="student1@example.com&#10;student2@example.com&#10;student3@example.com"
        />
        <div style={{ marginTop: 10 }}>
          <button onClick={handleImport} disabled={!emails.trim() || loading} className="btn btn-primary">
            {loading ? 'Importing...' : 'Import Emails'}
          </button>
          {message && <span style={{ marginLeft: 10 }} className={message.includes('Error') ? 'error' : 'success'}>{message}</span>}
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 }}>
          <h3>Students ({students.length})</h3>
          <button onClick={handleExport} disabled={students.length === 0} className="btn btn-secondary">
            Export Codes
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Email</th>
              <th>Access Code</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {students.map(s => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.email}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 16, letterSpacing: 1 }}>{s.access_code}</td>
                <td>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                    background: s.status === 'submitted' ? '#dcfce7' : s.status === 'in_progress' ? '#fef3c7' : '#f1f5f9',
                    color: s.status === 'submitted' ? '#166534' : s.status === 'in_progress' ? '#92400e' : '#64748b'
                  }}>
                    {s.status}
                  </span>
                </td>
                <td>
                  <button 
                    onClick={() => handleDelete(s.id, s.email)}
                    style={{ 
                      padding: '4px 8px', 
                      fontSize: 12,
                      background: 'var(--danger)',
                      color: 'white',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer'
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {students.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-light)' }}>No students imported yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default StudentManagement;