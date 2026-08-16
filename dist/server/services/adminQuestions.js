import { normalizeUnicode } from '../../utils/string.js';
export const QUESTION_TYPES = [
    'Coding',
    'Conceptual',
    'Fill-in',
    'Debug',
    'SingleChoice',
    'MultipleChoice',
];
export const QUESTION_LEVELS = ['Easy', 'Medium', 'Hard'];
export class QuestionValidationError extends Error {
}
const QUIZ_TYPES = new Set(['SingleChoice', 'MultipleChoice']);
const OPTION_KEYS = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
export function validateQuestionId(input) {
    const id = typeof input === 'string' ? input.trim() : '';
    if (!id)
        throw new QuestionValidationError('Question ID is required');
    if (id.length > 50)
        throw new QuestionValidationError('Question ID must be 50 characters or fewer');
    return id;
}
/**
 * Validate admin input without HTML-encoding it. Question/rubric text is stored
 * verbatim; React escapes controlled form values and the exam renderer sanitizes
 * HTML at the rendering boundary. Encoding here would corrupt round trips.
 */
export function validateQuestionUpdate(input) {
    if (!input || typeof input !== 'object') {
        throw new QuestionValidationError('Question data is required');
    }
    const body = input;
    const type = typeof body.type === 'string' ? body.type : '';
    const level = typeof body.level === 'string' ? body.level : '';
    if (!QUESTION_TYPES.includes(type)) {
        throw new QuestionValidationError('Invalid question type');
    }
    if (!QUESTION_LEVELS.includes(level)) {
        throw new QuestionValidationError('Invalid question level');
    }
    const moduleName = typeof body.module === 'string' ? body.module.trim() : '';
    const question = typeof body.question_sample === 'string' ? body.question_sample : '';
    if (!moduleName)
        throw new QuestionValidationError('Module is required');
    if (!question.trim())
        throw new QuestionValidationError('Question is required');
    const rubric = (field) => typeof body[field] === 'string' ? body[field] : '';
    const normalizedType = type;
    const normalizedLevel = level;
    if (!QUIZ_TYPES.has(normalizedType)) {
        return {
            type: normalizedType,
            level: normalizedLevel,
            module: moduleName,
            question_sample: question,
            rubric_must_have: rubric('rubric_must_have'),
            rubric_nice_to_have: rubric('rubric_nice_to_have'),
            rubric_optional: rubric('rubric_optional'),
            options: null,
            correct_answers: null,
            score: 1,
        };
    }
    if (!Array.isArray(body.options)) {
        throw new QuestionValidationError('Quiz options are required');
    }
    const seenKeys = new Set();
    const options = body.options.map((rawOption) => {
        if (!rawOption || typeof rawOption !== 'object') {
            throw new QuestionValidationError('Invalid quiz option');
        }
        const option = rawOption;
        const key = typeof option.key === 'string' ? option.key.trim().toUpperCase() : '';
        const text = typeof option.text === 'string' ? option.text : '';
        if (!OPTION_KEYS.has(key) || seenKeys.has(key)) {
            throw new QuestionValidationError('Quiz option keys must be unique values from A to F');
        }
        if (!text.trim())
            throw new QuestionValidationError(`Option ${key} cannot be empty`);
        seenKeys.add(key);
        return { key, text };
    });
    if (options.length < 2)
        throw new QuestionValidationError('Quiz questions need at least 2 options');
    if (!Array.isArray(body.correct_answers)) {
        throw new QuestionValidationError('Correct answer is required');
    }
    const correctAnswers = [...new Set(body.correct_answers.map((answer) => typeof answer === 'string' ? answer.trim().toUpperCase() : ''))].filter(Boolean);
    if (correctAnswers.length === 0)
        throw new QuestionValidationError('Correct answer is required');
    if (correctAnswers.some((answer) => !seenKeys.has(answer))) {
        throw new QuestionValidationError('Correct answers must match an available option');
    }
    if (normalizedType === 'SingleChoice' && correctAnswers.length !== 1) {
        throw new QuestionValidationError('SingleChoice questions must have exactly one correct answer');
    }
    const score = Number(body.score);
    if (!Number.isFinite(score) || score <= 0) {
        throw new QuestionValidationError('Score must be greater than 0');
    }
    return {
        type: normalizedType,
        level: normalizedLevel,
        module: moduleName,
        question_sample: question,
        rubric_must_have: rubric('rubric_must_have'),
        rubric_nice_to_have: rubric('rubric_nice_to_have'),
        rubric_optional: rubric('rubric_optional'),
        options,
        correct_answers: correctAnswers,
        score,
    };
}
export function validateQuestionCreate(input) {
    if (!input || typeof input !== 'object') {
        throw new QuestionValidationError('Question data is required');
    }
    const body = input;
    return {
        id: validateQuestionId(body.id),
        ...validateQuestionUpdate(body),
    };
}
export async function isQuestionIdAvailable(db, input) {
    const id = validateQuestionId(input);
    const existing = await db.query('SELECT id FROM question_bank WHERE id = ?', [id]);
    return { id, available: existing.rows.length === 0 };
}
export async function insertQuestion(db, question, uploadedBy) {
    await db.query(`
    INSERT INTO question_bank (
      id, type, level, module, question_sample,
      rubric_must_have, rubric_nice_to_have, rubric_optional,
      options, correct_answers, score, uploaded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
        question.id,
        question.type,
        question.level,
        normalizeUnicode(question.module),
        question.question_sample,
        question.rubric_must_have,
        question.rubric_nice_to_have,
        question.rubric_optional,
        question.options ? JSON.stringify(question.options) : null,
        question.correct_answers ? JSON.stringify(question.correct_answers) : null,
        question.score,
        uploadedBy,
    ]);
}
export function isDuplicateQuestionIdError(error) {
    if (!error || typeof error !== 'object')
        return false;
    const candidate = error;
    if (candidate.code === '23505')
        return true;
    const code = String(candidate.code || '');
    const message = String(candidate.message || '');
    return code.startsWith('SQLITE_CONSTRAINT') && /unique|primary key/i.test(message);
}
export async function loadPagedQuestions(db, options) {
    const conditions = [];
    const params = [];
    if (options.moduleName) {
        conditions.push('module = ?');
        params.push(options.moduleName);
    }
    if (options.category === 'quiz') {
        conditions.push("type IN ('SingleChoice', 'MultipleChoice')");
    }
    else if (options.category === 'essay') {
        conditions.push("type NOT IN ('SingleChoice', 'MultipleChoice')");
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await db.query(`SELECT COUNT(*) AS total FROM question_bank ${whereSql}`, params);
    const total = Number(countResult.rows[0]?.total) || 0;
    const totalPages = Math.max(1, Math.ceil(total / options.pageSize));
    const page = Math.min(options.page, totalPages);
    const offset = (page - 1) * options.pageSize;
    const itemsResult = await db.query(`
    SELECT id, type, level, module, question_sample, uploaded_by
    FROM question_bank
    ${whereSql}
    ORDER BY module, level, id
    LIMIT ? OFFSET ?
  `, [...params, options.pageSize, offset]);
    return { items: itemsResult.rows, total, page, pageSize: options.pageSize, totalPages };
}
export async function loadQuestionCatalogSummary(db) {
    const result = await db.query(`
    SELECT module, type, level, COUNT(*) AS count
    FROM question_bank
    GROUP BY module, type, level
    ORDER BY module, type, level
  `);
    const modules = new Set();
    const moduleStats = new Map();
    const typeStats = new Map();
    const moduleTypeStats = new Map();
    for (const row of result.rows) {
        const moduleName = String(row.module);
        const type = String(row.type);
        const level = String(row.level).toLowerCase();
        const count = Number(row.count) || 0;
        if (!['easy', 'medium', 'hard'].includes(level))
            continue;
        modules.add(moduleName);
        const moduleEntry = moduleStats.get(moduleName) || { module: moduleName, easy: 0, medium: 0, hard: 0 };
        moduleEntry[level] += count;
        moduleStats.set(moduleName, moduleEntry);
        const typeEntry = typeStats.get(type) || { type, easy: 0, medium: 0, hard: 0 };
        typeEntry[level] += count;
        typeStats.set(type, typeEntry);
        const key = `${moduleName}\u0000${type}`;
        const moduleTypeEntry = moduleTypeStats.get(key) || { module: moduleName, type, easy: 0, medium: 0, hard: 0 };
        moduleTypeEntry[level] += count;
        moduleTypeStats.set(key, moduleTypeEntry);
    }
    return {
        modules: [...modules].sort((a, b) => a.localeCompare(b)),
        moduleStats: [...moduleStats.values()],
        typeStats: [...typeStats.values()],
        moduleTypeStats: [...moduleTypeStats.values()],
    };
}
