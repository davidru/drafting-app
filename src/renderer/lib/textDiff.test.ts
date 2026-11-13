import { describe, it, expect } from 'vitest';
import { computeLineEdits, applyLineEdits, countWords } from './textDiff';

function roundTrip(a: string, b: string) {
  const { edits } = computeLineEdits(a, b);
  expect(applyLineEdits(a, edits)).toBe(b);
  return edits;
}

describe('computeLineEdits', () => {
  it('returns no edits for identical text', () => {
    expect(computeLineEdits('a\nb\n', 'a\nb\n')).toEqual({ edits: [], firstChangedLine: null });
  });

  it('replaces a single changed line in the middle', () => {
    const edits = roundTrip('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
    expect(edits).toEqual([{ fromLine: 2, toLine: 3, text: 'TWO\n' }]);
  });

  it('inserts at the end', () => {
    const edits = roundTrip('one\ntwo\n', 'one\ntwo\nthree\n');
    expect(edits).toEqual([{ fromLine: 3, toLine: 3, text: 'three\n' }]);
  });

  it('inserts at the start without touching later lines', () => {
    const edits = roundTrip('b\nc\n', 'a\nb\nc\n');
    expect(edits).toEqual([{ fromLine: 1, toLine: 1, text: 'a\n' }]);
  });

  it('deletes lines', () => {
    const edits = roundTrip('a\nb\nc\nd\n', 'a\nd\n');
    expect(edits).toEqual([{ fromLine: 2, toLine: 4, text: '' }]);
  });

  it('handles a final line without a trailing newline', () => {
    roundTrip('a\nb', 'a\nb\nc');
    roundTrip('a\nb\n', 'a\nb');
    roundTrip('a', 'b');
  });

  it('handles multiple separate hunks and reports the first change', () => {
    const a = 'l1\nl2\nl3\nl4\nl5\nl6\n';
    const b = 'l1\nX\nl3\nl4\nY\nl6\nl7\n';
    const r = computeLineEdits(a, b);
    expect(applyLineEdits(a, r.edits)).toBe(b);
    expect(r.edits.length).toBe(3);
    expect(r.firstChangedLine).toBe(2);
  });

  it('handles empty documents', () => {
    roundTrip('', 'hello\n');
    roundTrip('hello\n', '');
  });

  it('survives a full rewrite of a long document', () => {
    const a = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const b = Array.from({ length: 180 }, (_, i) => `row ${i * 2}`).join('\n') + '\n';
    roundTrip(a, b);
  });
});

describe('countWords', () => {
  it('counts words in legal prose', () => {
    expect(countWords("The Buyer's obligations under clause 4.2 don't survive termination.")).toBe(9);
    expect(countWords('')).toBe(0);
    expect(countWords('# Heading\n\n- item one\n- item two')).toBe(5);
  });
});
