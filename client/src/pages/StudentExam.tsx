import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { studentApi } from '../services/api';

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const clipboardCooldownRef = useRef<Record<string, number>>({});
  const clipboardWarningTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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

    const duration = parseInt(localStorage.getItem('duration') || '30');
    setTimeLeft(duration * 60);

    // Request fullscreen when entering exam
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => { });
    }

    const initExam = async () => {
      console.log('[Exam] initExam called, studentId:', studentId);
      try {
        console.log('[Exam] Step 1 - Getting existing questions...');
        const existingRes = await studentApi.getQuestions(parseInt(studentId));
        console.log('[Exam] Step 1 done, questions:', existingRes.data.length);

        if (existingRes.data.length > 0) {
          console.log('[Exam] Found questions, loading...');
          setStarted(true);
          loadQuestions();
          return;
        }

        console.log('[Exam] No questions, starting new exam...');
        const res = await studentApi.startExam(parseInt(studentId));

        console.log('[Exam] Start result:', res.data);

        if (res.data.success) {
          setStarted(true);
          loadQuestions();
        }
      } catch (error: any) {
        console.error('[Exam] Error:', error);
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
        alert(`Warning: ${warning}. This is violation ${res.data.violation_count}. After 2 violations, your exam will be locked.`);
        // Reset cooldown after alert closes to prevent queued events from firing immediately
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
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
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


  const loadQuestions = async () => {
    try {
      const res = await studentApi.getQuestions(parseInt(studentId!));
      const q = res.data;

      setQuestions(q);
      const savedAnswers: { [key: number]: string } = {};
      q.forEach((question: Question) => {
        if (question.answer) savedAnswers[question.question_order] = question.answer;
      });
      setAnswers(savedAnswers);
      setLoading(false);

      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    } catch (error) {
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

  const handleClipboardShortcut = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!started || locked || submitting) return;
    if (!event.ctrlKey && !event.metaKey) return;

    const key = event.key.toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      handleClipboardAttempt('copy_attempt');
    }
    if (key === 'x') {
      event.preventDefault();
      handleClipboardAttempt('cut_attempt');
    }
    if (key === 'v') {
      event.preventDefault();
      handleClipboardAttempt('paste_attempt');
    }
  }, [handleClipboardAttempt, locked, started, submitting]);

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
            <p style={{ color: 'var(--text-light)', fontSize: 14 }}>
              {currentQuestion.module} - {currentQuestion.level} - {currentQuestion.type}
            </p>
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
            <textarea
              ref={textareaRef}
              rows={15}
              value={answers[currentQuestion.question_order] || ''}
              onChange={e => {
                saveAnswer(currentQuestion.question_order, e.target.value);
              }}
              onCopy={e => {
                e.preventDefault();
                handleClipboardAttempt('copy_attempt');
              }}
              onCut={e => {
                e.preventDefault();
                handleClipboardAttempt('cut_attempt');
              }}
              onPaste={e => {
                e.preventDefault();
                handleClipboardAttempt('paste_attempt');
              }}
              onKeyDown={handleClipboardShortcut}
              placeholder="Type your answer here..."
              style={{ fontSize: 16, lineHeight: 1.8 }}
            />
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
    </div>
  );
}

export default StudentExam;