import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../shared/types';
import {
  readFile, readFiles, writeFile, createFile, createDirectory, renamePath, trashPath, revealPath, pathExists,
  listDirectory, openDirectoryDialog, openFileDialog, newFileDialog, isBinaryByMagic,
} from './file-manager';
import { startWatching, stopWatching, setExtraWatched, markEditorWrite } from './file-watcher';
import { createTerminal, writeToTerminal, resizeTerminal, disposeTerminal, restartTerminal } from './pty-manager';
import { saveSnapshot, listSnapshots, readSnapshot, restoreSnapshot, deleteSnapshot } from './snapshot-manager';
import { setActiveDocument, matterAssignmentChanged, todayFor } from './time-tracker';
import { matterContext, resolveMatterId, setMatter } from './matter-map';
import { getSettings, updateSettings, onSettingsChanged } from './settings';

const LOG_MAX_BYTES = 1024 * 1024;

/** Append to renderer.log in userData, rotating once it passes 1 MB. */
function appendLog(message: string): void {
  try {
    const logPath = path.join(app.getPath('userData'), 'renderer.log');
    try {
      if (fs.statSync(logPath).size > LOG_MAX_BYTES) {
        fs.renameSync(logPath, logPath + '.1');
      }
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf-8');
  } catch {
    /* logging must never throw */
  }
}

let offSettings: (() => void) | null = null;

export function registerIpcHandlers(window: BrowserWindow): void {
  // ---- settings ----
  ipcMain.handle(IPC.SETTINGS_GET, async () => getSettings());
  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: unknown) => updateSettings(patch));
  ipcMain.handle(IPC.SETTINGS_PICK_DIR, async (_e, current?: string) => openDirectoryDialog(window, current || undefined));
  offSettings = onSettingsChanged((s) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.SETTINGS_CHANGED, s);
  });

  // ---- time tracking ----
  ipcMain.handle(IPC.TRACKER_GET_MATTER_CONTEXT, async (_e, filePath: string | null) => matterContext(filePath));
  ipcMain.handle(IPC.TRACKER_SET_MATTER, async (_e, filePath: string | null, matterId: string | null, scope: 'file' | 'folder') => {
    if (!filePath) return null;
    setMatter(filePath, matterId, scope);
    matterAssignmentChanged();
    return resolveMatterId(filePath);
  });
  ipcMain.handle(IPC.TRACKER_TODAY, async (_e, filePath: string | null) => todayFor(filePath));
  ipcMain.on(IPC.TRACKER_ACTIVE_DOC, (_e, filePath: string | null, rootPath: string | null) => {
    setActiveDocument(filePath, rootPath);
  });

  // ---- files ----
  ipcMain.handle(IPC.FILE_READ, async (_e, filePath: string) => readFile(filePath));
  ipcMain.handle(IPC.FILE_READ_BATCH, async (_e, paths: string[]) => readFiles(paths));
  ipcMain.handle(IPC.FILE_WRITE, async (_e, filePath: string, content: string) => {
    markEditorWrite(filePath, content);
    return writeFile(filePath, content);
  });
  ipcMain.handle(IPC.FILE_LIST, async (_e, dirPath: string) => listDirectory(dirPath));
  ipcMain.handle(IPC.FILE_OPEN_DIALOG, async (_e, defaultPath?: string) => openDirectoryDialog(window, defaultPath));
  ipcMain.handle(IPC.FILE_OPEN_FILE_DIALOG, async (_e, defaultPath?: string) => openFileDialog(window, defaultPath));
  ipcMain.handle(IPC.FILE_CREATE, async (_e, filePath: string) => createFile(filePath));
  ipcMain.handle(IPC.FILE_NEW_DIALOG, async (_e, defaultDir?: string) => newFileDialog(window, defaultDir));
  ipcMain.handle(IPC.FILE_SNIFF, async (_e, filePath: string) => isBinaryByMagic(filePath));
  ipcMain.handle(IPC.FILE_RENAME, async (_e, from: string, to: string) => renamePath(from, to));
  ipcMain.handle(IPC.FILE_TRASH, async (_e, target: string) => trashPath(target));
  ipcMain.handle(IPC.FILE_MKDIR, async (_e, dirPath: string) => createDirectory(dirPath));
  ipcMain.handle(IPC.FILE_EXISTS, async (_e, target: string) => pathExists(target));
  ipcMain.on(IPC.FILE_REVEAL, (_e, target: string) => revealPath(target));

  // ---- snapshots ----
  ipcMain.handle(IPC.SNAPSHOT_SAVE, async (_e, filePath: string, label?: string) => saveSnapshot(filePath, label));
  ipcMain.handle(IPC.SNAPSHOT_LIST, async (_e, filePath: string) => listSnapshots(filePath));
  ipcMain.handle(IPC.SNAPSHOT_READ, async (_e, snapshotPath: string) => readSnapshot(snapshotPath));
  ipcMain.handle(IPC.SNAPSHOT_RESTORE, async (_e, snapshotPath: string, targetPath: string) => {
    const content = await restoreSnapshot(snapshotPath, targetPath);
    markEditorWrite(targetPath, content);
    return content;
  });
  ipcMain.handle(IPC.SNAPSHOT_DELETE, async (_e, snapshotPath: string) => deleteSnapshot(snapshotPath));

  // ---- watcher ----
  ipcMain.on(IPC.WATCHER_START, (_e, dirPath: string) => startWatching(dirPath, window));
  ipcMain.on(IPC.WATCHER_STOP, () => stopWatching());
  ipcMain.on(IPC.WATCHER_SET_EXTRA, (_e, paths: string[]) => setExtraWatched(Array.isArray(paths) ? paths.filter((p) => typeof p === 'string') : []));

  // ---- terminal ----
  ipcMain.on(IPC.TERMINAL_CREATE, (_e, cwd?: string) => createTerminal(window, cwd));
  ipcMain.on(IPC.TERMINAL_INPUT, (_e, data: string) => writeToTerminal(data));
  ipcMain.on(IPC.TERMINAL_RESIZE, (_e, cols: number, rows: number) => resizeTerminal(cols, rows));
  ipcMain.on(IPC.TERMINAL_DISPOSE, () => disposeTerminal());
  ipcMain.on(IPC.TERMINAL_RESTART, (_e, cwd?: string) => restartTerminal(window, cwd));

  // ---- diagnostics ----
  ipcMain.on(IPC.LOG_WRITE, (_e, message: string) => appendLog(message));
}

export function cleanupIpcHandlers(): void {
  for (const channel of [
    IPC.SETTINGS_GET, IPC.SETTINGS_SET, IPC.SETTINGS_PICK_DIR,
    IPC.TRACKER_GET_MATTER_CONTEXT, IPC.TRACKER_SET_MATTER, IPC.TRACKER_TODAY,
    IPC.FILE_READ, IPC.FILE_READ_BATCH, IPC.FILE_WRITE, IPC.FILE_LIST, IPC.FILE_OPEN_DIALOG,
    IPC.FILE_OPEN_FILE_DIALOG, IPC.FILE_CREATE, IPC.FILE_NEW_DIALOG, IPC.FILE_SNIFF,
    IPC.FILE_RENAME, IPC.FILE_TRASH, IPC.FILE_MKDIR, IPC.FILE_EXISTS,
    IPC.SNAPSHOT_SAVE, IPC.SNAPSHOT_LIST, IPC.SNAPSHOT_READ, IPC.SNAPSHOT_RESTORE, IPC.SNAPSHOT_DELETE,
  ]) {
    ipcMain.removeHandler(channel);
  }
  for (const channel of [
    IPC.TRACKER_ACTIVE_DOC, IPC.FILE_REVEAL, IPC.WATCHER_START, IPC.WATCHER_STOP, IPC.WATCHER_SET_EXTRA,
    IPC.TERMINAL_CREATE, IPC.TERMINAL_INPUT, IPC.TERMINAL_RESIZE, IPC.TERMINAL_DISPOSE, IPC.TERMINAL_RESTART,
    IPC.LOG_WRITE,
  ]) {
    ipcMain.removeAllListeners(channel);
  }
  if (offSettings) { offSettings(); offSettings = null; }
  stopWatching();
  disposeTerminal();
}
