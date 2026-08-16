import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react';
import * as examRecorder from '../services/examRecorder';
import { clearStudentSession } from '../services/studentSession';

type FinalizationState = 'finalizing' | 'complete' | 'failed';

function StudentSubmit() {
  const location = useLocation();
  const shouldFinalizeRecording = Boolean((location.state as { recordingFinalizing?: boolean } | null)?.recordingFinalizing);
  const [finalizationState, setFinalizationState] = useState<FinalizationState>(
    shouldFinalizeRecording ? 'finalizing' : 'complete'
  );

  useEffect(() => {
    let mounted = true;
    const finalization = shouldFinalizeRecording ? examRecorder.getFinalizationPromise() : null;
    if (!shouldFinalizeRecording) {
      clearStudentSession();
      return () => { mounted = false; };
    }
    if (!finalization) {
      setFinalizationState('failed');
      return () => { mounted = false; };
    }

    finalization.then(() => {
      if (!mounted) return;
      clearStudentSession();
      setFinalizationState('complete');
    }).catch((error) => {
      console.error('[submit] recording finalization failed:', error);
      if (mounted) setFinalizationState('failed');
    });
    return () => { mounted = false; };
  }, [shouldFinalizeRecording]);

  const isFinalizing = finalizationState === 'finalizing';
  const failed = finalizationState === 'failed';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden text-center p-8">
        <div className={`inline-flex items-center justify-center w-20 h-20 rounded-full mb-6 ${
          failed ? 'bg-amber-50 text-amber-500' : isFinalizing ? 'bg-blue-50 text-blue-500' : 'bg-emerald-50 text-emerald-500'
        }`}>
          {failed ? <AlertTriangle size={40} /> : isFinalizing ? <LoaderCircle size={40} className="animate-spin" /> : <CheckCircle2 size={40} />}
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-3">Assessment Submitted</h2>
        <p className="text-slate-600 mb-4 leading-relaxed">
          {failed
            ? 'Your answers were submitted, but the screen recording could not be finalized.'
            : isFinalizing
              ? 'Your answers are submitted. Please keep this window open while the screen recording finishes saving.'
              : 'Your answers and recording evidence have been securely saved.'}
        </p>
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 mt-6">
          <p className="text-slate-500 text-sm leading-relaxed">
            {failed
              ? 'Do not close this window. Please contact the administrator so the recording issue can be investigated.'
              : isFinalizing
                ? 'This may take a moment on a slow connection.'
                : 'Results will be available shortly. You may now close this window.'}
          </p>
        </div>
      </div>
    </div>
  );
}

export default StudentSubmit;
