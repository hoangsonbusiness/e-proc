import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../client/src/services/suggestionMatcher.ts', import.meta.url),
  'utf8'
);
const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const matcher = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);

test('allows an exact Monaco plain-text suggestion', () => {
  assert.equal(
    matcher.matchesRegisteredSuggestion('System.out.println', [
      { insertText: 'System.out.println', isSnippet: false },
    ]),
    true
  );
});

test('allows the initial expanded text of a Monaco snippet', () => {
  const template = 'public class ${1:Example} {\n\t$0\n}';
  assert.equal(matcher.resolveSnippetInitialText(template), 'public class Example {\n\n}');
  assert.equal(
    matcher.matchesRegisteredSuggestion('public class Example {\n\t\n}', [
      { insertText: template, isSnippet: true },
    ]),
    true
  );
});

test('rejects external text that is not registered Monaco suggestion data', () => {
  assert.equal(
    matcher.matchesRegisteredSuggestion('answer copied from an external AI tool', [
      { insertText: 'public class ${1:Example} {\n\t$0\n}', isSnippet: true },
    ]),
    false
  );
});

test('normalizes CRLF but otherwise requires exact suggestion content', () => {
  assert.equal(
    matcher.matchesRegisteredSuggestion('line one\r\nline two', [
      { insertText: 'line one\nline two', isSnippet: false },
    ]),
    true
  );
  assert.equal(
    matcher.matchesRegisteredSuggestion('line one\nline two modified', [
      { insertText: 'line one\nline two', isSnippet: false },
    ]),
    false
  );
});

test('allows Monaco indentation conversion but not content changes', () => {
  const suggestion = 'if (${1:condition}) {\n\t$0\n}';
  assert.equal(
    matcher.matchesRegisteredSuggestion('if (condition) {\n        \n    }', [
      { insertText: suggestion, isSnippet: true },
    ]),
    true
  );
  assert.equal(
    matcher.matchesRegisteredSuggestion('if (externalAnswer) {\n        doCheat();\n    }', [
      { insertText: suggestion, isSnippet: true },
    ]),
    false
  );
});
