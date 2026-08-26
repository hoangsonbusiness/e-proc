import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedSchemaVersion } from '../dist/server/db/schemaVersion.js';

test('cleanup transition accepts installed schema versions 1 and 2', () => {
  assert.equal(isSupportedSchemaVersion(1), true);
  assert.equal(isSupportedSchemaVersion(2), true);
});

test('schema fast path rejects missing, invalid, and pre-baseline versions', () => {
  assert.equal(isSupportedSchemaVersion(null), false);
  assert.equal(isSupportedSchemaVersion(0), false);
  assert.equal(isSupportedSchemaVersion(1.5), false);
});

test('schema fast path remains forward-compatible with newer versions', () => {
  assert.equal(isSupportedSchemaVersion(3), true);
});
