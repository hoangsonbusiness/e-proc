import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import db from '../dist/server/db/postgres.js';
import { studentAuthMiddleware } from '../dist/server/middleware/studentAuth.js';

const TEST_SECRET = 'student-auth-unit-test-secret';
const previousSecret = process.env.JWT_SECRET;
const originalQuery = db.query;
const originalConsoleError = console.error;

afterEach(() => {
  db.query = originalQuery;
  console.error = originalConsoleError;
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

function signToken(payload = {}, options = {}) {
  return jwt.sign({
    studentId: 7,
    batchId: 3,
    jti: 'session-a',
    ...payload,
  }, TEST_SECRET, options);
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function authenticate(rawToken) {
  process.env.JWT_SECRET = TEST_SECRET;
  const req = {
    headers: { authorization: `Bearer ${rawToken}` },
    body: {},
  };
  const res = createResponse();
  let nextCalls = 0;

  await studentAuthMiddleware(req, res, () => { nextCalls += 1; });
  return { req, res, nextCalls };
}

test('a transient active-session database failure is a retryable 503, not an invalid-token 401', async () => {
  let query;
  db.query = async (sql, params) => {
    query = { sql, params };
    throw new Error('database connection terminated');
  };
  console.error = () => {};

  const result = await authenticate(signToken());

  assert.equal(result.res.statusCode, 503);
  assert.deepEqual(result.res.body, {
    error: 'Student authentication service is temporarily unavailable',
    reason: 'auth_backend_unavailable',
  });
  assert.equal(result.res.headers['retry-after'], '1');
  assert.equal(result.nextCalls, 0, 'the request must fail closed while auth storage is unavailable');
  assert.equal(result.req.studentPayload, undefined);
  assert.deepEqual(query, {
    sql: 'SELECT active_jti FROM students WHERE id = ?',
    params: [7],
  });
});

test('an invalid JWT remains a non-retryable 401 and never queries the database', async () => {
  let queryCalls = 0;
  db.query = async () => {
    queryCalls += 1;
    return { rows: [], rowCount: 0 };
  };

  const invalidToken = jwt.sign({ studentId: 7, batchId: 3, jti: 'session-a' }, 'wrong-secret');
  const result = await authenticate(invalidToken);

  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, { error: 'Unauthorized: Invalid student token' });
  assert.equal(result.nextCalls, 0);
  assert.equal(queryCalls, 0);
});

test('an expired JWT remains a non-retryable 401 and never queries the database', async () => {
  let queryCalls = 0;
  db.query = async () => {
    queryCalls += 1;
    return { rows: [], rowCount: 0 };
  };

  const result = await authenticate(signToken({}, { expiresIn: -1 }));

  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, { error: 'Unauthorized: Student token expired' });
  assert.equal(result.nextCalls, 0);
  assert.equal(queryCalls, 0);
});

test('a revoked session remains a non-retryable 401', async () => {
  db.query = async () => ({ rows: [{ active_jti: 'session-b' }], rowCount: 0 });

  const result = await authenticate(signToken());

  assert.equal(result.res.statusCode, 401);
  assert.deepEqual(result.res.body, {
    error: 'Unauthorized: This exam session is no longer active',
    reason: 'session_revoked',
  });
  assert.equal(result.nextCalls, 0);
});

test('a valid active session still reaches the protected route', async () => {
  db.query = async () => ({ rows: [{ active_jti: 'session-a' }], rowCount: 0 });

  const result = await authenticate(signToken());

  assert.equal(result.res.statusCode, 200);
  assert.equal(result.res.body, undefined);
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.req.studentPayload.studentId, 7);
  assert.deepEqual(result.req.studentPayload.batchId, 3);
  assert.deepEqual(result.req.studentPayload.jti, 'session-a');
});
