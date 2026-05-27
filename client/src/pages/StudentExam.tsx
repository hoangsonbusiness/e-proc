import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { studentApi } from '../services/api';

const CLIPBOARD_VIOLATION_COOLDOWN_MS = 3000;

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
      document.documentElement.requestFullscreen().catch(() => {});
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

    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && started && !locked) {
        handleViolation('fullscreen_exit');
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden && started && !locked) {
        handleViolation('tab_switch');
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

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
  }, [started, locked]);

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

  const handleViolation = async (type: string) => {
    try {
      const res = await studentApi.reportViolation(parseInt(studentId!), type);
      setViolationCount(res.data.total_violations);
      if (res.data.locked) {
        setLocked(true);
        document.exitFullscreen().catch(() => {});
        alert('You have violated the exam rules. Your exam has been locked.');
        await handleSubmit(true);
      } else {
        const warningByType: Record<string, string> = {
          fullscreen_exit: 'You exited fullscreen',
          tab_switch: 'You switched tabs',
          copy_attempt: 'You attempted to copy text',
          cut_attempt: 'You attempted to cut text',
          paste_attempt: 'You attempted to paste text'
        };
        const warning = warningByType[type] || 'You violated the exam rules';
        alert(`Warning: ${warning}. This is violation ${res.data.violation_count}. After 2 violations, your exam will be locked.`);
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

  const handleSubmit = async (force = false) => {
    if (!force && !confirm('Are you sure you want to submit?')) return;
    
    setSubmitting(true);
    try {
      await studentApi.submit(parseInt(studentId!));
      document.exitFullscreen().catch(() => {});
      navigate('/submit');
    } catch (error) {
      console.error(error);
      alert('Error submitting exam. Please contact support.');
    }
    setSubmitting(false);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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
          <h3 style={{ marginBottom: 20 }}>{currentQuestion.question_sample}</h3>
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