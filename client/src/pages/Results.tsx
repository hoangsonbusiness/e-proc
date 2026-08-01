import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { adminApi } from '../services/api';
import AdminNav from '../components/AdminNav';

function Results() {
  const { id } = useParams<{ id: string }>();
  const [results, setResults] = useState<any[]>([]);
  // Batch dạng Practice: kết quả là danh sách practice_submissions (1 bài làm/học viên)
  const [practiceResults, setPracticeResults] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [selectedStudent, setSelectedStudent] = useState<any>(null);
  const [selectedPracticeRow, setSelectedPracticeRow] = useState<any>(null);
  const [editScore, setEditScore] = useState<number | null>(null);
  const [editFeedback, setEditFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Forensic popup: xem chi tiết các lần vi phạm (kèm nội dung paste) của 1 học viên
  const [violationDetail, setViolationDetail] = useState<{ email: string; events: any[] } | null>(null);

  const isPractice = !!batch?.practice_exam_id;

  useEffect(() => {
    init();
  }, [id]);

  // Load batch trước để biết là batch thường hay practice, rồi load đúng loại kết quả
  const init = async () => {
    setLoading(true);
    try {
      const bRes = await adminApi.getBatch(parseInt(id!));
      setBatch(bRes.data);
      if (bRes.data.practice_exam_id) {
        const r = await adminApi.getPracticeResults(parseInt(id!));
        setPracticeResults(r.data);
      } else {
        const r = await adminApi.getResults(parseInt(id!));
        setResults(r.data);
      }
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  };

  const loadResults = async () => {
    setLoading(true);
    try {
      if (isPractice) {
        const res = await adminApi.getPracticeResults(parseInt(id!));
        setPracticeResults(res.data);
      } else {
        const res = await adminApi.getResults(parseInt(id!));
        setResults(res.data);
      }
    } catch (error) {
      console.error(error);
    }
    setLoading(false);
  };

  const handleSavePracticeScore = async (studentId: number) => {
    setSaving(true);
    try {
      await adminApi.updatePracticeResult(studentId, {
        trainer_score: editScore,
        trainer_feedback: editFeedback
      });
      setSelectedPracticeRow(null);
      loadResults();
    } catch (error) {
      console.error(error);
    }
    setSaving(false);
  };

  const handleExport = async () => {
    try {
      const res = isPractice
        ? await adminApi.exportPracticeResults(parseInt(id!))
        : await adminApi.exportResults(parseInt(id!));
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${isPractice ? 'practice-' : ''}results-${id}.xlsx`);
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
    if (scores.length === 0) return 0;
    return (scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1);
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Results - {batch?.name}</h1>
        <Link to="/admin/batches" className="btn btn-secondary">Back to Batches</Link>
      </div>

      <AdminNav />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2>Student Results ({isPractice ? practiceResults.length : results.length})</h2>
        <button
          onClick={handleExport}
          disabled={isPractice ? practiceResults.length === 0 : results.length === 0}
          className="btn btn-primary"
        >
          Export Excel
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading results...</p>
      ) : isPractice ? (
        <>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Status</th>
                  <th>Violations</th>
                  <th>AI Score</th>
                  <th>Trainer Score</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {practiceResults.map(r => (
                  <tr key={r.student_id}>
                    <td>{r.email}</td>
                    <td>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: r.status === 'submitted' ? '#dcfce7' : '#fef3c7',
                        color: r.status === 'submitted' ? '#166534' : '#92400e'
                      }}>
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.violations > 0 && (
                        <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                          {r.violations}
                        </span>
                      )}
                    </td>
                    <td>{r.ai_score ?? '-'}</td>
                    <td>{r.trainer_score ?? '-'}</td>
                    <td>
                      <button
                        onClick={() => {
                          setSelectedPracticeRow(r);
                          setEditScore(r.trainer_score ?? r.ai_score ?? 0);
                          setEditFeedback(r.trainer_feedback ?? '');
                        }}
                        className="btn btn-primary"
                        style={{ fontSize: 12 }}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
                {practiceResults.length === 0 && (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-light)' }}>No results yet</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {selectedPracticeRow && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3>Review: {selectedPracticeRow.email}</h3>

              <div style={{ marginBottom: 20, padding: 15, background: 'var(--background)', borderRadius: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                  <strong>Practice Submission</strong>
                  <span style={{
                    background: selectedPracticeRow.ai_score >= 7 ? '#dcfce7' : selectedPracticeRow.ai_score >= 5 ? '#fef3c7' : '#fee2e2',
                    padding: '4px 8px',
                    borderRadius: 4
                  }}>
                    AI Score: {selectedPracticeRow.ai_score ?? '-'}
                  </span>
                </div>
                <p style={{ marginBottom: 6 }}><strong>Answer:</strong></p>
                <pre style={{
                  background: '#f1f5f9', border: '1px solid var(--border)', borderRadius: 4,
                  padding: '12px 16px', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  maxHeight: 420, overflowY: 'auto'
                }}>{selectedPracticeRow.answer || 'No answer'}</pre>
                {selectedPracticeRow.ai_feedback && (
                  <p style={{ marginTop: 10, padding: 10, background: '#f0f9ff', borderRadius: 4, fontSize: 14 }}>
                    <strong>AI Feedback:</strong> {selectedPracticeRow.ai_feedback}
                  </p>
                )}
              </div>

              <div style={{ marginTop: 20, padding: 20, background: '#f0fdf4', borderRadius: 8, border: '2px solid #22c55e' }}>
                <h4 style={{ marginBottom: 15, color: '#166534' }}>Trainer Score Override</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 15 }}>
                  <div className="form-group">
                    <label style={{ fontWeight: 600 }}>Final Score (0-10)</label>
                    <input
                      type="number"
                      min="0"
                      max="10"
                      step="0.1"
                      value={editScore ?? ''}
                      onChange={e => setEditScore(parseFloat(e.target.value))}
                      style={{ fontSize: 18, textAlign: 'center', padding: 10 }}
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontWeight: 600 }}>Trainer Feedback</label>
                    <textarea
                      rows={3}
                      value={editFeedback}
                      onChange={e => setEditFeedback(e.target.value)}
                      placeholder="Enter your feedback for the student..."
                    />
                  </div>
                </div>
                <div style={{ marginTop: 15, display: 'flex', gap: 10 }}>
                  <button
                    onClick={() => handleSavePracticeScore(selectedPracticeRow.student_id)}
                    disabled={saving}
                    className="btn btn-primary"
                  >
                    {saving ? 'Saving...' : 'Save Score'}
                  </button>
                  <button
                    onClick={() => setSelectedPracticeRow(null)}
                    className="btn btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Status</th>
                  <th>Violations</th>
                  <th>Avg Score</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.student.id}>
                    <td>
                      {r.student.email}
                      {/* Mật khẩu giải nén video record (mode local). HV không thấy — chỉ admin. */}
                      {r.student.recording_password && (
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-light)' }}>
                          🔑 Decryption password:{' '}
                          <code style={{
                            background: '#f1f5f9', padding: '1px 5px', borderRadius: 3,
                            fontFamily: 'monospace', userSelect: 'all', wordBreak: 'break-all',
                          }}>
                            {r.student.recording_password}
                          </code>
                        </div>
                      )}
                    </td>
                    <td>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: r.student.status === 'submitted' ? '#dcfce7' : '#fef3c7',
                        color: r.student.status === 'submitted' ? '#166534' : '#92400e'
                      }}>
                        {r.student.status}
                      </span>
                    </td>
                    <td>
                      {r.violations > 0 ? (
                        <div>
                          <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                            {r.violations} total
                          </span>
                          {/* Breakdown chi tiết theo type — mọi type đều lockable (badge cam) */}
                          {r.violations_breakdown && Object.keys(r.violations_breakdown).length > 0 && (
                            <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.6 }}>
                              {Object.entries(r.violations_breakdown as Record<string, number>)
                                .sort(([,a], [,b]) => b - a)
                                .map(([type, count]) => (
                                  <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <span style={{
                                      display: 'inline-block',
                                      background: '#fee2e2',
                                      color: '#991b1b',
                                      borderRadius: 3,
                                      padding: '0 4px',
                                      fontFamily: 'monospace',
                                      whiteSpace: 'nowrap',
                                    }}>
                                      🟠 {type}: <strong>{count}</strong>
                                    </span>
                                  </div>
                                ))}
                            </div>
                          )}
                          {/* Forensic: xem nội dung paste / thời điểm từng lần vi phạm */}
                          {r.violation_events && r.violation_events.length > 0 && (
                            <button
                              onClick={() => setViolationDetail({ email: r.student.email, events: r.violation_events })}
                              style={{
                                marginTop: 6, fontSize: 11, cursor: 'pointer',
                                background: 'transparent', border: '1px solid var(--danger)',
                                color: 'var(--danger)', borderRadius: 4, padding: '2px 8px',
                              }}
                            >
                              🔍 View details ({r.violation_events.length})
                            </button>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: 'var(--text-light)' }}>-</span>
                      )}
                    </td>
                    <td>{getAverageScore(r)}</td>
                    <td>
                      <button 
                        onClick={() => {
                          setSelectedStudent(r);
                          const firstQ = r.questions[0];
                          setEditScore(firstQ?.trainer_score ?? firstQ?.ai_score ?? 0);
                          setEditFeedback(firstQ?.trainer_feedback ?? '');
                        }} 
                        className="btn btn-primary" 
                        style={{ fontSize: 12 }}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-light)' }}>No results yet</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {selectedStudent && (
            <div className="card" style={{ marginTop: 20 }}>
              <h3>Review: {selectedStudent.student.email}</h3>
              
              {/* All Questions */}
              {selectedStudent.questions.map((q: any, index: number) => (
                <div key={q.id} style={{ marginBottom: 20, padding: 15, background: 'var(--background)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                    <strong>Question {index + 1} - {q.module} ({q.level}) - {q.type}</strong>
                    <span style={{ 
                      background: q.ai_score >= 7 ? '#dcfce7' : q.ai_score >= 5 ? '#fef3c7' : '#fee2e2',
                      padding: '4px 8px', 
                      borderRadius: 4 
                    }}>
                      AI Score: {q.ai_score ?? '-'}
                    </span>
                  </div>
                  <p style={{ marginBottom: 10 }}><strong>Q:</strong> {q.question_sample}</p>
                  <p style={{ marginBottom: 10, color: 'var(--text-light)' }}><strong>A:</strong> {q.answer || 'No answer'}</p>
                  <div style={{ marginTop: 10 }}>
                    <details style={{ marginTop: 5 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--primary)' }}>Rubric & Feedback</summary>
                      <div style={{ marginTop: 10, fontSize: 14 }}>
                        <p><strong>Must-have (70%):</strong> {q.rubric_must_have}</p>
                        <p><strong>Nice-to-have (20%):</strong> {q.rubric_nice_to_have}</p>
                        <p><strong>Optional (10%):</strong> {q.rubric_optional}</p>
                        {q.ai_feedback && (
                          <p style={{ marginTop: 10, padding: 10, background: '#f0f9ff', borderRadius: 4 }}>
                            <strong>AI Feedback:</strong> {q.ai_feedback}
                          </p>
                        )}
                      </div>
                    </details>
                  </div>
                </div>
              ))}

              {/* Trainer Score Override Form - AT THE BOTTOM */}
              <div style={{ marginTop: 20, padding: 20, background: '#f0fdf4', borderRadius: 8, border: '2px solid #22c55e' }}>
                <h4 style={{ marginBottom: 15, color: '#166534' }}>Trainer Score Override</h4>
                <p style={{ fontSize: 14, color: '#166534', marginBottom: 15 }}>
                  Review all answers above before making your decision.
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 15 }}>
                  <div className="form-group">
                    <label style={{ fontWeight: 600 }}>Final Score (0-10)</label>
                    <input 
                      type="number" 
                      min="0" 
                      max="10" 
                      step="0.1"
                      value={editScore ?? ''}
                      onChange={e => setEditScore(parseFloat(e.target.value))}
                      style={{ fontSize: 18, textAlign: 'center', padding: 10 }}
                    />
                  </div>
                  <div className="form-group">
                    <label style={{ fontWeight: 600 }}>Trainer Feedback</label>
                    <textarea 
                      rows={3}
                      value={editFeedback}
                      onChange={e => setEditFeedback(e.target.value)}
                      placeholder="Enter your feedback for the student..."
                    />
                  </div>
                </div>
                <div style={{ marginTop: 15, display: 'flex', gap: 10 }}>
                  <button 
                    onClick={() => handleSaveScore(selectedStudent.student.id)}
                    disabled={saving}
                    className="btn btn-primary"
                  >
                    {saving ? 'Saving...' : 'Save & Apply to All Questions'}
                  </button>
                  <button 
                    onClick={() => setSelectedStudent(null)}
                    className="btn btn-secondary"
                  >
                    Cancel
                  </button>
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
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--card, #fff)', borderRadius: 8, padding: 24,
              maxWidth: 720, width: '90%', maxHeight: '80vh', overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0 }}>Violation details — {violationDetail.email}</h3>
              <button onClick={() => setViolationDetail(null)} className="btn" style={{ fontSize: 14 }}>✕</button>
            </div>
            {violationDetail.events.length === 0 ? (
              <p style={{ color: 'var(--text-light)' }}>No detailed records.</p>
            ) : (
              violationDetail.events.map((ev: any, i: number) => (
                <div key={i} style={{ marginBottom: 12, padding: 12, background: 'var(--background, #f8f8f8)', borderRadius: 6 }}>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 13, marginBottom: ev.content_preview ? 8 : 0 }}>
                    <span><strong>🟠 {ev.type}</strong></span>
                    <span style={{ color: 'var(--text-light)' }}>{new Date(ev.created_at).toLocaleString()}</span>
                    {ev.text_length != null && <span>{ev.text_length} chars</span>}
                    {ev.question_id && <span>Q: {ev.question_id}</span>}
                  </div>
                  {ev.content_preview && (
                    <pre style={{
                      margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      fontSize: 12, fontFamily: 'monospace', background: '#1e1e1e',
                      color: '#d4d4d4', padding: 10, borderRadius: 4, maxHeight: 200, overflow: 'auto',
                    }}>
                      {ev.content_preview}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default Results;
