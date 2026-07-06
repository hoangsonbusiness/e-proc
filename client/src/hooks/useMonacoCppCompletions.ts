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

// ─── C++ Keywords & Types ──────────────────────────────────────────────────

function getCppKeywords(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const keywords = [
    'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor',
    'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t',
    'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
    'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype',
    'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
    'explicit', 'export', 'extern', 'false', 'final', 'float', 'for', 'friend',
    'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new',
    'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq',
    'override', 'private', 'protected', 'public', 'register',
    'reinterpret_cast', 'requires', 'return', 'short', 'signed', 'sizeof',
    'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template',
    'this', 'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid',
    'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile',
    'wchar_t', 'while', 'xor', 'xor_eq',
    // Common std types
    'std', 'string', 'vector', 'map', 'unordered_map', 'set', 'unordered_set',
    'pair', 'tuple', 'array', 'list', 'deque', 'stack', 'queue',
    'priority_queue', 'shared_ptr', 'unique_ptr', 'weak_ptr', 'optional',
    'variant', 'function', 'size_t', 'nullptr_t',
  ];

  return keywords.map(kw => ({
    label: kw,
    kind: monaco.languages.CompletionItemKind.Keyword,
    insertText: kw,
    detail: 'C++ keyword / type',
    range: undefined as unknown as Monaco.IRange,
  }));
}

// ─── C++ Snippets ──────────────────────────────────────────────────────────

function getCppSnippets(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  return [
    makeSnippet(monaco, 'main', 'int main() {\n\t$0\n\treturn 0;\n}',
      'main function', 'Program entry point', CIK.Snippet),
    makeSnippet(monaco, 'mainargs', 'int main(int argc, char *argv[]) {\n\t$0\n\treturn 0;\n}',
      'main with args', 'Program entry point with argc/argv', CIK.Snippet),
    makeSnippet(monaco, 'inciostream', '#include <iostream>',
      '#include <iostream>', 'Standard I/O stream header', CIK.Snippet),
    makeSnippet(monaco, 'incvector', '#include <vector>',
      '#include <vector>', 'Vector container header', CIK.Snippet),
    makeSnippet(monaco, 'incstring', '#include <string>',
      '#include <string>', 'String header', CIK.Snippet),
    makeSnippet(monaco, 'usingstd', 'using namespace std;',
      'using namespace std', 'Bring std namespace into scope', CIK.Snippet),
    makeSnippet(monaco, 'cout', 'std::cout << $1 << std::endl;',
      'std::cout', 'Print to standard output', CIK.Snippet),
    makeSnippet(monaco, 'cin', 'std::cin >> $1;',
      'std::cin', 'Read from standard input', CIK.Snippet),
    makeSnippet(monaco, 'fori', 'for (int $1 = 0; $1 < $2; $1++) {\n\t$0\n}',
      'for loop (index)', 'Standard indexed for loop', CIK.Snippet),
    makeSnippet(monaco, 'forrange', 'for (auto &$1 : $2) {\n\t$0\n}',
      'range-based for', 'Range-based for loop', CIK.Snippet),
    makeSnippet(monaco, 'while', 'while ($1) {\n\t$0\n}',
      'while loop', 'While loop', CIK.Snippet),
    makeSnippet(monaco, 'trycatch', 'try {\n\t$1\n} catch (const std::exception &e) {\n\t$0\n}',
      'try-catch', 'Try-catch block', CIK.Snippet),
    makeSnippet(monaco, 'class', 'class $1 {\npublic:\n\t$1();\n\t~$1();\n\nprivate:\n\t$0\n};',
      'class definition', 'Class with constructor/destructor', CIK.Snippet),
    makeSnippet(monaco, 'struct', 'struct $1 {\n\t$0\n};',
      'struct definition', 'Struct definition', CIK.Snippet),
    makeSnippet(monaco, 'template', 'template <typename $1>\n$0',
      'template', 'Function/class template', CIK.Snippet),
    makeSnippet(monaco, 'lambda', 'auto $1 = [$2]($3) {\n\t$0\n};',
      'lambda expression', 'Lambda expression assigned to auto', CIK.Snippet),
    makeSnippet(monaco, 'uniqueptr', 'std::unique_ptr<$1> $2 = std::make_unique<$1>($0);',
      'unique_ptr', 'Create a unique_ptr', CIK.Snippet),
    makeSnippet(monaco, 'sharedptr', 'std::shared_ptr<$1> $2 = std::make_shared<$1>($0);',
      'shared_ptr', 'Create a shared_ptr', CIK.Snippet),
    makeSnippet(monaco, 'vector', 'std::vector<$1> $2;',
      'vector declaration', 'Declare a vector', CIK.Snippet),
    makeSnippet(monaco, 'map', 'std::map<$1, $2> $3;',
      'map declaration', 'Declare a map', CIK.Snippet),
    makeSnippet(monaco, 'ifndefguard', '#ifndef $1_H\n#define $1_H\n\n$0\n\n#endif // $1_H',
      'header guard', 'Classic #ifndef include guard', CIK.Snippet),
    makeSnippet(monaco, 'pragmaonce', '#pragma once',
      '#pragma once', 'Non-standard but common include guard', CIK.Snippet),
    makeSnippet(monaco, 'namespace', 'namespace $1 {\n\t$0\n}',
      'namespace', 'Namespace block', CIK.Snippet),
    makeSnippet(monaco, 'switchcase', 'switch ($1) {\n\tcase $2:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}',
      'switch-case', 'Switch statement with default', CIK.Snippet),
    makeSnippet(monaco, 'operator<<', 'friend std::ostream &operator<<(std::ostream &os, const $1 &obj) {\n\tos << $0;\n\treturn os;\n}',
      'operator<< overload', 'Overload stream insertion operator', CIK.Snippet),
  ];
}

// ─── C++ STL / std Library Functions ──────────────────────────────────────

function getCppLibraryFunctions(monaco: typeof Monaco): Monaco.languages.CompletionItem[] {
  const CIK = monaco.languages.CompletionItemKind;
  const functions: Array<[string, string, string]> = [
    // <algorithm>
    ['std::sort', 'std::sort($1.begin(), $1.end())', 'algorithm - sort a range'],
    ['std::find', 'std::find($1.begin(), $1.end(), $2)', 'algorithm - find first matching element'],
    ['std::max', 'std::max($1, $2)', 'algorithm - larger of two values'],
    ['std::min', 'std::min($1, $2)', 'algorithm - smaller of two values'],
    ['std::reverse', 'std::reverse($1.begin(), $1.end())', 'algorithm - reverse a range in place'],
    ['std::unique', 'std::unique($1.begin(), $1.end())', 'algorithm - remove consecutive duplicates'],
    ['std::accumulate', 'std::accumulate($1.begin(), $1.end(), $2)', 'numeric - sum/fold a range'],
    ['std::count', 'std::count($1.begin(), $1.end(), $2)', 'algorithm - count matching elements'],
    ['std::count_if', 'std::count_if($1.begin(), $1.end(), $2)', 'algorithm - count elements matching predicate'],
    ['std::for_each', 'std::for_each($1.begin(), $1.end(), $2)', 'algorithm - apply function to each element'],
    ['std::transform', 'std::transform($1.begin(), $1.end(), $2.begin(), $3)', 'algorithm - apply function producing new range'],
    ['std::lower_bound', 'std::lower_bound($1.begin(), $1.end(), $2)', 'algorithm - binary search, first not-less'],
    ['std::upper_bound', 'std::upper_bound($1.begin(), $1.end(), $2)', 'algorithm - binary search, first greater'],
    ['std::swap', 'std::swap($1, $2)', 'utility - swap two values'],
    // container methods
    ['push_back', 'push_back($1)', 'vector/list/deque - append element'],
    ['emplace_back', 'emplace_back($1)', 'vector/list/deque - construct element in place at end'],
    ['pop_back', 'pop_back()', 'vector/list/deque - remove last element'],
    ['size', 'size()', 'container - number of elements'],
    ['empty', 'empty()', 'container - true if no elements'],
    ['clear', 'clear()', 'container - remove all elements'],
    ['begin', 'begin()', 'container - iterator to first element'],
    ['end', 'end()', 'container - iterator past last element'],
    ['insert', 'insert($1)', 'map/set - insert an element'],
    ['erase', 'erase($1)', 'container - remove an element'],
    ['find', 'find($1)', 'map/set - find element by key'],
    ['at', 'at($1)', 'vector/map - bounds-checked element access'],
    // string
    ['substr', 'substr($1, $2)', 'string - extract substring'],
    ['length', 'length()', 'string - length of the string'],
    ['c_str', 'c_str()', 'string - get null-terminated C string'],
    ['append', 'append($1)', 'string - append text'],
    ['to_string', 'std::to_string($1)', 'string - convert number to string'],
    ['stoi', 'std::stoi($1)', 'string - convert string to int'],
    ['stod', 'std::stod($1)', 'string - convert string to double'],
    // smart pointers / memory
    ['make_unique', 'std::make_unique<$1>($2)', 'memory - create a unique_ptr'],
    ['make_shared', 'std::make_shared<$1>($2)', 'memory - create a shared_ptr'],
    ['move', 'std::move($1)', 'utility - cast to rvalue reference'],
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

export function registerCppCompletions(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['.', ':', '>', ' ', '\n'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const allItems = [
        ...getCppKeywords(monaco),
        ...getCppSnippets(monaco),
        ...getCppLibraryFunctions(monaco),
      ].map(item => ({ ...item, range }));

      return { suggestions: allItems };
    }
  });
}
