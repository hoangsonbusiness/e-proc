import { useEffect, useRef } from 'react';
import type * as Monaco from 'monaco-editor';
import { getHtmlCompletions } from './htmlCompletions';
import { getCssCompletions } from './cssCompletions';
import { getJsCompletions } from './jsCompletions';

/**
 * Registers frontend (HTML / CSS / JavaScript) IntelliSense completions
 * with the Monaco Editor instance.
 *
 * Call this hook once per editor mount.  It safely disposes all providers
 * when the component unmounts or when `monacoInstance` changes.
 */
export function useFrontendCompletions(
  monacoInstance: typeof Monaco | null
): void {
  const disposablesRef = useRef<Monaco.IDisposable[]>([]);

  useEffect(() => {
    if (!monacoInstance) return;

    // Dispose previous registrations before re-registering
    disposablesRef.current.forEach((d) => d.dispose());
    disposablesRef.current = [];

    // ─── HTML ─────────────────────────────────────────────────────────────────
    const htmlProvider = monacoInstance.languages.registerCompletionItemProvider(
      'html',
      {
        triggerCharacters: ['<', ' ', '!', ':', '-', '.'],
        provideCompletionItems(_model, position) {
          const items = getHtmlCompletions(monacoInstance).map((item) => ({
            ...item,
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column,
              endColumn: position.column,
            },
          }));
          return { suggestions: items };
        },
      }
    );

    // ─── CSS ──────────────────────────────────────────────────────────────────
    const cssProvider = monacoInstance.languages.registerCompletionItemProvider(
      'css',
      {
        triggerCharacters: ['.', ':', '@', ' ', '-'],
        provideCompletionItems(_model, position) {
          const items = getCssCompletions(monacoInstance).map((item) => ({
            ...item,
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column,
              endColumn: position.column,
            },
          }));
          return { suggestions: items };
        },
      }
    );

    // ─── JavaScript ───────────────────────────────────────────────────────────
    const jsProvider = monacoInstance.languages.registerCompletionItemProvider(
      'javascript',
      {
        triggerCharacters: ['.', '(', ' ', "'", '"', '`'],
        provideCompletionItems(_model, position) {
          const items = getJsCompletions(monacoInstance).map((item) => ({
            ...item,
            range: {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: position.column,
              endColumn: position.column,
            },
          }));
          return { suggestions: items };
        },
      }
    );

    disposablesRef.current = [htmlProvider, cssProvider, jsProvider];

    return () => {
      disposablesRef.current.forEach((d) => d.dispose());
      disposablesRef.current = [];
    };
  }, [monacoInstance]);
}
