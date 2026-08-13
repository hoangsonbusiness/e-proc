import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../client/src/services/examBlockReason.ts', import.meta.url),
  'utf8'
);
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const blockReason = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

test('recognizes every supported exam block reason', () => {
  for (const reason of ['timeout', 'absent_too_long', 'submitted', 'concurrent_session']) {
    assert.equal(blockReason.normalizeBlockReason(reason), reason);
  }
});

test('falls back safely when a 410 response has an unknown or missing reason', () => {
  for (const reason of ['future_reason', '', null, undefined, 42, {}]) {
    assert.equal(blockReason.normalizeBlockReason(reason), 'submitted');
    assert.deepEqual(
      blockReason.getBlockReasonMessage(reason),
      blockReason.BLOCK_REASON_MESSAGES.submitted
    );
  }
});

test('provides renderable content for every supported reason', () => {
  for (const reason of blockReason.BLOCK_REASONS) {
    const message = blockReason.getBlockReasonMessage(reason);
    assert.equal(typeof message.icon, 'string');
    assert.ok(message.icon.length > 0);
    assert.equal(typeof message.title, 'string');
    assert.ok(message.title.length > 0);
    assert.equal(typeof message.message, 'string');
    assert.ok(message.message.length > 0);
  }
});

test('renders a dedicated concurrent-session lock message without exposing evidence', () => {
  const message = blockReason.getBlockReasonMessage('concurrent_session');
  assert.equal(message.title, 'Concurrent Session Detected');
  assert.match(message.message, /automatically submitted/i);
  assert.doesNotMatch(message.message, /\bIP\b|\bjti\b/i);
});
