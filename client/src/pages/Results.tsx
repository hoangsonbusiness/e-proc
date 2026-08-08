import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import AdminNav from '../components/AdminNav';
import { ArrowLeft, Download, Search, AlertCircle, FileText, CheckCircle2, FileJson, X, Settings2, ShieldAlert, Cpu, KeyRound } from 'lucide-react';
import DOMPurify from 'dompurify';

function Results() {
  const { id } = useParams<{ id: string }>();
  const [results, setResults] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [selectedStudent, setSelectedStudent] = useState<any>(null);
  const [editScore, setEditScore] = useState<number | null>(null);
  const [editFeedback, setEditFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Forensic popup: xem chi tiết các lần vi phạm (kèm nội dung paste) của 1 học viên
  const [violationDetail, setViolationDetail] = useState<{ email: string; events: any[] } | null>(null);

  useEffect(() => {
    loadBatch();
    loadResults();
  }, [id]);

  const loadBatch = async () => {
    try {
      const res = await adminApi.getBatch(parseInt(id!));
      setBatch(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const loadResults = async () => {
    setLoading(true);
    try {
      const res = await adminApi.getResults(parseInt(id!));
      setResults(res.data);
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  };

  const handleExport = async () => {
    try {
      const res = await adminApi.exportResults(parseInt(id!));
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `results-${id}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (error) {
      console.error(error);
    }
  };

  const handleSaveScore = async (studentId: number) => {
    setSaving(true);
    try {
      await adminApi.updateResult(studentId, {
        trainer_score: editScore,
        trainer_feedback: editFeedback
      });
      setSelectedStudent(null);
      loadResults();
    } catch (error) {
      console.error(error);
    }
    setSaving(false);
  };

  const getAverageScore = (student: any) => {
    const scores = student.questions?.filter((q: any) => q.ai_score !== null).map((q: any) => q.trainer_score ?? q.ai_score) || [];
    if (scores.length === 0) return '0.0';
    return (scores.reduce((a: number, b: number) => a + Number(b), 0) / scores.length).toFixed(1);
  };

  const sanitizeQuestion = (html: string): string => {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'br', 'p', 'strong', 'em', 'b', 'i', 'u',
        'pre', 'code', 'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'span', 'div', 'blockquote',
        'table', 'thead', 'tbody', 'tr', 'th', 'td'
      ],
      ALLOWED_ATTR: ['class', 'style'],
      FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur'],
    });
  };

  return (
    <div className="container">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-100 text-blue-600 rounded-lg">
            <FileText size={24} />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">Results {batch ? `- ${batch.name}` : ''}</h1>
        </div>
        <Link
          to="/admin/batches"
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm"
        >
          <ArrowLeft size={16} />
          <span className="hidden sm:inline">Back to Batches</span>
        </Link>
      </div>

      <AdminNav />

      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-bold text-slate-800 m-0 border-none pb-0">Student Results ({results.length})</h2>
        <button
          onClick={handleExport}
          disabled={results.length === 0}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium text-sm hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-50"
        >
          <Download size={16} />
          Export Excel
        </button>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center p-12 bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="w-8 h-8 border-4 border-slate-200 border-t-blue-600 rounded-full animate-spin mb-4"></div>
          <p className="text-slate-500 font-medium">Loading results...</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mb-8">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="px-6 py-4 font-semibold text-slate-600">Student</th>
                    <th className="px-6 py-4 font-semibold text-slate-600 text-center">Status</th>
                    <th className="px-6 py-4 font-semibold text-slate-600">Violations</th>
                    <th className="px-6 py-4 font-semibold text-slate-600 text-center">Avg Score</th>
                    <th className="px-6 py-4 font-semibold text-slate-600 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map(r => (
                    <tr key={r.student.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium text-slate-900">{r.student.email}</div>
                        {/* Mật khẩu giải nén video record (mode local). HV không thấy — chỉ admin. */}
                        {r.student.recording_password && (
                          <div className="mt-1.5 flex flex-col gap-1 text-xs text-slate-500">
                            <span className="flex items-center gap-1"><KeyRound size={12} /> Decryption password:</span>
                            <code className="bg-slate-100 text-slate-800 px-2 py-0.5 rounded border border-slate-200 font-mono break-all inline-block w-fit">
                              {r.student.recording_password}
                            </code>
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${r.student.status === 'submitted'
                            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                            : 'bg-amber-100 text-amber-700 border border-amber-200'
                          }`}>
                          {r.student.status === 'submitted' && <CheckCircle2 size={12} />}
                          {r.student.status}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {r.violations > 0 ? (
                          <div className="space-y-2">
                            <span className="inline-flex items-center gap-1.5 text-red-600 font-semibold text-sm">
                              <ShieldAlert size={14} />
                              {r.violations} total
                            </span>
                            {/* Breakdown chi tiết theo type — mọi type đều lockable (badge cam) */}
                            {r.violations_breakdown && Object.keys(r.violations_breakdown).length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-1">
                                {Object.entries(r.violations_breakdown as Record<string, number>)
                                  .sort(([, a], [, b]) => b - a)
                                  .map(([type, count]) => (
                                    <span key={type} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-orange-50 border border-orange-200 text-orange-700 rounded text-[10px] font-mono font-semibold">
                                      <span className="w-1.5 h-1.5 rounded-full bg-orange-500"></span>
                                      {type}: {count}
                                    </span>
                                  ))}
                              </div>
                            )}
                            {/* Forensic: xem nội dung paste / thời điểm từng lần vi phạm */}
                            {r.violation_events && r.violation_events.length > 0 && (
                              <button
                                onClick={() => setViolationDetail({ email: r.student.email, events: r.violation_events })}
                                className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 rounded transition-colors"
                              >
                                <Search size={12} /> View details ({r.violation_events.length})
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400 font-medium">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <span className="inline-block px-3 py-1 bg-slate-100 text-slate-800 font-bold rounded-lg border border-slate-200">
                          {getAverageScore(r)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => {
                            setSelectedStudent(r);
                            const firstQ = r.questions[0];
                            setEditScore(firstQ?.trainer_score ?? firstQ?.ai_score ?? 0);
                            setEditFeedback(firstQ?.trainer_feedback ?? '');
                            // scroll to review section
                            setTimeout(() => {
                              document.getElementById('review-section')?.scrollIntoView({ behavior: 'smooth' });
                            }, 100);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg text-sm font-medium hover:bg-blue-100 transition-colors"
                        >
                          <Settings2 size={14} />
                          Review
                        </button>
                      </td>
                    </tr>
                  ))}
                  {results.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-6 py-12 text-center text-slate-500">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <FileJson size={32} className="text-slate-300" />
                          <p>No results available for this batch yet.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selectedStudent && (
            <div id="review-section" className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden scroll-mt-24">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                <h3 className="font-bold text-slate-900 m-0 border-none pb-0">Review: <span className="text-blue-600 font-mono text-sm">{selectedStudent.student.email}</span></h3>
                <button onClick={() => setSelectedStudent(null)} className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-md transition-colors">
                  <X size={18} />
                </button>
              </div>

              <div className="p-6 space-y-6">
                {/* All Questions */}
                {selectedStudent.questions.map((q: any, index: number) => (
                  <div key={q.id} className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
                    <div className="px-5 py-3 bg-slate-100/50 border-b border-slate-200 flex justify-between items-center">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-100 text-blue-700 text-xs font-bold">
                          {index + 1}
                        </span>
                        <strong className="text-slate-800 text-sm">
                          {q.module} ({q.level}) - {q.type}
                        </strong>
                      </div>
                      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold border ${q.ai_score >= 7 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                          q.ai_score >= 5 ? 'bg-amber-50 text-amber-700 border-amber-200' :
                            'bg-red-50 text-red-700 border-red-200'
                        }`}>
                        <Cpu size={12} /> AI Score: {q.ai_score ?? '-'}
                      </span>
                    </div>

                    <div className="p-5 space-y-4">
                      <div>
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 block">Question</span>
                        <div
                          className="prose prose-sm prose-slate max-w-none text-slate-900 leading-relaxed"
                          dangerouslySetInnerHTML={{ __html: sanitizeQuestion(q.question_sample || '') }}
                        />
                      </div>

                      <div>
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 block">Student Answer</span>
                        {q.answer ? (
                          <div className="bg-slate-900 rounded-lg p-4 overflow-x-auto">
                            <pre className="text-slate-300 font-mono text-sm m-0 leading-relaxed whitespace-pre-wrap break-words">
                              {q.answer}
                            </pre>
                          </div>
                        ) : (
                          <div className="px-4 py-3 bg-slate-100 border border-slate-200 rounded-lg text-slate-500 text-sm italic">
                            No answer provided
                          </div>
                        )}
                      </div>

                      <details className="group border border-slate-200 rounded-lg bg-white overflow-hidden [&_summary::-webkit-details-marker]:hidden">
                        <summary className="flex items-center justify-between cursor-pointer px-4 py-3 bg-slate-50 text-slate-700 font-medium text-sm hover:bg-slate-100 transition-colors">
                          <span className="flex items-center gap-2"><FileText size={16} className="text-slate-400" /> Rubric & AI Feedback</span>
                          <span className="text-slate-400 transition-transform group-open:rotate-180">▼</span>
                        </summary>
                        <div className="p-4 border-t border-slate-100 text-sm space-y-4">
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                              <div className="md:col-span-3 text-emerald-700 font-semibold text-xs uppercase tracking-wide">Must-have (70%)</div>
                              <div className="md:col-span-9 text-slate-700">{q.rubric_must_have}</div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                              <div className="md:col-span-3 text-amber-700 font-semibold text-xs uppercase tracking-wide">Nice-to-have (20%)</div>
                              <div className="md:col-span-9 text-slate-700">{q.rubric_nice_to_have}</div>
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                              <div className="md:col-span-3 text-slate-500 font-semibold text-xs uppercase tracking-wide">Optional (10%)</div>
                              <div className="md:col-span-9 text-slate-700">{q.rubric_optional}</div>
                            </div>
                          </div>

                          {q.ai_feedback && (
                            <div className="mt-4 p-4 bg-indigo-50 border border-indigo-100 rounded-lg">
                              <strong className="flex items-center gap-2 text-indigo-900 text-xs uppercase tracking-wide mb-2"><Cpu size={14} /> AI Feedback Analysis</strong>
                              <div className="text-indigo-800 leading-relaxed">{q.ai_feedback}</div>
                            </div>
                          )}
                        </div>
                      </details>
                    </div>
                  </div>
                ))}

                {/* Trainer Score Override Form - AT THE BOTTOM */}
                <div className="mt-8 p-6 bg-emerald-50 border border-emerald-200 rounded-xl shadow-sm relative overflow-hidden">
                  <div className="absolute top-0 right-0 p-6 opacity-10 pointer-events-none">
                    <CheckCircle2 size={120} className="text-emerald-600" />
                  </div>

                  <div className="relative z-10">
                    <h4 className="text-lg font-bold text-emerald-900 mb-1 m-0 border-none pb-0">Trainer Score Override</h4>
                    <p className="text-emerald-700 text-sm mb-6">
                      Review all answers above before making your final decision.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="md:col-span-1">
                        <label className="block text-sm font-bold text-emerald-900 mb-2">Final Score (0-10)</label>
                        <input
                          type="number"
                          min="0"
                          max="10"
                          step="0.1"
                          value={editScore ?? ''}
                          onChange={e => setEditScore(parseFloat(e.target.value))}
                          className="block w-full px-4 py-3 bg-white border border-emerald-300 rounded-lg text-emerald-900 text-xl font-bold text-center focus:ring-2 focus:ring-emerald-500 shadow-inner"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-sm font-bold text-emerald-900 mb-2">Trainer Feedback (Optional)</label>
                        <textarea
                          rows={3}
                          value={editFeedback}
                          onChange={e => setEditFeedback(e.target.value)}
                          placeholder="Enter your feedback for the student..."
                          className="block w-full px-4 py-3 bg-white border border-emerald-300 rounded-lg text-emerald-900 focus:ring-2 focus:ring-emerald-500 shadow-inner text-sm"
                        />
                      </div>
                    </div>

                    <div className="mt-6 flex items-center gap-3">
                      <button
                        onClick={() => handleSaveScore(selectedStudent.student.id)}
                        disabled={saving}
                        className="inline-flex items-center justify-center px-6 py-2.5 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-50"
                      >
                        {saving ? 'Saving...' : 'Save & Apply to All Questions'}
                      </button>
                      <button
                        onClick={() => setSelectedStudent(null)}
                        className="inline-flex items-center justify-center px-4 py-2.5 bg-white text-slate-700 border border-slate-300 font-medium rounded-lg hover:bg-slate-50 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Forensic popup: chi tiết từng lần vi phạm kèm nội dung paste (500 ký tự) */}
      {violationDetail && (
        <div
          onClick={() => setViolationDetail(null)}
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
              <h3 className="font-bold text-slate-900 m-0 flex items-center gap-2 border-none pb-0">
                <AlertCircle size={20} className="text-red-500" />
                Violation Details <span className="text-slate-500 font-normal text-sm ml-2">{violationDetail.email}</span>
              </h3>
              <button
                onClick={() => setViolationDetail(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <X size={20} />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4">
              {violationDetail.events.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <ShieldAlert size={48} className="mx-auto text-slate-300 mb-3" />
                  <p>No detailed records found.</p>
                </div>
              ) : (
                violationDetail.events.map((ev: any, i: number) => (
                  <div key={i} className="border border-slate-200 rounded-xl overflow-hidden bg-white">
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
                      <span className="font-bold text-orange-700 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-orange-500"></span> {ev.type}
                      </span>
                      <span className="text-slate-500 flex items-center gap-1">
                        {new Date(ev.created_at).toLocaleString()}
                      </span>
                      {ev.text_length != null && (
                        <span className="px-1.5 py-0.5 bg-slate-200 text-slate-700 rounded font-mono">
                          {ev.text_length} chars
                        </span>
                      )}
                      {ev.question_id && (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-mono">
                          Q: {ev.question_id}
                        </span>
                      )}
                    </div>
                    {ev.content_preview && (
                      <div className="p-0">
                        <pre className="m-0 whitespace-pre-wrap break-words text-xs font-mono bg-slate-900 text-slate-300 p-4 max-h-[300px] overflow-y-auto">
                          {ev.content_preview}
                        </pre>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Results;
