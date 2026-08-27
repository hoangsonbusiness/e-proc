import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-react';
import * as examRecorder from '../services/examRecorder';

type FinalizationState = 'finalizing' | 'complete' | 'failed';
const ORPHANED_RECOVERY_DELAYS_MS = [500, 1500];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFinalizationFailure(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const stage = 'stage' in error && typeof error.stage === 'string' ? error.stage : null;
  const partIndex = 'partIndex' in error && Number.isInteger(error.partIndex)
    ? Number(error.partIndex)
    : null;
  if (!stage) return null;
  return `Failed stage: ${stage}${partIndex === null ? '' : ` (part ${partIndex})`}.`;
}

function StudentSubmit() {
  const location = useLocation();
  const navigate = useNavigate();
  const locationState = location.state as {
    recordingFinalizing?: boolean;
    submissionNotice?: string;
  } | null;
  const shouldFinalizeRecording = Boolean(locationState?.recordingFinalizing);
  const [recordMode] = useState(() => localStorage.getItem('recordMode') || 'none');
  const submissionNotice = typeof locationState?.submissionNotice === 'string'
    ? locationState.submissionNotice
    : null;
  const [finalizationState, setFinalizationState] = useState<FinalizationState>(
    shouldFinalizeRecording ? 'finalizing' : 'complete'
  );
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const observationRef = useRef(0);

  const completeFinalization = useCallback((observation: number) => {
    if (observation !== observationRef.current) return;
    localStorage.clear();
    setFailureDetail(null);
    setRetryAvailable(false);
    setFinalizationState('complete');
    // A refresh after success must not try to recover a Promise that no longer
    // exists in this JavaScript module instance.
    navigate('/submit', {
      replace: true,
      state: {
        recordingFinalizing: false,
        ...(submissionNotice ? { submissionNotice } : {}),
      },
    });
  }, [navigate, submissionNotice]);

  const recoverServerTruth = useCallback(async (observation: number, originalError?: unknown) => {
    setFinalizationState('finalizing');
    setRetryAvailable(false);
    try {
      // Deliberately performs status -> reconcile -> status. A lost S3 PUT or
      // finalize response must be decided by backend/S3 truth, not browser RAM.
      let status = await examRecorder.recoverRecordingFinalization();
      if (observation !== observationRef.current) return;
      // After a reload there is no in-memory uploader. Give an ambiguous final
      // PUT a short bounded window to become visible in S3, but do not claim that
      // recording is “still processing” for the entire one-hour backend grace
      // when no browser process can upload the missing blob anymore.
      if (status.state === 'processing' && !examRecorder.canRetryFinalization()) {
        for (const delayMs of ORPHANED_RECOVERY_DELAYS_MS) {
          await wait(delayMs);
          if (observation !== observationRef.current) return;
          status = await examRecorder.recoverRecordingFinalization();
          if (observation !== observationRef.current) return;
          if (status.state !== 'processing') break;
        }
      }
      if (status.state === 'finalized' || status.state === 'not_required') {
        completeFinalization(observation);
        return;
      }

      if (status.state === 'processing') {
        if (!examRecorder.canRetryFinalization()) {
          setFailureDetail(
            `S3 is missing sealed recording evidence (${status.completedPartCount}/${status.expectedPartCount} parts confirmed), and this tab no longer has an uploader that can send it.`,
          );
          setRetryAvailable(false);
          setFinalizationState('failed');
          return;
        }
        setFailureDetail(
          `Recording recovery is still processing (${status.completedPartCount}/${status.expectedPartCount} parts confirmed).`,
        );
        setRetryAvailable(true);
        setFinalizationState('finalizing');
        return;
      }

      if (status.state === 'awaiting_seal' && examRecorder.canRetryFinalization()) {
        setFailureDetail('The recording manifest still needs to be sealed. Retry while this tab remains open.');
        setRetryAvailable(true);
        setFinalizationState('finalizing');
        return;
      }

      setFailureDetail(
        status.state === 'incomplete'
          ? `The server confirmed that recording evidence is incomplete (${status.completedPartCount}/${status.expectedPartCount} parts).`
          : describeFinalizationFailure(originalError)
            || 'The recording manifest was not sealed before its browser data became unavailable.',
      );
      setRetryAvailable(false);
      setFinalizationState('failed');
    } catch (recoveryError) {
      console.error('[submit] recording status recovery failed:', recoveryError);
      if (observation !== observationRef.current) return;
      if (examRecorder.isRetryableFinalizationFailure(recoveryError)) {
        setFailureDetail('Recording status could not be confirmed yet. Keep this window open and retry.');
        setRetryAvailable(true);
        setFinalizationState('finalizing');
        return;
      }
      setFailureDetail(describeFinalizationFailure(originalError)
        || describeFinalizationFailure(recoveryError)
        || 'The recording status could not be recovered.');
      setRetryAvailable(false);
      setFinalizationState('failed');
    }
  }, [completeFinalization]);

  const observeFinalization = useCallback((finalization: Promise<void>) => {
    const observation = ++observationRef.current;
    setFailureDetail(null);
    setRetryAvailable(false);
    setFinalizationState('finalizing');

    void finalization.then(() => {
      completeFinalization(observation);
    }).catch((error) => {
      console.error('[submit] recording finalization failed:', error);
      if (observation !== observationRef.current) return;
      if (recordMode === 's3') {
        void recoverServerTruth(observation, error);
        return;
      }
      setFailureDetail(describeFinalizationFailure(error));
      setRetryAvailable(examRecorder.canRetryFinalization());
      setFinalizationState('failed');
    });
  }, [completeFinalization, recordMode, recoverServerTruth]);

  useEffect(() => {
    const finalization = shouldFinalizeRecording ? examRecorder.getFinalizationPromise() : null;
    if (!shouldFinalizeRecording) {
      localStorage.clear();
      return;
    }
    if (!finalization) {
      const observation = ++observationRef.current;
      if (recordMode === 's3') {
        void recoverServerTruth(observation);
      } else {
        setFailureDetail('The recording retry state is no longer available in this tab.');
        setRetryAvailable(false);
        setFinalizationState('failed');
      }
      return;
    }

    observeFinalization(finalization);
    return () => { observationRef.current += 1; };
  }, [observeFinalization, recordMode, recoverServerTruth, shouldFinalizeRecording]);

  const retryFinalization = useCallback(() => {
    if (!examRecorder.canRetryFinalization()) {
      const observation = ++observationRef.current;
      void recoverServerTruth(observation);
      return;
    }
    try {
      observeFinalization(examRecorder.retryFinalization());
    } catch (error) {
      console.error('[submit] could not retry recording finalization:', error);
      setFailureDetail(describeFinalizationFailure(error));
      setRetryAvailable(examRecorder.canRetryFinalization());
      setFinalizationState('failed');
    }
  }, [observeFinalization, recoverServerTruth]);

  const isFinalizing = finalizationState === 'finalizing';
  const failed = finalizationState === 'failed';

  useEffect(() => {
    if (!isFinalizing) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [isFinalizing]);

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
              : 'Your assessment has been securely submitted.'}
        </p>
        {submissionNotice && (
          <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {submissionNotice}
          </p>
        )}
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-4 mt-6">
          <p className="text-slate-500 text-sm leading-relaxed">
            {failed
              ? retryAvailable
                ? 'Keep this window open and retry saving the recording. If it still fails, contact the administrator.'
                : 'Please contact the administrator so the recording issue can be investigated.'
              : isFinalizing
                ? 'This may take a moment on a slow connection.'
                : 'Results will be available shortly. You may now close this window.'}
          </p>
          {(failed || isFinalizing) && failureDetail && (
            <p className="mt-2 text-xs font-medium text-amber-700">{failureDetail}</p>
          )}
          {retryAvailable && (
            <button
              type="button"
              onClick={retryFinalization}
              className="mt-4 inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-500/20"
            >
              {failed ? 'Retry recording save' : 'Retry recording check'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default StudentSubmit;
