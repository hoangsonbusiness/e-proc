import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { studentApi } from '../services/api';
import * as examRecorder from '../services/examRecorder';
import { startLivePublisher, type LivePublisher } from '../services/livePublisher';
import { getExamEnvironmentSnapshot } from '../services/examEnvironment';
import {
  hasServerConfirmedTerminalSubmission,
  shouldSuppressClientViolation,
} from '../services/violationLifecycle';
import { submitAnswersWithRecovery } from '../services/submissionRecovery';
import { getBlockReasonMessage, normalizeBlockReason } from '../services/examBlockReason';
import {
  clearFullscreenBaselineWidth,
  completeSidePanelReport,
  createSidePanelDetectorState,
  observeSidePanel,
  readFullscreenBaselineWidth,
} from '../services/sidePanelDetector';
import CodeEditor, { detectLanguage } from '../components/CodeEditor';
import type { CodeEditorHandle } from '../components/CodeEditor';

// Static import: `detectLanguage` was already imported statically above, so Monaco was
// always in the main bundle and lazy() gave no real split. Keep one deterministic import
// path because this is part of the exam-critical rendering path.

const CLIPBOARD_VIOLATION_COOLDOWN_MS = 3000;
const FULLSCREEN_EXIT_TIMEOUT_MS = 5000;
// [#3] Cooldown chống đếm trùng, nhưng TÁCH THEO TYPE thay vì global —
// trước đây một global cooldown 3s khiến một forensic event có thể "nuốt" mất
// recording_stopped nếu xảy ra trong 3s. Giờ mỗi type có cooldown riêng và các
// type critical bên dưới bỏ qua cooldown hoàn toàn.
const VIOLATION_COOLDOWN_MS = 3000;
// Các type KHÔNG BAO GIỜ bị cooldown bỏ qua — mất một sự kiện là mất bằng chứng gian lận nghiêm trọng.
const COOLDOWN_EXEMPT_TYPES = new Set<string>([
  'recording_stopped',
  // The side-panel state machine already caps this at two sustained reports.
  // A generic time cooldown must not swallow the second lockable report.
  'extension_panel',
  // Rejected text is reverted immediately and every occurrence is useful
  // forensic evidence. event_id keeps transport retries idempotent.
  'suspicious_paste',
]);
// [#7] Retry: các type quan trọng phải được gửi tới server dù request đầu tiên lỗi
// (extension/proxy chặn /violation không được phép âm thầm vô hiệu telemetry).
const VIOLATION_RETRY_MAX = 5;
const VIOLATION_RETRY_BASE_MS = 1000;
const VIEWPORT_CHECK_INTERVAL_MS = 1500;

interface QuizOption {
  key: string;
  text: string;
}

interface Question {
  id: string;
  question_order: number;
  question_sample: string;
  module: string;
  level: string;
  type: string;
  answer?: string;
  options?: QuizOption[];
}

function StudentExam() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<{ [key: number]: string }>({});
  const [timeLeft, setTimeLeft] = useState(0);
  // The initial zero is only a placeholder until the server returns the deadline.
  const [timerReady, setTimerReady] = useState(false);
  const [violationCount, setViolationCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clipboardWarning, setClipboardWarning] = useState('');
  const [violationWarningModal, setViolationWarningModal] = useState('');
  // Thông báo khi học viên reconnect sau khi tắt trình duyệt
  const [resumeInfo, setResumeInfo] = useState<{ timeLeft: number } | null>(null);
  // Modal yêu cầu bật lại ghi màn hình (khi recorder mất state sau reload/F5)
  const [recordingLost, setRecordingLost] = useState(false);
  const [initializationError, setInitializationError] = useState('');
  const [initializationRetry, setInitializationRetry] = useState(0);
  const editorRef = useRef<CodeEditorHandle>(null);
  // Mỗi câu một timer: dùng chung một debounce khiến sửa câu B hủy lần lưu đang chờ của câu A.
  const debounceRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const dirtyAnswersRef = useRef<Record<number, string>>({});
  const clipboardCooldownRef = useRef<Record<string, number>>({});
  const clipboardWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const violationWarningModalTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fullscreenExitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fullscreenAutoSubmitTriggeredRef = useRef(false);
  const sidePanelDetectorStateRef = useRef(createSidePanelDetectorState());
  const devtoolsViolationCooldownRef = useRef<number>(0);
  // [Anti-Cheat v2] focus heartbeat refs
  const focusLostTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const multipleDisplayReportedRef = useRef(false);
  const startedRef = useRef(false);
  const lockedRef = useRef(false);
  const submittingRef = useRef(false);
  // `submitting` starts before the request commits. Keep the terminal state
  // separate so a native Stop sharing event is not lost if submit later fails.
  const submitCommittedRef = useRef(false);
  const submissionFinishedRef = useRef(false);
  const mountedRef = useRef(true);
  const recordingResumeInFlightRef = useRef(false);
  const recordingSetupGenerationRef = useRef(0);
  const pendingRecordingStoppedRef = useRef(false);
  const recordingNextPartIndexRef = useRef(0);
  const livePublisherRef = useRef<LivePublisher | null>(null);
  // [#3] cooldown riêng cho từng type
  const violationCooldownByTypeRef = useRef<Record<string, number>>({});
  const currentQuestionIdRef = useRef<string | undefined>(undefined);
  const answersRef = useRef<{ [key: number]: string }>({});
  const navigate = useNavigate();
  const [documentWidthBaseline] = useState(() => readFullscreenBaselineWidth());

  // [Anti-Cheat v2] Dynamic watermark: cập nhật mỗi 30 giây để timestamp không bị freeze
  const [watermarkTime, setWatermarkTime] = useState(() => new Date());

  const studentId = localStorage.getItem('studentId');
  // [C-4] studentToken dùng để xác thực với backend (thay thế x-student-id header)
  const studentToken = localStorage.getItem('studentToken');
  const studentEmail = localStorage.getItem('studentEmail');
  const recordMode = (localStorage.getItem('recordMode') || 'none') as 'none' | 'local' | 's3';
  const recordEnabled = recordMode !== 'none'; // có ghi màn hình (local hoặc s3)
  const liveEnabled = localStorage.getItem('liveEnabled') === 'true';
  const screenShareRequired = recordEnabled || liveEnabled;

  const finishSubmittedAttempt = useCallback((submissionNotice?: string) => {
    if (submissionFinishedRef.current) return;
    submissionFinishedRef.current = true;
    recordingSetupGenerationRef.current += 1;
    submitCommittedRef.current = true;

    // Capture cleanup starts synchronously; S3/local I/O continues on /submit.
    // Do this before any user-facing notice: a blocking dialog must never keep the
    // browser's native screen-sharing indicator alive after terminal submission.
    const recordingFinalization = recordEnabled
      ? examRecorder.stopAndSave()
      : screenShareRequired ? examRecorder.stopAndDiscard() : null;
    const submitHandoff = recordEnabled && recordingFinalization
      ? examRecorder.getSubmitHandoffPromise()
      : null;
    recordingFinalization?.catch((recErr) => {
      console.error('[exam] stopAndSave failed:', recErr);
    });
    clearFullscreenBaselineWidth();
    document.exitFullscreen().catch(() => { });
    const navigateToSubmit = () => {
      navigate('/submit', {
        state: {
          recordingFinalizing: Boolean(recordingFinalization),
          ...(submissionNotice ? { submissionNotice } : {}),
        },
      });
    };

    if (submitHandoff) {
      // Do not expose /submit to refresh until the final chunk is captured and
      // the S3 seal request has succeeded or failed. Full upload/finalize remains
      // attached to the singleton Promise and continues after this navigation.
      // Both branches navigate so a seal failure can never strand the candidate.
      void submitHandoff.then(navigateToSubmit, navigateToSubmit);
    } else {
      navigateToSubmit();
    }
  }, [navigate, recordEnabled, screenShareRequired]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recordingSetupGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!studentId || !studentToken || documentWidthBaseline === null) {
      clearFullscreenBaselineWidth();
      void examRecorder.stopAndDiscard()
        .catch((error) => console.error('[exam] could not release pre-exam recording:', error))
        .finally(() => {
          document.exitFullscreen().catch(() => { });
          navigate('/');
        });
      return;
    }

    // Request fullscreen when entering exam
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { });
    }

    const initExam = async () => {
      console.log('[Exam] initExam called, studentId:', studentId);
      try {
        console.log('[Exam] Step 1 - Getting existing questions...');
        const existingRes = await studentApi.getQuestions();
        const data = existingRes.data;
        const existingQuestions = data.questions ?? data; // compat với format cũ
        console.log('[Exam] Step 1 done, questions:', existingQuestions.length);

        if (existingQuestions.length > 0) {
          console.log('[Exam] Found questions, loading (resume)...');
          setStarted(true);
          await loadQuestions(data);
          return;
        }

        console.log('[Exam] No questions, starting new exam...');
        const res = await studentApi.startExam(parseInt(studentId));

        console.log('[Exam] Start result:', res.data);

        if (res.data.success) {
          setStarted(true);
          // Sau khi start, gọi getQuestions để lấy time_remaining
          const qRes = await studentApi.getQuestions();
          await loadQuestions(qRes.data);
        }
      } catch (error: any) {
        console.error('[Exam] Error:', error);
        // Xử lý trường hợp bị block (410 Gone)
        if (error.response?.status === 410) {
          startedRef.current = false;
          setStarted(false);
          const reason = normalizeBlockReason(error.response.data?.reason);
          finishSubmittedAttempt(getBlockReasonMessage(reason).message);
          return;
        }
        // A transient initialization failure is not terminal. Stay on /exam with
        // capture intact and offer an explicit retry instead of navigating away
        // while native screen sharing continues in the background.
        setInitializationError(error.response?.data?.error || error.message || 'Could not initialize the exam.');
        setLoading(false);
      }
    };

    initExam();
  }, [documentWidthBaseline, finishSubmittedAttempt, initializationRetry, navigate, studentId, studentToken]);


  useEffect(() => {
    startedRef.current = started;
  }, [started]);

  // The candidate keeps one private signaling connection while the recorded
  // capture is active. A WebRTC peer is created only after an admin clicks View.
  useEffect(() => {
    if (!started || !screenShareRequired || locked || submitting) {
      const current = livePublisherRef.current;
      livePublisherRef.current = null;
      if (current) void current.stop();
      return;
    }
    let cancelled = false;
    void startLivePublisher()
      .then((publisher) => {
        if (cancelled) { if (publisher) void publisher.stop(); return; }
        livePublisherRef.current = publisher;
      })
      .catch((error) => console.warn('[live-monitor] signaling unavailable', error));
    return () => {
      cancelled = true;
      const current = livePublisherRef.current;
      livePublisherRef.current = null;
      if (current) void current.stop();
    };
  }, [started, screenShareRequired, locked, submitting]);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

  useEffect(() => {
    currentQuestionIdRef.current = questions[currentIndex]?.id;
  }, [questions, currentIndex]);

  // Gửi beacon khi học viên tắt trình duyệt / đóng tab
  useEffect(() => {
    const handleBeforeUnload = () => {
      // [C-4] disconnect gửi student_token trong body (không cần studentId nữa)
      if (startedRef.current && !submittingRef.current && !lockedRef.current) {
        studentApi.disconnect();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  const clearFullscreenExitTimeout = useCallback(() => {
    if (fullscreenExitTimeoutRef.current) {
      clearTimeout(fullscreenExitTimeoutRef.current);
      fullscreenExitTimeoutRef.current = null;
    }
  }, []);

  const flushDirtyAnswers = useCallback(async () => {
    const entries = Object.entries(dirtyAnswersRef.current);
    if (entries.length === 0) return;
    dirtyAnswersRef.current = {};
    const payload = entries.map(([order, answer]) => ({ question_order: Number(order), answer }));
    try {
      await studentApi.saveAnswers(payload);
    } catch (error) {
      for (const { question_order, answer } of payload) {
        if (dirtyAnswersRef.current[question_order] === undefined) dirtyAnswersRef.current[question_order] = answer;
      }
      throw error;
    }
  }, []);

  const handleSubmit = useCallback(async (force = false) => {
    if (submittingRef.current) return;
    if (!force && !confirm('Are you sure you want to submit?')) return;

    // [P2-3] Set ref ĐỒNG BỘ ngay khi vượt guard. setSubmitting(true) chỉ đổi submittingRef
    // ở render kế tiếp → hai lời gọi (vd hai response locked khác type song song) có thể cùng
    // vượt `if (submittingRef.current) return` và chạy stopAndSave() hai lần, đua nhau thay
    // recorder.onstop khiến một Promise không bao giờ resolve (treo submit). Đặt ref ngay đây
    // đóng cửa sổ race đó. (Nếu user bấm Cancel ở confirm() phía trên thì đã return, không tới đây.)
    submittingRef.current = true;
    if (!lockedRef.current) submitCommittedRef.current = false;
    setSubmitting(true);

    Object.values(debounceRef.current).forEach(clearTimeout);
    debounceRef.current = {};

    try {
      const finalAnswers = Object.entries(answersRef.current).map(([order, answer]) => ({
        question_order: Number(order),
        answer,
      }));
      await submitAnswersWithRecovery(finalAnswers, {
        submit: (answers) => studentApi.submit(answers),
        probeExam: () => studentApi.getQuestions(),
      });
      submitCommittedRef.current = true;
      finishSubmittedAttempt();
    } catch (error) {
      console.error(error);
      // A concurrent violation response may already have atomically submitted the
      // attempt. In that race, a failed/lost manual-submit response must still
      // close capture and enter the recording finalization screen.
      if (hasServerConfirmedTerminalSubmission({
        locked: lockedRef.current,
        submitCommitted: submitCommittedRef.current,
      })) {
        finishSubmittedAttempt();
        return;
      }
      alert('Error submitting exam. Please contact support.');
      submitCommittedRef.current = false;
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [finishSubmittedAttempt]);

  // [#3][#7] Gửi báo cáo vi phạm + xử lý kết quả lock. Tách riêng khỏi cooldown gate
  // để retry có thể tái sử dụng. Trả về true nếu bài đã bị khóa.
  const sendViolationReport = useCallback(async (
    type: string,
    meta?: { contentPreview?: string; textLength?: number; questionId?: string; metadata?: Record<string, number>; eventId?: string }
  ): Promise<boolean> => {
    const res = await studentApi.reportViolation(type, meta); // [C-4] token tự động
    // The backend is authoritative for the attempt lifecycle. A report that lost
    // the race with submit is acknowledged but must not reset counters or show a
    // misleading post-submit warning in the client.
    if (res.data.ignored) return false;
    setViolationCount(res.data.total_violations);
    if (res.data.forensic_only) return false;
    if (res.data.locked) {
      // [P2-3] Đặt ref ĐỒNG BỘ ngay khi nhận locked — setLocked/setSubmitting chỉ đổi ref
      // ở render kế tiếp, nên hai response locked song song có thể cùng vượt guard của
      // handleSubmit và chạy stopAndSave() hai lần (đua nhau thay recorder.onstop → treo).
      if (lockedRef.current) return true; // đã có luồng khác xử lý lock rồi
      lockedRef.current = true;
      // A locked response is returned only after backend auto-submit succeeds.
      submitCommittedRef.current = true;
      setLocked(true);
      clearFullscreenExitTimeout();
      finishSubmittedAttempt('The assessment was locked and submitted because the server confirmed an exam-rule violation.');
      return true;
    }
    const warningByType: Record<string, string> = {
      fullscreen_exit: 'You exited fullscreen',
      tab_switch: 'You switched tabs',
      copy_attempt: 'You attempted to copy text',
      cut_attempt: 'You attempted to cut text',
      paste_attempt: 'You attempted to paste text',
      devtools_open: 'You attempted to open Developer Tools',
      extension_panel: 'A browser extension panel was detected',
      screenshot_attempt: 'You attempted to take a screenshot',
      print_attempt: 'You attempted to print or capture the page',
      // [Anti-Cheat v2] log-only types — hiển warning nhưng không lock
      suspicious_paste: 'A large text insertion was detected (possible external paste)',
      focus_lost: 'Browser window lost focus for an extended period',
    };
    const warning = warningByType[type] || 'You violated the exam rules';
    // Show the warning as a modal toast instead of an alert() so it doesn't break fullscreen
    setViolationWarningModal(`Warning: ${warning}. This is violation ${res.data.violation_count}. After 2 violations, your exam will be locked.`);
    if (violationWarningModalTimeoutRef.current) {
      clearTimeout(violationWarningModalTimeoutRef.current);
    }
    violationWarningModalTimeoutRef.current = setTimeout(() => {
      setViolationWarningModal('');
    }, 5000);
    return false;
  }, [clearFullscreenExitTimeout, finishSubmittedAttempt]);

  const handleViolation = useCallback(async (
    type: string,
    meta?: { contentPreview?: string; textLength?: number; questionId?: string; metadata?: Record<string, number> }
  ): Promise<boolean> => {
    // A native Stop sharing event remains reportable while manual submit is only
    // pending: the request may still fail. Once commit is confirmed, the client
    // suppresses it and the backend independently rejects any in-flight race.
    if (shouldSuppressClientViolation(type, {
      started: startedRef.current,
      locked: lockedRef.current,
      submitting: submittingRef.current,
      submitCommitted: submitCommittedRef.current,
    })) {
      return false;
    }

    const now = Date.now();
    // [#3] Cooldown TÁCH THEO TYPE (không còn global). Các type critical được miễn
    // hoàn toàn để một sự kiện thường không thể "nuốt" mất recording_stopped.
    if (!COOLDOWN_EXEMPT_TYPES.has(type)) {
      const last = violationCooldownByTypeRef.current[type] || 0;
      if (now - last < VIOLATION_COOLDOWN_MS) {
        return false;
      }
      violationCooldownByTypeRef.current[type] = now;
    }

    // [P1-1] Sinh event_id MỘT LẦN cho sự kiện này; giữ nguyên qua lần gửi đầu và mọi retry.
    // Nhờ đó backend idempotent theo (student_id, event_id): retry sau khi server đã commit
    // (chỉ response bị mất) KHÔNG bị đếm trùng → không auto-lock oan.
    const eventId =
      (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const metaWithId = { ...meta, eventId };

    try {
      return await sendViolationReport(type, metaWithId);
    } catch (error) {
      console.error('[violation] report failed:', type, error);
      // [#7] Retry nền với backoff. An toàn nhờ event_id idempotent (P1-1): dù request đầu
      // đã commit ở server, retry cùng event_id sẽ được backend nhận diện trùng và trả lại
      // kết quả cũ. Không đụng cooldown vì đây là cùng một sự kiện đang gửi lại.
      // Lưu ý giới hạn: retry chỉ cứu lỗi mạng TẠM THỜI — extension/proxy chặn /violation
      // liên tục vẫn vô hiệu được telemetry (đây là signal, không phải bảo đảm tuyệt đối).
      void (async () => {
        for (let attempt = 1; attempt <= VIOLATION_RETRY_MAX; attempt++) {
          const delay = VIOLATION_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          await new Promise((r) => setTimeout(r, delay));
          if (shouldSuppressClientViolation(type, {
            started: startedRef.current,
            locked: lockedRef.current,
            submitting: submittingRef.current,
            submitCommitted: submitCommittedRef.current,
          })) return; // đã kết thúc, thôi retry
          try {
            await sendViolationReport(type, metaWithId);
            return; // gửi lại thành công
          } catch (retryErr) {
            console.error(`[violation] retry ${attempt}/${VIOLATION_RETRY_MAX} failed:`, type, retryErr);
          }
        }
      })();
      return false;
    }
  }, [sendViolationReport]);

  const reconcileFullscreenState = useCallback(() => {
    if (!startedRef.current || lockedRef.current || submittingRef.current) {
      clearFullscreenExitTimeout();
      return;
    }

    if (document.fullscreenElement) {
      clearFullscreenExitTimeout();
      fullscreenAutoSubmitTriggeredRef.current = false;
      return;
    }

    if (fullscreenExitTimeoutRef.current || fullscreenAutoSubmitTriggeredRef.current) return;

    fullscreenExitTimeoutRef.current = setTimeout(async () => {
      fullscreenExitTimeoutRef.current = null;
      if (!startedRef.current || lockedRef.current || submittingRef.current || document.fullscreenElement) return;
      if (fullscreenAutoSubmitTriggeredRef.current) return;

      fullscreenAutoSubmitTriggeredRef.current = true;
      const wasLocked = await handleViolation('fullscreen_exit');
      if (wasLocked || document.fullscreenElement) return;

      fullscreenExitTimeoutRef.current = setTimeout(async () => {
        fullscreenExitTimeoutRef.current = null;
        if (!startedRef.current || lockedRef.current || submittingRef.current || document.fullscreenElement) return;
        await handleViolation('fullscreen_exit');
      }, FULLSCREEN_EXIT_TIMEOUT_MS);
    }, FULLSCREEN_EXIT_TIMEOUT_MS);
  }, [clearFullscreenExitTimeout, handleViolation]);

  useEffect(() => {
    const handleFullscreenChange = () => reconcileFullscreenState();

    const handleVisibilityChange = () => {
      if (document.hidden && startedRef.current && !lockedRef.current && !submittingRef.current) {
        void handleViolation('tab_switch');
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearFullscreenExitTimeout();
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [clearFullscreenExitTimeout, reconcileFullscreenState]);

  // Fullscreen watchdog: catches initial denial and platform transitions that do not emit fullscreenchange.
  useEffect(() => {
    if (!started || locked || submitting) return;
    reconcileFullscreenState();
    const interval = setInterval(reconcileFullscreenState, 1000);
    return () => clearInterval(interval);
  }, [started, locked, submitting, reconcileFullscreenState]);

  // Detect a browser extension side panel (for example Monica AI). The canonical
  // width was captured once on /confirm immediately after entering fullscreen and
  // survives F5 in sessionStorage. Neither this effect nor the fullscreen watchdog
  // is allowed to replace it with a potentially shrunken width.
  useEffect(() => {
    if (!started || locked || submitting || documentWidthBaseline === null) return;

    const interval = setInterval(() => {
      const active =
        startedRef.current &&
        !lockedRef.current &&
        !submittingRef.current &&
        Boolean(document.fullscreenElement);
      const currentWidth = active
        ? document.documentElement.getBoundingClientRect().width
        : 0;
      const decision = observeSidePanel(sidePanelDetectorStateRef.current, {
        active,
        baselineWidth: documentWidthBaseline,
        currentWidth,
      });
      sidePanelDetectorStateRef.current = decision.state;

      const reportNumber = decision.reportNumber;
      if (!decision.shouldReport || reportNumber === null) return;

      void (async () => {
        try {
          await handleViolation('extension_panel', {
            metadata: {
              baselineWidth: documentWidthBaseline,
              currentWidth,
              widthShrink: decision.widthShrink,
              detectorReportNumber: reportNumber,
            },
          });
        } finally {
          sidePanelDetectorStateRef.current = completeSidePanelReport(
            sidePanelDetectorStateRef.current
          );
        }
      })();
    }, VIEWPORT_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [documentWidthBaseline, started, locked, submitting, handleViolation]);

  // [Anti-Cheat] Focus detection: bắt việc mất focus cửa sổ (mở Notes/Maccy/app khác trên macOS
  // song song mà không thoát fullscreen — visibilitychange & fullscreenchange đều không bắn).
  //
  // Dùng event blur/focus (không poll) để đo chính xác thời lượng mất focus, tránh aliasing
  // của polling (một khoảng mất focus ngắn có thể lọt gọn giữa 2 lần poll).
  //
  // Đệm 3 giây: sau khi đã fullscreen, không có lý do hợp lệ nào để focus rời cửa sổ.
  // 3s loại được nhiễu chính đáng: fullscreen transition (~0.5s), dialog xin quyền fullscreen,
  // Windows notification (~1–2s), macOS Spotlight (~2s). Maccy/Notes luôn tốn > 3s.
  const FOCUS_LOST_GRACE_MS = 3000;

  useEffect(() => {
    if (!started || locked || submitting) {
      if (focusLostTimeoutRef.current) {
        clearTimeout(focusLostTimeoutRef.current);
        focusLostTimeoutRef.current = null;
      }
      return;
    }

    const handleBlur = () => {
      if (!startedRef.current || lockedRef.current || submittingRef.current) return;
      if (focusLostTimeoutRef.current) return; // đã có timer đang chạy
      focusLostTimeoutRef.current = setTimeout(() => {
        focusLostTimeoutRef.current = null;
        if (!startedRef.current || lockedRef.current || submittingRef.current) return;
        if (document.hasFocus()) return; // focus đã quay lại
        void handleViolation('focus_lost');
      }, FOCUS_LOST_GRACE_MS);
    };

    const handleFocus = () => {
      // Focus quay lại trước khi hết grace → hủy, không tính vi phạm
      if (focusLostTimeoutRef.current) {
        clearTimeout(focusLostTimeoutRef.current);
        focusLostTimeoutRef.current = null;
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      if (focusLostTimeoutRef.current) {
        clearTimeout(focusLostTimeoutRef.current);
        focusLostTimeoutRef.current = null;
      }
    };
  }, [started, locked, submitting, handleViolation]);

  // Ghi màn hình: đăng ký handler khi thí sinh tự dừng chia sẻ giữa bài.
  // recording_stopped → backend khóa NGAY lần đầu → handleViolation auto-submit.
  // Nếu track đã ended trước khi effect này chạy, setOnRecordingStopped gọi lại ngay.
  useEffect(() => {
    if (!screenShareRequired) return;
    return examRecorder.setOnRecordingStopped(() => {
      if (!startedRef.current) {
        pendingRecordingStoppedRef.current = true;
        return;
      }
      void handleViolation('recording_stopped');
    });
  }, [handleViolation, screenShareRequired]);

  // The track can end during async exam initialization. Defer the report until
  // the backend has transitioned the attempt to `in_progress`.
  useEffect(() => {
    if (!screenShareRequired || !started || !pendingRecordingStoppedRef.current) return;
    pendingRecordingStoppedRef.current = false;
    void handleViolation('recording_stopped');
  }, [handleViolation, screenShareRequired, started]);

  // Resume-after-reload guard: nếu vào /exam khi bài đang chạy nhưng recorder KHÔNG
  // còn active (thí sinh F5/reload làm mất singleton), yêu cầu bật lại ghi màn hình.
  // Chỉ áp dụng khi batch bật record.
  useEffect(() => {
    if (!screenShareRequired) return;
    if (started && !locked && !submitting && !examRecorder.isActive()) {
      setRecordingLost(true);
    }
  }, [started, locked, submitting, screenShareRequired]);

  // [Anti-Cheat v2] Dynamic watermark interval
  useEffect(() => {
    const interval = setInterval(() => {
      setWatermarkTime(new Date());
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!started || locked || submitting) return;
    const inspectDisplays = () => {
      const snapshot = getExamEnvironmentSnapshot();
      if (snapshot.screenExtended === true && !multipleDisplayReportedRef.current) {
        multipleDisplayReportedRef.current = true;
        void handleViolation('multiple_display_detected', {
          metadata: {
            screenWidth: snapshot.screenWidth,
            screenHeight: snapshot.screenHeight,
            devicePixelRatio: snapshot.devicePixelRatio,
          },
        });
      } else if (snapshot.screenExtended === false) {
        multipleDisplayReportedRef.current = false;
      }
    };
    inspectDisplays();
    const interval = setInterval(inspectDisplays, 3000);
    return () => clearInterval(interval);
  }, [started, locked, submitting, handleViolation]);

  const triggerDevtoolsViolation = useCallback(() => {
    if (!startedRef.current || lockedRef.current || submittingRef.current) return;
    const now = Date.now();
    if (now - devtoolsViolationCooldownRef.current < 10000) return; // 10s cooldown
    devtoolsViolationCooldownRef.current = now;
    void handleViolation('devtools_open');
  }, [handleViolation]);

  // Chặn phím tắt mở DevTools và context menu
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!startedRef.current || lockedRef.current || submittingRef.current) return;

      const isF12 = e.key === 'F12';
      const key = e.key.toLowerCase();
      const isCtrlShiftI = e.ctrlKey && e.shiftKey && key === 'i';
      const isCtrlShiftJ = e.ctrlKey && e.shiftKey && key === 'j';
      const isCtrlShiftC = e.ctrlKey && e.shiftKey && key === 'c';
      const isCtrlShiftK = e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k');
      const isMacDevtools = e.metaKey && e.altKey && ['i', 'j', 'c'].includes(key);
      const isViewSource = (e.ctrlKey && key === 'u') || (e.metaKey && e.altKey && key === 'u');
      // Phím chụp màn hình
      const isPrintScreen = e.key === 'PrintScreen' || e.key === 'Snapshot';
      const isMacScreenshot = e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key);
      // Ctrl+P (in trang) — một số extension dùng print API để capture
      const isPrint = (e.ctrlKey || e.metaKey) && key === 'p';

      // Intercept F11 to force HTML5 Fullscreen API
      if (e.key === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => { });
        } else {
          document.exitFullscreen().catch(() => { });
        }
        return;
      }

      if (isF12 || isCtrlShiftI || isCtrlShiftJ || isCtrlShiftC || isCtrlShiftK || isMacDevtools) {
        e.preventDefault();
        e.stopPropagation();
        triggerDevtoolsViolation();
      }

      if (isViewSource) {
        e.preventDefault();
        e.stopPropagation();
        void handleViolation('view_source');
      }

      if (isPrintScreen || isMacScreenshot) {
        e.preventDefault();
        e.stopPropagation();
        void handleViolation('screenshot_attempt');
      }

      if (isPrint) {
        e.preventDefault();
        e.stopPropagation();
        void handleViolation('print_attempt');
      }
    };

    const handleContextMenu = (e: MouseEvent) => {
      if (startedRef.current && !lockedRef.current && !submittingRef.current) {
        e.preventDefault();
      }
    };

    // Dùng capture phase (true) để bắt trước khi browser xử lý
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('contextmenu', handleContextMenu);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [triggerDevtoolsViolation, handleViolation]);

  // Đã gỡ bỏ tính năng phát hiện DevTools qua kích thước cửa sổ vì tính năng này 
  // không tương thích với quá trình chuyển đổi (transition) Fullscreen của trình duyệt,
  // gây ra các báo cáo vi phạm giả mạo (false positives).

  // Chặn in trang (Ctrl+P qua menu browser) — kích hoạt beforeprint event
  useEffect(() => {
    const handleBeforePrint = () => {
      if (!startedRef.current || lockedRef.current || submittingRef.current) return;
      void handleViolation('print_attempt');
    };
    window.addEventListener('beforeprint', handleBeforePrint);
    return () => window.removeEventListener('beforeprint', handleBeforePrint);
  }, [handleViolation]);

  useEffect(() => {
    if (locked || submitting) {
      clearFullscreenExitTimeout();
    }
    if (locked) {
      fullscreenAutoSubmitTriggeredRef.current = true;
    }
  }, [clearFullscreenExitTimeout, locked, submitting]);

  useEffect(() => {
    if (!started) {
      fullscreenAutoSubmitTriggeredRef.current = false;
    }
  }, [started]);

  useEffect(() => {
    return () => {
      clearFullscreenExitTimeout();
    };
  }, [clearFullscreenExitTimeout]);

  useEffect(() => {
    if (started && timerReady && !loading && !locked && !submitting) {
      const timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            void handleSubmit(true);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [handleSubmit, loading, locked, started, submitting, timerReady]);

  useEffect(() => {
    return () => {
      if (clipboardWarningTimeoutRef.current) {
        clearTimeout(clipboardWarningTimeoutRef.current);
      }
    };
  }, []);


  const loadQuestions = async (prefetchedData?: any) => {
    try {
      let data = prefetchedData;
      if (!data) {
        const res = await studentApi.getQuestions(); // [C-4] token tự động
        data = res.data;
      }

      // Server trả về { questions, time_remaining } hoặc array (compat cũ)
      const q: Question[] = data.questions ?? data;
      const serverTimeRemaining: number | null = data.time_remaining ?? null;
      const serverNextPartIndex = Number(data.recording_next_part_index);
      if (recordMode === 's3') {
        if (Number.isInteger(serverNextPartIndex) && serverNextPartIndex >= 0) {
          recordingNextPartIndexRef.current = serverNextPartIndex;
          if (!examRecorder.setNextPartIndex(serverNextPartIndex) && examRecorder.isActive()) {
            console.error('[exam] Could not reconcile the server recording part cursor');
          }
        }
        examRecorder.activateS3ReservationTracking();
      }

      setQuestions(q);
      const savedAnswers: { [key: number]: string } = {};
      q.forEach((question: Question) => {
        if (question.answer) savedAnswers[question.question_order] = question.answer;
      });
      setAnswers(savedAnswers);

      // Set timer từ server (ưu tiên server, fallback sang localStorage)
      if (serverTimeRemaining !== null) {
        const wasAlreadyStarted = timeLeft > 0;
        setTimeLeft(Math.max(0, serverTimeRemaining));
        setTimerReady(true);
        // Nếu đây là resume (đã có timeLeft trước đó khác với giá trị mặc định)
        // và thời gian còn lại khác với duration đầy đủ → hiện thông báo resume
        const fullDuration = parseInt(localStorage.getItem('duration') || '30') * 60;
        if (wasAlreadyStarted || serverTimeRemaining < fullDuration - 5) {
          setResumeInfo({ timeLeft: serverTimeRemaining });
        }
      } else if (serverTimeRemaining === null) {
        // Fallback: server chưa có deadline (DB cũ chưa migrate)
        const duration = parseInt(localStorage.getItem('duration') || '30');
        setTimeLeft(duration * 60);
        setTimerReady(true);
      }

      setLoading(false);

      if (editorRef.current) {
        editorRef.current.focus();
      }
    } catch (error: any) {
      if (error.response?.status === 410) {
        startedRef.current = false;
        setStarted(false);
        const reason = normalizeBlockReason(error.response.data?.reason);
        finishSubmittedAttempt(getBlockReasonMessage(reason).message);
        return;
      }
      console.error(error);
      throw error;
    }
  };


  const showClipboardWarning = useCallback((message: string) => {
    setClipboardWarning(message);
    if (clipboardWarningTimeoutRef.current) {
      clearTimeout(clipboardWarningTimeoutRef.current);
    }
    clipboardWarningTimeoutRef.current = setTimeout(() => {
      setClipboardWarning('');
    }, 2500);
  }, []);

  const handleClipboardAttempt = useCallback((type: 'copy_attempt' | 'cut_attempt' | 'paste_attempt') => {
    if (!started || locked || submitting) return;

    showClipboardWarning('Copy, cut, and paste are not allowed during the exam.');

    const now = Date.now();
    const lastTriggeredAt = clipboardCooldownRef.current[type] || 0;
    if (now - lastTriggeredAt < CLIPBOARD_VIOLATION_COOLDOWN_MS) {
      return;
    }

    clipboardCooldownRef.current[type] = now;
    void handleViolation(type);
  }, [locked, showClipboardWarning, started, submitting]);

  // NOTE: Clipboard shortcuts (Ctrl+C/X/V) are now intercepted INSIDE the
  // CodeEditor component via Monaco's addCommand() API. This is required because
  // Monaco stops DOM event propagation internally, so React synthetic keyboard
  // events on a wrapper div never fire for shortcuts handled by Monaco.
  // The CodeEditor calls these callbacks directly:
  const handleCopyAttempt  = useCallback(() => handleClipboardAttempt('copy_attempt'),  [handleClipboardAttempt]);
  const handleCutAttempt   = useCallback(() => handleClipboardAttempt('cut_attempt'),   [handleClipboardAttempt]);
  const handlePasteAttempt = useCallback(() => handleClipboardAttempt('paste_attempt'), [handleClipboardAttempt]);

  // [Anti-Cheat] Suspicious paste handler: được gọi từ CodeEditor khi Monaco phát hiện
  // >= 300 ký tự xuất hiện đột ngột trong 1 change event. Gửi kèm preview (500 ký tự)
  // và độ dài thật để backend ghi forensic log.
  const handleSuspiciousPaste = useCallback((preview: string, textLength: number) => {
    if (!started || locked || submitting) return;
    void handleViolation('suspicious_paste', {
      contentPreview: preview,
      textLength,
      questionId: currentQuestionIdRef.current,
    });
  }, [started, locked, submitting, handleViolation]);

  const handleRapidInsertion = useCallback((metadata: {
    insertedChars: number;
    changeCount: number;
    windowMs: number;
    maxSingleChange: number;
  }) => {
    if (!started || locked || submitting) return;
    void handleViolation('rapid_text_insertion', {
      textLength: metadata.insertedChars,
      questionId: currentQuestionIdRef.current,
      metadata,
    });
  }, [started, locked, submitting, handleViolation]);

  // Bật lại ghi màn hình sau khi recorder mất state (reload/F5). Chia sẻ lại
  // toàn màn hình; đạt → tiếp tục thi, không đạt → giữ modal chặn.
  const handleResumeRecording = useCallback(async () => {
    if (recordingResumeInFlightRef.current || submissionFinishedRef.current) return;
    recordingResumeInFlightRef.current = true;
    const setupGeneration = ++recordingSetupGenerationRef.current;
    // Resume sau F5: dirHandle (local) không sống qua reload → phải chọn lại thư mục.
    // Password lấy lại từ localStorage (server đã cấp lúc verify, tái dùng đúng pass cũ).
    try {
      const setup = await examRecorder.requestSetup(recordMode === 'none' ? 'live' : recordMode);
      if (!setup.ok) return; // giữ modal, thí sinh phải thử lại

      // The picker may resolve after a timer/violation has already submitted and
      // navigated away. Release that newly acquired stream; never start a stale
      // recorder on /submit or after this component unmounts.
      if (
        !mountedRef.current
        || submissionFinishedRef.current
        || setupGeneration !== recordingSetupGenerationRef.current
      ) {
        await examRecorder.stopAndDiscard();
        return;
      }

      if (recordMode === 'none') {
        examRecorder.startLiveCapture();
      } else {
        const password = localStorage.getItem('recordingPassword');
        examRecorder.start({
          mode: recordMode,
          password,
          initialPartIndex: recordMode === 's3' ? recordingNextPartIndexRef.current : 0,
        });
        if (recordMode === 's3') examRecorder.activateS3ReservationTracking();
      }
      setRecordingLost(false);
    } finally {
      recordingResumeInFlightRef.current = false;
    }
  }, [recordMode]);

  const saveAnswer = useCallback((order: number, text: string) => {
    setAnswers(prev => ({ ...prev, [order]: text }));
    dirtyAnswersRef.current[order] = text;

    if (debounceRef.current[order]) clearTimeout(debounceRef.current[order]);
    debounceRef.current[order] = setTimeout(() => {
      delete debounceRef.current[order];
      flushDirtyAnswers().catch(console.error);
    }, 5000);
  }, [flushDirtyAnswers]);

  // Chọn/bỏ chọn đáp án trắc nghiệm. answer được lưu dưới dạng JSON mảng key, VD ["A","C"].
  // Single: thay thế; Multiple: toggle. Lưu ngay (debounce ngắn) qua studentApi.saveAnswer.
  const toggleQuizAnswer = useCallback((order: number, key: string, multiple: boolean) => {
    setAnswers(prev => {
      let current: string[] = [];
      try { current = prev[order] ? JSON.parse(prev[order]) : []; } catch (_) { current = []; }
      let next: string[];
      if (multiple) {
        next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
      } else {
        next = [key];
      }
      const serialized = JSON.stringify(next);
      dirtyAnswersRef.current[order] = serialized;
      if (debounceRef.current[order]) clearTimeout(debounceRef.current[order]);
      debounceRef.current[order] = setTimeout(() => {
        delete debounceRef.current[order];
        flushDirtyAnswers().catch(console.error);
      }, 500);
      return { ...prev, [order]: serialized };
    });
  }, [flushDirtyAnswers]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Sanitize HTML để chống XSS nhưng vẫn giữ lại các tag định dạng an toàn
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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-600 font-medium">Loading your exam...</p>
        </div>
      </div>
    );
  }

  if (initializationError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white rounded-2xl shadow-xl border border-amber-200 p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-xl font-bold text-slate-900 mb-3">Could not load the assessment</h2>
          <p className="text-slate-600 mb-6 leading-relaxed">{initializationError}</p>
          <p className="text-sm text-slate-500 mb-6">
            {recordEnabled
              ? examRecorder.isActive()
                ? 'Screen recording remains active while you retry. Do not close this tab.'
                : 'Screen recording is not active. Retry loading, then restart screen sharing before continuing.'
              : 'Retry loading the assessment. Do not close this tab.'}
          </p>
          <button
            type="button"
            onClick={() => {
              setInitializationError('');
              setLoading(true);
              setInitializationRetry((value) => value + 1);
            }}
            className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            Retry loading
          </button>
        </div>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="bg-white rounded-2xl shadow-xl border border-red-200 p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-red-600 mb-3">Exam Locked</h2>
          <p className="text-slate-600 mb-6 leading-relaxed">
            You have violated exam rules multiple times. Your session has been terminated.
          </p>
          <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 text-sm text-slate-500">
            Please contact your administrator for assistance.
          </div>
        </div>
      </div>
    );
  }

  const currentQuestion = questions[currentIndex];

  if (!currentQuestion) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-slate-600 font-medium">Loading questions...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 select-none pb-20">
      {/* Sticky Header with Timer */}
      <div className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-lg font-mono tracking-wider ${
              timeLeft < 300 
                ? 'bg-red-100 text-red-700 border border-red-200 animate-pulse' 
                : 'bg-slate-900 text-white shadow-md'
            }`}>
              <svg className="w-5 h-5 opacity-80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {formatTime(timeLeft)}
            </div>
          </div>
          <button
            onClick={() => handleSubmit()}
            disabled={submitting}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Submit Exam'}
          </button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 pb-12">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-bold text-blue-600 tracking-wider uppercase">Question</span>
            <span className="bg-slate-200 text-slate-700 py-1 px-3 rounded-full text-sm font-bold">
              {currentIndex + 1} <span className="opacity-50 font-normal mx-1">of</span> {questions.length}
            </span>
          </div>
        </div>

        {violationCount > 0 && (
          <div className="mb-6 p-4 bg-orange-50 border border-orange-200 rounded-xl flex items-start gap-3 text-orange-800">
            <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <p className="font-bold text-sm">Warning: {violationCount} violation(s) recorded.</p>
              <p className="text-sm opacity-90">After 2 violations, your exam will be locked automatically.</p>
            </div>
          </div>
        )}

        {clipboardWarning && (
          <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm font-medium flex items-center gap-2 animate-pulse">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
            {clipboardWarning}
          </div>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden mb-8">
          <div className="p-8 border-b border-slate-100 bg-slate-50/30">
            <div
              className="prose prose-slate max-w-none prose-pre:bg-slate-800 prose-pre:text-slate-50"
              dangerouslySetInnerHTML={{
                __html: sanitizeQuestion(currentQuestion.question_sample)
              }}
            />
          </div>
          <div className="p-8">
            <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-6 flex items-center gap-2">
              <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Your Answer
            </h3>
            
            {(currentQuestion.type === 'SingleChoice' || currentQuestion.type === 'MultipleChoice') ? (
              (() => {
                const multiple = currentQuestion.type === 'MultipleChoice';
                let selected: string[] = [];
                try {
                  const raw = answers[currentQuestion.question_order];
                  selected = raw ? JSON.parse(raw) : [];
                } catch (_) { selected = []; }
                return (
                  <div className="space-y-4">
                    <p className="text-slate-500 text-sm bg-slate-50 p-3 rounded-lg border border-slate-100 flex items-center gap-2">
                      <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {multiple ? 'Select all correct answers (multiple choices allowed)' : 'Select one answer'}
                    </p>
                    <div className="grid gap-3">
                      {(currentQuestion.options || []).map((opt) => {
                        const checked = selected.includes(opt.key);
                        return (
                          <label
                            key={opt.key}
                            className={`flex items-start gap-4 p-4 rounded-xl border-2 transition-all cursor-pointer ${
                              (locked || submitting) ? 'opacity-70 cursor-not-allowed' : 'hover:border-blue-300'
                            } ${
                              checked 
                                ? 'border-blue-600 bg-blue-50/50' 
                                : 'border-slate-200 bg-white'
                            }`}
                          >
                            <div className="flex items-center h-6 pt-0.5">
                              <input
                                type={multiple ? 'checkbox' : 'radio'}
                                name={`q-${currentQuestion.question_order}`}
                                checked={checked}
                                disabled={locked || submitting}
                                onChange={() => toggleQuizAnswer(currentQuestion.question_order, opt.key, multiple)}
                                className={`w-5 h-5 text-blue-600 border-slate-300 focus:ring-blue-500 ${
                                  multiple ? 'rounded' : 'rounded-full'
                                }`}
                              />
                            </div>
                            <div className="flex-1">
                              <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md mr-3 text-sm font-bold ${
                                checked ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                              }`}>
                                {opt.key}
                              </span>
                              <span className={`text-base ${checked ? 'text-slate-900 font-medium' : 'text-slate-700'}`}>
                                {opt.text}
                              </span>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="rounded-xl overflow-hidden border border-slate-200 shadow-inner bg-slate-50">
                <Suspense
                  fallback={
                    <div className="h-[550px] flex items-center justify-center text-slate-500 bg-slate-50">
                      <div className="flex flex-col items-center gap-3">
                        <div className="w-6 h-6 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin"></div>
                        <span>Initializing code editor...</span>
                      </div>
                    </div>
                  }
                >
                  <CodeEditor
                    ref={editorRef}
                    value={answers[currentQuestion.question_order] || ''}
                    modelPath={`inmemory://exam/question/${encodeURIComponent(currentQuestion.id)}`}
                    onChange={(val) => saveAnswer(currentQuestion.question_order, val)}
                    onCopyAttempt={handleCopyAttempt}
                    onCutAttempt={handleCutAttempt}
                    onPasteAttempt={handlePasteAttempt}
                    onSuspiciousPaste={handleSuspiciousPaste}
                    onRapidInsertion={handleRapidInsertion}
                    defaultLanguage={detectLanguage(
                      currentQuestion.type,
                      currentQuestion.module
                    )}
                    disabled={locked || submitting}
                    height="550px"
                  />
                </Suspense>
              </div>
            )}
          </div>
        </div>

        {/* Fixed Bottom Navigation */}
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 p-4 z-40 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center gap-4">
            <button
              onClick={() => {
                if (currentIndex > 0) {
                  setCurrentIndex(currentIndex - 1);
                }
              }}
              disabled={currentIndex === 0}
              className="hidden md:inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 font-medium text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Previous
            </button>
            
            <div className="flex-1 overflow-x-auto pb-2 md:pb-0 hide-scrollbar flex justify-center w-full">
              <div className="flex gap-2 mx-auto">
                {questions.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentIndex(idx)}
                    className={`flex-shrink-0 w-10 h-10 rounded-lg text-sm font-bold transition-all ${
                      idx === currentIndex 
                        ? 'bg-blue-600 text-white shadow-md ring-2 ring-blue-600 ring-offset-2 scale-110' 
                        : answers[questions[idx].question_order] 
                          ? 'bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200' 
                          : 'bg-white border border-slate-300 text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    {idx + 1}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex w-full md:w-auto gap-2 justify-between">
              <button
                onClick={() => {
                  if (currentIndex > 0) {
                    setCurrentIndex(currentIndex - 1);
                  }
                }}
                disabled={currentIndex === 0}
                className="md:hidden flex-1 inline-flex justify-center items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 font-medium text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Prev
              </button>
              
              <button
                onClick={() => {
                  if (currentIndex < questions.length - 1) {
                    setCurrentIndex(currentIndex + 1);
                  }
                }}
                disabled={currentIndex === questions.length - 1}
                className="flex-1 md:flex-none inline-flex justify-center items-center gap-2 px-5 py-2.5 rounded-lg border border-slate-300 font-medium text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                Next
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Modals & Overlays */}
      {recordingLost && !locked && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-[10000] p-4">
          <div className="bg-white p-8 rounded-2xl max-w-md w-full text-center border border-red-200 shadow-2xl">
            <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-red-600 mb-4">
              {recordEnabled ? 'Screen recording interrupted' : 'Screen sharing interrupted'}
            </h3>
            <p className="text-slate-600 mb-8 leading-relaxed">
              {recordEnabled ? 'Screen recording was lost' : 'Screen sharing was lost'} (possibly due to a page reload). You must share
              your <strong className="text-slate-900">entire screen</strong> again to continue the exam.
            </p>
            <button 
              onClick={handleResumeRecording} 
              className="w-full inline-flex justify-center items-center px-6 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-700 transition-colors shadow-sm"
            >
              {recordEnabled ? 'Restart Screen Recording' : 'Restart Screen Sharing'}
            </button>
          </div>
        </div>
      )}

      {violationWarningModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-white p-8 rounded-2xl max-w-md w-full text-center border-2 border-orange-500 shadow-2xl transform scale-100 animate-in fade-in zoom-in duration-200">
            <div className="w-16 h-16 bg-orange-100 text-orange-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h3 className="text-2xl font-bold text-orange-600 mb-4">Rule Violation</h3>
            <p className="text-slate-700 text-lg mb-6 leading-relaxed">
              {violationWarningModal}
            </p>
            <p className="text-slate-400 text-sm">
              This warning will disappear automatically...
            </p>
          </div>
        </div>
      )}

      {resumeInfo && (
        <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-[10000] p-4">
          <div className="bg-white p-10 rounded-3xl shadow-2xl max-w-md w-full text-center border-2 border-emerald-500">
            <div className="w-20 h-20 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10 animate-spin-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <h3 className="text-2xl font-bold text-emerald-600 mb-2">
              Exam Resumed
            </h3>
            <p className="text-slate-600 mb-6">
              Your session has been restored. Time remaining:
            </p>
            <div className="bg-slate-50 rounded-2xl p-6 mb-8 border border-slate-100">
              <p className="text-5xl font-black text-emerald-600 font-mono tracking-tight tabular-nums">
                {formatTime(resumeInfo.timeLeft)}
              </p>
            </div>
            <div className="bg-orange-50 text-orange-800 text-sm p-4 rounded-xl text-left mb-8 flex items-start gap-3">
              <svg className="w-5 h-5 shrink-0 mt-0.5 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <p>If you close the browser again, you will have exactly 2 minutes to return before automatic submission.</p>
            </div>
            <button
              onClick={() => setResumeInfo(null)}
              className="w-full inline-flex justify-center items-center px-6 py-4 bg-emerald-600 text-white rounded-xl font-bold text-lg hover:bg-emerald-700 transition-colors shadow-sm"
            >
              Continue Exam
            </button>
          </div>
        </div>
      )}

      {started && !locked && (
        <div
          aria-hidden="true"
          className="fixed inset-0 pointer-events-none z-[9997] overflow-hidden"
        >
          {Array.from({ length: 12 }).map((_, i) => (
            <span
              key={i}
              className="absolute text-[26px] font-bold whitespace-nowrap text-black/5 select-none"
              style={{
                top: `${((i % 3) * 33 + 8 + Math.floor(watermarkTime.getTime() / 15000) * 7) % 92}%`,
                left: `${(Math.floor(i / 3) * 26 + Math.floor(watermarkTime.getTime() / 15000) * 11) % 94}%`,
                transform: 'rotate(-25deg)',
              }}
            >
              {studentEmail || studentId} · SID {studentId} · {watermarkTime.toLocaleString('vi-VN')}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default StudentExam;
