import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

interface PracticeExamRow {
  id: number;
  name: string;
  created_at: string;
  batches_count: number;
}

function PracticeManagement() {
  const { isSuperAdmin } = useAuth();
  const [practices, setPractices] = useState<PracticeExamRow[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState('');

  useEffect(() => {
    loadPractices();
  }, []);

  const loadPractices = async () => {
    try {
      const res = await adminApi.getPracticeExams();
      setPractices(res.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load practice exams');
    }
  };

  const handleImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!file) {
      setError('Please choose a .docx file');
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('name', name.trim());
      const res = await adminApi.importPractice(formData);
      setSuccess(`Imported "${res.data.name}" successfully`);
      setName('');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadPractices();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Import failed');
    } finally {
      setUploading(false);
    }
  };

  const handlePreview = async (id: number) => {
    setError('');
    try {
      const res = await adminApi.getPracticeExam(id);
      setPreviewName(res.data.name);
      setPreviewHtml(res.data.content_html);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to load preview');
    }
  };

  const handleDelete = async (row: PracticeExamRow) => {
    if (!confirm(`Delete practice exam "${row.name}"? This cannot be undone.`)) return;
    setError('');
    setSuccess('');
    try {
      await adminApi.deletePracticeExam(row.id);
      setSuccess(`Deleted "${row.name}"`);
      loadPractices();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Practice Exams</h1>
        <Link to="/admin/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/practice" className="active">Practice</Link>
        <Link to="/admin/settings">AI Settings</Link>
        {isSuperAdmin && <Link to="/admin/users">User Management</Link>}
      </div>

      {error && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}

      <div className="card" style={{ maxWidth: 600, marginBottom: 24 }}>
        <h3>Import Practice Exam (.docx)</h3>
        <p style={{ color: 'var(--text-light)', fontSize: 14, marginBottom: 16 }}>
          Upload một file đề practice (ví dụ Practice_M3.docx). Toàn bộ nội dung file sẽ
          hiển thị cho học viên làm bài tại trang /practice.
        </p>
        <form onSubmit={handleImport}>
          <div className="form-group">
            <label>Name <span style={{ color: 'var(--text-light)', fontWeight: 400, fontSize: 12 }}>(để trống sẽ lấy theo tên file)</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Practice M3 — Embedded C"
              disabled={uploading}
            />
          </div>
          <div className="form-group">
            <label>File (.docx)</label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".docx"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              disabled={uploading}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={uploading || !file}>
            {uploading ? 'Importing...' : 'Import'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3>Imported Practice Exams</h3>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Used by batches</th>
              <th>Imported</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {practices.length === 0 && (
              <tr><td colSpan={5} style={{ color: 'var(--text-light)' }}>No practice exams imported yet.</td></tr>
            )}
            {practices.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.name}</td>
                <td>{p.batches_count}</td>
                <td>{new Date(p.created_at).toLocaleString()}</td>
                <td style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-secondary" onClick={() => handlePreview(p.id)}>Preview</button>
                  <button
                    className="btn btn-danger"
                    onClick={() => handleDelete(p)}
                    disabled={Number(p.batches_count) > 0}
                    title={Number(p.batches_count) > 0 ? 'In use by batches — delete those batches first' : undefined}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {previewHtml !== null && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
          }}
          onClick={() => setPreviewHtml(null)}
        >
          <div
            className="card"
            style={{ maxWidth: 900, width: '90%', maxHeight: '85vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3>{previewName}</h3>
              <button className="btn btn-secondary" onClick={() => setPreviewHtml(null)}>Close</button>
            </div>
            <div
              className="question-content"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default PracticeManagement;
