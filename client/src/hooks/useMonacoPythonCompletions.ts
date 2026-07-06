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

// ─── Python Keywords & Built-in Types ──────────────────────────────────────

function getPythonKeywords(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const keywords = [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
    'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for',
    'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None',
    'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try',
    'while', 'with', 'yield', 'match', 'case',
    // Built-in types / common names
    'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple',
    'bytes', 'bytearray', 'frozenset', 'complex', 'object', 'type',
    'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
    'AttributeError', 'RuntimeError', 'StopIteration', 'FileNotFoundError',
    'ZeroDivisionError', 'NotImplementedError',
    'self', 'cls',
  ];

  return keywords.map(kw => ({
    label: kw,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: kw,
    detail: 'Python keyword / type',
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── Python Snippets ───────────────────────────────────────────────────────

function getPythonSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  return [
    makeSnippet(monaco, 'main', 'def main():\n\t$0\n\nif __name__ == "__main__":\n\tmain()',
      'main entry point', 'Standard Python script entry point', CIK.Snippet),
    makeSnippet(monaco, 'def', 'def $1($2):\n\t$0',
      'function definition', 'Define a function', CIK.Snippet),
    makeSnippet(monaco, 'class', 'class $1:\n\tdef __init__(self, $2):\n\t\t$0',
      'class definition', 'Class with constructor', CIK.Snippet),
    makeSnippet(monaco, 'fori', 'for $1 in range($2):\n\t$0',
      'for range loop', 'For loop over a range', CIK.Snippet),
    makeSnippet(monaco, 'forin', 'for $1 in $2:\n\t$0',
      'for-in loop', 'For loop over an iterable', CIK.Snippet),
    makeSnippet(monaco, 'while', 'while $1:\n\t$0',
      'while loop', 'While loop', CIK.Snippet),
    makeSnippet(monaco, 'ifelse', 'if $1:\n\t$2\nelse:\n\t$0',
      'if-else', 'If-else block', CIK.Snippet),
    makeSnippet(monaco, 'trycatch', 'try:\n\t$1\nexcept $2 as e:\n\t$0',
      'try-except', 'Try-except block', CIK.Snippet),
    makeSnippet(monaco, 'tryfin', 'try:\n\t$1\nexcept $2 as e:\n\t$3\nfinally:\n\t$0',
      'try-except-finally', 'Try-except-finally block', CIK.Snippet),
    makeSnippet(monaco, 'withopen', 'with open($1, "$2") as $3:\n\t$0',
      'with open', 'Context-managed file open', CIK.Snippet),
    makeSnippet(monaco, 'listcomp', '[$1 for $2 in $3]',
      'list comprehension', 'List comprehension', CIK.Snippet),
    makeSnippet(monaco, 'dictcomp', '{$1: $2 for $3 in $4}',
      'dict comprehension', 'Dict comprehension', CIK.Snippet),
    makeSnippet(monaco, 'lambda', 'lambda $1: $0',
      'lambda expression', 'Lambda function', CIK.Snippet),
    makeSnippet(monaco, 'dataclass', '@dataclass\nclass $1:\n\t$2: $3\n\t$0',
      'dataclass', 'Dataclass definition (requires import)', CIK.Snippet),
    makeSnippet(monaco, 'property', '@property\ndef $1(self):\n\treturn self._$1\n\n@$1.setter\ndef $1(self, value):\n\tself._$1 = value',
      'property getter/setter', 'Property with getter and setter', CIK.Snippet),
    makeSnippet(monaco, 'staticmethod', '@staticmethod\ndef $1($2):\n\t$0',
      'staticmethod', 'Static method definition', CIK.Snippet),
    makeSnippet(monaco, 'classmethod', '@classmethod\ndef $1(cls, $2):\n\t$0',
      'classmethod', 'Class method definition', CIK.Snippet),
    makeSnippet(monaco, 'argparse', 'import argparse\n\nparser = argparse.ArgumentParser()\nparser.add_argument("--$1", type=$2, default=$3)\nargs = parser.parse_args()\n$0',
      'argparse setup', 'Command-line argument parsing boilerplate', CIK.Snippet),
    makeSnippet(monaco, 'docstring', '"""$1\n\nArgs:\n\t$2\n\nReturns:\n\t$0\n"""',
      'docstring', 'Function/module docstring template', CIK.Snippet),
  ];
}

// ─── Python Built-in / Standard Library Functions ─────────────────────────

function getPythonLibraryFunctions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  const functions: Array<[string, string, string]> = [
    // built-ins
    ['print', 'print($1)', 'builtin - print to stdout'],
    ['len', 'len($1)', 'builtin - length of a sequence/collection'],
    ['range', 'range($1)', 'builtin - arithmetic sequence generator'],
    ['enumerate', 'enumerate($1)', 'builtin - pair items with their index'],
    ['zip', 'zip($1, $2)', 'builtin - combine iterables element-wise'],
    ['map', 'map($1, $2)', 'builtin - apply a function to each item'],
    ['filter', 'filter($1, $2)', 'builtin - filter items by predicate'],
    ['sorted', 'sorted($1)', 'builtin - return a new sorted list'],
    ['reversed', 'reversed($1)', 'builtin - reverse iterator'],
    ['sum', 'sum($1)', 'builtin - sum of an iterable'],
    ['min', 'min($1)', 'builtin - smallest item'],
    ['max', 'max($1)', 'builtin - largest item'],
    ['abs', 'abs($1)', 'builtin - absolute value'],
    ['isinstance', 'isinstance($1, $2)', 'builtin - type check'],
    ['open', 'open($1, "$2")', 'builtin - open a file'],
    ['input', 'input($1)', 'builtin - read a line from stdin'],
    ['type', 'type($1)', 'builtin - get the type of an object'],
    ['super', 'super()', 'builtin - reference to the parent class'],
    // list / dict methods
    ['append', 'append($1)', 'list - add item to the end'],
    ['extend', 'extend($1)', 'list - append items from an iterable'],
    ['pop', 'pop($1)', 'list/dict - remove and return item'],
    ['sort', 'sort(key=$1)', 'list - sort in place'],
    ['get', 'get($1, $2)', 'dict - get value with default'],
    ['items', 'items()', 'dict - key-value pairs view'],
    ['keys', 'keys()', 'dict - keys view'],
    ['values', 'values()', 'dict - values view'],
    ['setdefault', 'setdefault($1, $2)', 'dict - get or set default value'],
    // string methods
    ['join', 'join($1)', 'str - join iterable of strings with separator'],
    ['split', 'split($1)', 'str - split into a list by delimiter'],
    ['strip', 'strip()', 'str - remove leading/trailing whitespace'],
    ['replace', 'replace($1, $2)', 'str - replace substring'],
    ['format', 'format($1)', 'str - format placeholders'],
    ['startswith', 'startswith($1)', 'str - check prefix'],
    ['endswith', 'endswith($1)', 'str - check suffix'],
    // modules
    ['os.path.join', 'os.path.join($1, $2)', 'os.path - join path components'],
    ['json.loads', 'json.loads($1)', 'json - parse JSON string to object'],
    ['json.dumps', 'json.dumps($1)', 'json - serialize object to JSON string'],
    ['re.match', 're.match($1, $2)', 're - match regex at string start'],
    ['re.search', 're.search($1, $2)', 're - search regex anywhere in string'],
    ['re.findall', 're.findall($1, $2)', 're - find all non-overlapping matches'],
    ['datetime.now', 'datetime.now()', 'datetime - current local datetime'],
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

export function registerPythonCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', ' ', '\n'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const allItems = [
        ...getPythonKeywords(monaco),
        ...getPythonSnippets(monaco),
        ...getPythonLibraryFunctions(monaco),
      ].map(item => ({ ...item, range }));

      return { suggestions: allItems };
    }
  });
}
