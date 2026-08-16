import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { AiGradingError, calculateFinalScore, gradeBatchManually, validateGradingResponse } from '../dist/server/services/batchAiGrading.js';
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

test('final score is normalized to ten and rounded to two decimals', () => {
  assert.equal(calculateFinalScore([{ score: 1 }, { score: 0.5 }, { score: 0 }], 3), 5);
  assert.equal(calculateFinalScore([{ score: 1 }, { score: 1 }, { score: 0 }], 3), 6.67);
});

test('manual grading rejects missing question results', () => {
  assert.throws(() => validateGradingResponse(JSON.stringify({
    results: [{ exam_question_id: 101, score: 1, feedback: 'Good' }],
    summary_feedback: 'Summary',
  }), questions), /omitted/);
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
  process.env.AI_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
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
