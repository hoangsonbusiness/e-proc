import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import adminRouter from '../dist/server/routes/admin.js';
import { authMiddleware, requireAdmin } from '../dist/server/middleware/auth.js';
import {
  AdminUserPasswordError,
  resetAdminUserPassword,
} from '../dist/server/services/adminUsers.js';

function executor(database) {
  return {
    async query(sql, params = []) {
      const statement = database.prepare(sql);
      if (sql.trim().toUpperCase().startsWith('SELECT')) {
        return { rows: statement.all(...params), rowCount: 0 };
      }
      const result = statement.run(...params);
      return { rows: [], rowCount: result.changes };
    },
  };
}

async function fixture() {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE admin_users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const oldPasswordHash = await bcrypt.hash('old-password', 4);
  database.prepare(`
    INSERT INTO admin_users (id, username, password_hash, updated_at)
    VALUES (1, 'managed-user', ?, '2000-01-01 00:00:00')
  `).run(oldPasswordHash);
  return { database, executor: executor(database), oldPasswordHash };
}

function isPasswordError(statusCode) {
  return (error) => error instanceof AdminUserPasswordError && error.statusCode === statusCode;
}

test('password reset route is protected by authentication and the admin role gate', () => {
  const authLayerIndex = adminRouter.stack.findIndex((layer) => layer.handle === authMiddleware);
  const resetRouteIndex = adminRouter.stack.findIndex((layer) => (
    layer.route?.path === '/users/:id/password' && layer.route.methods.put
  ));

  assert.ok(authLayerIndex >= 0);
  assert.ok(resetRouteIndex > authLayerIndex);
  assert.equal(
    adminRouter.stack[resetRouteIndex].route.stack.some((layer) => layer.handle === requireAdmin),
    true,
  );
});

test('resetAdminUserPassword replaces the hash using bcrypt cost 10', async (t) => {
  const { database, executor: db } = await fixture();
  t.after(() => database.close());

  // Boundary: password changes accept exactly eight characters.
  const result = await resetAdminUserPassword(db, '1', 'new-pass');

  assert.deepEqual(result, { userId: 1 });
  const stored = database.prepare(
    'SELECT password_hash, updated_at FROM admin_users WHERE id = 1',
  ).get();
  assert.notEqual(stored.password_hash, 'new-pass');
  assert.equal(await bcrypt.compare('new-pass', stored.password_hash), true);
  assert.equal(await bcrypt.compare('old-password', stored.password_hash), false);
  assert.equal(bcrypt.getRounds(stored.password_hash), 10);
  assert.notEqual(stored.updated_at, '2000-01-01 00:00:00');
});

test('resetAdminUserPassword rejects invalid user IDs without changing the hash', async (t) => {
  const { database, executor: db, oldPasswordHash } = await fixture();
  t.after(() => database.close());

  for (const invalidId of ['', '0', '-1', '1.5', '1abc', Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      resetAdminUserPassword(db, invalidId, 'new-password'),
      isPasswordError(400),
    );
  }

  const stored = database.prepare('SELECT password_hash FROM admin_users WHERE id = 1').get();
  assert.equal(stored.password_hash, oldPasswordHash);
});

test('resetAdminUserPassword rejects passwords shorter than eight characters', async (t) => {
  const { database, executor: db, oldPasswordHash } = await fixture();
  t.after(() => database.close());

  for (const invalidPassword of [undefined, 12345678, '', '1234567']) {
    await assert.rejects(
      resetAdminUserPassword(db, '1', invalidPassword),
      isPasswordError(400),
    );
  }

  const stored = database.prepare('SELECT password_hash FROM admin_users WHERE id = 1').get();
  assert.equal(stored.password_hash, oldPasswordHash);
});

test('resetAdminUserPassword returns 404 when the target user does not exist', async (t) => {
  const { database, executor: db } = await fixture();
  t.after(() => database.close());

  await assert.rejects(
    resetAdminUserPassword(db, '999', 'new-password'),
    isPasswordError(404),
  );
});
