import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import TabBar, { TabInfo, TabStatus } from './components/TabBar';
import Toolbar from './components/Toolbar';
import Editor, { EditorHandle, EditorStats } from './components/Editor';
import DiffReview, { DiffLabels } from './components/DiffReview';
import MilkdownPreview, { VisualHandle } from './components/MilkdownPreview';
import TerminalPane, { TerminalHandle } from './components/TerminalPane';
import DocumentPanel from './components/DocumentPanel';
import MatterCard, { MatterCardHandle } from './components/MatterCard';
import CommandPalette, { Command } from './components/CommandPalette';
import SettingsPanel from './components/SettingsPanel';
import { Icon } from './components/Icons';
import { IconButton, Toasts, useToasts } from './components/ui';
import { useFileSystem, PendingChange } from './hooks/useFileSystem';
import { useSettings } from './hooks/useSettings';
import { AppCommand, SnapshotInfo, ViewMode } from '../shared/types';
import { baseName, dirName, extName, isProse, relativeTo } from './lib/paths';
import { countWords } from './lib/textDiff';

const SESSION_KEY = 'drafting-app-session';

interface SessionState {
  rootPath: string | null;
  openFilePaths: string[];
  activeFile: string | null;
  splitRatio: number;
}

function readSession(): SessionState {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<SessionState>;
      return {
        rootPath: s.rootPath ?? null,
        openFilePaths: Array.isArray(s.openFilePaths) ? s.openFilePaths : [],
        activeFile: s.activeFile ?? null,
        splitRatio: typeof s.splitRatio === 'number' ? s.splitRatio : 0.6,
      };
    }
  } catch { /* fresh start */ }
  return { rootPath: null, openFilePaths: [], activeFile: null, splitRatio: 0.6 };
}

interface ReviewState {
  change: PendingChange;
  labels?: DiffLabels;
  custom?: { onApply: (text: string) => void; onKeepLeft: () => void };
}

/** The document's name, editable in place; committing renames the file. */
const TitleCard: React.FC<{ path: string; rootPath: string | null; readOnly: boolean; onRename: (newName: string) => Promise<unknown>; onError: (m: string) => void }> = ({ path, rootPath, readOnly, onRename, onError }) => {
  const ext = extName(path);
  const stem = baseName(path).slice(0, baseName(path).length - ext.length);
  const [value, setValue] = useState(stem);
  useEffect(() => { setValue(stem); }, [stem]);
  const commit = async () => {
    const v = value.trim();
    if (!v || v === stem) { setValue(stem); return; }
    if (/[\\/:*?"<>|]/.test(v)) { onError('That name contains characters Windows does not allow: \\ / : * ? " < > |'); setValue(stem); return; }
    try { await onRename(v + ext); } catch (err) { onError(err instanceof Error ? err.message : String(err)); setValue(stem); }
  };
  const crumbs = relativeTo(rootPath, dirName(path));
  return (
    <div className="card title-card">
      <input
        className={`title-input${readOnly ? ' readonly' : ''}`}
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        aria-label="Document name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => { void commit(); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setValue(stem); e.currentTarget.blur(); } }}
      />
      {ext && <span className="ext">{ext}</span>}
      <span className="crumbs" title={path}>{crumbs && crumbs !== dirName(path) ? <b>{crumbs}</b> : <b>{baseName(rootPath ?? dirName(path))}</b>}</span>
    </div>
  );
};

const App: React.FC = () => {
  const { settings, loaded: settingsLoaded, theme, update: updateSettings } = useSettings();
  const fs = useFileSystem(settings.editor.autosaveDelayMs);
  const fsRef = useRef(fs);
  useEffect(() => { fsRef.current = fs; }, [fs]);

  const initialSession = useRef(readSession());
  const [splitRatio, setSplitRatio] = useState(initialSession.current.splitRatio);
  const [sessionRestored, setSessionRestored] = useState(false);
  const [viewModes, setViewModes] = useState<Map<string, ViewMode>>(new Map());
  const [review, setReview] = useState<ReviewState | null>(null);
  const [palette, setPalette] = useState<'commands' | 'files' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stats, setStats] = useState<EditorStats>({ words: 0, line: 1, column: 1, selectionLines: 0 });
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [snapshotCount, setSnapshotCount] = useState<number | null>(null);
  const [snapshotMessage, setSnapshotMessage] = useState<string | null>(null);
  const [matterLabel, setMatterLabel] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const { toasts, push: toast } = useToasts();

  const editorRef = useRef<EditorHandle | null>(null);
  const visualRef = useRef<VisualHandle | null>(null);
  const termRef = useRef<TerminalHandle | null>(null);
  const matterRef = useRef<MatterCardHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const activeFile = fs.activeFile;
  const activeIsProse = !!activeFile && isProse(activeFile);
  const activeUnsupported = !!activeFile && !!fs.getFileState(activeFile)?.isUnsupported;
  const viewMode: ViewMode = activeFile && activeIsProse && !activeUnsupported
    ? (viewModes.get(activeFile) ?? settings.editor.defaultView)
    : 'raw';
  const sidebarVisible = settings.sidebar.visible;
  const sidebarWidth = settings.sidebar.width;
  const trackingEnabled = settings.timeTracking.enabled && !!settings.timeTracking.dir;

  // ---- session restore / save ----

  useEffect(() => {
    const s = initialSession.current;
    (async () => {
      if (s.rootPath) {
        try {
          if (await window.drafting.pathExists(s.rootPath)) {
            await fsRef.current.setRoot(s.rootPath);
            if (s.openFilePaths.length) await fsRef.current.openFilesBatch(s.openFilePaths, s.activeFile);
          }
        } catch { /* folder gone */ }
      }
      setSessionRestored(true);
    })();
  }, []);

  useEffect(() => {
    if (!sessionRestored) return;
    const id = setTimeout(() => {
      const s: SessionState = { rootPath: fs.rootPath, openFilePaths: fs.openPaths, activeFile: fs.activeFile, splitRatio };
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    }, 400);
    return () => clearTimeout(id);
  }, [fs.rootPath, fs.openPaths, fs.activeFile, splitRatio, sessionRestored]);

  useEffect(() => {
    window.drafting.setActiveDocument(fs.activeFile, fs.rootPath);
  }, [fs.activeFile, fs.rootPath]);

  useEffect(() => { setSnapshots(null); setReview(null); }, [activeFile]);

  // Snapshot count for the document card.
  useEffect(() => {
    let cancelled = false;
    if (!activeFile) { setSnapshotCount(null); return; }
    window.drafting.listSnapshots(activeFile).then((l) => { if (!cancelled) setSnapshotCount(l.length); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [activeFile, fs.lastSavedAt]);

  useEffect(() => {
    if (settings.externalChange.offerReview) return;
    for (const [p, c] of fs.pendingChanges) if (c.kind === 'applied') fs.dismissChange(p);
  }, [fs.pendingChanges, settings.externalChange.offerReview, fs]);

  // Opening a different folder leaves Claude running where it was. Say so.
  const lastRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionRestored) { lastRootRef.current = fs.rootPath; return; }
    if (fs.rootPath === lastRootRef.current) return;
    lastRootRef.current = fs.rootPath;
    const cwd = termRef.current?.getCwd() ?? null;
    if (fs.rootPath && (cwd ?? '').toLowerCase() !== fs.rootPath.toLowerCase()) {
      toast(`Claude is still running in ${cwd ? baseName(cwd) : 'your home folder'}. Use the restart button in the Claude card to move it to ${baseName(fs.rootPath)}.`, 'info', 6000);
    }
  }, [fs.rootPath, sessionRestored, toast]);

  // ---- Claude prompts ----

  const currentSelection = useCallback((): { text: string; lines: string } | null => {
    if (viewMode === 'raw') {
      const sel = editorRef.current?.getSelection();
      return sel ? { text: sel.text, lines: sel.startLine === sel.endLine ? `${sel.startLine}` : `${sel.startLine}-${sel.endLine}` } : null;
    }
    const text = visualRef.current?.getSelectionText() ?? '';
    return text.trim() ? { text, lines: '' } : null;
  }, [viewMode]);

  const fillPrompt = useCallback((template: string, path: string): string => {
    const rel = relativeTo(fs.rootPath, path);
    const relToken = /\s/.test(rel) ? `"${rel}"` : `@${rel}`;
    const sel = currentSelection();
    let out = template
      .replace(/\{relpath\}/g, relToken)
      .replace(/\{path\}/g, /\s/.test(path) ? `"${path}"` : path)
      .replace(/\{name\}/g, baseName(path))
      .replace(/\{lines\}/g, sel?.lines ?? '')
      .replace(/\{selection\}/g, sel ? sel.text.trim() : '');
    if (sel && !/\{(selection|lines)\}/.test(template)) {
      const snippet = sel.text.trim().replace(/\s+/g, ' ');
      out = out.trimEnd() + (sel.lines ? ` Focus on lines ${sel.lines}. ` : ` Focus on the passage beginning "${snippet.slice(0, 60)}${snippet.length > 60 ? '…' : ''}". `);
    }
    return out;
  }, [fs.rootPath, currentSelection]);

  const sendToClaude = useCallback(async (path: string | null, template: string) => {
    if (!path) return;
    await fs.saveAllDirty();
    termRef.current?.type(fillPrompt(template, path));
  }, [fs, fillPrompt]);

  // ---- view helpers ----

  const setViewMode = useCallback((mode: ViewMode) => {
    if (!activeFile) return;
    setViewModes((prev) => { const n = new Map(prev); n.set(activeFile, mode); return n; });
  }, [activeFile]);

  const toggleSidebar = useCallback(() => { void updateSettings({ sidebar: { visible: !sidebarVisible } }); }, [sidebarVisible, updateSettings]);

  const openReview = useCallback((path?: string | null) => {
    const p = path ?? activeFile;
    if (!p) return;
    const change = fs.pendingChanges.get(p);
    if (!change) { toast('Nothing to review for this document.'); return; }
    if (p !== activeFile) fs.activate(p);
    setReview({ change });
  }, [activeFile, fs, toast]);

  const copyPath = useCallback((p: string) => {
    void navigator.clipboard.writeText(p).then(() => toast('Path copied', 'ok'));
  }, [toast]);

  const saveSnapshot = useCallback(async () => {
    if (!activeFile || activeUnsupported) return;
    await fs.saveFile(activeFile);
    try {
      const snap = await window.drafting.saveSnapshot(activeFile);
      setSnapshotMessage(`Saved · ${snap.label}`);
      const list = await window.drafting.listSnapshots(activeFile);
      setSnapshotCount(list.length);
      if (snapshots) setSnapshots(list);
    } catch (err) {
      toast(`Snapshot failed: ${err instanceof Error ? err.message : String(err)}`, 'danger');
    }
    setTimeout(() => setSnapshotMessage(null), 2500);
  }, [activeFile, activeUnsupported, fs, snapshots, toast]);

  const toggleSnapshots = useCallback(async () => {
    if (!activeFile) return;
    if (snapshots) { setSnapshots(null); return; }
    setSnapshots(await window.drafting.listSnapshots(activeFile));
  }, [activeFile, snapshots]);

  const compareSnapshot = useCallback(async (snap: SnapshotInfo) => {
    if (!activeFile) return;
    const before = await window.drafting.readSnapshot(snap.snapshotPath);
    const after = fs.getContent(activeFile) ?? '';
    setReview({
      change: { path: activeFile, kind: 'applied', before, after, at: Date.now() },
      labels: { title: `Compare with ${snap.label}`, sub: new Date(snap.timestamp).toLocaleString(), left: 'Snapshot', right: 'Current document (editable)', keep: 'Restore snapshot', apply: 'Apply edits' },
      custom: {
        onApply: (text) => { void fs.acceptReviewed(activeFile, text); setReview(null); },
        onKeepLeft: async () => {
          const content = await window.drafting.restoreSnapshot(snap.snapshotPath, activeFile);
          fs.applyExternalContent(activeFile, content);
          setReview(null);
          toast('Snapshot restored. A snapshot of the previous text was kept.', 'ok');
        },
      },
    });
  }, [activeFile, fs, toast]);

  // ---- commands ----

  const commands: Command[] = useMemo(() => [
    { id: 'file.new', label: 'New Document', icon: 'file-plus', shortcut: 'Ctrl+N', run: () => { void fs.newFileFromDialog(); } },
    { id: 'file.open', label: 'Open File…', icon: 'file-text', shortcut: 'Ctrl+O', run: () => { void fs.openFileFromDialog(); } },
    { id: 'folder.open', label: 'Open Folder…', icon: 'folder-open', shortcut: 'Ctrl+Shift+O', run: () => { void fs.openFolder(); } },
    { id: 'file.save', label: 'Save', icon: 'save', shortcut: 'Ctrl+S', enabled: !!activeFile, run: () => { if (activeFile) void fs.saveFile(activeFile); } },
    { id: 'file.saveAll', label: 'Save All', icon: 'save', shortcut: 'Ctrl+Shift+S', run: () => { void fs.saveAllDirty(); } },
    { id: 'tab.close', label: 'Close Document', icon: 'x', shortcut: 'Ctrl+W', enabled: !!activeFile, run: () => { if (activeFile) void fs.closeFile(activeFile); } },
    { id: 'tab.next', label: 'Next Document', shortcut: 'Ctrl+Tab', enabled: fs.openPaths.length > 1, run: () => cycleTab(1) },
    { id: 'tab.prev', label: 'Previous Document', shortcut: 'Ctrl+Shift+Tab', enabled: fs.openPaths.length > 1, run: () => cycleTab(-1) },
    { id: 'view.quickOpen', label: 'Go to Document…', icon: 'search', shortcut: 'Ctrl+P', enabled: !!fs.rootPath, run: () => setPalette('files') },
    { id: 'view.toggleSidebar', label: sidebarVisible ? 'Hide Sidebar' : 'Show Sidebar', icon: 'panel-left', shortcut: 'Ctrl+\\', run: toggleSidebar },
    { id: 'view.togglePreview', label: viewMode === 'raw' ? 'Switch to Visual Editor' : 'Switch to Markdown Text', icon: viewMode === 'raw' ? 'eye' : 'code', shortcut: 'Ctrl+E', enabled: activeIsProse && !activeUnsupported, run: () => setViewMode(viewMode === 'raw' ? 'preview' : 'raw') },
    { id: 'view.focusToggle', label: 'Switch Between Document and Claude', icon: 'terminal', shortcut: 'Ctrl+`', run: () => { if (termRef.current?.hasFocus()) { if (viewMode === 'raw') editorRef.current?.focus(); else visualRef.current?.focus(); } else termRef.current?.focus(); } },
    { id: 'review.changes', label: 'Review Changes From Disk', icon: 'diff', shortcut: 'Ctrl+Shift+R', enabled: !!activeFile && fs.pendingChanges.has(activeFile), run: () => openReview() },
    { id: 'claude.send', label: 'Send Document to Claude', icon: 'send', shortcut: 'Ctrl+Enter', enabled: !!activeFile, run: () => { void sendToClaude(activeFile, settings.prompts.sendToClaude); } },
    { id: 'claude.proofread', label: 'Proofread With Claude', icon: 'sparkles', enabled: !!activeFile, run: () => { void sendToClaude(activeFile, settings.prompts.proofread); } },
    { id: 'terminal.restart', label: fs.rootPath ? `Restart Claude in ${baseName(fs.rootPath)}` : 'Restart Terminal', icon: 'refresh', run: () => termRef.current?.restart(fs.rootPath) },
    { id: 'terminal.clear', label: 'Clear Terminal', icon: 'terminal', run: () => termRef.current?.clear() },
    { id: 'snapshot.save', label: 'Save Snapshot', icon: 'camera', enabled: !!activeFile && !activeUnsupported, run: () => { void saveSnapshot(); } },
    { id: 'snapshot.list', label: 'Show Snapshots', icon: 'history', enabled: !!activeFile, run: () => { void toggleSnapshots(); } },
    { id: 'matter.set', label: 'Set Matter for This Document', icon: 'briefcase', enabled: !!activeFile && trackingEnabled, run: () => matterRef.current?.open(document.querySelector<HTMLElement>('[data-action=matter]')) },
    { id: 'theme.toggle', label: theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme', icon: theme === 'dark' ? 'sun' : 'moon', run: () => { void updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }); } },
    { id: 'view.settings', label: 'Settings…', icon: 'settings', shortcut: 'Ctrl+,', run: () => setSettingsOpen(true) },
    { id: 'reveal', label: 'Reveal Document in Explorer', icon: 'external', enabled: !!activeFile, run: () => { if (activeFile) window.drafting.revealPath(activeFile); } },
    { id: 'copyPath', label: 'Copy Document Path', icon: 'link', enabled: !!activeFile, run: () => { if (activeFile) copyPath(activeFile); } },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [fs, activeFile, activeIsProse, activeUnsupported, viewMode, sidebarVisible, theme, settings.prompts, trackingEnabled, toggleSidebar, setViewMode, openReview, sendToClaude, saveSnapshot, toggleSnapshots, updateSettings, copyPath]);

  const commandsRef = useRef(commands);
  useEffect(() => { commandsRef.current = commands; }, [commands]);

  function cycleTab(delta: 1 | -1) {
    const paths = fsRef.current.openPaths;
    if (paths.length < 2) return;
    const cur = fsRef.current.activeFile;
    const idx = cur ? paths.indexOf(cur) : -1;
    fsRef.current.activate(paths[idx < 0 ? 0 : (idx + delta + paths.length) % paths.length]);
  }

  const runCommand = useCallback((id: string) => {
    setPalette(null);
    const c = commandsRef.current.find((x) => x.id === id);
    if (c && c.enabled !== false) c.run();
  }, []);

  useEffect(() => window.drafting.onAppCommand((cmd: AppCommand, payload?: string) => {
    if (cmd === 'app.flushRequest') {
      fsRef.current.saveAllDirty().finally(() => window.drafting.flushDone());
      return;
    }
    if (cmd === 'folder.openPath') { if (payload) void fsRef.current.setRoot(payload); return; }
    if (cmd === 'file.openPath') { if (payload) void fsRef.current.openFile(payload); return; }
    if (cmd === 'view.palette') { setPalette((p) => (p === 'commands' ? null : 'commands')); return; }
    runCommand(cmd);
  }), [runCommand]);

  // Renderer-level shortcuts. These yield to the terminal, which has its own uses for them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (palette || settingsOpen) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const inTerminal = termRef.current?.hasFocus() ?? false;
      const key = e.key.toLowerCase();
      let id: string | null = null;
      if (key === 'p' && e.shiftKey) id = 'view.palette';
      else if (inTerminal) return;
      else if (key === 'n' && !e.shiftKey) id = 'file.new';
      else if (key === 'o' && !e.shiftKey) id = 'file.open';
      else if (key === 'o' && e.shiftKey) id = 'folder.open';
      else if (key === 'w') id = 'tab.close';
      else if (key === 'p') id = 'view.quickOpen';
      else if (key === '\\') id = 'view.toggleSidebar';
      else if (key === 'e' && !e.shiftKey) id = 'view.togglePreview';
      else if (key === 'enter') id = 'claude.send';
      else if (key === 'r' && e.shiftKey) id = 'review.changes';
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      if (id === 'view.palette') setPalette((p) => (p === 'commands' ? null : 'commands'));
      else runCommand(id);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [palette, settingsOpen, runCommand]);

  // ---- split divider ----

  const onDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let raf: number | null = null;
    let pending: number | null = null;
    const flush = () => { raf = null; if (pending !== null) { setSplitRatio(pending); pending = null; } };
    const onMove = (ev: MouseEvent) => {
      const el = bodyRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = Math.max(420, Math.min(r.width - 360, ev.clientX - r.left));
      pending = x / r.width;
      if (raf === null) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (raf !== null) { cancelAnimationFrame(raf); flush(); }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // ---- derived view data ----

  const tabs: TabInfo[] = fs.openPaths.map((p) => {
    let status: TabStatus = 'clean';
    const pc = fs.pendingChanges.get(p);
    if (fs.deletedPaths.has(p)) status = 'deleted';
    else if (pc?.kind === 'conflict') status = 'conflict';
    else if (pc?.kind === 'applied' && settings.externalChange.offerReview) status = 'change';
    else if (fs.dirtyPaths.has(p)) status = 'dirty';
    return { path: p, status };
  });

  const changedPaths = useMemo(() => new Set(Array.from(fs.pendingChanges.keys())), [fs.pendingChanges]);
  const quickOpenFiles = useMemo(() => {
    const out: { path: string }[] = [];
    for (const entries of fs.listings.values()) for (const e of entries) if (!e.isDirectory) out.push({ path: e.path });
    return out;
  }, [fs.listings]);

  const activePending = activeFile ? fs.pendingChanges.get(activeFile) ?? null : null;
  const activeDeleted = !!activeFile && fs.deletedPaths.has(activeFile);
  const showPendingBanner = !!activePending && (activePending.kind === 'conflict' || settings.externalChange.offerReview) && !review;
  const pendingKind = activePending && (activePending.kind === 'conflict' || settings.externalChange.offerReview) ? activePending.kind : null;

  const getContent = fs.getContent;
  const isUnsupportedFn = useCallback((p: string) => !!fs.getFileState(p)?.isUnsupported, [fs]);
  const onEditorChange = useCallback((p: string, content: string) => fs.updateContent(p, content), [fs]);
  const onPreviewChange = useCallback((content: string) => { if (activeFile) fs.updateContent(activeFile, content); }, [fs, activeFile]);
  const words = viewMode === 'preview' && activeFile ? countWords(getContent(activeFile) ?? '') : stats.words;

  if (!settingsLoaded) return <div className="app" />;

  return (
    <div className="app">
      {sidebarVisible && (
        <Sidebar
          rootPath={fs.rootPath}
          listings={fs.listings}
          activeFile={activeFile}
          dirtyPaths={fs.dirtyPaths}
          deletedPaths={fs.deletedPaths}
          changedPaths={changedPaths}
          width={sidebarWidth}
          onWidthChange={(w) => { void updateSettings({ sidebar: { width: w } }); }}
          onCollapse={toggleSidebar}
          onQuickOpen={() => setPalette('files')}
          onOpen={(p) => { void fs.openFile(p); }}
          onLoadDir={fs.listDir}
          onRefresh={fs.refreshTree}
          onOpenFolder={() => { void fs.openFolder(); }}
          onOpenFile={() => { void fs.openFileFromDialog(); }}
          onNewFileDialog={() => { void fs.newFileFromDialog(); }}
          onCreateFile={fs.createFileIn}
          onCreateFolder={fs.createFolderIn}
          onRename={fs.renameEntry}
          onTrash={fs.trashEntry}
          onReveal={(p) => window.drafting.revealPath(p)}
          onCopyPath={copyPath}
          onSendToClaude={(p) => { void (async () => { await fs.openFile(p); await sendToClaude(p, settings.prompts.sendToClaude); })(); }}
          onError={(m) => toast(m, 'danger', 4000)}
        />
      )}

      <div className="content">
        <div className="topbar">
          {!sidebarVisible && <IconButton icon="panel-left" title="Show sidebar  Ctrl+\" onClick={toggleSidebar} className="ring" />}
          <div className="grow">
            <TabBar
              tabs={tabs}
              activeTab={activeFile}
              onSelect={fs.activate}
              onClose={(p) => { void fs.closeFile(p); }}
              onCloseOthers={(p) => { void fs.closeOthers(p); }}
              onReveal={(p) => window.drafting.revealPath(p)}
              onCopyPath={copyPath}
              onNew={() => { void fs.newFileFromDialog(); }}
            />
          </div>
          <div className="right">
            <IconButton icon="command" title="Command palette  Ctrl+Shift+P" onClick={() => setPalette('commands')} className="ring" />
            <IconButton icon={theme === 'dark' ? 'sun' : 'moon'} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={() => { void updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' }); }} className="ring" />
            <IconButton icon="settings" title="Settings  Ctrl+," onClick={() => setSettingsOpen(true)} className="ring" />
          </div>
        </div>

        <div className="body" ref={bodyRef}>
          <div className="column-main" style={{ width: `${splitRatio * 100}%`, flexShrink: 0 }}>
            {activeFile ? (
              <>
                <TitleCard path={activeFile} rootPath={fs.rootPath} readOnly={activeUnsupported || activeDeleted} onRename={(n) => fs.renameEntry(activeFile, n)} onError={(m) => toast(m, 'danger', 4000)} />
                <div className="card editor-card">
                  <Toolbar
                    editor={editorRef}
                    visual={visualRef}
                    isProse={activeIsProse}
                    readOnly={activeUnsupported}
                    viewMode={viewMode}
                    onViewMode={setViewMode}
                    onSnapshot={() => { void saveSnapshot(); }}
                    onToggleSnapshots={() => { void toggleSnapshots(); }}
                    snapshotsOpen={snapshots !== null}
                    snapshotMessage={snapshotMessage}
                  />

                  {snapshots !== null && (
                    <div className="snap-list">
                      {snapshots.length === 0 && <div className="snap-empty">No snapshots of this document yet. The Snapshot button saves one.</div>}
                      {snapshots.map((snap) => (
                        <div key={snap.id} className="snap-row">
                          <Icon name="camera" size={13} />
                          <span className="label">{snap.label}</span>
                          <span className="when">{new Date(snap.timestamp).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
                          <button className="btn sm ghost" onClick={() => { void compareSnapshot(snap); }}><Icon name="diff" size={13} />Compare</button>
                          <button className="btn sm ghost danger" title="Delete this snapshot" onClick={async () => { await window.drafting.deleteSnapshot(snap.snapshotPath); const l = await window.drafting.listSnapshots(activeFile); setSnapshots(l); setSnapshotCount(l.length); }}><Icon name="trash" size={13} /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeDeleted && (
                    <div className="banner danger">
                      <span className="ico"><Icon name="trash" size={15} /></span>
                      <span className="text"><b>{baseName(activeFile)}</b> was deleted or moved on disk. Your copy is still here and is no longer autosaving.</span>
                      <span className="actions">
                        <button className="btn sm" onClick={() => { void fs.keepDeleted(activeFile); }}>Keep and re-create</button>
                        <button className="btn sm ghost" onClick={() => { void fs.closeFile(activeFile); }}>Close</button>
                      </span>
                    </div>
                  )}

                  {showPendingBanner && activePending && (
                    activePending.kind === 'conflict' ? (
                      <div className="banner warn">
                        <span className="ico"><Icon name="alert" size={15} /></span>
                        <span className="text"><b>{baseName(activeFile)}</b> changed on disk while you had unsaved edits. Nothing has been overwritten.</span>
                        <span className="actions">
                          <button className="btn sm primary" onClick={() => openReview()}><Icon name="diff" size={13} />Review</button>
                          <button className="btn sm" onClick={() => fs.takeDisk(activeFile)}>Use disk version</button>
                          <button className="btn sm ghost" onClick={() => { void fs.keepMine(activeFile); }}>Keep mine</button>
                        </span>
                      </div>
                    ) : (
                      <div className="banner info">
                        <span className="ico"><Icon name="sparkles" size={15} /></span>
                        <span className="text"><b>{baseName(activeFile)}</b> was changed on disk and reloaded. Ctrl+Z undoes it.</span>
                        <span className="actions">
                          <button className="btn sm primary" onClick={() => openReview()}><Icon name="diff" size={13} />Review</button>
                          <button className="btn sm" onClick={() => { void fs.revertApplied(activeFile); }}>Revert</button>
                          <button className="btn sm ghost" onClick={() => fs.dismissChange(activeFile)}>OK</button>
                        </span>
                      </div>
                    )
                  )}

                  <div className="editor-area">
                    <Editor
                      ref={editorRef}
                      filePath={activeFile}
                      openPaths={fs.openPaths}
                      visible={viewMode === 'raw'}
                      theme={theme}
                      settings={settings.editor}
                      cursorPolicy={settings.externalChange.cursor}
                      reloads={fs.reloads}
                      getContent={getContent}
                      isUnsupported={isUnsupportedFn}
                      onChange={onEditorChange}
                      onStats={setStats}
                    />
                    {viewMode === 'preview' && (
                      <MilkdownPreview key={activeFile} ref={visualRef} content={getContent(activeFile) ?? ''} onChange={onPreviewChange} fontSize={settings.editor.fontSize} theme={theme} />
                    )}
                    {review && (
                      <DiffReview
                        change={review.change}
                        theme={theme}
                        fontFamily={settings.editor.fontFamily}
                        fontSize={settings.editor.fontSize}
                        labels={review.labels}
                        onApply={(text) => {
                          if (review.custom) review.custom.onApply(text);
                          else { void fs.acceptReviewed(review.change.path, text); }
                          setReview(null);
                        }}
                        onKeepLeft={() => {
                          if (review.custom) { void review.custom.onKeepLeft(); return; }
                          if (review.change.kind === 'conflict') void fs.keepMine(review.change.path);
                          else void fs.revertApplied(review.change.path);
                          setReview(null);
                        }}
                        onClose={() => setReview(null)}
                      />
                    )}
                  </div>
                  {viewMode === 'raw' && (
                    <div className="editor-foot">
                      <span>Ln {stats.line}, Col {stats.column}{stats.selectionLines > 1 ? ` · ${stats.selectionLines} lines selected` : ''}</span>
                      <span className="grow" />
                      <span>Markdown</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="card empty-card">
                <div className="inner">
                  <div className="glyph"><Icon name="file-text" size={28} /></div>
                  <h2>{fs.rootPath ? 'Pick a document' : 'Start drafting'}</h2>
                  <p>{fs.rootPath ? 'Choose a document from the sidebar, or search for it by name.' : 'Open the folder for a matter, or a single document. Claude is ready on the right.'}</p>
                  <div className="actions">
                    {fs.rootPath ? (
                      <>
                        <button className="btn primary" onClick={() => setPalette('files')}><Icon name="search" size={14} />Find a document</button>
                        <button className="btn" onClick={() => { void fs.newFileFromDialog(); }}><Icon name="file-plus" size={14} />New document</button>
                      </>
                    ) : (
                      <>
                        <button className="btn primary" onClick={() => { void fs.openFolder(); }}><Icon name="folder-open" size={14} />Open folder</button>
                        <button className="btn" onClick={() => { void fs.openFileFromDialog(); }}><Icon name="file-text" size={14} />Open file</button>
                      </>
                    )}
                  </div>
                  <div className="hints">
                    <div><span>Find a document</span><span className="kbd">Ctrl+P</span></div>
                    <div><span>New document</span><span className="kbd">Ctrl+N</span></div>
                    <div><span>All commands</span><span className="kbd">Ctrl+Shift+P</span></div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className={`divider${dragging ? ' is-dragging' : ''}`} onMouseDown={onDividerDown} role="separator" aria-orientation="vertical" />

          <div className="column-side">
            <DocumentPanel
              activeFile={activeFile}
              saveState={activeFile ? fs.saveStates.get(activeFile) ?? (fs.dirtyPaths.has(activeFile) ? 'dirty' : 'clean') : 'clean'}
              lastSavedAt={activeFile ? fs.lastSavedAt.get(activeFile) ?? null : null}
              deleted={activeDeleted}
              pendingKind={pendingKind}
              words={words}
              snapshotCount={snapshotCount}
              matterLabel={matterLabel}
              trackingEnabled={trackingEnabled}
              onReview={() => openReview()}
              onSnapshots={() => { void toggleSnapshots(); }}
              onMatter={(anchor) => matterRef.current?.open(anchor)}
              onSend={() => { void sendToClaude(activeFile, settings.prompts.sendToClaude); }}
              onProofread={() => { void sendToClaude(activeFile, settings.prompts.proofread); }}
            />
            <div className="card claude-card">
              <TerminalPane
                ref={termRef}
                initialCwd={initialSession.current.rootPath}
                rootPath={fs.rootPath}
                activeFilePath={activeFile}
                theme={theme}
                settings={settings.terminal}
                onFocus={() => { void fsRef.current.saveAllDirty(); }}
              />
            </div>
          </div>
        </div>
      </div>

      {palette && (
        <CommandPalette
          mode={palette}
          commands={commands}
          files={quickOpenFiles}
          rootPath={fs.rootPath}
          onClose={() => setPalette(null)}
          onOpenFile={(p) => { void fs.openFile(p); }}
        />
      )}
      <MatterCard ref={matterRef} activeFile={activeFile} enabled={trackingEnabled} onLabel={setMatterLabel} />
      {settingsOpen && <SettingsPanel settings={settings} onChange={(patch) => { void updateSettings(patch); }} onClose={() => setSettingsOpen(false)} />}
      <Toasts toasts={toasts} />
    </div>
  );
};

export default App;
