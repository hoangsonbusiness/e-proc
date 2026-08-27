import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const APP_URL = process.env.ADMIN_RESET_TEST_APP_URL || 'http://127.0.0.1:3001';
const JWT_SECRET = process.env.ADMIN_RESET_TEST_JWT_SECRET
  || 'local-app-jwt-secret-at-least-thirty-two-characters';

async function requestJson(path, {
  method = 'GET', token, body, expectedStatus,
} = {}) {
  const response = await fetch(`${APP_URL}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  if (expectedStatus !== undefined) {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    assert.ok(
      allowed.includes(response.status),
      `${method} ${path} returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return { response, payload };
}

const suffix = `${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const username = `password_reset_${suffix}`;
const oldPassword = 'OldP@ss1';
const newPassword = 'NewP@ss2';
const adminToken = jwt.sign(
  { id: 2_000_000_000, username: 'local-password-reset-admin', role: 'admin' },
  JWT_SECRET,
  { expiresIn: '10m' },
);

let targetUserId;

async function findTarget() {
  const users = await requestJson('/api/admin/users', {
    token: adminToken,
    expectedStatus: 200,
  });
  assert.ok(Array.isArray(users.payload));
  const target = users.payload.find((user) => user.username === username);
  if (target) targetUserId = Number(target.id);
  return { target, users: users.payload };
}

try {
  await requestJson('/api/admin/users', {
    method: 'POST',
    token: adminToken,
    body: { username, password: oldPassword, role: 'mod' },
    expectedStatus: 201,
  });

  const beforeReset = await findTarget();
  assert.ok(beforeReset.target);
  assert.equal(beforeReset.target.role, 'mod');
  assert.equal('password_hash' in beforeReset.target, false);

  const oldLogin = await requestJson('/api/admin/login', {
    method: 'POST',
    body: { username, password: oldPassword },
    expectedStatus: 200,
  });
  assert.equal(Number(oldLogin.payload.userId), targetUserId);
  assert.equal(oldLogin.payload.role, 'mod');

  await requestJson(`/api/admin/users/${targetUserId}/password`, {
    method: 'PUT',
    body: { newPassword },
    expectedStatus: 401,
  });
  await requestJson(`/api/admin/users/${targetUserId}/password`, {
    method: 'PUT',
    token: oldLogin.payload.token,
    body: { newPassword },
    expectedStatus: 403,
  });
  await requestJson(`/api/admin/users/${targetUserId}/password`, {
    method: 'PUT',
    token: adminToken,
    body: { newPassword: 'short12' },
    expectedStatus: 400,
  });

  let missingUserId = 2_000_000_000;
  while (beforeReset.users.some((user) => Number(user.id) === missingUserId)) missingUserId -= 1;
  await requestJson(`/api/admin/users/${missingUserId}/password`, {
    method: 'PUT',
    token: adminToken,
    body: { newPassword },
    expectedStatus: 404,
  });

  const reset = await requestJson(`/api/admin/users/${targetUserId}/password`, {
    method: 'PUT',
    token: adminToken,
    body: { newPassword },
    expectedStatus: 200,
  });
  assert.equal(reset.payload.success, true);

  await requestJson('/api/admin/login', {
    method: 'POST',
    body: { username, password: oldPassword },
    expectedStatus: 401,
  });
  const newLogin = await requestJson('/api/admin/login', {
    method: 'POST',
    body: { username, password: newPassword },
    expectedStatus: 200,
  });
  assert.equal(Number(newLogin.payload.userId), targetUserId);
  assert.equal(newLogin.payload.role, 'mod');

  const afterReset = await findTarget();
  assert.equal(afterReset.target.username, username);
  assert.equal(afterReset.target.role, 'mod');
  assert.equal('password_hash' in afterReset.target, false);

  console.log(JSON.stringify({
    success: true,
    verifiedScenarios: [
      'missing token is rejected',
      'mod role is rejected',
      'short password is rejected',
      'missing user returns 404',
      'admin reset succeeds',
      'old password login fails',
      'new password login succeeds',
      'username and role remain unchanged',
      'user list never exposes the password hash',
    ],
  }, null, 2));
} finally {
  if (!targetUserId) {
    await findTarget().catch(() => undefined);
  }
  if (targetUserId) {
    await requestJson(`/api/admin/users/${targetUserId}`, {
      method: 'DELETE',
      token: adminToken,
      expectedStatus: [200, 404],
    });
  }
}
