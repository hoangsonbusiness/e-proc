import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLIENT_REPORTABLE_VIOLATION_TYPES,
  SERVER_OWNED_VIOLATION_TYPES,
  isClientReportableViolation,
  isServerOwnedViolation,
} from '../dist/server/services/violationPolicy.js';

test('concurrent_session is server-owned and cannot be reported by a client', () => {
  assert.equal(isServerOwnedViolation('concurrent_session'), true);
  assert.equal(isClientReportableViolation('concurrent_session'), false);
  assert.deepEqual(SERVER_OWNED_VIOLATION_TYPES, ['concurrent_session']);
});

test('client-reportable and server-owned violation policies are disjoint', () => {
  for (const type of CLIENT_REPORTABLE_VIOLATION_TYPES) {
    assert.equal(isClientReportableViolation(type), true);
    assert.equal(isServerOwnedViolation(type), false);
  }
  assert.equal(
    CLIENT_REPORTABLE_VIOLATION_TYPES.some((type) => SERVER_OWNED_VIOLATION_TYPES.includes(type)),
    false,
  );
});

test('unknown or non-string values are rejected by both policies', () => {
  for (const type of ['future_type', '', null, undefined, 42, {}]) {
    assert.equal(isClientReportableViolation(type), false);
    assert.equal(isServerOwnedViolation(type), false);
  }
});
