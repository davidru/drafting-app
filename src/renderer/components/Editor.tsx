import React, { useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { monaco, themeName } from './monacoSetup';
import { AppSettings, ExternalChangeCursor } from '../../shared/types';
import { ReloadRequest } from '../hooks/useFileSystem';
import { computeLineEdits, countWords } from '../lib/textDiff';
import { languageFor } from '../lib/paths';

export interface EditorStats {
  words: number;
  line: number;
  column: number;
  selectionLines: number;
}

export interface SelectionInfo {
  text: string;
  startLine: number;
  endLine: number;
}

export interface EditorHandle {
  focus: () => void;
  hasFocus: () => boolean;
  find: () => void;
  replace: () => void;
  wrapSelection: (prefix: string, suffix: string, placeholder?: string) => void;
  toggleLinePrefix: (prefix: string) => void;
  insertBlock: (before: string, after: string, placeholder?: string) => void;
  insertText: (text: string) => void;
  getSelection: () => SelectionInfo | null;
  undo: () => void;
}

interface EditorProps {
  ref?: React.Ref<EditorHandle>;
  filePath: string | null;
  openPaths: string[];
  visible: boolean;
  theme: 'dark' | 'light';
  settings: AppSettings['editor'];
  cursorPolicy: ExternalChangeCursor;
  reloads: Map<string, ReloadRequest>;
  getContent: (path: string) => string | undefined;
  isUnsupported: (path: string) => boolean;
  onChange: (path: string, content: string) => void;
  onStats: (stats: EditorStats) => void;
}

interface ModelEntry {
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
  appliedReload: number;
}

/**
 * One Monaco instance, one model per open file. Models are created from the
 * store on first attach, reconciled against it on every attach (so edits made
 * in Preview are never lost), disposed when their tab closes, and updated with
 * minimal line edits when the file changes on disk.
 */
const Editor: React.FC<EditorProps> = ({
  ref, filePath, openPaths, visible, theme, settings, cursorPolicy, reloads, getContent, isUnsupported, onChange, onStats,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef<Map<string, ModelEntry>>(new Map());
  const applyingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onStatsRef = useRef(onStats);
  const statsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentPathRef = useRef<string | null>(null);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onStatsRef.current = onStats; }, [onStats]);

  const emitStats = useCallback(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) { onStatsRef.current({ words: 0, line: 1, column: 1, selectionLines: 0 }); return; }
    const pos = editor.getPosition();
    const sel = editor.getSelection();
    onStatsRef.current({
      words: countWords(model.getValue()),
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
      selectionLines: sel && !sel.isEmpty() ? sel.endLineNumber - sel.startLineNumber + 1 : 0,
    });
  }, []);

  const scheduleStats = useCallback(() => {
    if (statsTimerRef.current) clearTimeout(statsTimerRef.current);
    statsTimerRef.current = setTimeout(emitStats, 200);
  }, [emitStats]);

  // ---- formatting helpers ----

  const wrapSelection = useCallback((prefix: string, suffix: string, placeholder?: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const sel = editor.getSelection();
    if (!sel) return;
    const selected = model.getValueInRange(sel);
    // Toggle off if already wrapped.
    if (selected.startsWith(prefix) && selected.endsWith(suffix) && selected.length >= prefix.length + suffix.length) {
      const inner = selected.slice(prefix.length, selected.length - suffix.length);
      editor.executeEdits('format', [{ range: sel, text: inner, forceMoveMarkers: true }]);
      editor.focus();
      return;
    }
    const text = selected || (placeholder ?? '');
    editor.executeEdits('format', [{ range: sel, text: `${prefix}${text}${suffix}`, forceMoveMarkers: true }]);
    if (!selected) {
      const start = sel.getStartPosition();
      const from = start.delta(0, prefix.length);
      const to = from.delta(0, text.length);
      editor.setSelection(new monaco.Selection(from.lineNumber, from.column, to.lineNumber, to.column));
    }
    editor.focus();
  }, []);

  const toggleLinePrefix = useCallback((prefix: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const sel = editor.getSelection();
    if (!sel) return;
    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = [];
    const headingLike = /^#{1,6}\s/;
    for (let line = sel.startLineNumber; line <= sel.endLineNumber; line++) {
      const content = model.getLineContent(line);
      if (content.startsWith(prefix)) {
        edits.push({ range: new monaco.Range(line, 1, line, prefix.length + 1), text: '' });
      } else if (headingLike.test(prefix) && headingLike.test(content)) {
        // Swap one heading level for another.
        const m = content.match(headingLike)!;
        edits.push({ range: new monaco.Range(line, 1, line, m[0].length + 1), text: prefix });
      } else {
        edits.push({ range: new monaco.Range(line, 1, line, 1), text: prefix });
      }
    }
    editor.executeEdits('format', edits);
    editor.focus();
  }, []);

  const insertBlock = useCallback((before: string, after: string, placeholder?: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const sel = editor.getSelection();
    if (!sel) return;
    const selected = model.getValueInRange(sel);
    const text = selected || (placeholder ?? '');
    editor.executeEdits('format', [{ range: sel, text: `${before}\n${text}\n${after}`, forceMoveMarkers: true }]);
    editor.focus();
  }, []);

  const insertText = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor || editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    const sel = editor.getSelection();
    if (!sel) return;
    editor.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }]);
    editor.focus();
  }, []);

  /** Apply `text` to a model with minimal edits; returns the first changed line. */
  const reconcileModel = useCallback((entry: ModelEntry, text: string, policy: ExternalChangeCursor, firstChangedHint: number | null): void => {
    const model = entry.model;
    const current = model.getValue();
    if (current === text) return;
    const { edits, firstChangedLine } = computeLineEdits(current, text);
    const lineCount = model.getLineCount();
    const toPos = (line: number): monaco.IPosition =>
      line <= lineCount ? { lineNumber: line, column: 1 } : { lineNumber: lineCount, column: model.getLineMaxColumn(lineCount) };
    const ops: monaco.editor.IIdentifiedSingleEditOperation[] = edits.map((e) => {
      const s = toPos(e.fromLine);
      const en = toPos(e.toLine);
      return { range: new monaco.Range(s.lineNumber, s.column, en.lineNumber, en.column), text: e.text, forceMoveMarkers: false };
    });
    applyingRef.current = true;
    try {
      model.pushEditOperations(null, ops, () => null);
      if (model.getValue() !== text) {
        // Defensive: if the line mapping ever disagrees, fall back to a whole replace.
        model.pushEditOperations(null, [{ range: model.getFullModelRange(), text }], () => null);
      }
    } finally {
      applyingRef.current = false;
    }

    const editor = editorRef.current;
    if (editor && editor.getModel() === model) {
      const target = firstChangedHint ?? firstChangedLine;
      if (policy === 'first-change' && target) {
        editor.setPosition({ lineNumber: Math.min(target, model.getLineCount()), column: 1 });
        editor.revealLineInCenterIfOutsideViewport(Math.min(target, model.getLineCount()));
      } else if (policy === 'end') {
        const last = model.getLineCount();
        editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
        editor.revealLine(last);
      }
      // 'keep': Monaco has already mapped the cursor through the edits.
      scheduleStats();
    }
  }, [scheduleStats]);

  const getOrCreateModel = useCallback((path: string): ModelEntry => {
    let entry = modelsRef.current.get(path);
    if (entry) return entry;
    const content = getContent(path) ?? '';
    const model = monaco.editor.createModel(content, languageFor(path));
    entry = { model, viewState: null, appliedReload: reloads.get(path)?.version ?? 0 };
    modelsRef.current.set(path, entry);
    return entry;
  }, [getContent, reloads]);

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      theme: themeName(theme),
      automaticLayout: true,
      minimap: { enabled: false },
      wordWrap: settings.wrapColumn > 0 ? 'wordWrapColumn' : 'on',
      wordWrapColumn: settings.wrapColumn > 0 ? settings.wrapColumn : 80,
      wrappingIndent: 'same',
      lineNumbers: settings.showLineNumbers ? 'on' : 'off',
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: Math.round(settings.fontSize * 1.65),
      padding: { top: 18, bottom: 40 },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      tabSize: 2,
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      renderWhitespace: 'none',
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 12,
      lineNumbersMinChars: 3,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: false },
      links: true,
      contextmenu: true,
      dragAndDrop: true,
      accessibilitySupport: 'auto',
    });
    editorRef.current = editor;

    editor.onDidChangeModelContent(() => {
      if (applyingRef.current) return;
      const model = editor.getModel();
      const path = currentPathRef.current;
      if (!model || !path) return;
      onChangeRef.current(path, model.getValue());
      scheduleStats();
    });
    editor.onDidChangeCursorPosition(scheduleStats);
    editor.onDidChangeCursorSelection(scheduleStats);

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => wrapSelection('**', '**', 'bold text'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => wrapSelection('*', '*', 'italic text'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => wrapSelection('[', '](url)', 'link text'));

    return () => {
      editor.dispose();
      editorRef.current = null;
      for (const e of modelsRef.current.values()) e.model.dispose();
      modelsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Options that can change at runtime.
  useEffect(() => {
    editorRef.current?.updateOptions({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: Math.round(settings.fontSize * 1.65),
      wordWrap: settings.wrapColumn > 0 ? 'wordWrapColumn' : 'on',
      wordWrapColumn: settings.wrapColumn > 0 ? settings.wrapColumn : 80,
      lineNumbers: settings.showLineNumbers ? 'on' : 'off',
    });
  }, [settings.fontFamily, settings.fontSize, settings.wrapColumn, settings.showLineNumbers]);

  useEffect(() => {
    monaco.editor.setTheme(themeName(theme));
  }, [theme]);

  // Dispose models whose tabs have closed.
  useEffect(() => {
    const open = new Set(openPaths);
    for (const [path, entry] of Array.from(modelsRef.current.entries())) {
      if (!open.has(path)) {
        if (editorRef.current?.getModel() === entry.model) editorRef.current.setModel(null);
        entry.model.dispose();
        modelsRef.current.delete(path);
      }
    }
  }, [openPaths]);

  // Attach the right model when the file or visibility changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    // Save the outgoing model's view state.
    const prev = editor.getModel();
    if (prev) {
      for (const entry of modelsRef.current.values()) {
        if (entry.model === prev) { entry.viewState = editor.saveViewState(); break; }
      }
    }

    if (!filePath || !visible) {
      currentPathRef.current = null;
      editor.setModel(null);
      emitStats();
      return;
    }

    const entry = getOrCreateModel(filePath);
    // Reconcile: the store is the truth (Preview may have edited it meanwhile).
    const stored = getContent(filePath);
    if (stored !== undefined && entry.model.getValue() !== stored) {
      reconcileModel(entry, stored, 'keep', null);
    }
    currentPathRef.current = filePath;
    editor.setModel(entry.model);
    editor.updateOptions({ readOnly: isUnsupported(filePath) });
    if (entry.viewState) editor.restoreViewState(entry.viewState);
    editor.focus();
    emitStats();
  }, [filePath, visible, getOrCreateModel, getContent, isUnsupported, reconcileModel, emitStats]);

  // Apply external reloads (disk changes, restores, review decisions) to any open model.
  useEffect(() => {
    for (const [path, req] of reloads) {
      const entry = modelsRef.current.get(path);
      if (!entry || entry.appliedReload >= req.version) continue;
      entry.appliedReload = req.version;
      const text = getContent(path);
      if (text === undefined) continue;
      reconcileModel(entry, text, cursorPolicy, req.firstChangedLine);
    }
  }, [reloads, getContent, cursorPolicy, reconcileModel]);

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    hasFocus: () => editorRef.current?.hasTextFocus() ?? false,
    find: () => { editorRef.current?.focus(); editorRef.current?.getAction('actions.find')?.run(); },
    replace: () => { editorRef.current?.focus(); editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run(); },
    wrapSelection,
    toggleLinePrefix,
    insertBlock,
    insertText,
    undo: () => { editorRef.current?.focus(); editorRef.current?.trigger('app', 'undo', null); },
    getSelection: () => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const sel = editor?.getSelection();
      if (!editor || !model || !sel || sel.isEmpty()) return null;
      return { text: model.getValueInRange(sel), startLine: sel.startLineNumber, endLine: sel.endLineNumber };
    },
  }), [wrapSelection, toggleLinePrefix, insertBlock, insertText]);

  return <div ref={hostRef} className={`editor-host${visible && filePath ? '' : ' is-hidden'}`} />;
};

export default Editor;
