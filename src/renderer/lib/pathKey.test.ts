import { describe, it, expect } from 'vitest';
import { findKey, pathKey } from './pathKey';

describe('findKey', () => {
  const keys = ['C:\\Users\\alice\\Documents\\Drafts\\Example Agreement.md'];

  it('matches the same file spelled with different case', () => {
    expect(findKey(keys, 'c:\\users\\alice\\Documents\\drafts\\example agreement.md')).toBe(keys[0]);
  });

  it('matches across separator styles', () => {
    expect(findKey(keys, 'C:/Users/alice/Documents/Drafts/Example Agreement.md')).toBe(keys[0]);
  });

  it('prefers an exact match', () => {
    const both = ['C:\\a\\B.md', 'C:\\a\\b.md'];
    expect(findKey(both, 'C:\\a\\b.md')).toBe('C:\\a\\b.md');
  });

  it('does not match a different file', () => {
    expect(findKey(keys, 'C:\\Users\\alice\\Documents\\Drafts\\other.md')).toBeUndefined();
  });

  it('ignores trailing separators', () => {
    expect(pathKey('C:\\a\\')).toBe(pathKey('C:\\A'));
  });
});
