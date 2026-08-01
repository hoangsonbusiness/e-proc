import type * as Monaco from 'monaco-editor';

// Monaco has no built-in COBOL language contribution (unlike Java/C/C++/SQL/etc.),
// so it must be registered manually with a Monarch tokenizer for basic syntax highlighting.
const COBOL_LANGUAGE_ID = 'cobol';

let registered = false;

const COBOL_KEYWORDS = [
  'IDENTIFICATION', 'DIVISION', 'PROGRAM-ID', 'AUTHOR', 'ENVIRONMENT',
  'CONFIGURATION', 'SOURCE-COMPUTER', 'OBJECT-COMPUTER', 'INPUT-OUTPUT',
  'FILE-CONTROL', 'DATA', 'FILE', 'WORKING-STORAGE', 'LINKAGE',
  'PROCEDURE', 'SECTION', 'PARAGRAPH',
  'MOVE', 'TO', 'FROM', 'INTO', 'GIVING', 'BY',
  'PERFORM', 'UNTIL', 'VARYING', 'THRU', 'THROUGH', 'TIMES',
  'IF', 'ELSE', 'END-IF', 'EVALUATE', 'WHEN', 'END-EVALUATE', 'OTHER',
  'ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'COMPUTE',
  'DISPLAY', 'ACCEPT', 'STOP', 'RUN', 'GOBACK', 'EXIT',
  'OPEN', 'CLOSE', 'READ', 'WRITE', 'REWRITE', 'DELETE',
  'INPUT', 'OUTPUT', 'I-O', 'EXTEND',
  'CALL', 'USING', 'RETURNING',
  'PIC', 'PICTURE', 'VALUE', 'VALUES', 'REDEFINES', 'OCCURS',
  'COPY', 'REPLACE',
  'STRING', 'UNSTRING', 'INSPECT', 'TALLYING', 'REPLACING',
  'INITIALIZE', 'SET', 'CONTINUE', 'NEXT', 'SENTENCE',
  'AND', 'OR', 'NOT', 'EQUAL', 'GREATER', 'LESS', 'THAN',
  'FD', 'SD', 'RECORD', 'CONTAINS', 'CHARACTERS',
];

export function registerCobolLanguage(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: COBOL_LANGUAGE_ID, extensions: ['.cbl', '.cob'], aliases: ['COBOL', 'cobol'] });

  monaco.languages.setLanguageConfiguration(COBOL_LANGUAGE_ID, {
    comments: { lineComment: '*' },
    brackets: [['(', ')']],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
  });

  monaco.languages.setMonarchTokensProvider(COBOL_LANGUAGE_ID, {
    ignoreCase: true,
    keywords: COBOL_KEYWORDS,
    tokenizer: {
      root: [
        // COBOL fixed-format comment: '*' in column 7 (approximated as line-leading '*')
        [/^\s*\*.*$/, 'comment'],
        [/\b\d+(\.\d+)?\b/, 'number'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/[A-Za-z][A-Za-z0-9-]*/, {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier',
          },
        }],
        [/[.,;()]/, 'delimiter'],
      ],
    },
  });
}
