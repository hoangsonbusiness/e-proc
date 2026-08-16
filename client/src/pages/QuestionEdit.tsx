import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { ArrowLeft, CheckCircle2, Database, Eye, LoaderCircle, Plus, Save, XCircle } from 'lucide-react';
import AdminNav from '../components/AdminNav';
import { adminApi } from '../services/api';

const QUESTION_TYPES = ['Coding', 'Conceptual', 'Fill-in', 'Debug', 'SingleChoice', 'MultipleChoice'] as const;
const LEVELS = ['Easy', 'Medium', 'Hard'] as const;
const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

type QuestionType = typeof QUESTION_TYPES[number];
type Level = typeof LEVELS[number];
type QuizOption = { key: string; text: string };
type IdStatus = 'idle' | 'checking' | 'available' | 'taken' | 'error';

interface QuestionForm {
  id: string;
  type: QuestionType;
  level: Level;
  module: string;
  question_sample: string;
  rubric_must_have: string;
  rubric_nice_to_have: string;
  rubric_optional: string;
  options: QuizOption[];
  correct_answers: string[];
  score: number;
}

const EMPTY_FORM: QuestionForm = {
  id: '',
  type: 'Coding',
  level: 'Easy',
  module: '',
  question_sample: '',
  rubric_must_have: '',
  rubric_nice_to_have: '',
  rubric_optional: '',
  options: OPTION_KEYS.map((key) => ({ key, text: '' })),
  correct_answers: [],
  score: 1,
};

const isQuizType = (type: QuestionType) => type === 'SingleChoice' || type === 'MultipleChoice';

// Keep this policy aligned with the student exam renderer so the admin preview
// is representative while untrusted scripts/event handlers cannot execute.
const sanitizeQuestionPreview = (html: string): string => DOMPurify.sanitize(html, {
  ALLOWED_TAGS: [
    'br', 'p', 'strong', 'em', 'b', 'i', 'u',
    'pre', 'code', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'span', 'div', 'blockquote',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: ['class', 'style'],
  FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur'],
});

function QuestionEdit() {
  const { id } = useParams();
  const isCreate = !id;
  const navigate = useNavigate();
  const [form, setForm] = useState<QuestionForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(!isCreate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [idStatus, setIdStatus] = useState<IdStatus>('idle');

  useEffect(() => {
    if (!id) return;
    let active = true;
    const loadQuestion = async () => {
      try {
        const response = await adminApi.getQuestion(id);
        if (!active) return;
        const question = response.data;
        const existingOptions: unknown[] = Array.isArray(question.options) ? question.options : [];
        const optionByKey = new Map<string, string>();
        existingOptions.forEach((rawOption) => {
          if (!rawOption || typeof rawOption !== 'object') return;
          const option = rawOption as Partial<QuizOption>;
          if (typeof option.key === 'string' && typeof option.text === 'string') {
            optionByKey.set(option.key, option.text);
          }
        });
        setForm({
          id: String(question.id),
          type: question.type,
          level: question.level,
          module: question.module || '',
          question_sample: question.question_sample || '',
          rubric_must_have: question.rubric_must_have || '',
          rubric_nice_to_have: question.rubric_nice_to_have || '',
          rubric_optional: question.rubric_optional || '',
          options: OPTION_KEYS.map((key) => ({ key, text: optionByKey.get(key) || '' })),
          correct_answers: Array.isArray(question.correct_answers) ? question.correct_answers : [],
          score: Number(question.score ?? 1),
        });
      } catch (requestError: any) {
        if (active) setError(requestError.response?.data?.error || requestError.message);
      } finally {
        if (active) setLoading(false);
      }
    };
    loadQuestion();
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!isCreate) return;
    const normalizedId = form.id.trim();
    if (!normalizedId || normalizedId.length > 50) {
      setIdStatus('idle');
      return;
    }

    let active = true;
    setIdStatus('checking');
    const timeout = window.setTimeout(async () => {
      try {
        const response = await adminApi.checkQuestionId(normalizedId);
        if (active) setIdStatus(response.data.available ? 'available' : 'taken');
      } catch (_) {
        if (active) setIdStatus('error');
      }
    }, 400);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [form.id, isCreate]);

  const setField = <K extends keyof QuestionForm>(field: K, value: QuestionForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const updateOption = (key: string, text: string) => {
    setForm((current) => ({
      ...current,
      options: current.options.map((option) => option.key === key ? { ...option, text } : option),
    }));
  };

  const toggleCorrectAnswer = (key: string) => {
    setForm((current) => ({
      ...current,
      correct_answers: current.type === 'SingleChoice'
        ? [key]
        : current.correct_answers.includes(key)
          ? current.correct_answers.filter((answer) => answer !== key)
          : [...current.correct_answers, key],
    }));
  };

  const handleTypeChange = (type: QuestionType) => {
    setForm((current) => ({
      ...current,
      type,
      correct_answers: type === 'SingleChoice' ? current.correct_answers.slice(0, 1) : current.correct_answers,
    }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedId = form.id.trim();
    if (isCreate && !normalizedId) {
      setError('Question ID is required');
      return;
    }
    if (isCreate && normalizedId.length > 50) {
      setError('Question ID must be 50 characters or fewer');
      return;
    }
    if (isCreate && idStatus === 'taken') {
      setError(`Question ID "${normalizedId}" already exists`);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const activeOptions = form.options.filter((option) => option.text.trim());
      const activeKeys = new Set(activeOptions.map((option) => option.key));
      const payload = {
        type: form.type,
        level: form.level,
        module: form.module,
        // Keep these strings raw. React safely escapes them in this form; the
        // student-facing HTML renderer sanitizes them when rendering markup.
        question_sample: form.question_sample,
        rubric_must_have: form.rubric_must_have,
        rubric_nice_to_have: form.rubric_nice_to_have,
        rubric_optional: form.rubric_optional,
        options: isQuizType(form.type) ? activeOptions : null,
        correct_answers: isQuizType(form.type)
          ? form.correct_answers.filter((answer) => activeKeys.has(answer))
          : null,
        score: form.score,
      };
      if (isCreate) {
        await adminApi.createQuestion({ id: normalizedId, ...payload });
      } else {
        await adminApi.updateQuestion(id, payload);
      }
      navigate('/admin/questions', { replace: true });
    } catch (requestError: any) {
      setError(requestError.response?.data?.error || requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'w-full px-3 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500';
  const labelClass = 'block mb-1.5 text-sm font-semibold text-slate-700';

  return (
    <div className="container">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 pb-4 border-b border-slate-200 gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-100 text-amber-600 rounded-lg"><Database size={24} /></div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight m-0 border-none pb-0">
              {isCreate ? 'Add Question' : 'Edit Question'}
            </h1>
            <p className="text-sm text-slate-500 mt-1 mb-0">
              {isCreate
                ? 'Create a question manually. Question IDs are case-sensitive.'
                : 'Update question content while keeping its ID unchanged.'}
            </p>
          </div>
        </div>
        <Link to="/admin/questions" className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-50 transition-colors shadow-sm">
          <ArrowLeft size={16} /> Back to Question Bank
        </Link>
      </div>

      <AdminNav />

      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-500">Loading question...</div>
      ) : !isCreate && error && !form.id ? (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-5">{error}</div>
      ) : (
        <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 space-y-6">
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3">{error}</div>}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              <div>
                <label className={labelClass} htmlFor="question-id">ID</label>
                <div className="relative">
                  <input
                    id="question-id"
                    value={form.id}
                    onChange={(event) => setField('id', event.target.value)}
                    readOnly={!isCreate}
                    required
                    maxLength={50}
                    autoComplete="off"
                    aria-describedby={isCreate ? 'question-id-status' : undefined}
                    className={`${inputClass} pr-10 font-mono ${!isCreate ? 'bg-slate-100 text-slate-500 cursor-not-allowed' : ''}`}
                  />
                  {isCreate && idStatus === 'checking' && <LoaderCircle size={18} className="absolute right-3 top-3 text-slate-400 animate-spin" />}
                  {isCreate && idStatus === 'available' && <CheckCircle2 size={18} className="absolute right-3 top-3 text-emerald-500" />}
                  {isCreate && idStatus === 'taken' && <XCircle size={18} className="absolute right-3 top-3 text-red-500" />}
                </div>
                {isCreate && (
                  <p id="question-id-status" className={`mt-1.5 mb-0 text-xs ${idStatus === 'taken' ? 'text-red-600' : idStatus === 'available' ? 'text-emerald-600' : 'text-slate-500'}`}>
                    {idStatus === 'checking' && 'Checking ID...'}
                    {idStatus === 'available' && `ID "${form.id.trim()}" is available.`}
                    {idStatus === 'taken' && `ID "${form.id.trim()}" already exists.`}
                    {idStatus === 'error' && 'Could not check the ID now; it will be validated when saved.'}
                    {idStatus === 'idle' && 'Maximum 50 characters. Uppercase and lowercase IDs are different.'}
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass} htmlFor="question-type">Type</label>
                <select id="question-type" value={form.type} onChange={(event) => handleTypeChange(event.target.value as QuestionType)} className={inputClass}>
                  {QUESTION_TYPES.map((type) => <option key={type}>{type}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="question-level">Level</label>
                <select id="question-level" value={form.level} onChange={(event) => setField('level', event.target.value as Level)} className={inputClass}>
                  {LEVELS.map((level) => <option key={level}>{level}</option>)}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="question-module">Module</label>
                <input id="question-module" value={form.module} onChange={(event) => setField('module', event.target.value)} required className={inputClass} />
              </div>
            </div>

            <div>
              <label className={labelClass} htmlFor="question-content">Question</label>
              <textarea id="question-content" value={form.question_sample} onChange={(event) => setField('question_sample', event.target.value)} required rows={10} className={`${inputClass} font-mono text-sm`} />
              <p className="mt-1.5 text-xs text-slate-500">HTML tags are shown as text in this editor and preserved unchanged when saved.</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
              <div>
                <label className={labelClass} htmlFor="rubric-must">Rubric Must-have</label>
                <textarea id="rubric-must" value={form.rubric_must_have} onChange={(event) => setField('rubric_must_have', event.target.value)} rows={7} className={inputClass} />
              </div>
              <div>
                <label className={labelClass} htmlFor="rubric-nice">Rubric Nice-to-have</label>
                <textarea id="rubric-nice" value={form.rubric_nice_to_have} onChange={(event) => setField('rubric_nice_to_have', event.target.value)} rows={7} className={inputClass} />
              </div>
              <div>
                <label className={labelClass} htmlFor="rubric-optional">Rubric Optional</label>
                <textarea id="rubric-optional" value={form.rubric_optional} onChange={(event) => setField('rubric_optional', event.target.value)} rows={7} className={inputClass} />
              </div>
            </div>

            <div className="border-t border-slate-200 pt-6">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 p-2 bg-blue-50 text-blue-600 rounded-lg">
                  <Eye size={18} />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900 m-0">Question Preview</h2>
                  <p className="text-sm text-slate-500 mt-1 mb-0">
                    Preview of the sanitized HTML shown to candidates.
                  </p>
                </div>
              </div>

              <div className="mt-4 min-h-40 rounded-xl border border-slate-200 bg-slate-50/50 p-5 sm:p-6">
                {form.question_sample.trim() ? (
                  <div
                    className="question-content mb-0"
                    dangerouslySetInnerHTML={{ __html: sanitizeQuestionPreview(form.question_sample) }}
                  />
                ) : (
                  <p className="m-0 text-sm italic text-slate-400">
                    Enter question content above to see its preview.
                  </p>
                )}
              </div>
            </div>

            {isQuizType(form.type) && (
              <div className="border-t border-slate-200 pt-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900 m-0">Quiz answers</h2>
                    <p className="text-sm text-slate-500 mt-1 mb-0">Enter at least two options and select the correct answer(s).</p>
                  </div>
                  <div className="w-40">
                    <label className={labelClass} htmlFor="question-score">Score</label>
                    <input id="question-score" type="number" min="0.01" step="0.01" value={form.score} onChange={(event) => setField('score', Number(event.target.value))} required className={inputClass} />
                  </div>
                </div>
                <div className="space-y-3">
                  {form.options.map((option) => (
                    <div key={option.key} className="flex items-center gap-3">
                      <input
                        type={form.type === 'SingleChoice' ? 'radio' : 'checkbox'}
                        name="correct-answer"
                        checked={form.correct_answers.includes(option.key)}
                        onChange={() => toggleCorrectAnswer(option.key)}
                        disabled={!option.text.trim()}
                        aria-label={`Mark option ${option.key} as correct`}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span className="w-6 font-bold text-slate-600">{option.key}</span>
                      <input value={option.text} onChange={(event) => updateOption(option.key, event.target.value)} placeholder={`Option ${option.key}`} className={inputClass} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-3">
            <Link to="/admin/questions" className="px-4 py-2.5 bg-white border border-slate-300 text-slate-700 rounded-lg font-medium text-sm hover:bg-slate-100">Cancel</Link>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-50">
              {isCreate ? <Plus size={16} /> : <Save size={16} />}
              {saving ? 'Saving...' : isCreate ? 'Add Question' : 'Save changes'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default QuestionEdit;
