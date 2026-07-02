import { useState, useEffect, useRef, useCallback, Suspense, lazy } from 'react';
import { useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { studentApi } from '../services/api';
import { detectLanguage } from '../components/CodeEditor';
import type { CodeEditorHandle } from '../components/CodeEditor';

// Lazy-load Monaco Editor to avoid bloating the initial bundle
const CodeEditor = lazy(() => import('../components/CodeEditor'));

const CLIPBOARD_VIOLATION_COOLDOWN_MS = 3000;
const FULLSCREEN_EXIT_TIMEOUT_MS = 5000;

interface Question {
  id: string;
  question_order: number;
  question_sample: string;
  module: string;
  level: string;
  type: string;
  answer?: string;
}

type BlockReason = 'timeout' | 'absent_too_long' | 'submitted';

function StudentExam() {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<{ [key: number]: string }>({});
  const [timeLeft, setTimeLeft] = useState(0);
  const [violationCount, setViolationCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clipboardWarning, setClipboardWarning] = useState('');
  const [violationWarningModal, setViolationWarningModal] = useState('');
  // Thông báo khi học viên reconnect sau khi tắt trình duyệt
  const [resumeInfo, setResumeInfo] = useState<{ timeLeft: number } | null>(null);
  // Thông báo khi bài thi bị block (timeout / vắng mặt quá lâu)
  const [blockedReason, setBlockedReason] = useState<BlockReason | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const clipboardCooldownRef = useRef<Record<string, number>>({});
  const clipboardWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const violationWarningModalTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fullscreenExitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fullscreenAutoSubmitTriggeredRef = useRef(false);
  const devtoolsViolationCooldownRef = useRef<number>(0);
  const startedRef = useRef(false);
  const lockedRef = useRef(false);
  const submittingRef = useRef(false);
  const lastViolationTimeRef = useRef<number>(0);
  const navigate = useNavigate();

  const studentId = localStorage.getItem('studentId');

  useEffect(() => {
    if (!studentId) {
      navigate('/');
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
        const existingRes = await studentApi.getQuestions(parseInt(studentId));
        const data = existingRes.data;
        const existingQuestions = data.questions ?? data; // compat với format cũ
        console.log('[Exam] Step 1 done, questions:', existingQuestions.length);

        if (existingQuestions.length > 0) {
          console.log('[Exam] Found questions, loading (resume)...');
          setStarted(true);
          loadQuestions(data);
          return;
        }

        console.log('[Exam] No questions, starting new exam...');
        const res = await studentApi.startExam(parseInt(studentId));

        console.log('[Exam] Start result:', res.data);

        if (res.data.success) {
          setStarted(true);
          // Sau khi start, gọi getQuestions để lấy time_remaining
          const qRes = await studentApi.getQuestions(parseInt(studentId));
          loadQuestions(qRes.data);
        }
      } catch (error: any) {
        console.error('[Exam] Error:', error);
        // Xử lý trường hợp bị block (410 Gone)
        if (error.response?.status === 410) {
          const reason: BlockReason = error.response.data?.reason ?? 'submitted';
          setBlockedReason(reason);
          setLoading(false);
          document.exitFullscreen().catch(() => { });
          return;
        }
        alert('Error: ' + (error.response?.data?.error || error.message));
        navigate('/');
      }
    };

    initExam();
  }, [navigate, studentId]);


  useEffect(() => {
    startedRef.current = started;
  }, [started]);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  useEffect(() => {
    submittingRef.current = submitting;
  }, [submitting]);

  // Gửi beacon khi học viên tắt trình duyệt / đóng tab
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (startedRef.current && !submittingRef.current && !lockedRef.current && studentId) {
        studentApi.disconnect(parseInt(studentId));
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [studentId]);

  const clearFullscreenExitTimeout = useCallback(() => {
    if (fullscreenExitTimeoutRef.current) {
      clearTimeout(fullscreenExitTimeoutRef.current);
      fullscreenExitTimeoutRef.current = null;
    }
  }, []);

  const handleSubmit = useCallback(async (force = false) => {
    if (submittingRef.current) return;
    if (!force && !confirm('Are you sure you want to submit?')) return;

    setSubmitting(true);
    try {
      await studentApi.submit(parseInt(studentId!));
      document.exitFullscreen().catch(() => { });
      navigate('/submit');
    } catch (error) {
      console.error(error);
      alert('Error submitting exam. Please contact support.');
      setSubmitting(false);
    }
  }, [navigate, studentId]);

  const handleViolation = useCallback(async (type: string): Promise<boolean> => {
    const now = Date.now();
    // Global cooldown: ignore multiple violations within 3 seconds
    // This prevents copy+paste or alt+tab from counting as 2 violations instantly
    if (now - lastViolationTimeRef.current < 3000) {
      return false;
    }
    lastViolationTimeRef.current = now;

    try {
      const res = await studentApi.reportViolation(parseInt(studentId!), type);
      setViolationCount(res.data.total_violations);
      if (res.data.locked) {
        setLocked(true);
        clearFullscreenExitTimeout();
        document.exitFullscreen().catch(() => { });
        alert('You have violated the exam rules. Your exam has been locked.');
        await handleSubmit(true);
        return true;
      } else {
        const warningByType: Record<string, string> = {
          fullscreen_exit: 'You exited fullscreen',
          tab_switch: 'You switched tabs',
          copy_attempt: 'You attempted to copy text',
          cut_attempt: 'You attempted to cut text',
          paste_attempt: 'You attempted to paste text',
          devtools_open: 'You attempted to open Developer Tools'
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

        // Reset cooldown after warning appears to prevent queued events from firing immediately
        lastViolationTimeRef.current = Date.now();
        return false;
      }
    } catch (error) {
      console.error(error);
      return false;
    }
  }, [clearFullscreenExitTimeout, handleSubmit, studentId]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (!startedRef.current || lockedRef.current || submittingRef.current) {
        clearFullscreenExitTimeout();
        return;
      }

      if (document.fullscreenElement) {
        clearFullscreenExitTimeout();
        fullscreenAutoSubmitTriggeredRef.current = false;
        return;
      }

      if (fullscreenExitTimeoutRef.current || fullscreenAutoSubmitTriggeredRef.current) {
        return;
      }

      fullscreenExitTimeoutRef.current = setTimeout(async () => {
        fullscreenExitTimeoutRef.current = null;

        if (!startedRef.current || lockedRef.current || submittingRef.current) return;
        if (document.fullscreenElement) return;
        if (fullscreenAutoSubmitTriggeredRef.current) return;

        fullscreenAutoSubmitTriggeredRef.current = true;
        const wasLocked = await handleViolation('fullscreen_exit');

        if (wasLocked) return;

        if (!document.fullscreenElement) {
          fullscreenExitTimeoutRef.current = setTimeout(async () => {
            fullscreenExitTimeoutRef.current = null;
            if (!startedRef.current || lockedRef.current || submittingRef.current) return;
            if (document.fullscreenElement) return;

            await handleViolation('fullscreen_exit');
          }, FULLSCREEN_EXIT_TIMEOUT_MS);
        }
      }, FULLSCREEN_EXIT_TIMEOUT_MS);
    };

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
  }, [clearFullscreenExitTimeout, handleSubmit, handleViolation]);

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
      const isCtrlShiftI = e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i');
      const isCtrlShiftJ = e.ctrlKey && e.shiftKey && (e.key === 'J' || e.key === 'j');
      const isCtrlShiftC = e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c');
      const isCtrlShiftK = e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k');
      const isCtrlU = e.ctrlKey && (e.key === 'u' || e.key === 'U');

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

      if (isF12 || isCtrlShiftI || isCtrlShiftJ || isCtrlShiftC || isCtrlShiftK || isCtrlU) {
        e.preventDefault();
        e.stopPropagation();
        triggerDevtoolsViolation();
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
  }, [triggerDevtoolsViolation]);

  // Đã gỡ bỏ tính năng phát hiện DevTools qua kích thước cửa sổ vì tính năng này 
  // không tương thích với quá trình chuyển đổi (transition) Fullscreen của trình duyệt,
  // gây ra các báo cáo vi phạm giả mạo (false positives).

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
    if (started && !locked) {
      const timer = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            handleSubmit();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [handleSubmit, locked, started]);

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
        const res = await studentApi.getQuestions(parseInt(studentId!));
        data = res.data;
      }

      // Server trả về { questions, time_remaining } hoặc array (compat cũ)
      const q: Question[] = data.questions ?? data;
      const serverTimeRemaining: number | null = data.time_remaining ?? null;

      setQuestions(q);
      const savedAnswers: { [key: number]: string } = {};
      q.forEach((question: Question) => {
        if (question.answer) savedAnswers[question.question_order] = question.answer;
      });
      setAnswers(savedAnswers);

      // Set timer từ server (ưu tiên server, fallback sang localStorage)
      if (serverTimeRemaining !== null && serverTimeRemaining > 0) {
        const wasAlreadyStarted = timeLeft > 0;
        setTimeLeft(serverTimeRemaining);
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
      }

      setLoading(false);

      if (editorRef.current) {
        editorRef.current.focus();
      }
    } catch (error: any) {
      if (error.response?.status === 410) {
        const reason: BlockReason = error.response.data?.reason ?? 'submitted';
        setBlockedReason(reason);
        setLoading(false);
        document.exitFullscreen().catch(() => { });
        return;
      }
      console.error(error);
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

  const saveAnswer = useCallback((order: number, text: string) => {
    setAnswers(prev => ({ ...prev, [order]: text }));

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      studentApi.saveAnswer(parseInt(studentId!), order, text).catch(console.error);
    }, 2000);
  }, [studentId]);

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p>Loading exam...</p>
      </div>
    );
  }

  if (locked) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div className="card" style={{ textAlign: 'center' }}>
          <h2 style={{ color: 'var(--danger)' }}>Exam Locked</h2>
          <p>You have violated exam rules multiple times.</p>
          <p>Please contact your administrator.</p>
        </div>
      </div>
    );
  }

  if (blockedReason) {
    const blockedMessages: Record<BlockReason, { title: string; message: string; icon: string }> = {
      timeout: {
        icon: '⏰',
        title: 'Time\'s Up',
        message: 'Your exam time has expired. Your answers have been automatically submitted.'
      },
      absent_too_long: {
        icon: '🚫',
        title: 'Session Expired',
        message: 'You were absent for more than 2 minutes. Your exam has been automatically submitted to prevent cheating.'
      },
      submitted: {
        icon: '✅',
        title: 'Exam Already Submitted',
        message: 'Your exam has already been submitted. You cannot re-enter the exam.'
      }
    };
    const { icon, title, message } = blockedMessages[blockedReason];
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--background)' }}>
        <div className="card" style={{ textAlign: 'center', maxWidth: 480 }}>
          <div style={{ fontSize: 64, marginBottom: 16 }}>{icon}</div>
          <h2 style={{ color: 'var(--danger)', marginBottom: 12 }}>{title}</h2>
          <p style={{ lineHeight: 1.6, color: 'var(--text)' }}>{message}</p>
          <p style={{ marginTop: 20, color: 'var(--text-light)', fontSize: 14 }}>Please contact your administrator if you believe this is an error.</p>
        </div>
      </div>
    );
  }

  const currentQuestion = questions[currentIndex];

  if (!currentQuestion) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p className="loading">Loading questions...</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <div className="exam-timer" style={{ background: timeLeft < 300 ? 'var(--danger)' : 'var(--primary)' }}>
        {formatTime(timeLeft)}
      </div>

      <div style={{ maxWidth: 800, margin: '0 auto', padding: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <h2>Question {currentIndex + 1} of {questions.length}</h2>
            {/* <p style={{ color: 'var(--text-light)', fontSize: 14 }}>
              {currentQuestion.module} - {currentQuestion.level} - {currentQuestion.type}
            </p> */}
          </div>
          <button
            onClick={() => handleSubmit()}
            disabled={submitting}
            className="btn btn-primary"
          >
            {submitting ? 'Submitting...' : 'Submit Exam'}
          </button>
        </div>

        {violationCount > 0 && (
          <div className="violation-warning">
            Warning: {violationCount} violation(s) recorded. After 2 violations, your exam will be locked.
          </div>
        )}

        {clipboardWarning && (
          <div className="violation-warning" style={{ marginTop: 12, marginBottom: 12 }}>
            {clipboardWarning}
          </div>
        )}

        <div className="card">
          <div
            className="question-content"
            dangerouslySetInnerHTML={{
              __html: sanitizeQuestion(currentQuestion.question_sample)
            }}
          />
          <div className="form-group">
            <label>Your Answer:</label>
            <Suspense
              fallback={
                <div className="code-editor-loading-fallback">
                  Loading editor...
                </div>
              }
            >
              <CodeEditor
                ref={editorRef}
                value={answers[currentQuestion.question_order] || ''}
                onChange={(val) => saveAnswer(currentQuestion.question_order, val)}
                onCopyAttempt={handleCopyAttempt}
                onCutAttempt={handleCutAttempt}
                onPasteAttempt={handlePasteAttempt}
                defaultLanguage={detectLanguage(
                  currentQuestion.type,
                  currentQuestion.module
                )}
                disabled={locked || submitting}
                height="400px"
              />
            </Suspense>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
          <button
            onClick={() => {
              if (currentIndex > 0) {
                setCurrentIndex(currentIndex - 1);
              }
            }}
            disabled={currentIndex === 0}
            className="btn btn-secondary"
          >
            Previous
          </button>
          <div style={{ display: 'flex', gap: 5 }}>
            {questions.map((_, idx) => (
              <button
                key={idx}
                onClick={() => setCurrentIndex(idx)}
                style={{
                  width: 32,
                  height: 32,
                  border: 'none',
                  borderRadius: 4,
                  background: idx === currentIndex ? 'var(--primary)' : answers[questions[idx].question_order] ? 'var(--success)' : 'var(--border)',
                  color: idx === currentIndex ? 'white' : 'var(--text)',
                  cursor: 'pointer'
                }}
              >
                {idx + 1}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              if (currentIndex < questions.length - 1) {
                setCurrentIndex(currentIndex + 1);
              }
            }}
            disabled={currentIndex === questions.length - 1}
            className="btn btn-secondary"
          >
            Next
          </button>
        </div>
      </div>

      {/* Violation Warning Modal (Toast) */}
      {violationWarningModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            background: 'white',
            padding: '30px',
            borderRadius: '12px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
            maxWidth: '500px',
            textAlign: 'center',
            border: '2px solid var(--danger)'
          }}>
            <h3 style={{ color: 'var(--danger)', marginBottom: '15px', fontSize: '24px' }}>⚠️ Exam Rule Violation</h3>
            <p style={{ fontSize: '18px', lineHeight: '1.5', color: '#333' }}>
              {violationWarningModal}
            </p>
            <p style={{ marginTop: '20px', color: 'var(--text-light)', fontSize: '14px' }}>
              This warning will disappear automatically...
            </p>
          </div>
        </div>
      )}

      {/* Resume Notification Modal — xuất hiện khi học viên quay lại sau khi tắt trình duyệt */}
      {resumeInfo && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000
        }}>
          <div style={{
            background: 'white',
            padding: '36px 40px',
            borderRadius: '16px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
            maxWidth: '480px',
            textAlign: 'center',
            border: '2px solid #22c55e'
          }}>
            <div style={{ fontSize: 52, marginBottom: 12 }}>🔄</div>
            <h3 style={{ color: '#16a34a', marginBottom: '12px', fontSize: '22px' }}>
              Exam Resumed
            </h3>
            <p style={{ fontSize: '16px', lineHeight: '1.6', color: '#333', marginBottom: 8 }}>
              Your session has been restored. Time remaining:
            </p>
            <p style={{ fontSize: '32px', fontWeight: 700, color: '#16a34a', marginBottom: 16, fontVariantNumeric: 'tabular-nums' }}>
              {formatTime(resumeInfo.timeLeft)}
            </p>
            <p style={{ color: '#666', fontSize: '13px', marginBottom: 20 }}>
              ⚠️ If you close the browser again, you will have 2 minutes to return before your exam is automatically submitted.
            </p>
            <button
              onClick={() => setResumeInfo(null)}
              style={{
                background: '#16a34a',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                padding: '10px 28px',
                fontSize: 15,
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Continue Exam
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default StudentExam;