import { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function QuestionBank() {
  const [questions, setQuestions] = useState<any[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filter & pagination
  const [selectedModule, setSelectedModule] = useState<string>('');
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [currentPage, setCurrentPage] = useState(1);

  // Bulk delete
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  useEffect(() => {
    loadQuestions();
    loadModules();
  }, []);


  const loadQuestions = async () => {
    try {
      const res = await adminApi.getQuestions();
      setQuestions(res.data);
      setSelectedIds(new Set());
    } catch (error) {
      console.error(error);
    }
  };

  const loadModules = async () => {
    try {
      const res = await adminApi.getModules();
      setModules(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    setMessage('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await adminApi.importQuestions(formData);
      setMessage(`Imported: ${res.data.imported}, Updated: ${res.data.updated}`);
      loadQuestions();
      loadModules();
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error: any) {
      setMessage('Error: ' + (error.response?.data?.error || error.message));
    }
    setLoading(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this question?')) return;
    try {
      await adminApi.deleteQuestion(id);
      loadQuestions();
    } catch (error) {
      console.error(error);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!confirm(`Delete ${selectedIds.size} selected question(s)?`)) return;
    setBulkDeleting(true);
    try {
      await adminApi.deleteQuestions(Array.from(selectedIds));
      loadQuestions();
    } catch (error: any) {
      alert('Error: ' + (error.response?.data?.error || error.message));
    }
    setBulkDeleting(false);
  };

  // ── Derived data ──────────────────────────────────────────────────────────
  const filtered = useMemo(() =>
    selectedModule ? questions.filter(q => q.module === selectedModule) : questions,
    [questions, selectedModule]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  const paginated = useMemo(() =>
    filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize]
  );

  const pageIds = useMemo(() => paginated.map((q: any) => q.id as string), [paginated]);
  const allPageSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
  const somePageSelected = pageIds.some(id => selectedIds.has(id));

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleModuleChange = (mod: string) => {
    setSelectedModule(mod);
    setCurrentPage(1);
    setSelectedIds(new Set());
  };

  const handlePageSizeChange = (size: PageSize) => {
    setPageSize(size);
    setCurrentPage(1);
    setSelectedIds(new Set());
  };

  const toggleSelectId = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pageIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        pageIds.forEach(id => next.add(id));
        return next;
      });
    }
  };

  // ── Pagination helpers ────────────────────────────────────────────────────
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

  const levelStyle = (level: string) => ({
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    background: level === 'Easy' ? '#dcfce7' : level === 'Medium' ? '#fef3c7' : '#fee2e2',
    color: level === 'Easy' ? '#166534' : level === 'Medium' ? '#92400e' : '#dc2626',
  });

  return (
    <div className="container">
      <div className="header">
        <h1>Question Bank</h1>
        <Link to="/admin/dashboard" className="btn btn-secondary">Back to Dashboard</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/settings">AI Settings</Link>
      </div>

      {/* ── Import card ── */}
      <div className="card">
        <h3>Import Questions from Excel</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 20 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={e => setFile(e.target.files?.[0] || null)}
            style={{ width: 'auto' }}
          />
          <button onClick={handleImport} disabled={!file || loading} className="btn btn-primary">
            {loading ? 'Importing...' : 'Import'}
          </button>
        </div>
        {message && <p className={message.includes('Error') ? 'error' : 'success'}>{message}</p>}
      </div>

      {/* ── Questions card ── */}
      <div className="card">
        {/* Header row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>
            Questions&nbsp;
            <span style={{ color: 'var(--text-light)', fontWeight: 400, fontSize: 15 }}>
              ({filtered.length}{selectedModule ? ` in "${selectedModule}"` : ''} / {questions.length} total)
            </span>
          </h3>
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="btn btn-danger"
              style={{ fontSize: 13 }}
            >
              {bulkDeleting ? 'Deleting...' : `Delete (${selectedIds.size}) Selected`}
            </button>
          )}
        </div>

        {/* Filter & page size row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 13, color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
              Filter by Module:
            </label>
            <select
              id="module-filter"
              value={selectedModule}
              onChange={e => handleModuleChange(e.target.value)}
              style={{ fontSize: 13, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer', minWidth: 160 }}
            >
              <option value="">All Modules</option>
              {modules.map(mod => (
                <option key={mod} value={mod}>{mod}</option>
              ))}
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
            <label style={{ fontSize: 13, color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
              Show:
            </label>
            <select
              id="page-size-selector"
              value={pageSize}
              onChange={e => handlePageSizeChange(Number(e.target.value) as PageSize)}
              style={{ fontSize: 13, padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer' }}
            >
              {PAGE_SIZE_OPTIONS.map(s => (
                <option key={s} value={s}>{s} / page</option>
              ))}
            </select>
          </div>
        </div>

        {/* Table */}
        <table>
          <thead>
            <tr>
              <th style={{ width: 36, textAlign: 'center' }}>
                <input
                  type="checkbox"
                  id="select-all-checkbox"
                  checked={allPageSelected}
                  ref={el => { if (el) el.indeterminate = somePageSelected && !allPageSelected; }}
                  onChange={toggleSelectAll}
                  disabled={pageIds.length === 0}
                  style={{ cursor: 'pointer', width: 15, height: 15 }}
                />
              </th>
              <th>ID</th>
              <th>Type</th>
              <th>Level</th>
              <th>Module</th>
              <th>Question</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {paginated.map((q: any) => (
              <tr
                key={q.id}
                style={{ background: selectedIds.has(q.id) ? 'rgba(99,102,241,0.07)' : undefined }}
              >
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(q.id)}
                    onChange={() => toggleSelectId(q.id)}
                    style={{ cursor: 'pointer', width: 15, height: 15 }}
                  />
                </td>
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{q.id}</td>
                <td>{q.type}</td>
                <td>
                  <span style={levelStyle(q.level)}>{q.level}</span>
                </td>
                <td>{q.module}</td>
                <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {q.question_sample}
                </td>
                <td>
                  <button
                    onClick={() => handleDelete(q.id)}
                    className="btn btn-danger"
                    style={{ fontSize: 12, padding: '4px 10px' }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-light)', padding: '24px 0' }}>
                  {questions.length === 0 ? 'No questions yet. Import from Excel.' : 'No questions match the selected filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
            <span style={{ fontSize: 13, color: 'var(--text-light)' }}>
              Page {currentPage} of {totalPages} &nbsp;·&nbsp;
              {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filtered.length)} of {filtered.length}
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

export default QuestionBank;