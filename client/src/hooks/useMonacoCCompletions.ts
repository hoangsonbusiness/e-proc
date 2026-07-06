import type * as Monaco from 'monaco-editor';

// ─── Helper ────────────────────────────────────────────────────────────────

function makeSnippet(
  monaco: typeof Monaco,
  label: string,
  insertText: string,
  detail: string,
  documentation: string,
  kind: Monaco.languages.CompletionItemKind
): Monaco.languages.CompletionItem {
  return {
    label,
    kind,
    detail,
    documentation: { value: documentation, isTrusted: true },
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  };
}

// ─── C Keywords & Standard Types ──────────────────────────────────────────

function getCKeywords(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const keywords = [
    'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
    'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
    'inline', 'int', 'long', 'register', 'restrict', 'return', 'short',
    'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
    'unsigned', 'void', 'volatile', 'while', '_Bool', '_Complex', '_Imaginary',
    'NULL', 'size_t', 'ssize_t', 'ptrdiff_t', 'wchar_t',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'FILE', 'true', 'false',
  ];

  return keywords.map(kw => ({
    label: kw,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: kw,
    detail: 'C keyword / type',
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── C Snippets ────────────────────────────────────────────────────────────

function getCSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  return [
    makeSnippet(monaco, 'main', 'int main(void) {\n\t$0\n\treturn 0;\n}',
      'main function', 'Program entry point', CIK.Snippet),
    makeSnippet(monaco, 'mainargs', 'int main(int argc, char *argv[]) {\n\t$0\n\treturn 0;\n}',
      'main with args', 'Program entry point with argc/argv', CIK.Snippet),
    makeSnippet(monaco, 'incstdio', '#include <stdio.h>',
      '#include <stdio.h>', 'Standard I/O header', CIK.Snippet),
    makeSnippet(monaco, 'incstdlib', '#include <stdlib.h>',
      '#include <stdlib.h>', 'Standard library header', CIK.Snippet),
    makeSnippet(monaco, 'incstring', '#include <string.h>',
      '#include <string.h>', 'String handling header', CIK.Snippet),
    makeSnippet(monaco, 'printf', 'printf("$1\\n", $0);',
      'printf', 'Formatted print to stdout', CIK.Snippet),
    makeSnippet(monaco, 'scanf', 'scanf("$1", $0);',
      'scanf', 'Formatted read from stdin', CIK.Snippet),
    makeSnippet(monaco, 'fori', 'for (int $1 = 0; $1 < $2; $1++) {\n\t$0\n}',
      'for loop (index)', 'Standard indexed for loop', CIK.Snippet),
    makeSnippet(monaco, 'while', 'while ($1) {\n\t$0\n}',
      'while loop', 'While loop', CIK.Snippet),
    makeSnippet(monaco, 'dowhile', 'do {\n\t$0\n} while ($1);',
      'do-while loop', 'Do-while loop', CIK.Snippet),
    makeSnippet(monaco, 'ifelse', 'if ($1) {\n\t$2\n} else {\n\t$0\n}',
      'if-else', 'If-else block', CIK.Snippet),
    makeSnippet(monaco, 'struct', 'typedef struct {\n\t$1\n} $2;',
      'struct definition', 'Typedef struct', CIK.Snippet),
    makeSnippet(monaco, 'malloc', '$1 *$2 = ($1 *)malloc($3 * sizeof($1));\nif ($2 == NULL) {\n\t$0\n}',
      'malloc with null check', 'Heap allocation with error check', CIK.Snippet),
    makeSnippet(monaco, 'free', 'free($1);\n$1 = NULL;',
      'free + null out', 'Free memory and clear pointer', CIK.Snippet),
    makeSnippet(monaco, 'func', '$1 $2($3) {\n\t$0\n}',
      'function definition', 'Function stub', CIK.Snippet),
    makeSnippet(monaco, 'fopen', 'FILE *$1 = fopen("$2", "$3");\nif ($1 == NULL) {\n\t$0\n}',
      'fopen with null check', 'Open a file with error handling', CIK.Snippet),
    makeSnippet(monaco, 'ifndefguard', '#ifndef $1_H\n#define $1_H\n\n$0\n\n#endif // $1_H',
      'header guard', 'Classic #ifndef include guard', CIK.Snippet),
    makeSnippet(monaco, 'switchcase', 'switch ($1) {\n\tcase $2:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}',
      'switch-case', 'Switch statement with default', CIK.Snippet),
  ];
}

// ─── C Standard Library Functions ─────────────────────────────────────────

function getCLibraryFunctions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  const functions: Array<[string, string, string]> = [
    // stdio.h
    ['printf', 'printf($1)', 'stdio.h - formatted output to stdout'],
    ['fprintf', 'fprintf($1, $2)', 'stdio.h - formatted output to stream'],
    ['sprintf', 'sprintf($1, $2)', 'stdio.h - formatted output to string'],
    ['snprintf', 'snprintf($1, $2, $3)', 'stdio.h - bounded formatted output to string'],
    ['scanf', 'scanf($1)', 'stdio.h - formatted input from stdin'],
    ['fscanf', 'fscanf($1, $2)', 'stdio.h - formatted input from stream'],
    ['sscanf', 'sscanf($1, $2)', 'stdio.h - formatted input from string'],
    ['fopen', 'fopen($1, $2)', 'stdio.h - open a file, returns FILE*'],
    ['fclose', 'fclose($1)', 'stdio.h - close a file stream'],
    ['fread', 'fread($1, $2, $3, $4)', 'stdio.h - read binary data from stream'],
    ['fwrite', 'fwrite($1, $2, $3, $4)', 'stdio.h - write binary data to stream'],
    ['fgets', 'fgets($1, $2, $3)', 'stdio.h - read a line from stream'],
    ['fputs', 'fputs($1, $2)', 'stdio.h - write a string to stream'],
    ['getchar', 'getchar()', 'stdio.h - read a single character from stdin'],
    ['putchar', 'putchar($1)', 'stdio.h - write a single character to stdout'],
    ['perror', 'perror($1)', 'stdio.h - print description of last error'],
    // stdlib.h
    ['malloc', 'malloc($1)', 'stdlib.h - allocate uninitialized heap memory'],
    ['calloc', 'calloc($1, $2)', 'stdlib.h - allocate zero-initialized heap memory'],
    ['realloc', 'realloc($1, $2)', 'stdlib.h - resize a heap allocation'],
    ['free', 'free($1)', 'stdlib.h - free heap memory'],
    ['exit', 'exit($1)', 'stdlib.h - terminate the program'],
    ['atoi', 'atoi($1)', 'stdlib.h - convert string to int'],
    ['atof', 'atof($1)', 'stdlib.h - convert string to double'],
    ['atol', 'atol($1)', 'stdlib.h - convert string to long'],
    ['strtol', 'strtol($1, $2, $3)', 'stdlib.h - convert string to long with base'],
    ['rand', 'rand()', 'stdlib.h - generate a pseudo-random number'],
    ['srand', 'srand($1)', 'stdlib.h - seed the random number generator'],
    ['qsort', 'qsort($1, $2, $3, $4)', 'stdlib.h - sort an array'],
    ['bsearch', 'bsearch($1, $2, $3, $4, $5)', 'stdlib.h - binary search in a sorted array'],
    ['abs', 'abs($1)', 'stdlib.h - absolute value of an int'],
    // string.h
    ['strlen', 'strlen($1)', 'string.h - length of a null-terminated string'],
    ['strcpy', 'strcpy($1, $2)', 'string.h - copy a string'],
    ['strncpy', 'strncpy($1, $2, $3)', 'string.h - copy up to n characters'],
    ['strcat', 'strcat($1, $2)', 'string.h - concatenate strings'],
    ['strncat', 'strncat($1, $2, $3)', 'string.h - concatenate up to n characters'],
    ['strcmp', 'strcmp($1, $2)', 'string.h - compare two strings'],
    ['strncmp', 'strncmp($1, $2, $3)', 'string.h - compare up to n characters'],
    ['strchr', 'strchr($1, $2)', 'string.h - find first occurrence of a character'],
    ['strstr', 'strstr($1, $2)', 'string.h - find first occurrence of a substring'],
    ['strtok', 'strtok($1, $2)', 'string.h - tokenize a string'],
    ['memset', 'memset($1, $2, $3)', 'string.h - fill memory with a byte value'],
    ['memcpy', 'memcpy($1, $2, $3)', 'string.h - copy memory block'],
    ['memmove', 'memmove($1, $2, $3)', 'string.h - copy memory block (overlap-safe)'],
    ['memcmp', 'memcmp($1, $2, $3)', 'string.h - compare memory blocks'],
    // math.h
    ['sqrt', 'sqrt($1)', 'math.h - square root'],
    ['pow', 'pow($1, $2)', 'math.h - raise to a power'],
    ['floor', 'floor($1)', 'math.h - round down'],
    ['ceil', 'ceil($1)', 'math.h - round up'],
    ['fabs', 'fabs($1)', 'math.h - absolute value of a double'],
  ];

  return functions.map(([label, insertText, detail]) => ({
    label,
    kind: CIK.Function,
    detail,
    insertText,
    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Main registration function ────────────────────────────────────────────

let registered = false;

export function registerCCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('c', {
    triggerCharacters: ['.', '>', ' ', '\n'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const allItems = [
        ...getCKeywords(monaco),
        ...getCSnippets(monaco),
        ...getCLibraryFunctions(monaco),
      ].map(item => ({ ...item, range }));

      return { suggestions: allItems };
    }
  });
}
