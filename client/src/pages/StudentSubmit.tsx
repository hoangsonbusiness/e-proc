import { useEffect } from 'react';

function StudentSubmit() {
  useEffect(() => {
    localStorage.clear();
  }, []);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
    }}>
      <div className="card" style={{ maxWidth: 500, textAlign: 'center' }}>
        <div style={{ fontSize: 64, marginBottom: 20 }}>✓</div>
        <h2 style={{ marginBottom: 10 }}>Exam Submitted</h2>
        <p style={{ color: 'var(--text-light)', marginBottom: 20 }}>
          Your answers have been recorded. The trainer is evaluating your responses.
        </p>
        <p style={{ color: 'var(--text-light)', fontSize: 14 }}>
          Results will be available after processing. Please check back later or contact your administrator.
        </p>
      </div>
    </div>
  );
}

export default StudentSubmit;