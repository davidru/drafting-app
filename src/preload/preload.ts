import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC, FileEntry, FileChangeEvent, SnapshotInfo, BatchReadResult, AppSettings, AppCommand, MatterContext, TrackerToday,
} from '../shared/types';

type Unsubscribe = () => void;

function on<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

export interface DraftingAPI {
  // File operations
  readFile: (filePath: string) => Promise<string>;
  readFiles: (paths: string[]) => Promise<BatchReadResult[]>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  listDirectory: (dirPath: string) => Promise<FileEntry[]>;
  openDirectoryDialog: (defaultPath?: string) => Promise<string | null>;
  openFileDialog: (defaultPath?: string) => Promise<string[] | null>;
  createFile: (filePath: string) => Promise<void>;
  createDirectory: (dirPath: string) => Promise<void>;
  newFileDialog: (defaultDir?: string) => Promise<string | null>;
  sniffBinary: (filePath: string) => Promise<boolean>;
  renamePath: (from: string, to: string) => Promise<void>;
  trashPath: (target: string) => Promise<void>;
  revealPath: (target: string) => void;
  pathExists: (target: string) => Promise<boolean>;

  // Snapshots
  saveSnapshot: (filePath: string, label?: string) => Promise<SnapshotInfo>;
  listSnapshots: (filePath: string) => Promise<SnapshotInfo[]>;
  readSnapshot: (snapshotPath: string) => Promise<string>;
  restoreSnapshot: (snapshotPath: string, targetPath: string) => Promise<string>;
  deleteSnapshot: (snapshotPath: string) => Promise<void>;

  // File watcher
  startWatching: (dirPath: string) => void;
  stopWatching: () => void;
  /** Open files that sit outside the watched folder; the watcher follows these too. */
  watchExtraFiles: (filePaths: string[]) => void;
  onFileChange: (callback: (event: FileChangeEvent) => void) => Unsubscribe;

  // Terminal
  createTerminal: (cwd?: string) => void;
  sendTerminalInput: (data: string) => void;
  resizeTerminal: (cols: number, rows: number) => void;
  disposeTerminal: () => void;
  restartTerminal: (cwd?: string) => void;
  onTerminalData: (callback: (data: string) => void) => Unsubscribe;
  onTerminalStopped: (callback: () => void) => Unsubscribe;

  // App-level commands from the menu, and the close handshake
  onAppCommand: (callback: (command: AppCommand, payload?: string) => void) => Unsubscribe;
  flushDone: () => void;

  // Settings
  getSettings: () => Promise<AppSettings>;
  updateSettings: (patch: unknown) => Promise<AppSettings>;
  onSettingsChanged: (callback: (settings: AppSettings) => void) => Unsubscribe;
  pickDirectory: (current?: string) => Promise<string | null>;

  // Diagnostics
  writeLog: (message: string) => void;

  // Time tracking (external time tracker)
  setActiveDocument: (filePath: string | null, rootPath: string | null) => void;
  getMatterContext: (filePath: string | null) => Promise<MatterContext>;
  setMatter: (filePath: string | null, matterId: string | null, scope: 'file' | 'folder') => Promise<string | null>;
  trackerToday: (filePath: string | null) => Promise<TrackerToday>;
}

const api: DraftingAPI = {
  readFile: (filePath) => ipcRenderer.invoke(IPC.FILE_READ, filePath),
  readFiles: (paths) => ipcRenderer.invoke(IPC.FILE_READ_BATCH, paths),
  writeFile: (filePath, content) => ipcRenderer.invoke(IPC.FILE_WRITE, filePath, content),
  listDirectory: (dirPath) => ipcRenderer.invoke(IPC.FILE_LIST, dirPath),
  openDirectoryDialog: (defaultPath) => ipcRenderer.invoke(IPC.FILE_OPEN_DIALOG, defaultPath),
  openFileDialog: (defaultPath) => ipcRenderer.invoke(IPC.FILE_OPEN_FILE_DIALOG, defaultPath),
  createFile: (filePath) => ipcRenderer.invoke(IPC.FILE_CREATE, filePath),
  createDirectory: (dirPath) => ipcRenderer.invoke(IPC.FILE_MKDIR, dirPath),
  newFileDialog: (defaultDir) => ipcRenderer.invoke(IPC.FILE_NEW_DIALOG, defaultDir),
  sniffBinary: (filePath) => ipcRenderer.invoke(IPC.FILE_SNIFF, filePath),
  renamePath: (from, to) => ipcRenderer.invoke(IPC.FILE_RENAME, from, to),
  trashPath: (target) => ipcRenderer.invoke(IPC.FILE_TRASH, target),
  revealPath: (target) => ipcRenderer.send(IPC.FILE_REVEAL, target),
  pathExists: (target) => ipcRenderer.invoke(IPC.FILE_EXISTS, target),

  saveSnapshot: (filePath, label) => ipcRenderer.invoke(IPC.SNAPSHOT_SAVE, filePath, label),
  listSnapshots: (filePath) => ipcRenderer.invoke(IPC.SNAPSHOT_LIST, filePath),
  readSnapshot: (snapshotPath) => ipcRenderer.invoke(IPC.SNAPSHOT_READ, snapshotPath),
  restoreSnapshot: (snapshotPath, targetPath) => ipcRenderer.invoke(IPC.SNAPSHOT_RESTORE, snapshotPath, targetPath),
  deleteSnapshot: (snapshotPath) => ipcRenderer.invoke(IPC.SNAPSHOT_DELETE, snapshotPath),

  startWatching: (dirPath) => ipcRenderer.send(IPC.WATCHER_START, dirPath),
  stopWatching: () => ipcRenderer.send(IPC.WATCHER_STOP),
  watchExtraFiles: (filePaths) => ipcRenderer.send(IPC.WATCHER_SET_EXTRA, filePaths),
  onFileChange: (callback) => on<FileChangeEvent>(IPC.WATCHER_EVENT, callback),

  createTerminal: (cwd) => ipcRenderer.send(IPC.TERMINAL_CREATE, cwd),
  sendTerminalInput: (data) => ipcRenderer.send(IPC.TERMINAL_INPUT, data),
  resizeTerminal: (cols, rows) => ipcRenderer.send(IPC.TERMINAL_RESIZE, cols, rows),
  disposeTerminal: () => ipcRenderer.send(IPC.TERMINAL_DISPOSE),
  restartTerminal: (cwd) => ipcRenderer.send(IPC.TERMINAL_RESTART, cwd),
  onTerminalData: (callback) => on<string>(IPC.TERMINAL_DATA, callback),
  onTerminalStopped: (callback) => on<void>(IPC.TERMINAL_STOPPED, () => callback()),

  onAppCommand: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, command: AppCommand, payload?: string) => callback(command, payload);
    ipcRenderer.on(IPC.APP_COMMAND, handler);
    return () => ipcRenderer.removeListener(IPC.APP_COMMAND, handler);
  },
  flushDone: () => ipcRenderer.send(IPC.APP_FLUSH_DONE),

  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  onSettingsChanged: (callback) => on<AppSettings>(IPC.SETTINGS_CHANGED, callback),
  pickDirectory: (current) => ipcRenderer.invoke(IPC.SETTINGS_PICK_DIR, current),

  writeLog: (message) => ipcRenderer.send(IPC.LOG_WRITE, message),

  setActiveDocument: (filePath, rootPath) => ipcRenderer.send(IPC.TRACKER_ACTIVE_DOC, filePath, rootPath),
  getMatterContext: (filePath) => ipcRenderer.invoke(IPC.TRACKER_GET_MATTER_CONTEXT, filePath),
  setMatter: (filePath, matterId, scope) => ipcRenderer.invoke(IPC.TRACKER_SET_MATTER, filePath, matterId, scope),
  trackerToday: (filePath) => ipcRenderer.invoke(IPC.TRACKER_TODAY, filePath),
};

contextBridge.exposeInMainWorld('drafting', api);
