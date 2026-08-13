export interface SuggestionTemplate {
  insertText: string;
  isSnippet: boolean;
}

function normalizeInsertedText(value: string): string {
  // Monaco may convert snippet tabs to spaces and add the current line's base
  // indentation. Compare the suggestion's data while ignoring only leading
  // indentation; all non-indentation content must still match exactly.
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^[\t ]+/, ''))
    .join('\n');
}

/**
 * Resolve the initial text Monaco inserts when accepting a snippet. Placeholder
 * defaults are materialized, cursor/tab stops without defaults become empty,
 * and repeated tab stops reuse the first default value.
 */
export function resolveSnippetInitialText(snippet: string): string {
  const defaults = new Map<string, string>();
  let output = normalizeInsertedText(snippet);

  // Resolve ${1:default}. Defaults in this repository do not contain unescaped
  // closing braces; run repeatedly to support a nested placeholder if added later.
  let previous: string;
  do {
    previous = output;
    output = output.replace(/\$\{(\d+):([^{}]*)\}/g, (_match, index: string, defaultValue: string) => {
      const resolved = resolveSnippetInitialText(defaultValue);
      defaults.set(index, resolved);
      return resolved;
    });
  } while (output !== previous);

  // Monaco selects the first option initially for choice placeholders.
  output = output.replace(/\$\{(\d+)\|([^}]*)\|\}/g, (_match, index: string, choices: string) => {
    const first = choices.split(',')[0] ?? '';
    defaults.set(index, first);
    return first;
  });

  output = output.replace(/\$\{(\d+)\}/g, (_match, index: string) => defaults.get(index) ?? '');
  output = output.replace(/\$(\d+)/g, (_match, index: string) => defaults.get(index) ?? '');

  // Monaco snippet escaping for literal $, }, and backslash.
  return output.replace(/\\([\\$}])/g, '$1');
}

export function matchesRegisteredSuggestion(
  insertedText: string,
  suggestions: readonly SuggestionTemplate[]
): boolean {
  const candidate = normalizeInsertedText(insertedText);
  return suggestions.some(({ insertText, isSnippet }) => {
    const expected = isSnippet
      ? resolveSnippetInitialText(insertText)
      : normalizeInsertedText(insertText);
    return candidate === expected;
  });
}
