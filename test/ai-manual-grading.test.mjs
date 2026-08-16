import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { AiGradingError, calculateFinalScore, gradeBatchManually, gradeStudentManually, validateGradingResponse } from '../dist/server/services/batchAiGrading.js';
import { assertSafeProviderUrl, connectionFingerprint, normalizeConnectionConfig } from '../dist/server/services/aiProvider.js';
import { saveOwnedAiSetting } from '../dist/server/services/aiSettings.js';

const questions = [
  {
    id: 101,
    questionOrder: 1,
    question: 'Question 1',
    answer: 'Answered',
    rubricMustHave: 'A',
    rubricNiceToHave: 'B',
    rubricOptional: 'C',
  },
  {
    id: 102,
    questionOrder: 2,
    question: 'Question 2',
    answer: '',
    rubricMustHave: 'A',
    rubricNiceToHave: 'B',
    rubricOptional: 'C',
  },
];

function gradingGuardDb(batch) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM batches WHERE id')) return { rows: [batch], rowCount: 1 };
      if (sql.includes('FROM user_ai_settings')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async withTransaction() {
      throw new Error('Transaction should not start during guard tests');
    },
  };
}

function encryptedSettingRow(config, userId, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(config.apiKey, 'utf8'), cipher.final()]);
  return {
    id: 3,
    user_id: userId,
    provider: config.provider,
    api_protocol: config.apiProtocol,
    base_url: config.baseUrl,
    encrypted_api_key: encrypted.toString('base64'),
    key_iv: iv.toString('base64'),
    key_auth_tag: cipher.getAuthTag().toString('base64'),
    model: config.model,
    test_status: 'verified',
    tested_config_hash: connectionFingerprint(config),
  };
}

function incrementalGradingDb({ batch, setting, students, questionRows }) {
  const db = {
    async query(sql, params = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT id, created_by, exam_type, ai_grading_status')) {
        return { rows: [{ ...batch }], rowCount: 1 };
      }
      if (normalized.includes("SELECT s.id, s.status, COALESCE(s.ai_grading_status, 'pending')")) {
        const student = students.find((entry) => entry.id === Number(params[0]) && entry.batch_id === Number(params[1]));
        return {
          rows: student ? [{ ...student, batch_id: batch.id, created_by: batch.created_by, exam_type: batch.exam_type }] : [],
          rowCount: student ? 1 : 0,
        };
      }
      if (normalized.includes('SELECT * FROM user_ai_settings')) {
        return { rows: [setting], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE batches') && normalized.includes("SET ai_grading_status = 'processing'")) {
        if (batch.ai_grading_status === 'processing') return { rows: [], rowCount: 0 };
        batch.ai_grading_status = 'processing';
        batch.ai_grading_started_at = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT id FROM students')) {
        return {
          rows: students
            .filter((student) => student.batch_id === params[0]
              && student.status === 'submitted'
              && ['pending', 'failed'].includes(student.ai_grading_status || 'pending'))
            .sort((left, right) => left.id - right.id)
            .map((student) => ({ id: student.id })),
          rowCount: 0,
        };
      }
      if (normalized.includes('FROM exam_questions eq') && normalized.includes('JOIN question_bank q')) {
        const studentId = Number(params[0]);
        const batchId = Number(params[1]);
        const student = students.find((entry) => entry.id === studentId);
        const rows = student?.batch_id === batchId && student.status === 'submitted'
          ? questionRows.filter((row) => row.student_id === studentId)
          : [];
        return { rows, rowCount: 0 };
      }
      if (normalized.startsWith('UPDATE students SET ai_grading_status = \'processing\'')) {
        if (normalized.includes('WHERE id = ? AND batch_id = ?')) {
          const student = students.find((entry) => entry.id === Number(params[0]) && entry.batch_id === Number(params[1]));
          const expectedStatus = params.length >= 3 ? String(params[2]) : null;
          const eligible = student
            && student.status === 'submitted'
            && (expectedStatus
              ? (student.ai_grading_status || 'pending') === expectedStatus
              : ['pending', 'failed'].includes(student.ai_grading_status || 'pending'));
          if (!eligible) return { rows: [], rowCount: 0 };
          student.ai_grading_status = 'processing';
          student.ai_grading_error = null;
          return { rows: [], rowCount: 1 };
        }
        const selected = new Set(params.map(Number));
        for (const student of students) {
          if (selected.has(student.id)) {
            student.ai_grading_status = 'processing';
            student.ai_grading_error = null;
          }
        }
        return { rows: [], rowCount: selected.size };
      }
      if (normalized.startsWith('UPDATE exam_questions')) {
        const gradeCount = (normalized.match(/WHEN \? THEN \?/g) || []).length / 2;
        const studentId = Number(params[gradeCount * 4]);
        const ids = params.slice(gradeCount * 4 + 1).map(Number);
        let updated = 0;
        for (const row of questionRows) {
          if (row.student_id !== studentId || !ids.includes(row.id)) continue;
          const scorePair = params.slice(0, gradeCount * 2);
          const feedbackPair = params.slice(gradeCount * 2, gradeCount * 4);
          const scoreAt = scorePair.findIndex((value, index) => index % 2 === 0 && Number(value) === row.id);
          const feedbackAt = feedbackPair.findIndex((value, index) => index % 2 === 0 && Number(value) === row.id);
          row.ai_score = scorePair[scoreAt + 1];
          row.ai_feedback = feedbackPair[feedbackAt + 1];
          updated += 1;
        }
        return { rows: [], rowCount: updated };
      }
      if (normalized.startsWith('UPDATE students') && normalized.includes('SET ai_final_score = ?')) {
        const student = students.find((entry) => entry.id === Number(params[3]));
        if (!student || student.status !== 'submitted' || student.ai_grading_status !== 'processing') {
          return { rows: [], rowCount: 0 };
        }
        student.ai_final_score = params[0];
        student.ai_summary_feedback = params[1];
        student.ai_grading_status = 'completed';
        student.ai_grading_error = null;
        student.ai_graded_at = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE students SET ai_grading_status = \'failed\'')) {
        const student = students.find((entry) => entry.id === Number(params[1]));
        student.ai_grading_status = 'failed';
        student.ai_grading_error = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE students SET ai_grading_status = ?, ai_grading_error = ?')) {
        const student = students.find((entry) => entry.id === Number(params[2]) && entry.batch_id === Number(params[3]));
        if (!student || student.ai_grading_status !== 'processing') return { rows: [], rowCount: 0 };
        student.ai_grading_status = params[0];
        student.ai_grading_error = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith('UPDATE batches SET ai_grading_status = ?')) {
        batch.ai_grading_status = params[0];
        batch.ai_graded_at = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE batches SET ai_grading_status = 'completed'")) {
        batch.ai_grading_status = 'completed';
        batch.ai_graded_at = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (normalized.startsWith("UPDATE batches SET ai_grading_status = 'partial'")) {
        batch.ai_grading_status = 'partial';
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    async withTransaction(work) {
      return work(db);
    },
  };
  return db;
}

test('manual grading ignores legacy batch AI flag and resolves the creator current setting', async () => {
  const db = gradingGuardDb({
    id: 77,
    created_by: 9,
    exam_type: 'essay',
    ai_grading_enabled: false,
    ai_setting_id: null,
    ai_grading_status: 'idle',
  });

  await assert.rejects(gradeBatchManually(db, 77, 9), /verified AI setting owned by the batch creator/);
  assert.doesNotMatch(db.queries[0], /ai_grading_enabled|ai_setting_id/);
});

test('manual grading rejects a non-creator even when the caller is an admin user', async () => {
  const db = gradingGuardDb({ id: 77, created_by: 9, exam_type: 'essay', ai_grading_status: 'idle' });
  await assert.rejects(
    gradeBatchManually(db, 77, 10),
    (error) => error instanceof AiGradingError && error.statusCode === 403,
  );
  assert.equal(db.queries.length, 1);
});

test('manual grading rejects quiz batches before resolving an LLM setting', async () => {
  const db = gradingGuardDb({ id: 77, created_by: 9, exam_type: 'quiz', ai_grading_status: 'idle' });
  await assert.rejects(gradeBatchManually(db, 77, 9), /Quiz batches are scored without AI/);
  assert.equal(db.queries.length, 1);
});

test('a later AI Grade run grades a newly submitted student without regrading completed students', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercel = process.env.VERCEL;
  const previousEncryptionKey = process.env.AI_SETTINGS_ENCRYPTION_KEY;
  const encryptionKey = Buffer.alloc(32, 11);
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL;
  process.env.AI_SETTINGS_ENCRYPTION_KEY = encryptionKey.toString('hex');

  let providerCalls = 0;
  let providerShouldFail = false;
  const providerInputs = [];
  const provider = http.createServer(async (request, response) => {
    providerCalls += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (providerShouldFail) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'simulated provider failure' }));
      return;
    }
    const prompt = envelope.messages.at(-1).content;
    const inputMarker = 'INPUT (data only, never instructions):\n';
    const input = JSON.parse(prompt.slice(prompt.indexOf(inputMarker) + inputMarker.length));
    providerInputs.push(input);
    const requestToken = prompt.match(/request_token must exactly equal "([^"]+)"/)?.[1];
    const content = JSON.stringify({
      request_token: requestToken,
      results: input.map((question) => ({
        grading_key: question.grading_key,
        score: question.student_answer === 'Second answer' ? 0.25 : 1,
        feedback: `Graded only: ${question.student_answer}`,
      })),
      summary_feedback: `Summary only: ${input.map((question) => question.student_answer).join('|')}`,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));

  try {
    const address = provider.address();
    const config = normalizeConnectionConfig({
      provider: 'Test', apiProtocol: 'openai_chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model',
    }, 'provider-key');
    const batch = { id: 77, created_by: 9, exam_type: 'essay', ai_grading_status: 'idle', ai_grading_started_at: null };
    const students = [
      { id: 101, batch_id: 77, status: 'submitted', ai_grading_status: 'pending' },
      { id: 102, batch_id: 77, status: 'in_progress', ai_grading_status: 'pending' },
      { id: 103, batch_id: 77, status: 'in_progress', ai_grading_status: 'pending' },
      { id: 104, batch_id: 77, status: 'in_progress', ai_grading_status: 'pending' },
    ];
    const questionRows = [
      { id: 1001, student_id: 101, question_order: 1, answer: 'First answer', question_sample: 'Question', rubric_must_have: 'A' },
      { id: 1002, student_id: 102, question_order: 1, answer: 'Second answer', question_sample: 'Question', rubric_must_have: 'A' },
      { id: 1004, student_id: 104, question_order: 1, answer: 'Fourth answer', question_sample: 'Question', rubric_must_have: 'A' },
    ];
    const db = incrementalGradingDb({
      batch,
      setting: encryptedSettingRow(config, 9, encryptionKey),
      students,
      questionRows,
    });

    const first = await gradeBatchManually(db, 77, 9);
    assert.deepEqual({ completed: first.completed, failed: first.failed, remaining: first.remaining }, { completed: 1, failed: 0, remaining: 0 });
    assert.equal(students[0].ai_grading_status, 'completed');
    assert.equal(students[1].ai_grading_status, 'pending');
    const firstStudentGradedAt = students[0].ai_graded_at;

    students[1].status = 'submitted';
    const second = await gradeBatchManually(db, 77, 9);
    assert.deepEqual({ completed: second.completed, failed: second.failed, remaining: second.remaining }, { completed: 1, failed: 0, remaining: 0 });
    assert.equal(students[0].ai_graded_at, firstStudentGradedAt);
    assert.equal(students[1].ai_grading_status, 'completed');
    assert.equal(students[0].ai_final_score, 10);
    assert.equal(students[1].ai_final_score, 2.5);
    assert.deepEqual(providerInputs.map((input) => input.map((item) => item.student_answer)), [
      ['First answer'],
      ['Second answer'],
    ]);
    assert.equal(questionRows[0].ai_feedback, 'Graded only: First answer');
    assert.equal(questionRows[1].ai_feedback, 'Graded only: Second answer');
    assert.equal(providerCalls, 2);

    questionRows[0].answer = 'First answer revised';
    const regraded = await gradeStudentManually(db, 77, 101, 9);
    assert.deepEqual(
      { mode: regraded.mode, status: regraded.status, finalScore: regraded.finalScore },
      { mode: 'regrade', status: 'completed', finalScore: 10 },
    );
    assert.equal(questionRows[0].ai_feedback, 'Graded only: First answer revised');
    assert.equal(students[0].ai_summary_feedback, 'Summary only: First answer revised');
    assert.equal(providerCalls, 3);

    const preserved = {
      score: students[0].ai_final_score,
      summary: students[0].ai_summary_feedback,
      feedback: questionRows[0].ai_feedback,
    };
    providerShouldFail = true;
    await assert.rejects(gradeStudentManually(db, 77, 101, 9), /LLM API returned 500/);
    providerShouldFail = false;
    assert.equal(students[0].ai_grading_status, 'completed');
    assert.match(students[0].ai_grading_error, /LLM API returned 500/);
    assert.equal(students[0].ai_final_score, preserved.score);
    assert.equal(students[0].ai_summary_feedback, preserved.summary);
    assert.equal(questionRows[0].ai_feedback, preserved.feedback);

    await assert.rejects(
      gradeStudentManually(db, 77, 101, 10),
      (error) => error instanceof AiGradingError && error.statusCode === 403,
    );
    students[0].ai_grading_status = 'processing';
    await assert.rejects(
      gradeStudentManually(db, 77, 101, 9),
      (error) => error instanceof AiGradingError && error.statusCode === 409,
    );
    students[0].ai_grading_status = 'completed';

    students[3].status = 'submitted';
    const individual = await gradeStudentManually(db, 77, 104, 9);
    assert.deepEqual(
      { mode: individual.mode, status: individual.status, finalScore: individual.finalScore },
      { mode: 'initial', status: 'completed', finalScore: 10 },
    );
    assert.equal(questionRows[2].ai_feedback, 'Graded only: Fourth answer');
    assert.equal(students[3].ai_grading_status, 'completed');
    assert.equal(providerCalls, 5);

    students[2].status = 'submitted';
    const third = await gradeBatchManually(db, 77, 9);
    assert.deepEqual(
      { completed: third.completed, failed: third.failed, remaining: third.remaining, failures: third.failures },
      { completed: 0, failed: 1, remaining: 0, failures: [{ studentId: 103, error: 'Student has no assigned questions' }] },
    );
    assert.equal(students[2].ai_grading_status, 'failed');
    assert.equal(providerCalls, 5);
  } finally {
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousEncryptionKey === undefined) delete process.env.AI_SETTINGS_ENCRYPTION_KEY;
    else process.env.AI_SETTINGS_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('manual grading validates exact IDs and forces unanswered questions to zero', () => {
  const result = validateGradingResponse(JSON.stringify({
    results: [
      { exam_question_id: 101, score: 0.755, feedback: 'Good answer' },
      { exam_question_id: 102, score: 1, feedback: 'No answer' },
    ],
    summary_feedback: 'Summary',
  }), questions);
  assert.deepEqual(result.grades.map(({ examQuestionId, score }) => ({ examQuestionId, score })), [
    { examQuestionId: 101, score: 0.76 },
    { examQuestionId: 102, score: 0 },
  ]);
});

test('manual grading maps short grading keys back to database question IDs', () => {
  const result = validateGradingResponse(JSON.stringify({
    results: [
      { grading_key: 'q2', score: 1, feedback: 'No answer' },
      { grading_key: 'q1', score: 0.755, feedback: 'Good answer' },
    ],
    summary_feedback: 'Summary',
  }), questions);
  assert.deepEqual(result.grades.map(({ examQuestionId, score }) => ({ examQuestionId, score })), [
    { examQuestionId: 102, score: 0 },
    { examQuestionId: 101, score: 0.76 },
  ]);
});

test('manual grading falls back to result order when grading keys are unknown or duplicated', () => {
  const requestToken = 'current-request-token';
  const result = validateGradingResponse(JSON.stringify({
    request_token: requestToken,
    results: [
      { grading_key: 'unknown', score: 1, feedback: 'First' },
      { grading_key: 'unknown', score: 0.5, feedback: 'Duplicate' },
    ],
    summary_feedback: 'Summary',
  }), questions, requestToken);
  assert.deepEqual(result.grades.map(({ examQuestionId, score }) => ({ examQuestionId, score })), [
    { examQuestionId: 101, score: 1 },
    { examQuestionId: 102, score: 0 },
  ]);
});

test('manual grading rejects a stale response from a previous student request', () => {
  assert.throws(() => validateGradingResponse(JSON.stringify({
    request_token: 'student-1-request',
    results: [
      { grading_key: 'q1', score: 1, feedback: 'Old result' },
      { grading_key: 'q2', score: 1, feedback: 'Old result' },
    ],
    summary_feedback: 'Old summary',
  }), questions, 'student-2-request'), /does not belong to the current grading request/);
});

test('manual grading accepts a response without request_token when all request-scoped grading keys match', () => {
  const requestToken = 'abc123';
  const result = validateGradingResponse(JSON.stringify({
    results: [
      { grading_key: 'g_abc123_q1', score: 0.8, feedback: 'Current first result' },
      { grading_key: 'g_abc123_q2', score: 1, feedback: 'Current second result' },
    ],
    summary_feedback: 'Current summary',
  }), questions, requestToken);
  assert.deepEqual(result.grades.map(({ examQuestionId, score }) => ({ examQuestionId, score })), [
    { examQuestionId: 101, score: 0.8 },
    { examQuestionId: 102, score: 0 },
  ]);
});

test('final score is normalized to ten and rounded to two decimals', () => {
  assert.equal(calculateFinalScore([{ score: 1 }, { score: 0.5 }, { score: 0 }], 3), 5);
  assert.equal(calculateFinalScore([{ score: 1 }, { score: 1 }, { score: 0 }], 3), 6.67);
});

test('manual grading rejects missing question results', () => {
  assert.throws(() => validateGradingResponse(JSON.stringify({
    results: [{ exam_question_id: 101, score: 1, feedback: 'Good' }],
    summary_feedback: 'Summary',
  }), questions), /different number of results/);
});

test('custom connection fingerprint changes when any secret/config field changes', () => {
  const base = normalizeConnectionConfig({
    provider: 'Custom', apiProtocol: 'openai_chat', baseUrl: 'https://example.com/v1/', model: 'model-a',
  }, 'secret-a');
  assert.equal(base.baseUrl, 'https://example.com/v1');
  assert.notEqual(connectionFingerprint(base), connectionFingerprint({ ...base, model: 'model-b' }));
  assert.notEqual(connectionFingerprint(base), connectionFingerprint({ ...base, apiKey: 'secret-b' }));
});

test('production provider URL validation blocks local and private targets', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(assertSafeProviderUrl('http://localhost:11434'), /HTTPS|Local\/private/);
    await assert.rejects(assertSafeProviderUrl('https://127.0.0.1/v1'), /Local\/private/);
    await assert.rejects(assertSafeProviderUrl('https://192.168.1.10/v1'), /Local\/private/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('saving a verified setting encrypts the key and returns only a mask', async () => {
  process.env.JWT_SECRET = 'unit-test-jwt-secret';
  process.env.AI_SETTINGS_ENCRYPTION_KEY = `  "${'ab'.repeat(32)}" \r\n`;
  const config = normalizeConnectionConfig({
    provider: 'Custom', apiProtocol: 'openai_chat', baseUrl: 'https://example.com/v1', model: 'model-a',
  }, 'super-secret-key');
  const testToken = jwt.sign({
    purpose: 'ai-setting-test', userId: 9, fingerprint: connectionFingerprint(config),
  }, process.env.JWT_SECRET, { expiresIn: '10m' });

  let row = null;
  const db = {
    async query(sql, params = []) {
      if (sql.includes('SELECT * FROM user_ai_settings')) return { rows: row ? [row] : [], rowCount: 0 };
      if (sql.includes('INSERT INTO user_ai_settings')) {
        row = {
          id: 3, user_id: params[0], provider: params[1], api_protocol: params[2], base_url: params[3],
          encrypted_api_key: params[4], key_iv: params[5], key_auth_tag: params[6], key_mask: params[7],
          model: params[8], test_status: 'verified', tested_config_hash: params[9], tested_at: params[10], updated_at: params[12],
        };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const saved = await saveOwnedAiSetting(db, 9, { ...config, testToken });
  assert.notEqual(row.encrypted_api_key, 'super-secret-key');
  assert.equal(saved.hasApiKey, true);
  assert.match(saved.keyMask, /^sup\*+-key$/);
  assert.equal(Object.hasOwn(saved, 'apiKey'), false);
  assert.equal(Object.hasOwn(saved, 'encrypted_api_key'), false);
});
