import React, { useCallback, useEffect, useRef, useState } from 'react';
import { monaco, themeName } from './monacoSetup';
import { Icon } from './Icons';
import { IconButton } from './ui';
import { baseName, languageFor } from '../lib/paths';
import { PendingChange } from '../hooks/useFileSystem';

export interface DiffLabels {
  title?: string;
  sub?: string;
  left?: string;
  right?: string;
  keep?: string;
  apply?: string;
}

interface DiffReviewProps {
  change: PendingChange;
  theme: 'dark' | 'light';
  fontFamily: string;
  fontSize: number;
  labels?: DiffLabels;
  /** The text in the right-hand (editable) pane wins. */
  onApply: (text: string) => void;
  /** Put the left-hand text back (applied: undo Claude; conflict: keep mine). */
  onKeepLeft: () => void;
  onClose: () => void;
}

type LineChange = monaco.editor.ILineChange;

/**
 * Side-by-side review of a change that arrived from disk. The right side is
 * editable. A change bar walks through the differences one at a time so each
 * can be kept or undone individually before applying the result. Everything
 * applied here goes through the normal reload path, so Ctrl+Z in the editor
 * still undoes it afterward.
 */
const DiffReview: React.FC<DiffReviewProps> = ({ change, theme, fontFamily, fontSize, labels, onApply, onKeepLeft, onClose }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  const [changes, setChanges] = useState<LineChange[]>([]);
  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const lang = languageFor(change.path);
    const original = monaco.editor.createModel(change.before, lang);
    const modified = monaco.editor.createModel(change.after, lang);
    modelsRef.current = { original, modified };

    const diff = monaco.editor.createDiffEditor(host, {
      theme: themeName(theme),
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: false,
      renderMarginRevertIcon: true,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
      wordWrap: 'on',
      fontFamily,
      fontSize,
      lineHeight: Math.round(fontSize * 1.6),
      scrollBeyondLastLine: false,
      folding: false,
      lineNumbersMinChars: 3,
      renderLineHighlight: 'none',
      diffWordWrap: 'on',
      useInlineViewWhenSpaceIsLimited: false,
      padding: { top: 12, bottom: 24 },
    });
    diff.setModel({ original, modified });
    diffRef.current = diff;

    let first = true;
    const sub = diff.onDidUpdateDiff(() => {
      const list = diff.getLineChanges() ?? [];
      setChanges(list);
      setReady(true);
      if (first && list.length) {
        first = false;
        diff.revealLineInCenter(list[0].modifiedStartLineNumber || list[0].originalStartLineNumber || 1);
      }
    });

    return () => {
      sub.dispose();
      diff.dispose();
      original.dispose();
      modified.dispose();
      diffRef.current = null;
      modelsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change.path, change.at]);

  useEffect(() => { monaco.editor.setTheme(themeName(theme)); }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep the index valid as changes are undone.
  useEffect(() => {
    setIndex((i) => Math.max(0, Math.min(i, changes.length - 1)));
  }, [changes.length]);

  const goTo = useCallback((i: number) => {
    const c = changes[i];
    if (!c) return;
    setIndex(i);
    diffRef.current?.revealLineInCenter(c.modifiedStartLineNumber || c.originalStartLineNumber || 1);
  }, [changes]);

  /** Put the original text back for one change in the modified (right) pane. */
  const undoChange = useCallback((c: LineChange) => {
    const m = modelsRef.current;
    if (!m) return;
    const { original, modified } = m;
    const originalText = c.originalEndLineNumber > 0
      ? original.getValueInRange(new monaco.Range(c.originalStartLineNumber, 1, c.originalEndLineNumber, original.getLineMaxColumn(c.originalEndLineNumber)))
      : '';

    let range: monaco.Range;
    let text = originalText;
    if (c.modifiedEndLineNumber > 0) {
      // Lines exist on the modified side: replace them.
      if (c.originalEndLineNumber > 0) {
        range = new monaco.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber, modified.getLineMaxColumn(c.modifiedEndLineNumber));
      } else {
        // Pure insertion on the modified side: remove the lines including a line break.
        const last = modified.getLineCount();
        if (c.modifiedEndLineNumber < last) {
          range = new monaco.Range(c.modifiedStartLineNumber, 1, c.modifiedEndLineNumber + 1, 1);
        } else if (c.modifiedStartLineNumber > 1) {
          range = new monaco.Range(c.modifiedStartLineNumber - 1, modified.getLineMaxColumn(c.modifiedStartLineNumber - 1), c.modifiedEndLineNumber, modified.getLineMaxColumn(c.modifiedEndLineNumber));
        } else {
          range = modified.getFullModelRange();
        }
        text = '';
      }
    } else {
      // Pure deletion on the modified side: insert the original lines back after modifiedStartLineNumber.
      const after = c.modifiedStartLineNumber;
      if (after === 0) {
        range = new monaco.Range(1, 1, 1, 1);
        text = originalText + '\n';
      } else {
        const col = modified.getLineMaxColumn(after);
        range = new monaco.Range(after, col, after, col);
        text = '\n' + originalText;
      }
    }
    modified.pushEditOperations([], [{ range, text }], () => null);
  }, []);

  const isConflict = change.kind === 'conflict';
  const name = baseName(change.path);
  const L: Required<DiffLabels> = {
    title: labels?.title ?? (isConflict ? `${name} changed on disk while you were editing` : `${name} was changed on disk`),
    sub: labels?.sub ?? (isConflict ? 'Nothing has been applied yet.' : 'Already in the editor. Undo any part below, then apply.'),
    left: labels?.left ?? (isConflict ? 'Your unsaved text' : 'Before'),
    right: labels?.right ?? 'Now on disk (editable)',
    keep: labels?.keep ?? (isConflict ? 'Keep my version' : 'Revert all'),
    apply: labels?.apply ?? (isConflict ? 'Use this version' : 'Apply'),
  };
  const current = changes[index];
  const describe = (c: LineChange): string => {
    const o = c.originalEndLineNumber > 0 ? c.originalEndLineNumber - c.originalStartLineNumber + 1 : 0;
    const mcount = c.modifiedEndLineNumber > 0 ? c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1 : 0;
    if (o === 0) return `${mcount} line${mcount === 1 ? '' : 's'} added at line ${c.modifiedStartLineNumber}`;
    if (mcount === 0) return `${o} line${o === 1 ? '' : 's'} removed after line ${c.modifiedStartLineNumber}`;
    return `line${mcount === 1 ? '' : 's'} ${c.modifiedStartLineNumber}${mcount > 1 ? `–${c.modifiedEndLineNumber}` : ''} changed`;
  };

  return (
    <div className="review" role="dialog" aria-label={`Review changes to ${name}`}>
      <div className="review-head">
        <Icon name="diff" size={16} />
        <span className="title">{L.title}</span>
        <span className="sub">{L.sub}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={onKeepLeft}>
          <Icon name="undo" size={14} />{L.keep}
        </button>
        <button className="btn primary" onClick={() => onApply(modelsRef.current?.modified.getValue() ?? change.after)}>
          <Icon name="check" size={14} />{L.apply}
        </button>
        <IconButton icon="x" title="Close  Esc" onClick={onClose} />
      </div>
      <div className="review-nav">
        {!ready ? (
          <span className="muted">Comparing…</span>
        ) : changes.length === 0 ? (
          <span className="muted">No differences remain. Apply to keep the text on the right.</span>
        ) : (
          <>
            <IconButton icon="chevron-down" title="Previous change" small className="up" disabled={index === 0} onClick={() => goTo(index - 1)} />
            <span className="count">{index + 1} of {changes.length}</span>
            <IconButton icon="chevron-down" title="Next change" small disabled={index >= changes.length - 1} onClick={() => goTo(index + 1)} />
            <span className="desc">{current ? describe(current) : ''}</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => { if (current) undoChange(current); }} title="Put the original text back for this change">
              <Icon name="undo" size={13} />Undo this change
            </button>
            <button className="btn sm soft" onClick={() => goTo(Math.min(index + 1, changes.length - 1))} title="Keep this change and move to the next">
              <Icon name="check" size={13} />Keep
            </button>
          </>
        )}
      </div>
      <div className="review-labels">
        <div>{L.left}</div>
        <div>{L.right}</div>
      </div>
      <div ref={hostRef} className="review-host" />
    </div>
  );
};

export default DiffReview;
