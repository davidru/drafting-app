import { useState, useCallback, useEffect, useRef } from 'react';
import { FileEntry, FileChangeEvent } from '../../shared/types';
import { baseName, dirName, joinPath, extName, isUnder, TEXT_EXTENSIONS } from '../lib/paths';
import { findKey } from '../lib/pathKey';

interface FileState {
  content: string;
  savedContent: string;
  isUnsupported: boolean;
}

/**
 * A change that arrived from disk while the file was open.
 *  - 'applied'  : the file was clean, so the new text is already in the editor;
 *                 `before` is kept so the change can be reviewed or reverted.
 *  - 'conflict' : the file had unsaved edits; nothing was applied. `after` is
 *                 what is on disk, `before` is the editor's text at that moment.
 */
export interface PendingChange {
  path: string;
  kind: 'applied' | 'conflict';
  before: string;
  after: string;
  at: number;
}

export interface ReloadRequest {
  version: number;
  /** Line in the new text where the first change is, for the cursor policy. */
  firstChangedLine: number | null;
}

export type SaveState = 'clean' | 'dirty' | 'saving' | 'error';

function unsupportedPlaceholder(filePath: string): string {
  return `# Unsupported file\n\n**${baseName(filePath)}** is a binary file and cannot be edited here.\n\nOpen it with the application it belongs to. Text formats such as .md, .txt, .json and .yaml open in this editor.`;
}

async function shouldTreatAsBinary(filePath: string): Promise<boolean> {
  const ext = extName(filePath);
  if (ext && TEXT_EXTENSIONS.has(ext)) return false;
  return window.drafting.sniffBinary(filePath);
}

export function useFileSystem(autosaveDelayMs: number) {
  const [rootPath, setRootPath] = useState<string | null>(null);
  /** Directory listings by directory path. The root's own entry is `listings.get(rootPath)`. */
  const [listings, setListings] = useState<Map<string, FileEntry[]>>(new Map());
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activeFile, setActiveFileState] = useState<string | null>(null);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [deletedPaths, setDeletedPaths] = useState<Set<string>>(new Set());
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  const [reloads, setReloads] = useState<Map<string, ReloadRequest>>(new Map());
  const [saveStates, setSaveStates] = useState<Map<string, SaveState>>(new Map());
  const [lastSavedAt, setLastSavedAt] = useState<Map<string, number>>(new Map());

  // Content lives in a ref: keystrokes must not re-render the app.
  const filesRef = useRef<Map<string, FileState>>(new Map());
  const saveTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const deletedPathsRef = useRef<Set<string>>(new Set());
  const mruRef = useRef<string[]>([]);
  const autosaveDelayRef = useRef(autosaveDelayMs);
  autosaveDelayRef.current = autosaveDelayMs;

  // ---- small state helpers ----

  const setDirty = useCallback((filePath: string, dirty: boolean) => {
    setDirtyPaths((prev) => {
      if (prev.has(filePath) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(filePath); else next.delete(filePath);
      return next;
    });
    setSaveStates((prev) => {
      const cur = prev.get(filePath) ?? 'clean';
      const want: SaveState = dirty ? 'dirty' : (cur === 'saving' ? 'saving' : 'clean');
      if (cur === want) return prev;
      const next = new Map(prev); next.set(filePath, want); return next;
    });
  }, []);

  const setSaveState = useCallback((filePath: string, state: SaveState) => {
    setSaveStates((prev) => {
      if (prev.get(filePath) === state) return prev;
      const next = new Map(prev); next.set(filePath, state); return next;
    });
  }, []);

  const removeFrom = <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) =>
    setter((prev) => { if (!prev.has(value)) return prev; const n = new Set(prev); n.delete(value); return n; });

  const getContent = useCallback((filePath: string): string | undefined => filesRef.current.get(filePath)?.content, []);
  const getFileState = useCallback((filePath: string) => filesRef.current.get(filePath), []);

  const putFile = useCallback((filePath: string, content: string, savedContent: string, isUnsupported: boolean) => {
    filesRef.current.set(filePath, { content, savedContent, isUnsupported });
  }, []);

  // ---- directory listings ----

  const listDir = useCallback(async (dirPath: string) => {
    const entries = await window.drafting.listDirectory(dirPath);
    setListings((prev) => {
      const next = new Map(prev);
      next.set(dirPath, entries);
      // The main process returns one level of grandchildren; seed those too.
      for (const e of entries) {
        if (e.isDirectory && e.children) next.set(e.path, e.children);
      }
      return next;
    });
    return entries;
  }, []);

  const refreshDir = useCallback(async (dirPath: string) => {
    try { await listDir(dirPath); } catch { /* folder may be gone */ }
  }, [listDir]);

  const refreshTree = useCallback(async () => {
    if (!rootPath) return;
    // Re-list every directory we currently know about so expanded folders stay honest.
    const known = Array.from(listings.keys());
    const stillThere = known.filter((d) => d === rootPath || d.toLowerCase().startsWith(rootPath.toLowerCase()));
    await Promise.all(stillThere.map((d) => refreshDir(d)));
  }, [rootPath, listings, refreshDir]);

  const setRoot = useCallback(async (dir: string) => {
    setRootPath(dir);
    setListings(new Map());
    await listDir(dir);
    window.drafting.startWatching(dir);
  }, [listDir]);

  // ---- activation and MRU ----

  const activate = useCallback((filePath: string | null) => {
    setActiveFileState(filePath);
    if (filePath) {
      mruRef.current = [filePath, ...mruRef.current.filter((p) => p !== filePath)].slice(0, 30);
    }
  }, []);

  const addOpen = useCallback((paths: string[]) => {
    setOpenPaths((prev) => {
      const next = [...prev];
      for (const p of paths) if (!next.includes(p)) next.push(p);
      return next.length === prev.length ? prev : next;
    });
  }, []);

  // ---- saving ----

  const writeNow = useCallback(async (filePath: string): Promise<boolean> => {
    const f = filesRef.current.get(filePath);
    if (!f || f.isUnsupported) return true;
    const t = saveTimeoutRef.current.get(filePath);
    if (t) { clearTimeout(t); saveTimeoutRef.current.delete(filePath); }
    const content = f.content;
    if (content === f.savedContent) { setDirty(filePath, false); return true; }
    setSaveState(filePath, 'saving');
    try {
      await window.drafting.writeFile(filePath, content);
      f.savedContent = content;
      // The user may have typed during the write.
      const stillDirty = f.content !== f.savedContent;
      setSaveState(filePath, stillDirty ? 'dirty' : 'clean');
      setDirty(filePath, stillDirty);
      setLastSavedAt((prev) => { const n = new Map(prev); n.set(filePath, Date.now()); return n; });
      return true;
    } catch (err) {
      console.error('Save failed:', err);
      setSaveState(filePath, 'error');
      return false;
    }
  }, [setDirty, setSaveState]);

  const scheduleSave = useCallback((filePath: string) => {
    const existing = saveTimeoutRef.current.get(filePath);
    if (existing) clearTimeout(existing);
    saveTimeoutRef.current.set(filePath, setTimeout(() => {
      saveTimeoutRef.current.delete(filePath);
      void writeNow(filePath);
    }, autosaveDelayRef.current));
  }, [writeNow]);

  const saveFile = useCallback((filePath: string) => writeNow(filePath), [writeNow]);

  const saveAllDirty = useCallback(async () => {
    const paths = Array.from(filesRef.current.entries())
      .filter(([, f]) => !f.isUnsupported && f.content !== f.savedContent)
      .map(([p]) => p);
    await Promise.all(paths.map((p) => writeNow(p)));
  }, [writeNow]);

  // ---- opening ----

  const loadIntoStore = useCallback(async (filePath: string) => {
    if (filesRef.current.has(filePath)) return;
    if (await shouldTreatAsBinary(filePath)) {
      putFile(filePath, unsupportedPlaceholder(filePath), '', true);
    } else {
      const content = await window.drafting.readFile(filePath);
      putFile(filePath, content, content, false);
    }
  }, [putFile]);

  const openFile = useCallback(async (filePath: string) => {
    try {
      await loadIntoStore(filePath);
    } catch (err) {
      console.error('Open failed:', err);
      return;
    }
    addOpen([filePath]);
    activate(filePath);
  }, [loadIntoStore, addOpen, activate]);

  /** Batch open (session restore): one IPC round-trip for known text files. */
  const openFilesBatch = useCallback(async (paths: string[], activePath?: string | null) => {
    const toRead: string[] = [];
    const toSniff: string[] = [];
    for (const p of paths) {
      if (filesRef.current.has(p)) continue;
      const ext = extName(p);
      if (ext && TEXT_EXTENSIONS.has(ext)) toRead.push(p); else toSniff.push(p);
    }
    const opened: string[] = [];
    const results = await window.drafting.readFiles(toRead);
    for (const r of results) {
      if (r.content !== undefined) { putFile(r.path, r.content, r.content, false); opened.push(r.path); }
    }
    const sniffed = await Promise.all(toSniff.map(async (p) => ({ p, binary: await shouldTreatAsBinary(p) })));
    const textPaths: string[] = [];
    for (const { p, binary } of sniffed) {
      if (binary) { putFile(p, unsupportedPlaceholder(p), '', true); opened.push(p); } else textPaths.push(p);
    }
    if (textPaths.length) {
      for (const r of await window.drafting.readFiles(textPaths)) {
        if (r.content !== undefined) { putFile(r.path, r.content, r.content, false); opened.push(r.path); }
      }
    }
    const inOrder = paths.filter((p) => filesRef.current.has(p));
    addOpen(inOrder);
    const target = activePath && inOrder.includes(activePath) ? activePath : inOrder[inOrder.length - 1] ?? null;
    if (target) activate(target);
  }, [putFile, addOpen, activate]);

  const openFolder = useCallback(async (dirPath?: string) => {
    const dir = dirPath || await window.drafting.openDirectoryDialog(rootPath ?? undefined);
    if (!dir) return;
    await setRoot(dir);
  }, [rootPath, setRoot]);

  const openFileFromDialog = useCallback(async () => {
    const filePaths = await window.drafting.openFileDialog(rootPath ?? undefined);
    if (!filePaths || filePaths.length === 0) return;
    if (!rootPath) await setRoot(dirName(filePaths[0]));
    for (const p of filePaths) {
      try { await loadIntoStore(p); } catch (err) { console.error('Open failed:', err); }
    }
    const ok = filePaths.filter((p) => filesRef.current.has(p));
    addOpen(ok);
    if (ok.length) activate(ok[0]);
  }, [rootPath, setRoot, loadIntoStore, addOpen, activate]);

  const createFileIn = useCallback(async (dir: string, fileName: string) => {
    const filePath = joinPath(dir, fileName);
    try {
      await window.drafting.createFile(filePath);
    } catch (err) {
      console.error('Create failed:', err);
      throw err;
    }
    await refreshDir(dir);
    putFile(filePath, '', '', false);
    addOpen([filePath]);
    activate(filePath);
    return filePath;
  }, [refreshDir, putFile, addOpen, activate]);

  const createFolderIn = useCallback(async (dir: string, name: string) => {
    await window.drafting.createDirectory(joinPath(dir, name));
    await refreshDir(dir);
  }, [refreshDir]);

  const newFileFromDialog = useCallback(async () => {
    const filePath = await window.drafting.newFileDialog(rootPath ?? undefined);
    if (!filePath) return;
    const parent = dirName(filePath);
    if (!rootPath) await setRoot(parent); else await refreshDir(parent);
    putFile(filePath, '', '', false);
    addOpen([filePath]);
    activate(filePath);
  }, [rootPath, setRoot, refreshDir, putFile, addOpen, activate]);

  // ---- closing ----

  const closeFile = useCallback(async (filePath: string) => {
    if (!deletedPaths.has(filePath)) await writeNow(filePath);
    const t = saveTimeoutRef.current.get(filePath);
    if (t) { clearTimeout(t); saveTimeoutRef.current.delete(filePath); }
    filesRef.current.delete(filePath);
    removeFrom(setDirtyPaths, filePath);
    removeFrom(setDeletedPaths, filePath);
    setPendingChanges((prev) => { if (!prev.has(filePath)) return prev; const n = new Map(prev); n.delete(filePath); return n; });
    mruRef.current = mruRef.current.filter((p) => p !== filePath);
    setOpenPaths((prev) => {
      const remaining = prev.filter((p) => p !== filePath);
      setActiveFileState((cur) => {
        if (cur !== filePath) return cur;
        return mruRef.current.find((p) => remaining.includes(p)) ?? remaining[remaining.length - 1] ?? null;
      });
      return remaining;
    });
  }, [deletedPaths, writeNow]);

  const closeOthers = useCallback(async (keep: string) => {
    for (const p of openPaths) if (p !== keep) await closeFile(p);
  }, [openPaths, closeFile]);

  // ---- rename / trash ----

  const renameEntry = useCallback(async (oldPath: string, newName: string) => {
    const newPath = joinPath(dirName(oldPath), newName);
    if (newPath === oldPath) return;
    const f = filesRef.current.get(oldPath);
    if (f && f.content !== f.savedContent) await writeNow(oldPath);
    await window.drafting.renamePath(oldPath, newPath);
    if (f) {
      filesRef.current.delete(oldPath);
      filesRef.current.set(newPath, f);
      setOpenPaths((prev) => prev.map((p) => (p === oldPath ? newPath : p)));
      setActiveFileState((cur) => (cur === oldPath ? newPath : cur));
      mruRef.current = mruRef.current.map((p) => (p === oldPath ? newPath : p));
    }
    // Open files under a renamed folder: retarget them too.
    const prefix = oldPath.toLowerCase() + '\\';
    for (const [p, state] of Array.from(filesRef.current.entries())) {
      if (p.toLowerCase().startsWith(prefix)) {
        const np = newPath + p.slice(oldPath.length);
        filesRef.current.delete(p);
        filesRef.current.set(np, state);
        setOpenPaths((prev) => prev.map((x) => (x === p ? np : x)));
        setActiveFileState((cur) => (cur === p ? np : cur));
      }
    }
    await refreshDir(dirName(oldPath));
  }, [writeNow, refreshDir]);

  const trashEntry = useCallback(async (target: string) => {
    await window.drafting.trashPath(target);
    const prefix = target.toLowerCase() + '\\';
    for (const p of openPaths) {
      if (p === target || p.toLowerCase().startsWith(prefix)) {
        const t = saveTimeoutRef.current.get(p);
        if (t) { clearTimeout(t); saveTimeoutRef.current.delete(p); }
        filesRef.current.delete(p);
        removeFrom(setDirtyPaths, p);
        removeFrom(setDeletedPaths, p);
        mruRef.current = mruRef.current.filter((x) => x !== p);
      }
    }
    setOpenPaths((prev) => {
      const remaining = prev.filter((p) => !(p === target || p.toLowerCase().startsWith(prefix)));
      setActiveFileState((cur) => {
        if (cur && remaining.includes(cur)) return cur;
        return mruRef.current.find((p) => remaining.includes(p)) ?? remaining[remaining.length - 1] ?? null;
      });
      return remaining;
    });
    await refreshDir(dirName(target));
  }, [openPaths, refreshDir]);

  // ---- editing ----

  /** Called on every keystroke by Monaco or Milkdown. Ref only; React sees dirty transitions. */
  const updateContent = useCallback((filePath: string, newContent: string) => {
    const f = filesRef.current.get(filePath);
    if (!f || f.isUnsupported) return;
    f.content = newContent;
    setDirty(filePath, newContent !== f.savedContent);
    if (!deletedPaths.has(filePath)) scheduleSave(filePath);
  }, [setDirty, scheduleSave, deletedPaths]);

  /**
   * Replace a file's text from outside the editor (disk change, snapshot restore,
   * review decisions). Editors listen to `reloads` and apply the new text with a
   * minimal diff so the cursor stays put.
   */
  const applyExternalContent = useCallback((filePath: string, newContent: string, firstChangedLine: number | null = null) => {
    const f = filesRef.current.get(filePath);
    if (!f) return;
    f.content = newContent;
    f.savedContent = newContent;
    setDirty(filePath, false);
    const t = saveTimeoutRef.current.get(filePath);
    if (t) { clearTimeout(t); saveTimeoutRef.current.delete(filePath); }
    setReloads((prev) => {
      const next = new Map(prev);
      next.set(filePath, { version: (prev.get(filePath)?.version ?? 0) + 1, firstChangedLine });
      return next;
    });
  }, [setDirty]);

  // ---- watcher ----

  const handleFileChange = useCallback(async (event: FileChangeEvent) => {
    let { eventType } = event;

    // A write done as replace-by-rename can arrive as an unlink with no matching add
    // (notably for a file watched on its own). Only believe a delete if the file is
    // still gone after the writer has had a moment to finish.
    if (eventType === 'unlink') {
      await new Promise((r) => setTimeout(r, 300));
      if (await window.drafting.pathExists(event.filePath).catch(() => false)) eventType = 'change';
    }

    if (eventType === 'addDir' || eventType === 'unlinkDir') {
      void refreshDir(dirName(event.filePath));
      return;
    }

    // The watcher may spell the path differently from the store (case, separators).
    // Resolve to the store's own key; fall back to the event's spelling.
    const storeKey = findKey(filesRef.current.keys(), event.filePath);
    const filePath = storeKey ?? event.filePath;

    if (eventType === 'add') {
      void refreshDir(dirName(filePath));
      // A file we thought was deleted has come back (rename undone, or rewritten,
      // including a write done as delete-then-add). Read the flag through a ref:
      // the unlink that set it may not have re-rendered this callback yet.
      const deletedKey = findKey(deletedPathsRef.current, filePath);
      if (deletedKey) {
        deletedPathsRef.current.delete(deletedKey);
        removeFrom(setDeletedPaths, deletedKey);
        try {
          const content = await window.drafting.readFile(deletedKey);
          applyExternalContent(deletedKey, content);
        } catch { /* ignore */ }
      }
      return;
    }
    if (eventType === 'unlink') {
      void refreshDir(dirName(filePath));
      if (storeKey) {
        const t = saveTimeoutRef.current.get(storeKey);
        if (t) { clearTimeout(t); saveTimeoutRef.current.delete(storeKey); }
        deletedPathsRef.current.add(storeKey);
        setDeletedPaths((prev) => { if (prev.has(storeKey)) return prev; const n = new Set(prev); n.add(storeKey); return n; });
      }
      return;
    }

    // 'change'
    const f = storeKey ? filesRef.current.get(storeKey) : undefined;
    if (!f || f.isUnsupported) {
      // Not an open document: fine for most files in the folder, but say so if it
      // looks like a document we hold under another spelling.
      if (!storeKey && /\.(md|markdown|txt)$/i.test(filePath) && filesRef.current.size > 0) {
        window.drafting.writeLog(`[watcher] change for a file that is not open: ${filePath}; open: ${Array.from(filesRef.current.keys()).join(' | ')}`);
      }
      return;
    }
    // The file is evidently back on disk; drop a stale 'deleted' flag.
    if (deletedPathsRef.current.delete(filePath)) removeFrom(setDeletedPaths, filePath);
    let disk: string;
    try {
      disk = await window.drafting.readFile(filePath);
    } catch (err) {
      console.error('Reload failed:', err);
      return;
    }
    if (disk === f.content) {
      // Nothing to do (our own write echoed late, or an identical rewrite).
      if (f.savedContent !== disk) { f.savedContent = disk; setDirty(filePath, false); }
      return;
    }
    const before = f.content;
    if (before !== f.savedContent) {
      // Unsaved edits here: do not clobber them.
      setPendingChanges((prev) => { const n = new Map(prev); n.set(filePath, { path: filePath, kind: 'conflict', before, after: disk, at: Date.now() }); return n; });
      return;
    }
    // Clean file: take the disk version, keep the previous text for review.
    applyExternalContent(filePath, disk);
    setPendingChanges((prev) => { const n = new Map(prev); n.set(filePath, { path: filePath, kind: 'applied', before, after: disk, at: Date.now() }); return n; });
  }, [refreshDir, applyExternalContent, setDirty]);

  useEffect(() => { deletedPathsRef.current = new Set(deletedPaths); }, [deletedPaths]);

  const handleFileChangeRef = useRef(handleFileChange);
  useEffect(() => { handleFileChangeRef.current = handleFileChange; }, [handleFileChange]);
  useEffect(() => window.drafting.onFileChange((e) => { void handleFileChangeRef.current(e); }), []);

  // Open documents outside the watched folder (opened by dialog, or restored from a
  // session) are invisible to the folder watch; have the main process follow them too.
  useEffect(() => {
    const outside = openPaths.filter((p) => !rootPath || !isUnder(rootPath, p));
    window.drafting.watchExtraFiles(outside);
  }, [openPaths, rootPath]);

  // ---- pending change decisions ----

  const dismissChange = useCallback((filePath: string) => {
    setPendingChanges((prev) => { if (!prev.has(filePath)) return prev; const n = new Map(prev); n.delete(filePath); return n; });
  }, []);

  /** Conflict: take what is on disk, discarding unsaved edits. */
  const takeDisk = useCallback((filePath: string) => {
    const pc = pendingChanges.get(filePath);
    if (!pc) return;
    applyExternalContent(filePath, pc.after);
    dismissChange(filePath);
  }, [pendingChanges, applyExternalContent, dismissChange]);

  /** Conflict: keep the editor's text and write it to disk now so Claude sees it. */
  const keepMine = useCallback(async (filePath: string) => {
    dismissChange(filePath);
    await writeNow(filePath);
  }, [dismissChange, writeNow]);

  /** Applied change: put the previous text back and write it, undoing the external edit. */
  const revertApplied = useCallback(async (filePath: string) => {
    const pc = pendingChanges.get(filePath);
    if (!pc) return;
    applyExternalContent(filePath, pc.before);
    const f = filesRef.current.get(filePath);
    if (f) { f.savedContent = ' '; } // force the write
    dismissChange(filePath);
    await writeNow(filePath);
  }, [pendingChanges, applyExternalContent, dismissChange, writeNow]);

  /** Review outcome: the user edited the diff's modified side; that text wins. */
  const acceptReviewed = useCallback(async (filePath: string, text: string) => {
    applyExternalContent(filePath, text);
    const f = filesRef.current.get(filePath);
    if (f) { f.savedContent = ' '; }
    dismissChange(filePath);
    await writeNow(filePath);
  }, [applyExternalContent, dismissChange, writeNow]);

  // ---- deleted-file decisions ----

  const keepDeleted = useCallback(async (filePath: string) => {
    removeFrom(setDeletedPaths, filePath);
    const f = filesRef.current.get(filePath);
    if (f) { f.savedContent = ' '; }
    await writeNow(filePath);
    await refreshDir(dirName(filePath));
  }, [writeNow, refreshDir]);

  return {
    rootPath,
    listings,
    openPaths,
    activeFile,
    dirtyPaths,
    deletedPaths,
    pendingChanges,
    reloads,
    saveStates,
    lastSavedAt,
    // content access
    getContent,
    getFileState,
    // folders
    openFolder,
    setRoot,
    listDir,
    refreshDir,
    refreshTree,
    // files
    openFile,
    openFilesBatch,
    openFileFromDialog,
    newFileFromDialog,
    createFileIn,
    createFolderIn,
    renameEntry,
    trashEntry,
    closeFile,
    closeOthers,
    activate,
    // editing
    updateContent,
    saveFile,
    saveAllDirty,
    applyExternalContent,
    // external changes
    dismissChange,
    takeDisk,
    keepMine,
    revertApplied,
    acceptReviewed,
    keepDeleted,
  };
}

export type FileSystemApi = ReturnType<typeof useFileSystem>;
