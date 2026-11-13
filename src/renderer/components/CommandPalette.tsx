import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, IconName } from './Icons';
import { baseName, dirName, isProse, relativeTo } from '../lib/paths';

export interface Command {
  id: string;
  label: string;
  icon?: IconName;
  shortcut?: string;
  /** Hidden from the palette when false. */
  enabled?: boolean;
  run: () => void;
}

export interface FileChoice {
  path: string;
}

interface CommandPaletteProps {
  mode: 'commands' | 'files';
  commands: Command[];
  files: FileChoice[];
  rootPath: string | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

interface Scored<T> { item: T; score: number; positions: number[] }

/** Subsequence match with a preference for word starts and contiguity. */
function fuzzy(query: string, text: string): { score: number; positions: number[] } | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let ti = 0;
  let score = 0;
  let last = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = t.indexOf(q[qi], ti);
    if (idx < 0) return null;
    positions.push(idx);
    score += idx === last + 1 ? 3 : 1;
    if (idx === 0 || /[\s\-_./\\]/.test(t[idx - 1])) score += 2;
    last = idx;
    ti = idx + 1;
  }
  score -= (t.length - q.length) * 0.02;
  return { score, positions };
}

function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  return <>{Array.from(text).map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>;
}

const CommandPalette: React.FC<CommandPaletteProps> = ({ mode, commands, files, rootPath, onClose, onOpenFile }) => {
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    // Escape closes even if focus wandered (a menu command, the terminal).
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onDocKey, true);
    return () => { cancelAnimationFrame(id); document.removeEventListener('keydown', onDocKey, true); };
  }, [onClose]);

  const results = useMemo(() => {
    if (mode === 'commands') {
      const out: Scored<Command>[] = [];
      for (const c of commands) {
        if (c.enabled === false) continue;
        const m = fuzzy(query, c.label);
        if (m) out.push({ item: c, score: m.score, positions: m.positions });
      }
      out.sort((a, b) => b.score - a.score);
      return out;
    }
    const out: Scored<FileChoice>[] = [];
    for (const f of files) {
      const name = baseName(f.path);
      const m = fuzzy(query, name) ?? (query.length > 2 ? fuzzy(query, relativeTo(rootPath, f.path)) : null);
      if (m) out.push({ item: f, score: m.score + (isProse(f.path) ? 0.5 : 0), positions: m.positions });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 60);
  }, [mode, commands, files, query, rootPath]);

  useEffect(() => { setFocus(0); }, [query, mode]);

  useEffect(() => {
    const el = listRef.current?.children[focus] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  const choose = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    if (mode === 'commands') (r.item as Command).run();
    else onOpenFile((r.item as FileChoice).path);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus((f) => Math.min(results.length - 1, f + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus((f) => Math.max(0, f - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(focus); }
    else if (e.key === 'PageDown') { e.preventDefault(); setFocus((f) => Math.min(results.length - 1, f + 8)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setFocus((f) => Math.max(0, f - 8)); }
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-label={mode === 'commands' ? 'Command palette' : 'Quick open'}>
        <div className="palette-input">
          <Icon name={mode === 'commands' ? 'command' : 'search'} size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === 'commands' ? 'Type a command…' : 'Type a file name…'}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">{mode === 'files' && files.length === 0 ? 'Open a folder first.' : 'No matches.'}</div>}
          {results.map((r, i) => {
            if (mode === 'commands') {
              const c = r.item as Command;
              return (
                <button key={c.id} className={`palette-item${i === focus ? ' is-focused' : ''}`} role="option" aria-selected={i === focus} onMouseEnter={() => setFocus(i)} onClick={() => choose(i)}>
                  <span className="ico">{c.icon && <Icon name={c.icon} size={15} />}</span>
                  <span className="label"><Highlight text={c.label} positions={r.positions} /></span>
                  {c.shortcut && <span className="kbd">{c.shortcut}</span>}
                </button>
              );
            }
            const f = r.item as FileChoice;
            const name = baseName(f.path);
            const dir = relativeTo(rootPath, dirName(f.path));
            return (
              <button key={f.path} className={`palette-item${i === focus ? ' is-focused' : ''}`} role="option" aria-selected={i === focus} onMouseEnter={() => setFocus(i)} onClick={() => choose(i)} title={f.path}>
                <span className="ico"><Icon name={isProse(f.path) ? 'file-text' : 'file'} size={15} /></span>
                <span className="label">
                  <Highlight text={name} positions={r.positions.filter((p) => p < name.length)} />
                  {dir && dir !== f.path && <span className="path">{dir}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">Enter</span> {mode === 'commands' ? 'run' : 'open'}</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
