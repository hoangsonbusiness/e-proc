import type * as Monaco from 'monaco-editor';

// Monaco has no built-in COBOL language contribution, so unlike Java/C/C++/Python
// (which reuse Monaco's own built-in language ids), COBOL IntelliSense must be
// registered separately against the custom 'cobol' language id created in
// useMonacoCobolLanguage.ts's registerCobolLanguage().
const COBOL_LANGUAGE_ID = 'cobol';

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

// ─── COBOL Keywords ─────────────────────────────────────────────────────────

function getCobolKeywords(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const keywords = [
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

  return keywords.map(kw => ({
    label: kw,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: kw,
    detail: 'COBOL keyword',
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── COBOL Snippets ────────────────────────────────────────────────────────

function getCobolSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  return [
    makeSnippet(monaco, 'skeleton',
      'IDENTIFICATION DIVISION.\nPROGRAM-ID. $1.\n\nENVIRONMENT DIVISION.\n\nDATA DIVISION.\nWORKING-STORAGE SECTION.\n$2\n\nPROCEDURE DIVISION.\n\t$0\n\tSTOP RUN.',
      'Program skeleton', 'Full four-division COBOL program skeleton', CIK.Snippet),
    makeSnippet(monaco, 'iddivision',
      'IDENTIFICATION DIVISION.\nPROGRAM-ID. $1.\nAUTHOR. $0.',
      'IDENTIFICATION DIVISION', 'Identification division header', CIK.Snippet),
    makeSnippet(monaco, 'datadivision',
      'DATA DIVISION.\nWORKING-STORAGE SECTION.\n$0',
      'DATA DIVISION', 'Data division with working-storage section', CIK.Snippet),
    makeSnippet(monaco, 'filecontrol',
      'ENVIRONMENT DIVISION.\nINPUT-OUTPUT SECTION.\nFILE-CONTROL.\n\tSELECT $1 ASSIGN TO "$2"\n\t\tORGANIZATION IS $3.',
      'FILE-CONTROL', 'File-control paragraph for a file assignment', CIK.Snippet),
    makeSnippet(monaco, 'fdrecord',
      'FD  $1.\n01  $2.\n\t05  $0 PIC X(10).',
      'FD record layout', 'File description with a record layout', CIK.Snippet),
    makeSnippet(monaco, 'pic9',
      '01  $1 PIC 9($2)$0.',
      'PIC 9 numeric field', 'Numeric picture clause field', CIK.Snippet),
    makeSnippet(monaco, 'picx',
      '01  $1 PIC X($2)$0.',
      'PIC X alphanumeric field', 'Alphanumeric picture clause field', CIK.Snippet),
    makeSnippet(monaco, 'ifelse',
      'IF $1\n\t$2\nELSE\n\t$0\nEND-IF.',
      'IF-ELSE', 'If-else conditional block', CIK.Snippet),
    makeSnippet(monaco, 'evaluate',
      'EVALUATE $1\n\tWHEN $2\n\t\t$0\n\tWHEN OTHER\n\t\tCONTINUE\nEND-EVALUATE.',
      'EVALUATE', 'Evaluate (switch-like) statement', CIK.Snippet),
    makeSnippet(monaco, 'performuntil',
      'PERFORM $1 UNTIL $2\n\t$0\nEND-PERFORM.',
      'PERFORM UNTIL', 'Perform loop with until condition', CIK.Snippet),
    makeSnippet(monaco, 'performvarying',
      'PERFORM VARYING $1 FROM $2 BY $3 UNTIL $4\n\t$0\nEND-PERFORM.',
      'PERFORM VARYING', 'Perform loop with varying counter', CIK.Snippet),
    makeSnippet(monaco, 'performthru',
      'PERFORM $1 THRU $2.',
      'PERFORM THRU', 'Perform a range of paragraphs', CIK.Snippet),
    makeSnippet(monaco, 'display',
      'DISPLAY $0.',
      'DISPLAY', 'Display a value to standard output', CIK.Snippet),
    makeSnippet(monaco, 'accept',
      'ACCEPT $0.',
      'ACCEPT', 'Accept input into a variable', CIK.Snippet),
    makeSnippet(monaco, 'move',
      'MOVE $1 TO $0.',
      'MOVE', 'Move a value into a field', CIK.Snippet),
    makeSnippet(monaco, 'openfile',
      'OPEN $1 $2.',
      'OPEN', 'Open a file (INPUT/OUTPUT/I-O/EXTEND)', CIK.Snippet),
    makeSnippet(monaco, 'readfile',
      'READ $1\n\tAT END $2\nEND-READ.',
      'READ AT END', 'Read a record with end-of-file handling', CIK.Snippet),
    makeSnippet(monaco, 'writefile',
      'WRITE $1 FROM $0.',
      'WRITE FROM', 'Write a record from a field', CIK.Snippet),
    makeSnippet(monaco, 'closefile',
      'CLOSE $0.',
      'CLOSE', 'Close a file', CIK.Snippet),
    makeSnippet(monaco, 'compute',
      'COMPUTE $1 = $0.',
      'COMPUTE', 'Compute an arithmetic expression', CIK.Snippet),
    makeSnippet(monaco, 'addto',
      'ADD $1 TO $0.',
      'ADD TO', 'Add a value to a field', CIK.Snippet),
    makeSnippet(monaco, 'callusing',
      'CALL "$1" USING $0.',
      'CALL USING', 'Call another program passing parameters', CIK.Snippet),
    makeSnippet(monaco, 'stringstmt',
      'STRING $1 DELIMITED BY SIZE\n\tINTO $2.',
      'STRING', 'Concatenate fields into a target', CIK.Snippet),
    makeSnippet(monaco, 'stoprun',
      'STOP RUN.',
      'STOP RUN', 'Terminate program execution', CIK.Snippet),
  ];
}

// ─── Main registration function ────────────────────────────────────────────

let registered = false;

export function registerCobolCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider(COBOL_LANGUAGE_ID, {
    triggerCharacters: [' ', '\n', '-'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const allItems = [
        ...getCobolKeywords(monaco),
        ...getCobolSnippets(monaco),
      ].map(item => ({ ...item, range }));

      return { suggestions: allItems };
    }
  });
}
