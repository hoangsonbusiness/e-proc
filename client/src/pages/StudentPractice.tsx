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

interface PracticeInfo {
  id: number;
  name: string;
  content_html: string;
}

type BlockReason = 'timeout' | 'absent_too_long' | 'submitted';

// Trang thi Practice: 1 đề dài import từ .docx (hiển thị bên trái) + 1 bài làm
// duy nhất trong code editor (bên phải). Tái dùng toàn bộ cơ chế anti-cheat,
// timer và violation của trang thi thường (StudentExam.tsx).
function StudentPractice() {
  const [practice, setPractice] = useState<PracticeInfo | null>(null);
  const [answer, setAnswer] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);
  const [violationCount, setViolationCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [started, setStarted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clipboardWarning, setClipboardWarning] = useState('');
  const [violationWarningModal, setViolationWarningModal] = useState('');
  const [resumeInfo, setResumeInfo] = useState<{ timeLeft: number } | null>(null);
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
  const studentToken = localStorage.getItem('studentToken');

  useEffect(() => {
    if (!studentId || !studentToken) {
      navigate('/');
      return;
    }

    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { });
    }

    const initPractice = async () => {
      try {
        // GET /student/practice tự start (set deadline) ở lần gọi đầu
        const res = await studentApi.getPractice();
        setStarted(true);
        loadPractice(res.data);
      } catch (error: any) {
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

    initPractice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Gửi beacon khi học viên tắt trình duyệt / đóng tab (dùng chung endpoint với exam)
  useEffect(() => {
    const handleBeforeUnload = () => {
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

  const handleSubmit = useCallback(async (force = false) => {
    if (submittingRef.current) return;
    if (!force && !confirm('Are you sure you want to submit?')) return;

    setSubmitting(true);
    try {
      await studentApi.submitPractice();
      document.exitFullscreen().catch(() => { });
      navigate('/submit');
    } catch (error) {
      console.error(error);
      alert('Error submitting exam. Please contact support.');
      setSubmitting(false);
    }
  }, [navigate]);

  const handleViolation = useCallback(async (type: string): Promise<boolean> => {
    const now = Date.now();
    if (now - lastViolationTimeRef.current < 3000) {
      return false;
    }
    lastViolationTimeRef.current = now;

    try {
      const res = await studentApi.reportViolation(type);
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

        setViolationWarningModal(`Warning: ${warning}. This is violation ${res.data.violation_count}. After 2 violations, your exam will be locked.`);
        if (violationWarningModalTimeoutRef.current) {
          clearTimeout(violationWarningModalTimeoutRef.current);
        }
        violationWarningModalTimeoutRef.current = setTimeout(() => {
          setViolationWarningModal('');
        }, 5000);

        lastViolationTimeRef.current = Date.now();
        return false;
      }
    } catch (error) {
      console.error(error);
      return false;
    }
  }, [clearFullscreenExitTimeout, handleSubmit]);

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

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('contextmenu', handleContextMenu);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [triggerDevtoolsViolation]);

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
            handleSubmit(true);
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

  const loadPractice = (data: any) => {
    setPractice(data.practice);
    setAnswer(data.answer || '');

    const serverTimeRemaining: number | null = data.time_remaining ?? null;
    if (serverTimeRemaining !== null && serverTimeRemaining > 0) {
      setTimeLeft(serverTimeRemaining);
      const fullDuration = parseInt(localStorage.getItem('duration') || '30') * 60;
      if (serverTimeRemaining < fullDuration - 5) {
        setResumeInfo({ timeLeft: serverTimeRemaining });
      }
    } else if (serverTimeRemaining === null) {
      const duration = parseInt(localStorage.getItem('duration') || '30');
      setTimeLeft(duration * 60);
    }

    setLoading(false);

    if (editorRef.current) {
      editorRef.current.focus();
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

  const handleCopyAttempt  = useCallback(() => handleClipboardAttempt('copy_attempt'),  [handleClipboardAttempt]);
  const handleCutAttempt   = useCallback(() => handleClipboardAttempt('cut_attempt'),   [handleClipboardAttempt]);
  const handlePasteAttempt = useCallback(() => handleClipboardAttempt('paste_attempt'), [handleClipboardAttempt]);

  const saveAnswer = useCallback((text: string) => {
    setAnswer(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      studentApi.savePracticeAnswer(text).catch(console.error);
    }, 2000);
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Đoán ngôn ngữ mặc định của editor từ tên đề + phần đầu nội dung đề
  // (ví dụ "Practice_Cobol_M3" → cobol; đề chứa "C/C++" → cpp). Học viên vẫn
  // đổi được qua dropdown. Thay _/- bằng khoảng trắng vì detectLanguage dùng
  // \b (word boundary) mà dấu gạch dưới là word character — "practice_cobol"
  // sẽ không match \bcobol\b nếu giữ nguyên.
  const practiceLanguage = detectLanguage(
    practice?.name.replace(/[_-]+/g, ' '),
    practice?.content_html.replace(/<[^>]*>/g, ' ').replace(/[_-]+/g, ' ').slice(0, 1000)
  );

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p>Loading practice exam...</p>
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

  if (!practice) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p className="loading">Loading practice exam...</p>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--background)' }}>
      <div className="exam-timer" style={{ background: timeLeft < 300 ? 'var(--danger)' : 'var(--primary)' }}>
        {formatTime(timeLeft)}
      </div>

      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '20px 32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2>{practice.name}</h2>
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

        <div className="practice-layout">
          {/* Đề bài (từ file .docx) — panel trái, cuộn độc lập */}
          <div className="card practice-content-panel">
            <div
              className="question-content"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(practice.content_html) }}
            />
          </div>

          {/* Bài làm — panel phải */}
          <div className="card practice-editor-panel">
            <div className="form-group" style={{ marginBottom: 0 }}>
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
                  value={answer}
                  onChange={saveAnswer}
                  onCopyAttempt={handleCopyAttempt}
                  onCutAttempt={handleCutAttempt}
                  onPasteAttempt={handlePasteAttempt}
                  defaultLanguage={practiceLanguage}
                  disabled={locked || submitting}
                  height="calc(100vh - 220px)"
                />
              </Suspense>
            </div>
          </div>
        </div>
      </div>

      {/* Violation warning modal toast */}
      {violationWarningModal && (
        <div style={{
          position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)',
          background: '#fef2f2', border: '2px solid #ef4444', color: '#991b1b',
          padding: '14px 24px', borderRadius: 10, zIndex: 2000, maxWidth: 560,
          fontWeight: 600, boxShadow: '0 8px 24px rgba(0,0,0,0.18)'
        }}>
          {violationWarningModal}
        </div>
      )}

      {/* Resume notification */}
      {resumeInfo && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500
          }}
          onClick={() => setResumeInfo(null)}
        >
          <div className="card" style={{ maxWidth: 420, textAlign: 'center' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🔄</div>
            <h3 style={{ marginBottom: 8 }}>Exam Resumed</h3>
            <p style={{ color: 'var(--text-light)', marginBottom: 16 }}>
              Your session has been restored. Time remaining: <strong>{formatTime(resumeInfo.timeLeft)}</strong>
            </p>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setResumeInfo(null)}>
              Continue
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default StudentPractice;
