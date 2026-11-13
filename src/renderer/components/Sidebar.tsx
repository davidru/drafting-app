import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileEntry } from '../../shared/types';
import { Icon } from './Icons';
import { ContextMenu, IconButton, MenuItem, MenuState } from './ui';
import { baseName, isProse } from '../lib/paths';

interface SidebarProps {
  rootPath: string | null;
  listings: Map<string, FileEntry[]>;
  activeFile: string | null;
  dirtyPaths: Set<string>;
  deletedPaths: Set<string>;
  changedPaths: Set<string>;
  width: number;
  onWidthChange: (w: number) => void;
  onCollapse: () => void;
  onQuickOpen: () => void;
  onOpen: (path: string) => void;
  onLoadDir: (dir: string) => Promise<unknown>;
  onRefresh: () => void;
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onNewFileDialog: () => void;
  onCreateFile: (dir: string, name: string) => Promise<unknown>;
  onCreateFolder: (dir: string, name: string) => Promise<unknown>;
  onRename: (path: string, newName: string) => Promise<unknown>;
  onTrash: (path: string) => Promise<unknown>;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onSendToClaude: (path: string) => void;
  onError: (message: string) => void;
}

interface Row {
  entry: FileEntry;
  depth: number;
  expanded: boolean;
  loaded: boolean;
}

type Editing =
  | { mode: 'rename'; path: string; dir: string; depth: number; initial: string }
  | { mode: 'new-file' | 'new-folder'; dir: string; depth: number; initial: string };

const Sidebar: React.FC<SidebarProps> = (props) => {
  const {
    rootPath, listings, activeFile, dirtyPaths, deletedPaths, changedPaths, width, onWidthChange, onCollapse, onQuickOpen,
    onOpen, onLoadDir, onRefresh, onOpenFolder, onOpenFile, onNewFileDialog, onCreateFile, onCreateFolder, onRename, onTrash,
    onReveal, onCopyPath, onSendToClaude, onError,
  } = props;

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Top-level folders start expanded, once, when a root's listing first arrives.
  const initializedRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootPath) { initializedRootRef.current = null; return; }
    if (initializedRootRef.current === rootPath) return;
    const top = listings.get(rootPath);
    if (!top) return;
    initializedRootRef.current = rootPath;
    setExpanded(new Set(top.filter((e) => e.isDirectory).map((e) => e.path)));
  }, [rootPath, listings]);

  const toggleDir = useCallback(async (dir: string) => {
    const isOpen = expanded.has(dir);
    setExpanded((prev) => { const n = new Set(prev); if (isOpen) n.delete(dir); else n.add(dir); return n; });
    if (!isOpen && !listings.has(dir)) {
      setLoading((prev) => new Set(prev).add(dir));
      try { await onLoadDir(dir); } catch { /* shown as empty */ }
      setLoading((prev) => { const n = new Set(prev); n.delete(dir); return n; });
    }
  }, [expanded, listings, onLoadDir]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!rootPath) return out;
    const walk = (dir: string, depth: number) => {
      const entries = listings.get(dir);
      if (!entries) return;
      for (const e of entries) {
        const isOpen = e.isDirectory && expanded.has(e.path);
        out.push({ entry: e, depth, expanded: isOpen, loaded: listings.has(e.path) });
        if (isOpen) walk(e.path, depth + 1);
      }
    };
    walk(rootPath, 0);
    return out;
  }, [rootPath, listings, expanded]);

  const scrollRowIntoView = (path: string) => {
    treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onTreeKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const idx = rows.findIndex((r) => r.entry.path === focused);
    const cur = idx >= 0 ? rows[idx] : null;
    const move = (to: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (r) { setFocused(r.entry.path); scrollRowIntoView(r.entry.path); }
    };
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(idx + 1); break;
      case 'ArrowUp': e.preventDefault(); move(idx - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (cur?.entry.isDirectory) { if (!cur.expanded) void toggleDir(cur.entry.path); else move(idx + 1); }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (cur?.entry.isDirectory && cur.expanded) void toggleDir(cur.entry.path);
        else if (cur) { for (let i = idx - 1; i >= 0; i--) if (rows[i].depth < cur.depth) { move(i); break; } }
        break;
      case 'Enter': case ' ':
        e.preventDefault();
        if (cur) { if (cur.entry.isDirectory) void toggleDir(cur.entry.path); else onOpen(cur.entry.path); }
        break;
      case 'F2': e.preventDefault(); if (cur) startRename(cur); break;
      case 'Delete': e.preventDefault(); if (cur) void confirmTrash(cur.entry.path); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(rows.length - 1); break;
    }
  };

  useEffect(() => { if (activeFile) setFocused(activeFile); }, [activeFile]);

  const startRename = (row: Row) => {
    setEditing({ mode: 'rename', path: row.entry.path, dir: parentOf(row.entry.path), depth: row.depth, initial: row.entry.name });
  };
  const startNew = (mode: 'new-file' | 'new-folder', dir: string, depth: number) => {
    if (!expanded.has(dir) && dir !== rootPath) void toggleDir(dir);
    setEditing({ mode, dir, depth, initial: '' });
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      if (editing.mode === 'rename') {
        const dot = editing.initial.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : editing.initial.length);
      }
    }
  }, [editing]);

  const commitEditing = async (value: string) => {
    const ed = editing;
    setEditing(null);
    if (!ed) return;
    const name = value.trim();
    if (!name) return;
    if (/[\\/:*?"<>|]/.test(name)) { onError('That name contains characters Windows does not allow: \\ / : * ? " < > |'); return; }
    try {
      if (ed.mode === 'rename') { if (name !== ed.initial) await onRename(ed.path, name); }
      else if (ed.mode === 'new-file') await onCreateFile(ed.dir, /\.[^.]+$/.test(name) ? name : `${name}.md`);
      else await onCreateFolder(ed.dir, name);
    } catch (err) {
      onError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(err));
    }
  };

  const confirmTrash = async (path: string) => {
    if (!window.confirm(`Move "${baseName(path)}" to the Recycle Bin?`)) return;
    try { await onTrash(path); } catch (err) { onError(err instanceof Error ? err.message : String(err)); }
  };

  const openMenu = (e: React.MouseEvent, row: Row | null) => {
    e.preventDefault();
    if (!rootPath) return;
    const dir = row ? (row.entry.isDirectory ? row.entry.path : parentOf(row.entry.path)) : rootPath;
    const depth = row ? (row.entry.isDirectory ? row.depth + 1 : row.depth) : 0;
    const items: MenuItem[] = [];
    if (row && !row.entry.isDirectory) {
      items.push({ label: 'Open', icon: 'file-text', onSelect: () => onOpen(row.entry.path) });
      items.push({ label: 'Send to Claude', icon: 'send', onSelect: () => onSendToClaude(row.entry.path) });
      items.push({ kind: 'sep' });
    }
    items.push({ label: 'New Document', icon: 'file-plus', onSelect: () => startNew('new-file', dir, depth) });
    items.push({ label: 'New Folder', icon: 'folder-plus', onSelect: () => startNew('new-folder', dir, depth) });
    if (row) {
      items.push({ kind: 'sep' });
      items.push({ label: 'Rename', icon: 'pencil', shortcut: 'F2', onSelect: () => startRename(row) });
      items.push({ label: 'Copy Path', icon: 'link', onSelect: () => onCopyPath(row.entry.path) });
      items.push({ label: 'Reveal in Explorer', icon: 'external', onSelect: () => onReveal(row.entry.path) });
      items.push({ kind: 'sep' });
      items.push({ label: 'Move to Recycle Bin', icon: 'trash', shortcut: 'Del', danger: true, onSelect: () => { void confirmTrash(row.entry.path); } });
    } else {
      items.push({ kind: 'sep' });
      items.push({ label: 'Reveal in Explorer', icon: 'external', onSelect: () => onReveal(rootPath) });
    }
    if (row) setFocused(row.entry.path);
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => onWidthChange(Math.max(200, Math.min(480, startW + ev.clientX - startX)));
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const doRefresh = async () => {
    setRefreshing(true);
    try { await onRefresh(); } finally { setTimeout(() => setRefreshing(false), 300); }
  };

  const renderEditor = (depth: number, key: string, isFolder: boolean) => (
    <div key={key} className="tree-row" style={{ paddingLeft: 6 + depth * 16 }}>
      <span className="chev is-blank"><Icon name="chevron-right" size={12} /></span>
      <span className="ico"><Icon name={isFolder ? 'folder' : 'file-text'} size={15} /></span>
      <input
        ref={inputRef}
        className="tree-input"
        defaultValue={editing?.initial ?? ''}
        placeholder={isFolder ? 'folder name' : 'name.md'}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void commitEditing(e.currentTarget.value); }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
          e.stopPropagation();
        }}
        onBlur={(e) => { void commitEditing(e.currentTarget.value); }}
      />
    </div>
  );

  return (
    <div className="sidebar" style={{ width }}>
      <div className="brand">
        <span className="mark">D</span>
        <span className="name">Drafting</span>
        <IconButton icon="panel-left" title="Hide sidebar  Ctrl+\" small onClick={onCollapse} />
      </div>

      <button className="side-search" onClick={onQuickOpen} title="Find a document by name">
        <Icon name="search" size={14} />
        <span className="grow">Search documents…</span>
        <span className="kbd">Ctrl+P</span>
      </button>

      {rootPath && (
        <div className="side-section">
          <span className="grow" title={rootPath}>Documents</span>
          <IconButton icon="file-plus" title="New document" small onClick={() => startNew('new-file', rootPath, 0)} />
          <IconButton icon="folder-plus" title="New folder" small onClick={() => startNew('new-folder', rootPath, 0)} />
          <IconButton icon="refresh" title="Refresh" small spin={refreshing} onClick={() => { void doRefresh(); }} />
        </div>
      )}

      <div
        ref={treeRef}
        className="tree"
        tabIndex={0}
        role="tree"
        onKeyDown={onTreeKeyDown}
        onContextMenu={(e) => { if (e.target === e.currentTarget) openMenu(e, null); }}
      >
        {!rootPath ? (
          <div className="side-empty">
            <p>Open the folder for a matter, or a single document, to start drafting.</p>
            <button className="btn accent" onClick={onOpenFolder}><Icon name="folder-open" size={14} />Open Folder</button>
            <button className="btn" onClick={onOpenFile}><Icon name="file-text" size={14} />Open File</button>
            <button className="btn" onClick={onNewFileDialog}><Icon name="file-plus" size={14} />New Document</button>
          </div>
        ) : (
          <>
            {editing && editing.mode !== 'rename' && editing.dir === rootPath && renderEditor(0, '__new_root', editing.mode === 'new-folder')}
            {rows.map((row) => {
              const p = row.entry.path;
              const isDir = row.entry.isDirectory;
              const isActive = p === activeFile;
              const isRenaming = editing?.mode === 'rename' && editing.path === p;
              const classes = ['tree-row', isDir ? 'is-dir' : '', !isDir && isProse(p) ? 'is-prose' : '', isActive ? 'is-active' : '', focused === p ? 'is-focused' : '', deletedPaths.has(p) ? 'is-deleted' : ''].filter(Boolean).join(' ');
              return (
                <React.Fragment key={p}>
                  {isRenaming ? renderEditor(row.depth, p + '__rename', isDir) : (
                    <div
                      className={classes}
                      data-path={p}
                      role="treeitem"
                      aria-expanded={isDir ? row.expanded : undefined}
                      aria-selected={isActive}
                      style={{ paddingLeft: 6 + row.depth * 16 }}
                      title={p}
                      onClick={() => { setFocused(p); if (isDir) void toggleDir(p); else onOpen(p); }}
                      onContextMenu={(e) => openMenu(e, row)}
                    >
                      <span className={`chev${isDir ? (row.expanded ? ' is-open' : '') : ' is-blank'}`}><Icon name="chevron-right" size={12} /></span>
                      <span className="ico"><Icon name={isDir ? (row.expanded ? 'folder-open' : 'folder') : (isProse(p) ? 'file-text' : 'file')} size={15} /></span>
                      <span className="name">{isDir ? row.entry.name : row.entry.name.replace(/\.(md|markdown|mdx)$/i, '')}</span>
                      {!isDir && dirtyPaths.has(p) && <span className="dot" title="Unsaved changes" />}
                      {!isDir && !dirtyPaths.has(p) && changedPaths.has(p) && <span className="dot" style={{ background: 'var(--info)' }} title="Changed on disk" />}
                    </div>
                  )}
                  {isDir && row.expanded && editing && editing.mode !== 'rename' && editing.dir === p && renderEditor(row.depth + 1, p + '__new', editing.mode === 'new-folder')}
                  {isDir && row.expanded && loading.has(p) && <div className="tree-loading" style={{ paddingLeft: 28 + (row.depth + 1) * 16 }}>Loading…</div>}
                  {isDir && row.expanded && row.loaded && (listings.get(p)?.length ?? 0) === 0 && !loading.has(p) && (
                    <div className="tree-empty-dir" style={{ paddingLeft: 28 + (row.depth + 1) * 16 }}>empty</div>
                  )}
                </React.Fragment>
              );
            })}
          </>
        )}
      </div>

      <button className="side-folder" onClick={onOpenFolder} title={rootPath ? `${rootPath}\nClick to open a different folder` : 'Open a folder'}>
        <span className="ico"><Icon name="folder-open" size={15} /></span>
        <span className="text">
          <div className="name">{rootPath ? baseName(rootPath) : 'No folder open'}</div>
          <div className="path">{rootPath ? parentOf(rootPath) : 'Choose a matter folder'}</div>
        </span>
        <span className="chev"><Icon name="chevron-right" size={14} /></span>
      </button>

      <div className="sidebar-resizer" onMouseDown={onResizeStart} />
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
};

function parentOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export default Sidebar;
