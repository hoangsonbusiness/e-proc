import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  loadPagedQuestions,
  loadQuestionCatalogSummary,
  validateQuestionUpdate,
} from '../dist/server/services/adminQuestions.js';

function fixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE question_bank (
      id TEXT PRIMARY KEY, type TEXT, level TEXT, module TEXT,
      question_sample TEXT, uploaded_by INTEGER
    );
    INSERT INTO question_bank VALUES
      ('q1', 'Coding', 'Easy', 'Java', 'one', 1),
      ('q2', 'Conceptual', 'Hard', 'Java', 'two', 1),
      ('q3', 'SingleChoice', 'Medium', 'Spring', 'three', 2),
      ('q4', 'MultipleChoice', 'Easy', 'Spring', 'four', 2);
  `);
  let queryCount = 0;
  return {
    get queryCount() { return queryCount; },
    async query(sql, params = []) {
      queryCount += 1;
      return { rows: database.prepare(sql).all(...params), rowCount: 0 };
    },
  };
}

test('paged questions return bounded stable pages with server filters', async () => {
  const db = fixture();
  const result = await loadPagedQuestions(db, {
    page: 1,
    pageSize: 10,
    moduleName: 'Spring',
    category: 'quiz',
  });
  assert.equal(db.queryCount, 2);
  assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => item.id), ['q4', 'q3']);
});

test('catalog summary replaces four aggregate requests with one query', async () => {
  const db = fixture();
  const result = await loadQuestionCatalogSummary(db);
  assert.equal(db.queryCount, 1);
  assert.deepEqual(result.modules, ['Java', 'Spring']);
  assert.deepEqual(result.moduleStats.find(item => item.module === 'Java'), {
    module: 'Java', easy: 1, medium: 0, hard: 1,
  });
  assert.deepEqual(result.typeStats.find(item => item.type === 'SingleChoice'), {
    type: 'SingleChoice', easy: 0, medium: 1, hard: 0,
  });
});

test('question update validation preserves HTML-like content verbatim', () => {
  const question = '<p>Compare <code>List&lt;T&gt;</code></p>\n<pre>if (a < b) return;</pre>';
  const rubric = '<strong>Must explain O(n)</strong>';
  const result = validateQuestionUpdate({
    type: 'Coding',
    level: 'Hard',
    module: ' Java ',
    question_sample: question,
    rubric_must_have: rubric,
    rubric_nice_to_have: '',
    rubric_optional: '',
  });
  assert.equal(result.question_sample, question);
  assert.equal(result.rubric_must_have, rubric);
  assert.equal(result.module, 'Java');
});

test('quiz update validation requires correct answers to match non-empty options', () => {
  assert.throws(() => validateQuestionUpdate({
    type: 'SingleChoice',
    level: 'Easy',
    module: 'Java',
    question_sample: '<p>Pick one</p>',
    options: [{ key: 'A', text: 'One' }, { key: 'B', text: 'Two' }],
    correct_answers: ['C'],
    score: 1,
  }), /Correct answers must match an available option/);
});
