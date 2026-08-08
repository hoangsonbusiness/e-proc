import { useEffect } from 'react';
import { CheckCircle2 } from 'lucide-react';

function StudentSubmit() {
  useEffect(() => {
    localStorage.clear();
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden text-center p-8">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-emerald-50 text-emerald-500 mb-6">
          <CheckCircle2 size={40} />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-3">Assessment Submitted</h2>
        <p className="text-slate-600 mb-4 leading-relaxed">
          Your answers have been securely recorded. The evaluation system is processing your responses.
        </p>
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 mt-6">
          <p className="text-slate-500 text-sm leading-relaxed">
            Results will be available shortly. You may close this window and wait for further instructions from your administrator.
          </p>
        </div>
      </div>
    </div>
  );
}

export default StudentSubmit;