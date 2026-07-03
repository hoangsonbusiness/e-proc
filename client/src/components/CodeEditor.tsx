import {
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useState,
} from 'react';
import Editor, { OnMount, BeforeMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { registerJavaCompletions } from '../hooks/useMonacoJavaCompletions';
import { registerCobolLanguage } from '../hooks/useMonacoCobolLanguage';

// ─── Language options displayed in the selector dropdown ──────────────────

export const LANGUAGE_OPTIONS: { value: SupportedLanguage; label: string }[] = [
  { value: 'java',      label: 'Java' },
  { value: 'c',         label: 'C' },
  { value: 'cpp',       label: 'C++' },
  { value: 'csharp',    label: 'C#' },
  { value: 'python',    label: 'Python' },
  { value: 'cobol',     label: 'COBOL' },
  { value: 'sql',       label: 'SQL' },
  { value: 'xml',       label: 'XML / Hibernate HBM' },
  { value: 'yaml',      label: 'YAML / Spring Config' },
  { value: 'json',      label: 'JSON' },
  { value: 'plaintext', label: 'Plain Text' },
];

export type SupportedLanguage = 'java' | 'c' | 'cpp' | 'csharp' | 'python' | 'cobol' | 'sql' | 'xml' | 'yaml' | 'json' | 'plaintext';

// ─── Auto-detect language from question metadata ───────────────────────────

export function detectLanguage(
  questionType?: string,
  questionModule?: string
): SupportedLanguage {
  const combined = `${questionType ?? ''} ${questionModule ?? ''}`.toLowerCase();

  if (/\bcobol\b/.test(combined)) return 'cobol';
  if (/\bsql\b/.test(combined)) return 'sql';
  if (/\bxml\b|hibernate.*mapping|hbm/.test(combined)) return 'xml';
  if (/\byaml\b|yml\b|spring.*config/.test(combined)) return 'yaml';
  if (/\bjson\b/.test(combined)) return 'json';
  if (/\bpython\b|\bpy\b|django|flask|pandas/.test(combined)) return 'python';
  if (/c#|csharp|\.net|dotnet|asp\.net/.test(combined)) return 'csharp';
  if (/\bjava\b|spring|hibernate|jpa/.test(combined)) return 'java';
  if (/c\+\+|cpp|embedded|mcu|isr|autosar/.test(combined)) return 'cpp';
  if (/\bc\b/.test(combined)) return 'c';

  return 'java'; // sensible default for Java exams
}

// ─── Handle exposed via ref ───────────────────────────────────────────────

export interface CodeEditorHandle {
  focus(): void;
}

// ─── Props ────────────────────────────────────────────────────────────────

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onCopyAttempt: () => void;
  onCutAttempt: () => void;
  onPasteAttempt: () => void;
  disabled?: boolean;
  defaultLanguage?: SupportedLanguage;
  height?: string;
}

// ─── Component ────────────────────────────────────────────────────────────

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  function CodeEditor(
    {
      value,
      onChange,
      onCopyAttempt,
      onCutAttempt,
      onPasteAttempt,
      disabled = false,
      defaultLanguage = 'java',
      height = '400px',
    },
    ref
  ) {
    const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
    const monacoRef = useRef<typeof Monaco | null>(null);
    const [language, setLanguage] = useState<SupportedLanguage>(defaultLanguage);

    // Expose focus() to parent
    useImperativeHandle(ref, () => ({
      focus() {
        editorRef.current?.focus();
      },
    }));

    // ── Before mount: configure Monaco globally ─────────────────────────
    const handleBeforeMount: BeforeMount = useCallback((monaco) => {
      monacoRef.current = monaco;
      // Register Java/Spring/Hibernate IntelliSense completions (once)
      registerJavaCompletions(monaco);
      // Monaco has no built-in COBOL support — register a minimal Monarch tokenizer
      registerCobolLanguage(monaco);
    }, []);

    // ── On mount: bind anti-cheat commands ────────────────────────────────
    //
    // IMPORTANT — Anti-cheat approach with Monaco:
    // Monaco intercepts keyboard events internally via its own keybinding system.
    // Standard React synthetic events (onCopy/onCut/onPaste on the div wrapper)
    // do NOT fire when the user copies inside the Monaco editor because Monaco
    // calls e.stopPropagation() before events bubble up to the DOM.
    //
    // Solution: Override Monaco's built-in copy/cut/paste commands via
    // editor.addCommand() and editor.addAction(). This hooks into Monaco's
    // keybinding layer BEFORE the clipboard action executes, allowing us to
    // prevent it and trigger our violation logic.
    //
    const handleEditorMount: OnMount = useCallback(
      (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;

        const { KeyMod, KeyCode } = monaco;

        // ── Override Ctrl+C (copy) ────────────────────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyC, () => {
          onCopyAttempt();
          // Do NOT call the original clipboard copy action
        });

        // ── Override Ctrl+X (cut) ─────────────────────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyX, () => {
          onCutAttempt();
        });

        // ── Override Ctrl+V (paste) ───────────────────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyV, () => {
          onPasteAttempt();
        });

        // ── Override Shift+Delete (cut shortcut) ──────────────────────────
        editor.addCommand(KeyMod.Shift | KeyCode.Delete, () => {
          onCutAttempt();
        });

        // ── Override Ctrl+Insert (copy shortcut) ──────────────────────────
        editor.addCommand(KeyMod.CtrlCmd | KeyCode.Insert, () => {
          onCopyAttempt();
        });

        // ── Override Shift+Insert (paste shortcut) ────────────────────────
        editor.addCommand(KeyMod.Shift | KeyCode.Insert, () => {
          onPasteAttempt();
        });

        // ── Override right-click context menu ────────────────────────────
        // Remove copy/cut/paste from Monaco's context menu
        // Monaco uses action IDs to register context menu items.
        // We override the three clipboard actions to no-ops so they
        // don't appear or don't work via context menu.
        editor.addAction({
          id: 'editor.action.clipboardCopyAction',
          label: 'Copy (disabled)',
          run() {
            onCopyAttempt();
          },
        });
        editor.addAction({
          id: 'editor.action.clipboardCutAction',
          label: 'Cut (disabled)',
          run() {
            onCutAttempt();
          },
        });
        editor.addAction({
          id: 'editor.action.clipboardPasteAction',
          label: 'Paste (disabled)',
          run() {
            onPasteAttempt();
          },
        });

        // ── Disable drag-and-drop (another paste vector) ──────────────────
        editor.onMouseDown((e) => {
          if (e.event.browserEvent.type === 'dragstart') {
            e.event.browserEvent.preventDefault();
          }
        });

        // Auto-focus
        editor.focus();
      },
      [onCopyAttempt, onCutAttempt, onPasteAttempt]
    );

    // ── Language change handler ────────────────────────────────────────────
    const handleLanguageChange = useCallback(
      (e: React.ChangeEvent<HTMLSelectElement>) => {
        setLanguage(e.target.value as SupportedLanguage);
      },
      []
    );

    // ── Sync language prop if parent changes it (question navigation) ──────
    // (defaultLanguage only used as initial value; language selector is
    //  controlled locally so student can override it)

    return (
      <div className="code-editor-wrapper">
        {/* ── Language selector bar ─────────────────────────────────────── */}
        <div className="code-editor-toolbar">
          <span className="code-editor-toolbar-label">Language:</span>
          <select
            value={language}
            onChange={handleLanguageChange}
            className="code-editor-lang-select"
            title="Select coding language for syntax highlighting"
          >
            {LANGUAGE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <span className="code-editor-hint">
            💡 Press <kbd>Ctrl</kbd>+<kbd>Space</kbd> to trigger suggestions
          </span>
        </div>

        {/* ── Monaco Editor ────────────────────────────────────────────── */}
        <div
          className="code-editor-container"
          // Intercept native drag-drop paste at DOM level as a safety net
          onDrop={(e) => {
            e.preventDefault();
            onPasteAttempt();
          }}
          onDragOver={(e) => e.preventDefault()}
        >
          <Editor
            height={height}
            language={language}
            theme="vs-dark"
            value={value}
            options={{
              fontSize: 16,
              lineHeight: 1.8,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace",
              fontLigatures: true,
              minimap: { enabled: false },
              wordWrap: 'on',
              // IntelliSense
              quickSuggestions: { other: true, comments: false, strings: true },
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnEnter: 'on',
              tabCompletion: 'on',
              parameterHints: { enabled: true },
              // Formatting
              tabSize: 4,
              insertSpaces: true,
              formatOnType: true,
              formatOnPaste: false, // security: we block paste anyway
              autoIndent: 'full',
              // UX
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              cursorSmoothCaretAnimation: 'on',
              renderLineHighlight: 'all',
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              // Disable built-in clipboard integration at editor config level
              // (commands are already overridden above, but this adds extra protection)
              emptySelectionClipboard: false,
              copyWithSyntaxHighlighting: false,
              // Accessibility
              accessibilitySupport: 'auto',
              // Disable drag-drop at editor level
              dragAndDrop: false,
              // Read-only when exam is locked
              readOnly: disabled,
              // Line numbers
              lineNumbers: 'on',
              glyphMargin: false,
              folding: true,
            }}
            beforeMount={handleBeforeMount}
            onMount={handleEditorMount}
            onChange={(val) => onChange(val ?? '')}
            loading={
              <div className="code-editor-loading">
                <span>Loading editor...</span>
              </div>
            }
          />
        </div>
      </div>
    );
  }
);

export default CodeEditor;
