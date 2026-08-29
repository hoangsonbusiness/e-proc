import { test } from 'node:test';
import assert from 'node:assert/strict';
import adminRouter from '../dist/server/routes/admin.js';
import { requireAdmin } from '../dist/server/middleware/auth.js';
import { isLiveBatchOwner } from '../dist/server/services/liveMonitorAccess.js';

test('Live ownership accepts only the batch creator regardless of role', () => {
  assert.equal(isLiveBatchOwner(12, 12), true);
  assert.equal(isLiveBatchOwner('12', 12), true);
  assert.equal(isLiveBatchOwner(12, 13), false);
  assert.equal(isLiveBatchOwner(null, 12), false);
});

test('Live list, session, and audit routes do not use the admin-role middleware', () => {
  const routes = [
    ['/batches/:batchId/live/students', 'get'],
    ['/batches/:batchId/live/students/:studentId/session', 'post'],
    ['/live/audit/:viewerSessionId/end', 'post'],
  ];

  for (const [path, method] of routes) {
    const layer = adminRouter.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
    assert.ok(layer, `missing ${method.toUpperCase()} ${path}`);
    assert.equal(
      layer.route.stack.some((entry) => entry.handle === requireAdmin),
      false,
      `${method.toUpperCase()} ${path} must be ownership-based, not role-based`,
    );
  }
});
