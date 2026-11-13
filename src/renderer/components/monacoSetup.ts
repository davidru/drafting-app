import 'monaco-editor/esm/vs/editor/editor.all';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
import 'monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution';
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
import 'monaco-editor/esm/vs/basic-languages/bat/bat.contribution';

// No MonacoEnvironment worker factory on purpose. Monaco then logs one warning
// and runs its editor worker (which computes diffs) on the main thread. A
// no-op stub worker, as this app once had, silently breaks the diff editor:
// the diff request goes to a worker that never answers, so nothing is
// highlighted. Documents here are small; main-thread diffing is instant.

// JSON has a language contribution in the full build; register a minimal one so
// .json files at least get a language id (highlighting comes from the tokenizer).
if (!monaco.languages.getLanguages().some((l) => l.id === 'json')) {
  monaco.languages.register({ id: 'json', extensions: ['.json'] });
}

let themesDefined = false;
export function ensureThemes(): void {
  if (themesDefined) return;
  themesDefined = true;

  monaco.editor.defineTheme('drafting-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword.md', foreground: '7f97ff', fontStyle: 'bold' },
      { token: 'string.link.md', foreground: '62b4ff' },
      { token: 'variable.md', foreground: 'c3c7d1' },
      { token: 'variable.source.md', foreground: 'e8c98a' },
      { token: 'string.md', foreground: 'c3c7d1' },
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'comment.md', foreground: '5f6575' },
    ],
    colors: {
      'editor.background': '#15171c',
      'editor.foreground': '#dfe2ea',
      'editorLineNumber.foreground': '#454b58',
      'editorLineNumber.activeForeground': '#8d93a3',
      'editor.lineHighlightBackground': '#1b1e25',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#7f97ff45',
      'editor.inactiveSelectionBackground': '#7f97ff22',
      'editorCursor.foreground': '#7f97ff',
      'editorIndentGuide.background1': '#22262e',
      'editorWhitespace.foreground': '#2a2f39',
      'editorWidget.background': '#272c35',
      'editorWidget.border': '#3a404c',
      'input.background': '#1f232a',
      'input.border': '#3a404c',
      'focusBorder': '#7f97ff',
      'scrollbarSlider.background': '#ffffff1a',
      'scrollbarSlider.hoverBackground': '#ffffff2e',
      'scrollbarSlider.activeBackground': '#ffffff3a',
      'diffEditor.insertedTextBackground': '#4fcf8a55',
      'diffEditor.removedTextBackground': '#ff6b7a55',
      'diffEditor.insertedLineBackground': '#4fcf8a1e',
      'diffEditor.removedLineBackground': '#ff6b7a1e',
      'diffEditorGutter.insertedLineBackground': '#4fcf8a40',
      'diffEditorGutter.removedLineBackground': '#ff6b7a40',
      'diffEditorOverview.insertedForeground': '#4fcf8a',
      'diffEditorOverview.removedForeground': '#ff6b7a',
    },
  });

  monaco.editor.defineTheme('drafting-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword.md', foreground: '4761d8', fontStyle: 'bold' },
      { token: 'string.link.md', foreground: '2f7fd0' },
      { token: 'variable.md', foreground: '3b4050' },
      { token: 'variable.source.md', foreground: '8a5a12' },
      { token: 'string.md', foreground: '3b4050' },
      { token: 'emphasis', fontStyle: 'italic' },
      { token: 'strong', fontStyle: 'bold' },
      { token: 'comment.md', foreground: '9aa0b0' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2330',
      'editorLineNumber.foreground': '#b8bcc8',
      'editorLineNumber.activeForeground': '#6b7185',
      'editor.lineHighlightBackground': '#f4f5f8',
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': '#4761d838',
      'editor.inactiveSelectionBackground': '#4761d81a',
      'editorCursor.foreground': '#4761d8',
      'editorIndentGuide.background1': '#eceef3',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#d9dce6',
      'input.background': '#f4f5f8',
      'input.border': '#d9dce6',
      'focusBorder': '#4761d8',
      'diffEditor.insertedTextBackground': '#1f9d5b4d',
      'diffEditor.removedTextBackground': '#d63d4c40',
      'diffEditor.insertedLineBackground': '#1f9d5b1a',
      'diffEditor.removedLineBackground': '#d63d4c14',
      'diffEditorGutter.insertedLineBackground': '#1f9d5b40',
      'diffEditorGutter.removedLineBackground': '#d63d4c33',
      'diffEditorOverview.insertedForeground': '#1f9d5b',
      'diffEditorOverview.removedForeground': '#d63d4c',
    },
  });
}

export function themeName(theme: 'dark' | 'light'): string {
  ensureThemes();
  return theme === 'dark' ? 'drafting-dark' : 'drafting-light';
}

export { monaco };
