// Shared types for IPC communication between main and renderer.

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

export type FileChangeType = 'change' | 'add' | 'unlink' | 'addDir' | 'unlinkDir';

export interface FileChangeEvent {
  filePath: string;
  eventType: FileChangeType;
}

export interface BatchReadResult {
  path: string;
  content?: string;
  error?: string;
}

export interface SnapshotInfo {
  id: string;
  filePath: string;
  timestamp: string;
  label: string;
  snapshotPath: string;
}

export interface MatterOption {
  id: string;
  client: string;
  name: string;
  label: string;
  billable: boolean;
}

export interface MatterContext {
  matters: MatterOption[];
  matterId: string | null;
  /** Where the current assignment comes from, so the UI can say "set on folder X". */
  source: 'file' | 'folder' | null;
  sourcePath: string | null;
}

export interface TrackerToday {
  /** Active seconds recorded today on the given document. */
  documentSeconds: number;
  /** Active seconds recorded today across all documents. */
  totalSeconds: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePreference = 'system' | 'dark' | 'light';
export type ExternalChangeCursor = 'keep' | 'first-change' | 'end';
export type ViewMode = 'raw' | 'preview';

export interface AppSettings {
  theme: ThemePreference;
  editor: {
    fontFamily: string;
    fontSize: number;
    /** 0 = wrap at the viewport edge; otherwise wrap at this column. */
    wrapColumn: number;
    autosaveDelayMs: number;
    defaultView: ViewMode;
    showLineNumbers: boolean;
  };
  externalChange: {
    /** Where the cursor goes after a file is reloaded because it changed on disk. */
    cursor: ExternalChangeCursor;
    /** Keep the previous text so the change can be reviewed as a diff. */
    offerReview: boolean;
  };
  terminal: {
    /** Command typed into the shell after it starts. Empty string disables auto-launch. */
    launchCommand: string;
    /** Shell executable; empty string = platform default. */
    shell: string;
    fontFamily: string;
    fontSize: number;
  };
  timeTracking: {
    enabled: boolean;
    /** Folder that holds the time tracker's app-state.json and receives drafter-*.json. */
    dir: string;
  };
  prompts: {
    /** Templates. Available tokens: {path} {relpath} {name} {selection} {lines} */
    sendToClaude: string;
    proofread: string;
  };
  sidebar: {
    width: number;
    visible: boolean;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  editor: {
    fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
    fontSize: 14,
    wrapColumn: 0,
    autosaveDelayMs: 500,
    defaultView: 'preview',
    showLineNumbers: true,
  },
  externalChange: {
    cursor: 'keep',
    offerReview: true,
  },
  terminal: {
    launchCommand: 'claude --dangerously-skip-permissions',
    shell: '',
    fontFamily: 'Cascadia Code, Consolas, "Courier New", monospace',
    fontSize: 14,
  },
  timeTracking: {
    enabled: true,
    dir: '',
  },
  prompts: {
    sendToClaude: 'Edit @{relpath} ',
    proofread:
      'Proofread @{relpath}. Fix typos, grammar and punctuation. Check that defined terms are used consistently and that every cross-reference points to a clause that exists. Do not change the substance. Make the edits in place and then summarise what you changed.',
  },
  sidebar: {
    width: 260,
    visible: true,
  },
};

// ---------------------------------------------------------------------------
// Commands the main-process menu can ask the renderer to run.
// ---------------------------------------------------------------------------

export type AppCommand =
  | 'file.save'
  | 'file.saveAll'
  | 'file.new'
  | 'file.open'
  | 'folder.open'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | 'view.palette'
  | 'view.quickOpen'
  | 'view.settings'
  | 'view.toggleSidebar'
  | 'view.togglePreview'
  | 'view.focusToggle'
  | 'review.changes'
  | 'claude.send'
  | 'claude.proofread'
  | 'terminal.restart'
  | 'app.flushRequest'
  // With a payload (path). Used by scripted checks; harmless otherwise.
  | 'folder.openPath'
  | 'file.openPath';

// ---------------------------------------------------------------------------
// IPC channel names
// ---------------------------------------------------------------------------

export const IPC = {
  // File operations
  FILE_READ: 'file:read',
  FILE_READ_BATCH: 'file:read-batch',
  FILE_WRITE: 'file:write',
  FILE_LIST: 'file:list',
  FILE_OPEN_DIALOG: 'file:open-dialog',
  FILE_OPEN_FILE_DIALOG: 'file:open-file-dialog',
  FILE_CREATE: 'file:create',
  FILE_NEW_DIALOG: 'file:new-dialog',
  FILE_SNIFF: 'file:sniff',
  FILE_RENAME: 'file:rename',
  FILE_TRASH: 'file:trash',
  FILE_MKDIR: 'file:mkdir',
  FILE_REVEAL: 'file:reveal',
  FILE_EXISTS: 'file:exists',

  // File watcher
  WATCHER_START: 'watcher:start',
  WATCHER_STOP: 'watcher:stop',
  WATCHER_SET_EXTRA: 'watcher:set-extra',
  WATCHER_EVENT: 'watcher:event',

  // Terminal
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_DATA: 'terminal:data',
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DISPOSE: 'terminal:dispose',
  TERMINAL_STOPPED: 'terminal:stopped',
  TERMINAL_RESTART: 'terminal:restart',

  // App-level commands forwarded from the main process menu, and the close handshake
  APP_COMMAND: 'app:command',
  APP_FLUSH_DONE: 'app:flush-done',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_CHANGED: 'settings:changed',
  SETTINGS_PICK_DIR: 'settings:pick-dir',

  // Diagnostics
  LOG_WRITE: 'log:write',

  // Time tracking (external time tracker)
  TRACKER_ACTIVE_DOC: 'tracker:active-doc',
  TRACKER_GET_MATTER_CONTEXT: 'tracker:get-matter-context',
  TRACKER_SET_MATTER: 'tracker:set-matter',
  TRACKER_TODAY: 'tracker:today',

  // Snapshots
  SNAPSHOT_SAVE: 'snapshot:save',
  SNAPSHOT_LIST: 'snapshot:list',
  SNAPSHOT_READ: 'snapshot:read',
  SNAPSHOT_RESTORE: 'snapshot:restore',
  SNAPSHOT_DELETE: 'snapshot:delete',
} as const;
