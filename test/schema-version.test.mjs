import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOTSTRAP_SCHEMA_VERSION,
  MINIMUM_SCHEMA_VERSION,
  isSupportedSchemaVersion,
} from '../dist/server/db/schemaVersion.js';

test('sealed recording manifest runtime requires installed schema version 4', () => {
  assert.equal(MINIMUM_SCHEMA_VERSION, 4);
  assert.equal(BOOTSTRAP_SCHEMA_VERSION, 4);
  assert.equal(isSupportedSchemaVersion(1), false);
  assert.equal(isSupportedSchemaVersion(2), false);
  assert.equal(isSupportedSchemaVersion(3), false);
  assert.equal(isSupportedSchemaVersion(4), true);
});

test('schema fast path rejects missing, invalid, and pre-baseline versions', () => {
  assert.equal(isSupportedSchemaVersion(null), false);
  assert.equal(isSupportedSchemaVersion(0), false);
  assert.equal(isSupportedSchemaVersion(1.5), false);
});

test('schema fast path remains forward-compatible with newer versions', () => {
  assert.equal(isSupportedSchemaVersion(5), true);
});
