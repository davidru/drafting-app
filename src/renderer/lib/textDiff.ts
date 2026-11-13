import { diffLines } from 'diff';

/**
 * A replacement of whole lines in the old text: lines [fromLine, toLine) are
 * replaced by `text`. Line numbers are 1-based; `toLine` is exclusive, so an
 * insertion has fromLine === toLine.
 */
export interface LineRangeEdit {
  fromLine: number;
  toLine: number;
  text: string;
}

export interface TextDiffResult {
  edits: LineRangeEdit[];
  /** First line (1-based, in the NEW text) that differs, or null when identical. */
  firstChangedLine: number | null;
}

/**
 * Compute the minimal set of line-range edits that turn `oldText` into
 * `newText`. Applying these through Monaco's pushEditOperations, instead of
 * replacing the whole document, keeps the cursor and scroll position where they
 * were unless the change lands on top of them, and keeps the undo stack small.
 */
export function computeLineEdits(oldText: string, newText: string): TextDiffResult {
  if (oldText === newText) return { edits: [], firstChangedLine: null };

  const parts = diffLines(oldText, newText);
  const edits: LineRangeEdit[] = [];
  let oldLine = 1;
  let newLine = 1;
  let firstChangedLine: number | null = null;

  let removedLines = 0;
  let addedText = '';
  let blockStart = 1;
  let inBlock = false;

  const flush = () => {
    if (!inBlock) return;
    edits.push({ fromLine: blockStart, toLine: blockStart + removedLines, text: addedText });
    inBlock = false;
    removedLines = 0;
    addedText = '';
  };

  for (const part of parts) {
    const count = part.count ?? countLines(part.value);
    if (part.added) {
      if (!inBlock) { inBlock = true; blockStart = oldLine; }
      if (firstChangedLine === null) firstChangedLine = newLine;
      addedText += part.value;
      newLine += count;
    } else if (part.removed) {
      if (!inBlock) { inBlock = true; blockStart = oldLine; }
      if (firstChangedLine === null) firstChangedLine = newLine;
      removedLines += count;
      oldLine += count;
    } else {
      flush();
      oldLine += count;
      newLine += count;
    }
  }
  flush();

  return { edits, firstChangedLine };
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) n++;
  if (value.charCodeAt(value.length - 1) !== 10) n++;
  return n;
}

/** Apply line-range edits to a string. Used by tests to prove the edits are correct. */
export function applyLineEdits(oldText: string, edits: LineRangeEdit[]): string {
  const lines = splitKeepingNewlines(oldText);
  // Apply from the bottom up so earlier line numbers stay valid.
  const sorted = [...edits].sort((a, b) => b.fromLine - a.fromLine);
  for (const e of sorted) {
    lines.splice(e.fromLine - 1, e.toLine - e.fromLine, e.text);
  }
  return lines.join('');
}

function splitKeepingNewlines(text: string): string[] {
  if (text === '') return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Rough word count for the status bar: runs of letters/digits, apostrophes allowed. */
export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}](?:[\p{L}\p{N}'’-]|\.(?=\p{N}))*/gu);
  return m ? m.length : 0;
}
