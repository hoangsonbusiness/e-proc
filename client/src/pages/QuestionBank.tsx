import { useState, useEffect, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import AdminNav from '../components/AdminNav';
import { Database, ArrowLeft, Upload, FileSpreadsheet, Trash2, Search, Filter, AlertCircle, FileQuestion, ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function QuestionBank() {
  const { isAdmin, userId } = useAuth();
  const [questions, setQuestions] = useState<any[]>([]);
  const [modules, setModules] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filter & pagination
  const [selectedModule, setSelectedModule] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'essay' | 'quiz'>('all');
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

  const handleImport = async (mode: 'essay' | 'quiz' = 'essay') => {
    if (!file) return;
    setLoading(true);
    setMessage('');
    setIsError(false);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = mode === 'quiz'
        ? await adminApi.importQuizQuestions(formData)
        : await adminApi.importQuestions(formData);
      let msg = `Imported: ${res.data.imported}, Updated: ${res.data.updated}`;
      if (res.data.skipped) msg += `, Skipped: ${res.data.skipped}`;
      if (res.data.errors?.length) {
        msg += ` — Lỗi: ${res.data.errors.join('; ')}`;
        setIsError(true);
      }
      setMessage(msg);
      loadQuestions();
      loadModules();
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error: any) {
      setIsError(true);
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
      setSelectedIds(new Set());
    } catch (error: any) {
      alert('Error: ' + (error.response?.data?.error || error.message));
    }
    setBulkDeleting(false);
  };

  /** Mod chỉ được xóa question mình upload; admin xóa tất cả */
  const canDeleteQuestion = (q: any) => isAdmin || q.uploaded_by === userId;

  /** Với mod: chỉ cho chọn checkbox những question của mình */
  const isSelectable = (q: any) => isAdmin || q.uploaded_by === userId;

  // ── Derived data ──────────────────────────────────────────────────────────
  const QUIZ_TYPES = ['SingleChoice', 'MultipleChoice'];
  const filtered = useMemo(() =>
    questions.filter(q => {
      if (selectedModule && q.module !== selectedModule) return false;
      if (selectedCategory === 'quiz') return QUIZ_TYPES.includes(q.type);
      if (selectedCategory === 'essay') return !QUIZ_TYPES.includes(q.type);
      return true;
    }),
    [questions, selectedModule, selectedCategory]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  const paginated = useMemo(() =>
    filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filtered, currentPage, pageSize]
  );

  // Chỉ những question mod có quyền select (mình upload hoặc admin)
  const selectablePageIds = useMemo(() =>
    paginated.filter((q: any) => isSelectable(q)).map((q: any) => q.id as string),
    [paginated, isAdmin, userId]
  );
  const allPageSelected = selectablePageIds.length > 0 && selectablePageIds.every(id => selectedIds.has(id));
  const somePageSelected = selectablePageIds.some(id => selectedIds.has(id));

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

  const toggleSelectId = (id: string, q: any) => {
    if (!isSelectable(q)) return; // mod không được chọn question người khác
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
        selectablePageIds.forEach(id => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        selectablePageIds.forEach(id => next.add(id));
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

  return (
    <div className="container">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-100 text-amber-600 rounded-lg">
            <Database size={24} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">Question Bank</h1>
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

      {/* ── Import card ── */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
          <h3 className="font-bold text-slate-900 m-0 border-none pb-0 flex items-center gap-2">
            <Upload size={18} className="text-slate-500" />
            Import Questions from Excel
          </h3>
        </div>
        <div className="p-6">
          <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center mb-4">
            <div className="relative flex-1 max-w-md">
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={e => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-slate-500
                  file:mr-4 file:py-2.5 file:px-4
                  file:rounded-lg file:border-0
                  file:text-sm file:font-medium
                  file:bg-blue-50 file:text-blue-700
                  hover:file:bg-blue-100
                  border border-slate-200 rounded-lg bg-slate-50 cursor-pointer"
              />
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => handleImport('essay')} 
                disabled={!file || loading} 
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
              >
                <FileSpreadsheet size={16} />
                {loading ? 'Importing...' : 'Import Essay'}
              </button>
              <button 
                onClick={() => handleImport('quiz')} 
                disabled={!file || loading} 
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-white text-slate-700 border border-slate-300 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm disabled:opacity-50"
              >
                <FileQuestion size={16} />
                {loading ? 'Importing...' : 'Import Quiz'}
              </button>
            </div>
          </div>
          
          <div className="bg-slate-50 rounded-lg p-3 border border-slate-100 inline-block w-full md:w-auto">
            <p className="text-xs text-slate-500 m-0 flex items-center gap-1.5">
              <AlertCircle size={14} className="text-slate-400" />
              <span className="font-semibold text-slate-700">Quiz template:</span> ID | Type (SingleChoice/MultipleChoice) | Level | Topic | Question Sample | Option A…F | Correct | Score
            </p>
          </div>
          
          {message && (
            <div className={`mt-4 p-3 rounded-lg text-sm font-medium border ${isError ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
              {message}
            </div>
          )}
        </div>
      </div>

      {/* ── Questions card ── */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        {/* Header row */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <h3 className="font-bold text-slate-900 m-0 border-none pb-0 flex items-center gap-2">
            <Database size={18} className="text-slate-500" />
            Questions Library
            <span className="bg-slate-200 text-slate-700 py-0.5 px-2 rounded-full text-xs font-medium ml-2">
              {filtered.length} {selectedModule ? `in ${selectedModule}` : 'total'}
            </span>
          </h3>
          
          {selectedIds.size > 0 && (
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-100 transition-colors"
            >
              <Trash2 size={16} />
              {bulkDeleting ? 'Deleting...' : `Delete (${selectedIds.size}) Selected`}
            </button>
          )}
        </div>

        {/* Filter & page size row */}
        <div className="p-4 border-b border-slate-100 bg-white flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
              <Filter size={14} className="text-slate-400" /> Module
            </label>
            <select
              value={selectedModule}
              onChange={e => handleModuleChange(e.target.value)}
              className="block w-40 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-sm focus:ring-2 focus:ring-blue-500"
            >
              <option value="">All Modules</option>
              {modules.map(mod => (
                <option key={mod} value={mod}>{mod}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-slate-600 flex items-center gap-1.5">
              <FileQuestion size={14} className="text-slate-400" /> Type
            </label>
            <select
              value={selectedCategory}
              onChange={e => { setSelectedCategory(e.target.value as 'all' | 'essay' | 'quiz'); setCurrentPage(1); setSelectedIds(new Set()); }}
              className="block w-36 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-sm focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Types</option>
              <option value="essay">Essay / Coding</option>
              <option value="quiz">Quiz</option>
            </select>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <label className="text-sm font-medium text-slate-600">Show</label>
            <select
              value={pageSize}
              onChange={e => handlePageSizeChange(Number(e.target.value) as PageSize)}
              className="block w-24 px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-sm focus:ring-2 focus:ring-blue-500"
            >
              {PAGE_SIZE_OPTIONS.map(s => (
                <option key={s} value={s}>{s} / page</option>
              ))}
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="px-4 py-3 text-center w-12">
                  <input
                    type="checkbox"
                    checked={allPageSelected}
                    ref={el => { if (el) el.indeterminate = somePageSelected && !allPageSelected; }}
                    onChange={toggleSelectAll}
                    disabled={selectablePageIds.length === 0}
                    className="w-4 h-4 text-blue-600 bg-slate-100 border-slate-300 rounded focus:ring-blue-500 disabled:opacity-50 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 font-semibold text-slate-600 whitespace-nowrap">ID</th>
                <th className="px-4 py-3 font-semibold text-slate-600 whitespace-nowrap">Type</th>
                <th className="px-4 py-3 font-semibold text-slate-600 whitespace-nowrap">Level</th>
                <th className="px-4 py-3 font-semibold text-slate-600 whitespace-nowrap">Module</th>
                <th className="px-4 py-3 font-semibold text-slate-600 w-1/2">Question</th>
                <th className="px-4 py-3 font-semibold text-slate-600 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paginated.map((q: any) => {
                const deletable = canDeleteQuestion(q);
                const selectable = isSelectable(q);
                const isSelected = selectedIds.has(q.id);
                
                return (
                  <tr
                    key={q.id}
                    className={`transition-colors ${isSelected ? 'bg-indigo-50/50' : 'hover:bg-slate-50/50'}`}
                  >
                    <td className="px-4 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelectId(q.id, q)}
                        disabled={!selectable}
                        className="w-4 h-4 text-blue-600 bg-slate-100 border-slate-300 rounded focus:ring-blue-500 disabled:opacity-30 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{q.id}</td>
                    <td className="px-4 py-3 text-slate-700 whitespace-nowrap">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                        {q.type}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                        q.level === 'Easy' ? 'bg-emerald-100 text-emerald-700' :
                        q.level === 'Medium' ? 'bg-amber-100 text-amber-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        {q.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-800 whitespace-nowrap">{q.module}</td>
                    <td className="px-4 py-3">
                      <div className="max-w-xs md:max-w-md lg:max-w-xl xl:max-w-3xl truncate text-slate-600" title={q.question_sample}>
                        {q.question_sample}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {deletable ? (
                        <button
                          onClick={() => handleDelete(q.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white text-red-600 border border-red-200 rounded-lg text-sm font-medium hover:bg-red-50 hover:border-red-300 transition-colors"
                          title="Delete question"
                        >
                          <Trash2 size={14} />
                          <span>Delete</span>
                        </button>
                      ) : (
                        <span className="inline-block px-2 text-slate-300">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {paginated.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Search size={32} className="text-slate-300" />
                      <p>{questions.length === 0 ? 'No questions yet. Import from Excel to get started.' : 'No questions match the selected filters.'}</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4">
            <span className="text-sm text-slate-500 font-medium">
              Showing <span className="text-slate-900">{(currentPage - 1) * pageSize + 1}</span> to <span className="text-slate-900">{Math.min(currentPage * pageSize, filtered.length)}</span> of <span className="text-slate-900">{filtered.length}</span> questions
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-100 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
              >
                <ChevronLeft size={16} />
              </button>
              
              <div className="hidden sm:flex items-center gap-1 mx-2">
                {getPageNumbers().map((p, i) =>
                  p === '...' ? (
                    <span key={`ellipsis-${i}`} className="px-2 text-slate-400">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setCurrentPage(p as number)}
                      className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                        currentPage === p 
                          ? 'bg-blue-600 text-white shadow-sm' 
                          : 'text-slate-600 hover:bg-slate-100'
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
                className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-100 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default QuestionBank;
