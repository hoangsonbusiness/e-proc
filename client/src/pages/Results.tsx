import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { adminApi } from '../services/api';

function Results() {
  const { id } = useParams<{ id: string }>();
  const [results, setResults] = useState<any[]>([]);
  const [batch, setBatch] = useState<any>(null);
  const [selectedStudent, setSelectedStudent] = useState<any>(null);
  const [editScore, setEditScore] = useState<number | null>(null);
  const [editFeedback, setEditFeedback] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

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
    if (scores.length === 0) return 0;
    return (scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1);
  };

  return (
    <div className="container">
      <div className="header">
        <h1>Results - {batch?.name}</h1>
        <Link to="/admin/batches" className="btn btn-secondary">Back to Batches</Link>
      </div>

      <div className="nav">
        <Link to="/admin/dashboard">Dashboard</Link>
        <Link to="/admin/questions">Question Bank</Link>
        <Link to="/admin/batches">Batches</Link>
        <Link to="/admin/settings">AI Settings</Link>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h2>Student Results ({results.length})</h2>
        <button onClick={handleExport} disabled={results.length === 0} className="btn btn-primary">
          Export Excel
        </button>
      </div>

      {loading ? (
        <p className="loading">Loading results...</p>
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
                    <td>{r.student.email}</td>
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
                      {r.violations > 0 && (
                        <span style={{ color: 'var(--danger)', fontWeight: 600 }}>
                          {r.violations}
                        </span>
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
    </div>
  );
}

export default Results;
