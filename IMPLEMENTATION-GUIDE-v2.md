# Drafting App v2 — Implementation Guide for an LLM

This document is a complete, self-contained specification for rebuilding the Drafting App v2 from nothing. It is written for a language model that will be given this file and an empty folder, and asked to produce a working application. Every behaviour, constant, contract and gotcha that the working build depends on is stated here. Where a detail is not stated, use the simplest choice that keeps the stated invariants.

**Provenance.** Written from a full read of every source file of an earlier revision of this project: all of `src/`, the build configuration, `package.json`, the scripts, `README.md` and `CLAUDE.md`. The checks (`npm run check`: tsc, eslint, vitest) passed on that revision. Later changes to the watcher (watching open files that live outside the opened folder, debouncing delete events, normalising watcher paths) and the path-key helper are not described here; where this guide and the source disagree, the source wins. Older documents from the Copilot era (dark-only, split-pane) have been removed from this repository and are not a reference.

---

## Part 0 — How to use this guide

1. Read Part 1 (what the product is) and Part 2 (the invariants). The invariants are the point of the app; every later section exists to satisfy them.
2. Build in the order given in Part 11. Each step ends with something runnable.
3. Copy the code blocks marked **verbatim** exactly: the shared type contract, the design tokens, the diff algorithm and its tests. These are load-bearing.
4. Run `npm run check` after every step. It must be clean (0 errors) before the app is considered done.
5. Before declaring completion, walk the acceptance checklist in Part 12.

---

## Part 1 — What the product is

A Windows-first Electron desktop app for a lawyer who drafts documents in Markdown alongside Claude Code. The window has a document editor on the left and a terminal running `claude` on the right. Both operate on the same folder on disk. The user edits; Claude edits; neither side's work is ever lost silently.

Four promises, in the README's words:

- **You edit, Claude sees it.** Documents autosave. Unsaved files are flushed the moment the user turns to Claude (clicks into the terminal, presses Send to Claude), so Claude always reads the latest text.
- **Claude edits, you see it.** A file watcher reloads changed documents with a minimal line edit, so cursor, scroll and undo history survive. A "changed on disk" banner offers a side-by-side diff review where individual changes can be undone.
- **Nothing is lost silently.** Writes are atomic. Unsaved files are flushed before the window closes. Unsaved edits are never overwritten by a disk change (they become a conflict the user resolves). A file deleted on disk is not quietly re-created.
- **Time is recorded per document** for an external time tracker, with a matter chosen from the Document card.

### Layout

```
┌ Sidebar (dark navy, 260px) ─┬──────────────────────────────────────────────────────────────┐
│ [D] Drafting          [⊟]   │ topbar: (Tab pill)(Tab pill) + New              [⌘] [◐] [⚙]    │
│ [🔍 Search documents… Ctrl+P]│ ┌ Title card: "Services Agreement" .md   folder ┐ ┌ Document ──────┐│
│ DOCUMENTS        [+][+📁][↻]│ ├ Toolbar: Snapshot|⏱|Paragraph▾|B I S <>|…|Visual|Text ┤ │ Status: Saved  ││
│  ▾ Correspondence           │ │ (banner: changed on disk / conflict / deleted)  │ │ Matter: … Edit ││
│     Cover letter            │ │                                                 │ │ Time today: …  ││
│  Services Agreement ●       │ │   editor: Milkdown (Visual) or Monaco (Text)    │ │ Length: 1,204 w││
│                             │ │                                                 │ │ Snapshots: 2   ││
│                             │ │                                                 │ │ [Proofread][Send to Claude]│
│                             │ ├ foot: Ln 12, Col 4            Markdown ────────┤ ├ Claude ────────┤│
│                             │ └─────────────────────────────────────────────────┘ │ ● Claude  in X ↻││
│ [📁 testdocs  C:\…      ›]  │                       ║ divider ║                     │ xterm terminal ││
└─────────────────────────────┴──────────────────────────────────────────────────────┴────────────────┘
```

- Left: a dark sidebar (dark in both themes) with brand, a search button that opens Quick Open, a Documents tree, and a folder button at the bottom.
- Centre column (`column-main`, width = `splitRatio` of the body): a Title card, then the Editor card (toolbar, optional snapshot list, optional banners, the editor area, a footer in Text mode). When no file is open, an Empty card.
- A 16px draggable divider.
- Right column (`column-side`): the Document card (status, matter, time, length, snapshots, two action buttons) and the Claude card (terminal) filling the rest.
- Overlays: command palette / quick open, settings dialog, context menus, popovers, toasts, and the diff review which covers the editor area.

Markdown documents open in **Visual** (Milkdown Crepe, editable rendered view) by default; **Text** shows raw markdown in Monaco. One toolbar drives both. The default view is a setting.

---

## Part 2 — Invariants (do not violate)

1. **Document text lives in a ref, not React state.** A `Map<path, {content, savedContent, isUnsupported}>` held in `useRef`. Keystrokes mutate the ref and never trigger a React render. React state only sees dirty/clean transitions, open/close, active file, and a `reloads` version bump.
2. **The store is the source of truth for text.** The Monaco model for a file is reconciled against the store every time it is attached, because the Visual editor may have edited the store while Monaco was hidden.
3. **External text arrives through one function**, `applyExternalContent(path, text, firstChangedLine?)`, which updates the store, marks the file clean, cancels any pending autosave, and bumps `reloads[path].version`. Editors watch `reloads` and apply the new text with **minimal line edits** (`computeLineEdits`), never a whole-document replace, so the cursor and undo stack survive.
4. **Writes are atomic** (temp file beside the target, fsync, rename; with retries for OneDrive locks) and **every editor write is registered** with the watcher (`markEditorWrite(path, content)`) so the watcher can suppress its own echo by comparing a content hash.
5. **Never clobber unsaved edits.** A disk change on a dirty file becomes a `conflict` pending change. Nothing is applied until the user chooses Review, Use disk version, or Keep mine.
6. **A clean file that changes on disk is reloaded immediately**, and the previous text is kept as an `applied` pending change so the user can Review or Revert. Ctrl+Z in Monaco also undoes it because the reload is a normal edit operation.
7. **Deleted on disk is not re-created.** An `unlink` event for an open file puts it in `deletedPaths`: autosave stops, a red banner offers "Keep and re-create" or "Close". If the file comes back (`add`), it is reloaded from disk.
8. **Monaco models are disposed when their tab closes.** Reopening reads fresh from disk.
9. **The close handshake flushes unsaved files.** Main intercepts `close`, asks the renderer to save everything, waits for an acknowledgement or 3 s, then closes.
10. **Menu accelerators are the only shortcuts that fire while the terminal has focus.** That set is deliberately small (Save, Save All, Settings, Command Palette, Ctrl+Tab/Ctrl+Shift+Tab, Ctrl+`, Ctrl+Shift+R). Every other shortcut is handled in the renderer's keydown listener and yields to the terminal so Claude Code's own keys keep working.
11. **Both themes are complete.** Every colour comes from a token defined for light and dark. Components use CSS classes, not inline styles (a handful of tiny inline style exceptions exist for dynamic values such as widths and indent).

---

## Part 3 — Stack and tooling

| Package | Version (installed, verified) | Role |
|---|---|---|
| electron | 41.0.4 (pinned exactly) | shell |
| @electron-forge/* (cli, plugin-webpack, plugin-fuses, plugin-auto-unpack-natives, makers) | 7.11.x | build/package |
| @electron/fuses | 1.8.x | fuses |
| webpack (via forge) | 5.x | bundling |
| typescript | 5.9.x | |
| react, react-dom | 19.2.x | renderer |
| monaco-editor | 0.55.1 | Text editor and diff editor |
| @milkdown/crepe, core, ctx, prose, transformer, preset-commonmark, preset-gfm, plugin-listener | 7.21.x (^7.20.0) | Visual editor |
| @xterm/xterm 6.0.0; addons fit 0.11, webgl 0.19, unicode11 0.9, web-links 0.12, search 0.16, clipboard 0.2 | | terminal |
| node-pty | 1.1.0 | PTY (native) |
| chokidar | 5.0.0 | watcher |
| diff | 9.0.0 (+ @types/diff) | line diff |
| electron-squirrel-startup | 1.0.1 | Windows installer hook |
| vitest 4.x, eslint 9.x, typescript-eslint 8.x, eslint-plugin-react-hooks 7.x, eslint-plugin-import, @eslint/js, globals | dev | checks |
| ts-loader, fork-ts-checker-webpack-plugin, css-loader, style-loader, node-loader, @vercel/webpack-asset-relocator-loader, monaco-editor-webpack-plugin (installed but **not used**) | dev | webpack |

Node 24 / npm 11 were used. Node 20+ is the stated minimum.

### package.json essentials

```json
{
  "name": "drafting-app",
  "productName": "Drafting App",
  "version": "2.0.0",
  "main": ".webpack/main",
  "private": true,
  "license": "MIT",
  "scripts": {
    "start": "electron-forge start",
    "package": "electron-forge package",
    "make": "electron-forge make",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint .",
    "test": "vitest run",
    "check": "npm run typecheck && npm run lint && npm run test",
    "postinstall": "node scripts/patch-node-pty.js"
  },
  "allowScripts": { "electron@41.0.4": true, "electron-winstaller@5.4.4": true, "node-pty@1.1.0": true }
}
```

If npm blocks install scripts: `npm install-scripts approve electron electron-winstaller node-pty`.

### tsconfig.json

`target ES2022`, `lib [ES2022, DOM, DOM.Iterable]`, `module commonjs`, `moduleResolution node`, `jsx react-jsx`, `strict`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `allowJs`, `skipLibCheck`, `esModuleInterop`, `resolveJsonModule`, `sourceMap`, `baseUrl .`, `outDir dist`, `paths {"*": ["node_modules/*"]}`. `include: ["src/**/*", "*.ts"]`, `exclude: node_modules, .webpack, out, dist`.

### webpack

- `webpack.rules.ts`: (1) `native_modules[/\\].+\.node$` → `node-loader`; (2) `[/\\]node_modules[/\\].+\.(m?js|node)$` with `parser: { amd: false }` → `@vercel/webpack-asset-relocator-loader` with `outputAssetBase: 'native_modules'`; (3) `\.tsx?$` (exclude node_modules and .webpack) → `ts-loader` with `transpileOnly: true`.
- `webpack.plugins.ts`: `plugins = [new ForkTsCheckerWebpackPlugin({ logger: 'webpack-infrastructure' })]`. `rendererPlugins = [...plugins, new DefinePlugin({ __dirname: JSON.stringify('') }), new BannerPlugin({ banner: 'var __dirname = "";', raw: true, entryOnly: false })]`. Reason: the asset relocator injects `__dirname + "/native_modules/"` into the renderer runtime chunk; the banner defines `__dirname` before any runtime code runs. **No MonacoWebpackPlugin.**
- `webpack.main.config.ts`: entry `./src/main/main.ts`, the rules, `plugins`, resolve extensions `.js .ts .jsx .tsx .css .json`, `externals: { 'node-pty': 'commonjs node-pty' }`.
- `webpack.renderer.config.ts`: push two more rules onto `rules`: `\.css$` → style-loader + css-loader; `\.ttf$` → `type: 'asset/resource'`. `target: 'web'` (required: contextIsolation + no nodeIntegration, and it stops Monaco's AMD loader fighting Node globals). `plugins: rendererPlugins`. `resolve.extensions` `.js .ts .jsx .tsx .css` and **`resolve.conditionNames: ['import', 'module', 'webpack', 'development', 'browser', 'require', 'default']`** (required for the pure-ESM `@milkdown/*` packages whose exports map only declares `import`).

### forge.config.ts

- `packagerConfig: { asar: false }`.
- `hooks.postPackage`: copy `node_modules/node-pty` recursively into `<out>/resources/app/node_modules/node-pty` (the main bundle externalises it).
- `rebuildConfig: { onlyModules: [] }` — **do not rebuild node-pty from source**; its N-API prebuilds run under Electron and rebuilding needs Python and the VS C++ toolchain.
- Makers: Squirrel, ZIP (darwin), Rpm, Deb.
- `WebpackPlugin` with `mainConfig`, a `devServer.client.overlay.runtimeErrors` filter that returns `false` for the message `ResizeObserver loop completed with undelivered notifications.`, and one renderer entry: `html ./src/renderer/index.html`, `js ./src/renderer/index.tsx`, `name main_window`, `preload.js ./src/preload/preload.ts`.
- `FusesPlugin` V1: `RunAsNode false`, `EnableCookieEncryption true`, `EnableNodeOptionsEnvironmentVariable false`, `EnableNodeCliInspectArguments false`, `EnableEmbeddedAsarIntegrityValidation false`, `OnlyLoadAppFromAsar false`.

### scripts/patch-node-pty.js (postinstall)

In `node_modules/node-pty/binding.gyp` and `node_modules/node-pty/deps/winpty/src/winpty.gyp`, replace every `'SpectreMitigation': 'Spectre'` with `'SpectreMitigation': 'false'`. If anything was patched, delete `node_modules/node-pty/build`. Log the count. Never throw.

### eslint.config.mjs

Flat config: ignore `node_modules, .webpack, out, dist`; `js.configs.recommended`; `tseslint.configs.recommended`; for `src/renderer/**/*.{ts,tsx}` enable `react-hooks` recommended rules but downgrade the React Compiler advisories (`set-state-in-effect`, `refs`, `immutability`, `purity`, `preserve-manual-memoization`) to `warn`, with browser globals; node globals for `src/main`, `src/preload`, root `*.ts`, `scripts/**/*.js`; `@typescript-eslint/no-unused-vars` warn with `^_` ignore pattern; `no-explicit-any` warn; `no-require-imports` off. Warnings are acceptable; errors are not.

### vitest.config.mts

`test.include: ['src/**/*.test.ts', 'src/**/*.test.tsx']`, `environment: 'node'`.

### Other root files

- `.gitattributes`: `* text=auto`, `*.cmd text eol=crlf`, `*.ps1 text eol=crlf`.
- `.gitignore`: standard Node ignores plus `.webpack/`, `out/`, `*.log`.
- `Rebuild-Drafting-App.cmd`: `cd` to its own folder, `npm run check` (abort on failure), `npm run package` (abort on failure), then, only if the `DEPLOY_DIR` environment variable is set, `robocopy "out\Drafting App-win32-x64" "%DEPLOY_DIR%" /MIR /NFL /NDL /NJH /NJS /NP` (abort if robocopy errorlevel ≥ 8).
- `README.md` and `CLAUDE.md`: reproduce the content summarised in Parts 1, 2 and 10 (README: purpose, layout diagram, keyboard table, settings, development, script mode, source layout, stack; CLAUDE.md: where things live, invariants, checks, design direction, style).

---

## Part 4 — Source layout

```
src/
  shared/types.ts                 contract: data types, AppSettings + defaults, AppCommand, IPC channel names
  main/
    main.ts                       window, window-state persistence, menu, theme, close handshake, script mode
    ipc-handlers.ts               registers every IPC channel; renderer.log appender
    file-manager.ts               read/write/list/dialogs/rename/trash/reveal, binary sniff
    file-watcher.ts               chokidar + content-hash echo suppression
    pty-manager.ts                node-pty spawn, restart limits, auto-launch of `claude`
    settings.ts                   settings.json in userData, deep-merge of known keys, listeners
    snapshot-manager.ts           .drafts/ snapshots beside each file
    time-tracker.ts               per-document active-time sampling → drafter-YYYY-MM-DD.json
    matter-map.ts                 document → matter mapping (drafter-matter-map.json), reads app-state.json
  preload/preload.ts              contextBridge: window.drafting (typed DraftingAPI)
  renderer/
    index.html, index.tsx, global.d.ts
    App.tsx                       composition root: session, commands, shortcuts, layout, review, prompts
    hooks/useFileSystem.ts        the document state machine
    hooks/useSettings.ts          mirror of main-process settings + theme resolution
    lib/paths.ts                  path helpers (renderer has no Node path), extension tables
    lib/textDiff.ts (+ .test.ts)  computeLineEdits / applyLineEdits / countWords
    components/
      Sidebar.tsx  TabBar.tsx  Toolbar.tsx  Editor.tsx  MilkdownPreview.tsx  DiffReview.tsx
      TerminalPane.tsx  DocumentPanel.tsx  MatterCard.tsx  CommandPalette.tsx  SettingsPanel.tsx
      ErrorBoundary.tsx  Icons.tsx  ui.tsx (ContextMenu, Popover, Toasts, IconButton, Switch, formatDuration, timeAgo)
      monacoSetup.ts              ESM Monaco import, language contributions, the two themes
    styles/global.css             all styling; tokens at the top
```

---

## Part 5 — The shared contract (`src/shared/types.ts`) — **verbatim**

```ts
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
```

### The preload API (`window.drafting`)

`contextBridge.exposeInMainWorld('drafting', api)` where `api: DraftingAPI`. Each method maps 1:1 to a channel: `invoke` for request/response, `send` for fire-and-forget, `ipcRenderer.on` wrapped so that the returned function unsubscribes.

```ts
export interface DraftingAPI {
  readFile(filePath): Promise<string>;                       // FILE_READ
  readFiles(paths: string[]): Promise<BatchReadResult[]>;    // FILE_READ_BATCH
  writeFile(filePath, content): Promise<void>;               // FILE_WRITE
  listDirectory(dirPath): Promise<FileEntry[]>;              // FILE_LIST
  openDirectoryDialog(defaultPath?): Promise<string|null>;   // FILE_OPEN_DIALOG
  openFileDialog(defaultPath?): Promise<string[]|null>;      // FILE_OPEN_FILE_DIALOG
  createFile(filePath): Promise<void>;                       // FILE_CREATE
  createDirectory(dirPath): Promise<void>;                   // FILE_MKDIR
  newFileDialog(defaultDir?): Promise<string|null>;          // FILE_NEW_DIALOG
  sniffBinary(filePath): Promise<boolean>;                   // FILE_SNIFF
  renamePath(from, to): Promise<void>;                       // FILE_RENAME
  trashPath(target): Promise<void>;                          // FILE_TRASH
  revealPath(target): void;                                  // FILE_REVEAL (send)
  pathExists(target): Promise<boolean>;                      // FILE_EXISTS

  saveSnapshot(filePath, label?): Promise<SnapshotInfo>;
  listSnapshots(filePath): Promise<SnapshotInfo[]>;
  readSnapshot(snapshotPath): Promise<string>;
  restoreSnapshot(snapshotPath, targetPath): Promise<string>;
  deleteSnapshot(snapshotPath): Promise<void>;

  startWatching(dirPath): void;  stopWatching(): void;       // send
  onFileChange(cb: (e: FileChangeEvent) => void): Unsubscribe;

  createTerminal(cwd?): void; sendTerminalInput(data): void; resizeTerminal(cols, rows): void;
  disposeTerminal(): void; restartTerminal(cwd?): void;      // all send
  onTerminalData(cb: (data: string) => void): Unsubscribe;
  onTerminalStopped(cb: () => void): Unsubscribe;

  onAppCommand(cb: (command: AppCommand, payload?: string) => void): Unsubscribe;
  flushDone(): void;                                         // APP_FLUSH_DONE (send)

  getSettings(): Promise<AppSettings>;
  updateSettings(patch: unknown): Promise<AppSettings>;
  onSettingsChanged(cb: (s: AppSettings) => void): Unsubscribe;
  pickDirectory(current?): Promise<string|null>;             // SETTINGS_PICK_DIR

  writeLog(message): void;                                   // LOG_WRITE (send)

  setActiveDocument(filePath|null, rootPath|null): void;     // TRACKER_ACTIVE_DOC (send)
  getMatterContext(filePath|null): Promise<MatterContext>;
  setMatter(filePath|null, matterId|null, scope: 'file'|'folder'): Promise<string|null>;
  trackerToday(filePath|null): Promise<TrackerToday>;
}
```

`src/renderer/global.d.ts` declares `interface Window { drafting: DraftingAPI }`.

---

## Part 6 — Main process

### 6.1 `main.ts`

- `if (require('electron-squirrel-startup')) app.quit();`
- If `process.env.DRAFTER_USER_DATA` is set, `app.setPath('userData', that)` before anything else (scratch profiles for automated checks).
- **Window state** persisted in `<userData>/window-state.json` as `{x?, y?, width, height, maximized}`; default `1440×900`, not maximized. On load, drop a saved position unless it lies within (with 50px slack) some connected display's work area. Save is debounced 400 ms on `resize`, `move`, `maximize`, `unmaximize`, and also on close. When maximized, save `getNormalBounds()`.
- `applyTheme()`: `nativeTheme.themeSource = settings.theme` ('system' | 'dark' | 'light'). Called at window creation and on every settings change.
- `BrowserWindow` options: saved bounds, `minWidth 900`, `minHeight 540`, `title 'Drafting App'`, `backgroundColor` `#16181d` if `nativeTheme.shouldUseDarkColors` else `#f6f7fa`, `show: false` then show on `ready-to-show`, `webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false /* preload needs __dirname for the asset relocator */, spellcheck: true }`. Maximize if saved so.
- Call `registerIpcHandlers(win)`, `initTimeTracker(win)`, `win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY)`. Open detached DevTools when `!app.isPackaged`.
- Forward renderer console `error`/`warning` messages to main's stdout as `[Renderer:<level>] <message>`.
- `setWindowOpenHandler`: open `http(s)` URLs with `shell.openExternal`, always `deny`.
- **Menu** (`Menu.setApplicationMenu`). `send(cmd)` = `win.webContents.send(IPC.APP_COMMAND, cmd)`. Items with `registerAccelerator: false` show the shortcut but do not bind it (the renderer handles those keys so they can yield to the terminal).
  - macOS only: `appMenu` role first, and an `editMenu` role (clipboard roles would steal Ctrl+C from the shell on Windows/Linux, so they are omitted there).
  - `&File`: New File `CmdOrCtrl+N` (no register) → `file.new`; Open File… `CmdOrCtrl+O` (no register) → `file.open`; Open Folder… `CmdOrCtrl+Shift+O` (no register) → `folder.open`; sep; Save `CmdOrCtrl+S` → `file.save`; Save All `CmdOrCtrl+Shift+S` → `file.saveAll`; sep; Close Tab `CmdOrCtrl+W` (no register) → `tab.close`; sep; Settings… `CmdOrCtrl+,` → `view.settings`; sep; `close` role on mac else `quit`.
  - `&View`: Command Palette… `CmdOrCtrl+Shift+P` → `view.palette`; Quick Open… `CmdOrCtrl+P` (no register) → `view.quickOpen`; sep; Toggle Sidebar `CmdOrCtrl+\` (no register) → `view.toggleSidebar`; Toggle Preview `CmdOrCtrl+E` (no register) → `view.togglePreview`; Switch Editor / Terminal ``CmdOrCtrl+` `` → `view.focusToggle`; Review Changes `CmdOrCtrl+Shift+R` → `review.changes`; sep; `resetZoom`, `zoomIn`, `zoomOut`; sep; `togglefullscreen`, `toggleDevTools`.
  - `&Tabs`: Next Tab `Ctrl+Tab` → `tab.next`; Previous Tab `Ctrl+Shift+Tab` → `tab.prev`.
  - `&Claude`: Send File to Claude `CmdOrCtrl+Enter` (no register) → `claude.send`; Proofread with Claude → `claude.proofread`; sep; Restart Terminal in Open Folder → `terminal.restart`.
  - `&Help`: Claude Code Documentation → open `https://docs.anthropic.com/en/docs/claude-code`; Open Settings Folder → `shell.openPath(userData)`.
- **Close handshake**: on `close`, if not already flushed: `preventDefault`, register `ipcMain.once(APP_FLUSH_DONE, finish)`, `setTimeout(finish, 3000)`, `send('app.flushRequest')`. `finish` (idempotent): remove the listener, set flushed, save window state, `win.close()`.
- On `closed`: `disposeTimeTracker()`, `cleanupIpcHandlers()`, null the window. `before-quit` → `disposeTimeTracker()`. `window-all-closed` → quit unless darwin. `activate` → create window if none. `app.on('ready')` → `createWindow(); onSettingsChanged(applyTheme)`.
- **Script mode** (developer aid; the desktop cannot be screenshotted by external tools):
  - `DRAFTER_SCREENSHOT=<file.png>` captures the page once, `DRAFTER_SCREENSHOT_DELAY_MS` (default 2500) after `did-finish-load`.
  - `DRAFTER_SHOTS="step;step;…"` runs steps after that delay. Steps: `wait:<ms>` (default 500); `shot:<name>` writes `<DRAFTER_SHOT_DIR or app temp>/<name>.png` via `webContents.capturePage().toPNG()`; `click:<css selector>` runs `document.querySelector(sel)?.click()` via `executeJavaScript` then waits 500 ms; `key:<key>` sends `keyDown`/`keyUp` input events with that `keyCode` then waits 400 ms; `cmd:<AppCommand>[=payload]` sends `APP_COMMAND` with the payload then waits 700 ms. Log `[screenshot] script finished` at the end.

### 6.2 `ipc-handlers.ts`

`registerIpcHandlers(window)` registers every channel exactly once; `cleanupIpcHandlers()` removes them all (`removeHandler` for invokes, `removeAllListeners` for sends), unsubscribes the settings listener, stops the watcher and disposes the terminal.

Non-trivial handlers:

- `FILE_WRITE(path, content)`: `markEditorWrite(path, content)` **then** `writeFile(path, content)`.
- `SNAPSHOT_RESTORE(snapshotPath, targetPath)`: restore, then `markEditorWrite(targetPath, content)`, return content.
- `SETTINGS_SET(patch)` → `updateSettings(patch)`; also subscribe `onSettingsChanged` and push `SETTINGS_CHANGED` to the window.
- `SETTINGS_PICK_DIR(current?)` → the folder dialog.
- `TRACKER_SET_MATTER(filePath, matterId, scope)`: if no path return null; `setMatter(...)`; `matterAssignmentChanged()`; return `resolveMatterId(filePath)`.
- `TRACKER_ACTIVE_DOC(filePath, rootPath)` (send) → `setActiveDocument`.
- `LOG_WRITE(message)` → append `[ISO time] message\n` to `<userData>/renderer.log`, rotating to `renderer.log.1` once it exceeds 1 MB. Never throws.
- Everything else is a direct pass-through to the module function of the same name.

### 6.3 `file-manager.ts`

- `readFile(path)`: utf-8 read.
- `isBinaryByMagic(path)`: read the first 16 bytes; true if they start with any known signature (`%PDF`, `PK\x03\x04`, `PK\x05\x06`, `Rar!\x1A\x07`, `\x1F\x8B`, JPEG `FF D8 FF`, PNG 8-byte, `GIF87a`, `GIF89a`, BMP `BM`, ICO `00 00 01 00`, PE `MZ`, ELF `7F ELF`, Mach-O `CA FE BA BE` / `CF FA ED FE`, `ID3`, `fLaC`, TIFF `II*\0` / `MM\0*`, PSD `8BPS`) or contain a NUL byte. Never throws (returns false on error).
- `readFiles(paths)`: `Promise.allSettled` of reads; returns `{path, content}` or `{path, error}` per entry.
- `writeFile(path, content)` **atomic**: write to `<dir>/.<basename>.<pid>.<base36 time>.tmp` via a file handle, `sync()`, close, then `rename` over the target. On `EPERM`/`EBUSY`/`EACCES` retry up to 5 times with delay `60ms × attempt` (OneDrive holds short locks). If still failing, fall back to a direct `fs.writeFile` and unlink the temp file, so the save is never lost.
- `createFile(path)`: mkdir -p parent; write `''` with flag `wx` (fails if exists).
- `createDirectory(path)`: mkdir -p.
- `renamePath(from, to)`: throw `"<basename> already exists"` if the target exists; `fs.rename`.
- `trashPath(target)`: `shell.trashItem` (Recycle Bin, never hard delete).
- `revealPath(target)`: `shell.showItemInFolder`. `pathExists`: `existsSync`.
- `listDirectory(dir, depth=0, maxDepth=1)`: skip names in `{.git, .DS_Store, .svn, .hg, .drafts, node_modules, Thumbs.db, desktop.ini}` and any dotfile ending `.tmp` (our temp files). For directories with `depth < maxDepth`, recurse to fill `children` (so one call returns the root and one level of grandchildren; an unreadable subdir gets `children: []`). Sort directories first, then `localeCompare` with `{numeric: true, sensitivity: 'base'}`.
- `openDirectoryDialog(win, defaultPath?)`: `openDirectory`, title "Open Folder"; null on cancel.
- `openFileDialog(win, defaultPath?)`: `openFile` + `multiSelections`, title "Open File", filters "Text Files" (`md markdown mdx txt json yaml yml xml csv html htm css js ts jsx tsx py rb rs go java c cpp h cs sh bat ps1 cfg ini conf log svg toml`) and "All Files".
- `newFileDialog(win, defaultDir?)`: save dialog titled "New File", default `<dir>/untitled.md`, filters Markdown/Text/All; on confirm mkdir -p and write an empty file; return the path.

### 6.4 `file-watcher.ts`

- One `chokidar` watcher at a time. `startWatching(dir, window)` stops any previous one, then `chokidar.watch(dir, { ignored: [ .git, .DS_Store, .svn, .hg, .drafts, node_modules (each as a path-segment regex), /(^|[/\\])\.[^/\\]*\.tmp$/ ], persistent: true, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 } })`.
- Forward `change`, `add`, `unlink`, `addDir`, `unlinkDir` to the renderer as `FileChangeEvent` on `WATCHER_EVENT`, except that a `change` is dropped when `isEditorEcho(path)` is true. Log watcher errors.
- **Echo suppression is content-based.** `recentEditorWrites: Map<path, {hash, ts}>`. `markEditorWrite(path, content)` stores `hashBuffer(utf8 bytes)` and prunes entries older than 5000 ms. `isEditorEcho(path)`: no entry or expired → false; otherwise read the file from disk, hash it, and return equal-to-stored. Read failure → false (let the renderer decide). Entries are **not** deleted on first match because Windows can emit several events for one write.
- `hashBuffer(buf)`: sha1 of the whole buffer if ≤ 64 KiB; otherwise sha1 of the first 64 KiB plus the decimal length.
- `stopWatching()` closes the watcher and clears the map.

### 6.5 `pty-manager.ts`

- State: `current: {proc, id, cwd} | null`, `nextId`, `restartCount`, `lastStartTime`. Constants: `MAX_RESTARTS 3`, `RESTART_WINDOW_MS 10000`, `AUTO_LAUNCH_DELAY_MS 1200`.
- `createTerminal(window, cwd?, autoLaunch = true)`: no-op if one exists. Rate limit: if now − lastStart < window, `restartCount++`; if it reaches 3, send `TERMINAL_STOPPED`, reset the count and return. Otherwise reset the count. Shell = `settings.terminal.shell` or (`powershell.exe` on win32, else `$SHELL` or `/bin/bash`). Cwd = given or `os.homedir()`. `pty.spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env: { ...process.env, TERM_PROGRAM: 'DraftingApp' } })`; on throw, log and send `TERMINAL_STOPPED`. Pipe `onData` to `TERMINAL_DATA`. `onExit`: if this is still the live instance, clear it and after 1000 ms call `createTerminal(window, cwd, false)` (auto-restarts **never** auto-launch, so a failing command cannot loop). If `autoLaunch` and the trimmed launch command is non-empty: after 1200 ms, if still the live instance, check the first word with `where` (win) / `which` (2 s timeout); if found write `${launch}\r`, else write `echo "<exe> was not found on PATH. Install it, or change the launch command in Settings."\r`.
- `writeToTerminal(data)`, `resizeTerminal(cols, rows)` (guard > 0, swallow errors), `terminalCwd()`.
- `killCurrent()`: set `current = null` **before** `kill()` so `onExit` does not schedule a restart. `disposeTerminal()` = kill. `restartTerminal(window, cwd?)`: kill, reset the rate-limit counters, `createTerminal(window, cwd, true)`.

### 6.6 `settings.ts`

- File: `<userData>/settings.json`. Cached in memory after first read.
- `mergeKnown(base, patch)`: deep merge keeping **only keys that exist in `base`**, and only when the patch value's type matches the base value's type (or base is null); nested objects recurse. Unknown keys on disk are ignored on read; because the written file is the merged object, they are dropped on the next write. Missing keys fall back to defaults, so older and newer builds can share one file.
- `getSettings()`: parse the file (defaults on failure), `mergeKnown(DEFAULT_SETTINGS, fromDisk)`. If `timeTracking.dir` is empty, use `process.env.DRAFTER_TIME_DIR`, else leave it empty (time tracking then does nothing until a folder is chosen in Settings).
- `updateSettings(patch)`: merge over current, cache, write atomically (`<file>.<pid>.tmp` + rename, mkdir -p), notify listeners, return the new settings. Write errors are logged, not thrown.
- `onSettingsChanged(listener)` returns an unsubscribe.

### 6.7 `snapshot-manager.ts`

- Snapshots live in `<dir of file>/.drafts/`. Name: `<stem>_<id><ext>` where `id = Date.now().toString(36)`; metadata beside it as `<snapshot>.meta.json` containing `SnapshotInfo`.
- `saveSnapshot(path, label?)`: mkdir, `copyFile`, write meta with `timestamp` ISO and `label` defaulting to `Snapshot HH:MM` (locale, 2-digit hour and minute).
- `listSnapshots(path)`: read `.drafts`, take `*.meta.json` whose name starts with `<stem>_`, parse each (skip corrupt), keep those whose `snapshotPath` still exists, sort newest first. `[]` on any error.
- `readSnapshot(snapshotPath)`: utf-8 read.
- `restoreSnapshot(snapshotPath, targetPath)`: if target exists, first `saveSnapshot(target, 'Before restore')`; then write the snapshot content over the target and return it.
- `deleteSnapshot(snapshotPath)`: unlink the file and its meta, ignoring errors.

### 6.8 `time-tracker.ts`

Purpose: record active seconds per document, and contiguous sessions with start/end, into `<timeTracking.dir>/drafter-YYYY-MM-DD.json` for an external tracker. Everything fails soft; if `timeTracking.enabled` is false or `dir` is empty it is a no-op.

Constants: `TICK_MS 10000`, `FLUSH_MS 60000`, `IDLE_CUTOFF_SECONDS 60`, `MIN_SECONDS_TO_RECORD 60`, `MIN_INTERVAL_SECONDS 30`, `MAX_INTERVALS 500`, `KEEP_DAYS 45`.

State: `win`, `activePath`, `activeRoot`, `activeMatterId`, `activeMatterLabel`, `records: Map<path, DocRecord>`, `sessions: Session[]`, `current: Session | null`, `lastTickMs`, `day` (local `YYYY-MM-DD`), `dirty`.

`DocRecord = {path, name, folder (basename of parent), matterId, matterLabel, seconds, firstAt, lastAt}`; `Session = {path, name, folder, matterId, matterLabel, start, end, seconds}`.

- `initTimeTracker(window)`: reset state, `loadToday()` (re-read today's file so a restart keeps time already recorded: documents → records, intervals → sessions), `updateTitle()`, `prune()` (delete `drafter-*.json` older than 45 days by mtime), start the tick and flush intervals, subscribe to settings changes (close the session, flush, reset, reload, refresh matter, update title).
- `tick()` (every 10 s, wrapped in try/catch): if no output dir, no active path, window not focused/destroyed, or `powerMonitor.getSystemIdleTime() > 60` → close the current session and return. On a day rollover: close session, flush, reset records/sessions, set day, `loadToday()`. Add 10 s to the record for `activePath` (create it if missing, with matter id/label). If `current` is for the same path and `now − lastTickMs ≤ 25 s`, extend it (end, seconds, matter); else close it and start a new one with `start = now − 10 s`. Set `lastTickMs`, `dirty = true`.
- `flush()` (every 60 s, on dispose, on matter change): if dirty and the dir exists, write `{ date, source: 'AI Drafter (per-document active time)', generatedAt, idleCutoffSeconds: 60, minSecondsIncluded: 60, rootPath, totalActiveMinutes, documents, intervals }` where `documents` = records with `seconds ≥ 60`, sorted desc, each with `minutes = round(seconds/6)/10`; `intervals` = sessions (plus `current`) with `seconds ≥ 30`, sorted by start, last 500, each with `minutes`. If no document qualifies, do not write. Atomic write (`.tmp` + rename). Clear `dirty`.
- `setActiveDocument(path, root)`: if the path changed, close the current session; set active path/root; resolve the matter; `updateTitle()`.
- `updateTitle()`: no file → `Drafting App`; else `<name> — <parent folder> [<matter label>] — Drafting App` (matter part only when set; folder part only when non-empty).
- `matterAssignmentChanged()`: re-resolve the matter, update the record, current session and past sessions for the active path, update the title, flush.
- `todayFor(path)`: `{documentSeconds: records[path]?.seconds ?? 0, totalSeconds: sum of all records}`.
- `disposeTimeTracker()`: clear timers, unsubscribe, close session, flush, drop the window ref.

### 6.9 `matter-map.ts`

- `timeDir()` = `settings.timeTracking.dir`. Map file: `<dir>/drafter-matter-map.json` with `{ note, updatedAt, byFolder: Record<folderPath, matterId>, byFile: Record<filePath, matterId> }`. Matters come from `<dir>/app-state.json` (published by the external tracker): `raw.state ?? raw`, then `.matters[]`; keep objects with an `id` and not `archived`; map to `{id, client, name, label: "<client or ?> · <name or ?>", billable: m.billable !== false}`. `[]` if missing/unreadable.
- `resolveIn(map, filePath)`: normalise paths (backslashes → `/`, strip trailing `/`, lowercase). A `byFile` key equal to the target wins (`source: 'file'`). Otherwise the **longest** `byFolder` key that is a proper prefix (`target.startsWith(folder + '/')`) wins (`source: 'folder'`). Else nulls. Exported for tests.
- `resolveMatterId`, `matterContext(filePath)` → `{matters, matterId, source, sourcePath}`, `labelFor(id)`.
- `setMatter(filePath, matterId | null, scope)`: file scope sets/deletes `byFile[filePath]`; folder scope sets/deletes `byFolder[dirname(filePath)]` and, when setting, also deletes `byFile[filePath]` so a stale file override cannot mask the folder decision. `writeMap` is a no-op if the dir is missing; never throws.

---

## Part 7 — Renderer

### 7.1 Entry (`index.html`, `index.tsx`, `ErrorBoundary`)

- `index.html`: CSP `default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self';`. Title "Drafting App". Inline style: `html, body { margin:0; padding:0; height:100%; background:#15171c }` with a `prefers-color-scheme: light` override to `#ffffff`. `<div id="root">`.
- `index.tsx`: import `./styles/global.css`; register `window.onerror` and `unhandledrejection` handlers that call `window.drafting.writeLog(...)` with message, location and stack; render `<ErrorBoundary><App/></ErrorBoundary>` with `createRoot`.
- `ErrorBoundary`: class component; on catch, write `[ErrorBoundary] message\nstack\nComponent stack: …` to the log and console; render a "Something went wrong" panel ("Your files are safe on disk…"), a "Reload window" primary button (`location.reload()`), and the error text in a `<pre>`.

### 7.2 `lib/paths.ts`

Renderer has no Node `path`. Paths arrive from main with backslashes on Windows; keep them as-is so Map/Set keys stay consistent.

- `SEP` = `'\\'` if `navigator.platform` starts with `Win` else `'/'`.
- `baseName(p)`: last segment split on `/` or `\`. `dirName(p)`: up to the last separator (or `p` if none). `joinPath(dir, name)`: append with `SEP` unless dir already ends with a separator. `extName(p)`: lowercase from the last dot of the basename (empty if no dot or leading dot).
- `relativeTo(root, p)`: if `root` is null return `p`; strip trailing separators from root; if `p` (normalised to `/`, lowercased) starts with `root/`, return the remainder with forward slashes; else `p`. Used for `@docs/file.md` in prompts.
- `isUnder(root, p)`, `quoteIfNeeded(p)` (wrap in double quotes if it has whitespace).
- `TEXT_EXTENSIONS` (with leading dots): `.md .markdown .mdx .txt .text .json .yaml .yml .toml .xml .csv .tsv .js .ts .jsx .tsx .css .scss .less .html .htm .py .rb .rs .go .java .c .cpp .h .hpp .cs .sh .bash .zsh .bat .cmd .ps1 .env .gitignore .editorconfig .prettierrc .eslintrc .cfg .ini .conf .log .svg`.
- `PROSE_EXTENSIONS` = `.md .markdown .mdx .txt .text` and `''` (extensionless). `isProse(p)`.
- `languageFor(p)`: Monaco language id by extension (`markdown` for prose/extensionless, `json`, `yaml`, `ini` for toml/ini/cfg/conf/env, `xml` for xml/svg, `plaintext` for csv/tsv/log, `javascript`, `typescript`, `css`, `scss`, `less`, `html`, `python`, `ruby`, `rust`, `go`, `java`, `c`, `cpp`, `csharp`, `shell`, `bat`, `powershell`); default `plaintext`.

### 7.3 `lib/textDiff.ts` — **verbatim algorithm**

```ts
import { diffLines } from 'diff';

/** Lines [fromLine, toLine) (1-based, toLine exclusive) are replaced by `text`. Insertion: fromLine === toLine. */
export interface LineRangeEdit { fromLine: number; toLine: number; text: string; }
export interface TextDiffResult { edits: LineRangeEdit[]; firstChangedLine: number | null; }

export function computeLineEdits(oldText: string, newText: string): TextDiffResult {
  if (oldText === newText) return { edits: [], firstChangedLine: null };
  const parts = diffLines(oldText, newText);
  const edits: LineRangeEdit[] = [];
  let oldLine = 1, newLine = 1;
  let firstChangedLine: number | null = null;
  let removedLines = 0, addedText = '', blockStart = 1, inBlock = false;
  const flush = () => {
    if (!inBlock) return;
    edits.push({ fromLine: blockStart, toLine: blockStart + removedLines, text: addedText });
    inBlock = false; removedLines = 0; addedText = '';
  };
  for (const part of parts) {
    const count = part.count ?? countLines(part.value);
    if (part.added) {
      if (!inBlock) { inBlock = true; blockStart = oldLine; }
      if (firstChangedLine === null) firstChangedLine = newLine;
      addedText += part.value; newLine += count;
    } else if (part.removed) {
      if (!inBlock) { inBlock = true; blockStart = oldLine; }
      if (firstChangedLine === null) firstChangedLine = newLine;
      removedLines += count; oldLine += count;
    } else { flush(); oldLine += count; newLine += count; }
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

/** Apply edits to a string (bottom-up so line numbers stay valid). Used by tests. */
export function applyLineEdits(oldText: string, edits: LineRangeEdit[]): string {
  const lines = splitKeepingNewlines(oldText);
  const sorted = [...edits].sort((a, b) => b.fromLine - a.fromLine);
  for (const e of sorted) lines.splice(e.fromLine - 1, e.toLine - e.fromLine, e.text);
  return lines.join('');
}

function splitKeepingNewlines(text: string): string[] {
  if (text === '') return [];
  const out: string[] = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { out.push(text.slice(start, i + 1)); start = i + 1; }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Rough word count: runs of letters/digits, apostrophes and hyphens allowed, "4.2" is one word. */
export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}](?:[\p{L}\p{N}'’-]|\.(?=\p{N}))*/gu);
  return m ? m.length : 0;
}
```

`textDiff.test.ts` (vitest) must contain these cases; all must pass:

| Case | Old → New | Expected |
|---|---|---|
| identical | `a\nb\n` → same | `{edits: [], firstChangedLine: null}` |
| single middle line | `one\ntwo\nthree\n` → `one\nTWO\nthree\n` | `[{2,3,'TWO\n'}]` |
| insert at end | `one\ntwo\n` → `one\ntwo\nthree\n` | `[{3,3,'three\n'}]` |
| insert at start | `b\nc\n` → `a\nb\nc\n` | `[{1,1,'a\n'}]` |
| delete lines | `a\nb\nc\nd\n` → `a\nd\n` | `[{2,4,''}]` |
| no trailing newline | `a\nb`→`a\nb\nc`; `a\nb\n`→`a\nb`; `a`→`b` | round-trips |
| multiple hunks | `l1..l6\n` → `l1\nX\nl3\nl4\nY\nl6\nl7\n` | 3 edits, `firstChangedLine 2`, round-trips |
| empty docs | `''`→`hello\n`; `hello\n`→`''` | round-trips |
| long rewrite | 200 lines `line i` (no trailing \n) → 180 lines `row 2i` + `\n` | round-trips |
| countWords | `"The Buyer's obligations under clause 4.2 don't survive termination."` → 9; `''` → 0; `'# Heading\n\n- item one\n- item two'` → 5 |

"Round-trips" means `applyLineEdits(a, computeLineEdits(a,b).edits) === b`.

### 7.4 `hooks/useSettings.ts`

- State: `settings` (starts as `DEFAULT_SETTINGS`), `loaded`, `theme: 'dark' | 'light'` resolved from `matchMedia('(prefers-color-scheme: dark)')`.
- On mount: `getSettings()` → set + `loaded = true`; subscribe to `onSettingsChanged`.
- Re-read the media query whenever `settings.theme` changes and on `change` events (main sets `nativeTheme.themeSource`, so the media query already reflects the preference).
- Effect: `document.documentElement.dataset.theme = theme`.
- `update(patch)`: `updateSettings(patch)` then set the returned settings. Returns `{settings, loaded, theme, update}`.

### 7.5 `hooks/useFileSystem.ts` — the document state machine

Signature: `useFileSystem(autosaveDelayMs)`.

**React state:** `rootPath: string|null`; `listings: Map<dirPath, FileEntry[]>`; `openPaths: string[]`; `activeFile: string|null`; `dirtyPaths: Set`; `deletedPaths: Set`; `pendingChanges: Map<path, PendingChange>`; `reloads: Map<path, ReloadRequest>`; `saveStates: Map<path, 'clean'|'dirty'|'saving'|'error'>`; `lastSavedAt: Map<path, number>`.

**Refs:** `filesRef: Map<path, {content, savedContent, isUnsupported}>`; `saveTimeoutRef: Map<path, timeout>`; `mruRef: string[]` (max 30); `autosaveDelayRef` (kept current every render).

**Types:**
```ts
interface PendingChange { path; kind: 'applied' | 'conflict'; before: string; after: string; at: number }
interface ReloadRequest { version: number; firstChangedLine: number | null }
```

**Helpers:** `setDirty(path, bool)` updates `dirtyPaths` and `saveStates` (`dirty` → `'dirty'`; clean → keep `'saving'` if saving else `'clean'`), always returning the previous object when nothing changes. `getContent(path)`, `getFileState(path)`, `putFile(...)`.

**Binary handling:** `shouldTreatAsBinary(path)`: false if the extension is in `TEXT_EXTENSIONS`; otherwise `sniffBinary`. Unsupported files get a placeholder `# Unsupported file\n\n**<name>** is a binary file and cannot be edited here.\n\nOpen it with the application it belongs to. Text formats such as .md, .txt, .json and .yaml open in this editor.`, `savedContent ''`, `isUnsupported true`; they are never written.

**Listings:** `listDir(dir)` calls `listDirectory`, stores the result under `dir` and also seeds each child directory's `children` under its own path. `refreshDir(dir)` = listDir, swallowing errors. `refreshTree()` re-lists every known directory under the root. `setRoot(dir)`: set root, clear listings, `listDir`, `startWatching(dir)`.

**Activation:** `activate(path)` sets active and moves it to the front of MRU. `addOpen(paths)` appends new ones to `openPaths`.

**Saving:** `writeNow(path)`: skip unsupported; cancel a pending timer; if content equals saved, mark clean and return true; set `'saving'`; `writeFile`; set `savedContent = content`; recompute dirty (the user may have typed during the write); record `lastSavedAt`; on error set `'error'` and return false. `scheduleSave(path)` debounces `writeNow` by `autosaveDelayRef.current`. `saveFile` = writeNow. `saveAllDirty()` writes every supported file whose content differs from saved.

**Opening:** `loadIntoStore(path)` (no-op if present; binary → placeholder; else read). `openFile(path)`: load, addOpen, activate; errors are logged and swallowed. `openFilesBatch(paths, activePath?)` (session restore): one `readFiles` round-trip for known text extensions, sniff the rest and read the text ones in a second batch, then open in the original order and activate `activePath` if it loaded, else the last loaded. `openFolder(dir?)`: dir or dialog (defaulting to the current root), then `setRoot`. `openFileFromDialog()`: multi-select; if no root, set root to the first file's folder; load all; activate the first. `createFileIn(dir, name)`: `createFile` (rethrow on failure), refresh dir, put `''`, open, activate; return the path. `createFolderIn(dir, name)`. `newFileFromDialog()`: dialog; if no root set root to the parent else refresh parent; put `''`, open, activate.

**Closing:** `closeFile(path)`: unless deleted, `writeNow` first (save on close, no prompt); cancel timer; drop from the store, dirty, deleted, pendingChanges, MRU; remove from openPaths and, if it was active, activate the first MRU entry still open, else the last remaining, else null. `closeOthers(keep)`.

**Rename / trash:** `renameEntry(oldPath, newName)`: compute `newPath` in the same dir; flush if dirty; `renamePath`; retarget the store entry, openPaths, activeFile and MRU; also retarget any open file under `oldPath + '\\'` (folder rename); refresh the parent dir. `trashEntry(target)`: `trashPath`; drop every open file equal to or under the target (timers, store, dirty, deleted, MRU); remove from openPaths, re-pick the active file by MRU; refresh the parent.

**Editing:** `updateContent(path, text)` — called on every keystroke by Monaco or Milkdown: mutate `content`, `setDirty(path, text !== savedContent)`, and `scheduleSave` unless the file is in `deletedPaths`.

`applyExternalContent(path, text, firstChangedLine = null)`: set `content` and `savedContent` to `text`, mark clean, cancel any timer, bump `reloads[path] = {version: prev+1, firstChangedLine}`.

**Watcher handling** (`handleFileChange`, subscribed once through a ref so the IPC listener is never re-registered):
- `addDir` / `unlinkDir`: refresh the parent listing.
- `add`: refresh the parent; if the path is in `deletedPaths`, remove it and reload the file from disk via `applyExternalContent`.
- `unlink`: refresh the parent; if the file is open, cancel its autosave timer and add it to `deletedPaths`.
- `change`: ignore if not open or unsupported. Read the disk text. If it equals the store content, do nothing except resync `savedContent` (a late echo or identical rewrite). Else if the store is dirty (`content !== savedContent`) → `pendingChanges[path] = {kind: 'conflict', before: content, after: disk}` and **do not apply**. Else → `applyExternalContent(path, disk)` and `pendingChanges[path] = {kind: 'applied', before: previous content, after: disk}`.

**Pending-change decisions:** `dismissChange(path)`. `takeDisk(path)` (conflict): apply `after`, dismiss. `keepMine(path)` (conflict): dismiss, `writeNow` (so Claude sees the user's text). `revertApplied(path)`: apply `before`, force a write by setting `savedContent = ' '`, dismiss, `writeNow`. `acceptReviewed(path, text)`: apply `text`, force write, dismiss, `writeNow`. `keepDeleted(path)`: remove from deleted, force write, refresh parent.

The hook returns all state and all functions above; `FileSystemApi = ReturnType<typeof useFileSystem>`.

### 7.6 `App.tsx` — composition root

**Session** in `localStorage['drafting-app-session']`: `{rootPath, openFilePaths, activeFile, splitRatio (default 0.6)}`. On mount, if the saved root still exists (`pathExists`), `setRoot` then `openFilesBatch`; then `sessionRestored = true`. Save (debounced 400 ms) whenever root/openPaths/activeFile/splitRatio change, only after restore.

**Local state:** `splitRatio`, `viewModes: Map<path, ViewMode>` (per-file override of the default view), `review: {change, labels?, custom?} | null`, `palette: 'commands' | 'files' | null`, `settingsOpen`, `stats: {words, line, column, selectionLines}`, `snapshots: SnapshotInfo[] | null` (null = list closed), `snapshotCount`, `snapshotMessage`, `matterLabel`, `dragging`, toasts.

**Derived:** `activeIsProse`, `activeUnsupported`, `viewMode` = for a prose, supported active file: `viewModes.get(active) ?? settings.editor.defaultView`; otherwise `'raw'`. `trackingEnabled = settings.timeTracking.enabled && !!dir`.

**Effects:** push `setActiveDocument(activeFile, rootPath)` on change; clear snapshot list and review when the active file changes; refresh `snapshotCount` on active-file change and after every save (`lastSavedAt`); when `offerReview` is off, auto-dismiss every `applied` pending change; when the root changes after restore and the terminal cwd differs, toast "Claude is still running in <cwd basename or 'your home folder'>. Use the restart button in the Claude card to move it to <root basename>." (info, 6 s).

**Prompts.** `fillPrompt(template, path)`: `{relpath}` → `@<rel>` or `"<rel>"` if it contains whitespace; `{path}` → path, quoted if it has whitespace; `{name}` → basename; `{lines}` → `"12"` or `"12-18"` from the Monaco selection (empty in Visual mode); `{selection}` → trimmed selected text (Monaco selection, or Milkdown `textBetween`). If there is a selection and the template mentions neither `{selection}` nor `{lines}`, append ` Focus on lines <lines>. ` (Text mode) or ` Focus on the passage beginning "<first 60 chars, whitespace collapsed>…". ` (Visual mode). `sendToClaude(path, template)`: `saveAllDirty()` then `terminal.type(fillPrompt(...))` (types without Enter; the user finishes the instruction).

**Commands** (the palette list; `enabled: false` hides an item):

| id | label | icon | shortcut | enabled when | action |
|---|---|---|---|---|---|
| file.new | New Document | file-plus | Ctrl+N | | newFileFromDialog |
| file.open | Open File… | file-text | Ctrl+O | | openFileFromDialog |
| folder.open | Open Folder… | folder-open | Ctrl+Shift+O | | openFolder |
| file.save | Save | save | Ctrl+S | active | saveFile(active) |
| file.saveAll | Save All | save | Ctrl+Shift+S | | saveAllDirty |
| tab.close | Close Document | x | Ctrl+W | active | closeFile(active) |
| tab.next / tab.prev | Next / Previous Document | | Ctrl+Tab / Ctrl+Shift+Tab | >1 open | cycle in **openPaths order** (not MRU) |
| view.quickOpen | Go to Document… | search | Ctrl+P | root | palette 'files' |
| view.toggleSidebar | Hide/Show Sidebar | panel-left | Ctrl+\ | | update `sidebar.visible` |
| view.togglePreview | Switch to Visual Editor / Switch to Markdown Text | eye / code | Ctrl+E | prose & supported | set viewModes[active] |
| view.focusToggle | Switch Between Document and Claude | terminal | Ctrl+` | | terminal has focus → focus Monaco or Milkdown; else focus terminal |
| review.changes | Review Changes From Disk | diff | Ctrl+Shift+R | pendingChanges has active | openReview() |
| claude.send | Send Document to Claude | send | Ctrl+Enter | active | sendToClaude(active, prompts.sendToClaude) |
| claude.proofread | Proofread With Claude | sparkles | | active | sendToClaude(active, prompts.proofread) |
| terminal.restart | Restart Claude in <root name> / Restart Terminal | refresh | | | terminal.restart(rootPath) |
| terminal.clear | Clear Terminal | terminal | | | terminal.clear() |
| snapshot.save | Save Snapshot | camera | | active & supported | saveSnapshot |
| snapshot.list | Show Snapshots | history | | active | toggleSnapshots |
| matter.set | Set Matter for This Document | briefcase | | active & tracking | open the matter popover anchored to `[data-action=matter]` |
| theme.toggle | Switch to Light/Dark Theme | sun/moon | | | update theme |
| view.settings | Settings… | settings | Ctrl+, | | open settings |
| reveal | Reveal Document in Explorer | external | | active | revealPath |
| copyPath | Copy Document Path | link | | active | clipboard + toast "Path copied" |

`runCommand(id)` closes the palette and runs the command if enabled. Commands are also kept in a ref so IPC handlers see the latest.

**App commands from main** (`onAppCommand`): `app.flushRequest` → `saveAllDirty().finally(flushDone)`; `folder.openPath=<p>` → `setRoot(p)`; `file.openPath=<p>` → `openFile(p)`; `view.palette` → toggle the commands palette; anything else → `runCommand(cmd)`.

**Renderer keydown listener** (capture phase on `document`; inactive while a palette or settings is open; only when Ctrl/Cmd is held): `Ctrl+Shift+P` toggles the palette **even in the terminal**; if the terminal has focus, everything else is ignored; otherwise `Ctrl+N` file.new, `Ctrl+O` file.open, `Ctrl+Shift+O` folder.open, `Ctrl+W` tab.close, `Ctrl+P` view.quickOpen, `Ctrl+\` view.toggleSidebar, `Ctrl+E` view.togglePreview, `Ctrl+Enter` claude.send, `Ctrl+Shift+R` review.changes. Matched keys `preventDefault` + `stopPropagation`.

**Divider drag:** on mousedown set `dragging`, body cursor `col-resize`, `user-select: none`; on move clamp `x` to `[420, bodyWidth − 360]` and set `splitRatio = x / bodyWidth`, coalesced to one update per animation frame; on mouseup clean up and flush any pending value.

**Tabs:** status per open path: `deleted` if in deletedPaths; else `conflict` if pending kind conflict; else `change` if pending kind applied **and** `offerReview`; else `dirty`; else `clean`.

**Quick Open files:** every non-directory entry across all listings.

**Banners in the editor card** (only for the active file; pending banners hidden while a review is open):
- Deleted (danger, trash icon): "**name** was deleted or moved on disk. Your copy is still here and is no longer autosaving." Buttons: `Keep and re-create` (keepDeleted), `Close` (ghost, closeFile).
- Conflict (warn, alert icon): "**name** changed on disk while you had unsaved edits. Nothing has been overwritten." Buttons: `Review` (primary, diff icon), `Use disk version` (takeDisk), `Keep mine` (ghost, keepMine).
- Applied (info, sparkles icon; only when `offerReview`): "**name** was changed on disk and reloaded. Ctrl+Z undoes it." Buttons: `Review` (primary), `Revert` (revertApplied), `OK` (ghost, dismiss).

**Snapshots:** `saveSnapshot()`: save the file first, then `saveSnapshot`, show `Saved · <label>` in the toolbar for 2.5 s, update count/list; toast on failure. `toggleSnapshots()` loads or closes the list. The list (inside the editor card, under the toolbar) shows each snapshot's label, date/time (medium date, short time), a `Compare` button and a delete (trash) button. `compareSnapshot(snap)` opens the review with `{before: snapshot text, after: current text}` and labels `{title: "Compare with <label>", sub: <timestamp>, left: 'Snapshot', right: 'Current document (editable)', keep: 'Restore snapshot', apply: 'Apply edits'}`, custom handlers: apply → `acceptReviewed(active, text)`; keep-left → `restoreSnapshot` then `applyExternalContent` and toast "Snapshot restored. A snapshot of the previous text was kept."

**Review (default handlers):** `onApply(text)` → `acceptReviewed(path, text)`; `onKeepLeft` → conflict ? `keepMine` : `revertApplied`; close on either or on Esc/×.

**Title card:** an editable input holding the file stem (extension shown beside it, greyed), read-only for unsupported or deleted files. Commit on blur/Enter (Escape reverts): ignore empty or unchanged; reject `\ / : * ? " < > |` with a toast "That name contains characters Windows does not allow: \ / : * ? " < > |"; else `renameEntry(path, value + ext)`, toasting errors. A crumb on the right shows the path relative to the root (or the root/folder name).

**Empty card** (no active file): glyph + heading `Pick a document` (root open) / `Start drafting` (no root); paragraph; primary/secondary buttons (`Find a document` + `New document`, or `Open folder` + `Open file`); three hint rows with kbd chips (Ctrl+P, Ctrl+N, Ctrl+Shift+P).

**Topbar:** if the sidebar is hidden, a ringed `panel-left` button to show it; the TabBar grows; on the right three ringed icon buttons: command palette (`command`), theme toggle (`sun`/`moon`), settings (`settings`).

**Render order:** `<div class="app">` → optional Sidebar → `.content` (`.topbar`, `.body` with `column-main` at `splitRatio*100%`, `.divider`, `column-side` with DocumentPanel and the `card claude-card` wrapping TerminalPane) → optional CommandPalette → MatterCard (headless) → optional SettingsPanel → Toasts. Render an empty `.app` until settings have loaded.

`TerminalPane.onFocus` = `saveAllDirty()` (auto-save on terminal focus).

### 7.7 `components/monacoSetup.ts`

- `import 'monaco-editor/esm/vs/editor/editor.all'`, `import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'`, then the basic-language contributions for markdown, yaml, typescript, javascript, python, powershell, shell, html, css, xml, ini, csharp, java, rust, go, ruby, cpp, bat.
- **Do not define `MonacoEnvironment.getWorker`.** Monaco logs one warning and runs its editor worker (diff computation) on the main thread. A no-op stub worker silently breaks the diff editor (requests go to a worker that never answers; nothing is highlighted). Documents are small; main-thread diffing is instant.
- Register a minimal `json` language (`{ id: 'json', extensions: ['.json'] }`) if none exists.
- `ensureThemes()` defines `drafting-dark` (base `vs-dark`) and `drafting-light` (base `vs`) once; `themeName(theme)` returns the name after ensuring. Token rules (both): `keyword.md` bold (`7f97ff` dark / `4761d8` light), `string.link.md` (`62b4ff` / `2f7fd0`), `variable.md` and `string.md` (`c3c7d1` / `3b4050`), `variable.source.md` (`e8c98a` / `8a5a12`), `emphasis` italic, `strong` bold, `comment.md` (`5f6575` / `9aa0b0`).
- Colors, dark: `editor.background #15171c`, `editor.foreground #dfe2ea`, `editorLineNumber.foreground #454b58`, `editorLineNumber.activeForeground #8d93a3`, `editor.lineHighlightBackground #1b1e25`, `editor.lineHighlightBorder #00000000`, `editor.selectionBackground #7f97ff45`, `editor.inactiveSelectionBackground #7f97ff22`, `editorCursor.foreground #7f97ff`, `editorIndentGuide.background1 #22262e`, `editorWhitespace.foreground #2a2f39`, `editorWidget.background #272c35`, `editorWidget.border #3a404c`, `input.background #1f232a`, `input.border #3a404c`, `focusBorder #7f97ff`, `scrollbarSlider.background #ffffff1a`, `.hoverBackground #ffffff2e`, `.activeBackground #ffffff3a`, `diffEditor.insertedTextBackground #4fcf8a55`, `diffEditor.removedTextBackground #ff6b7a55`, `diffEditor.insertedLineBackground #4fcf8a1e`, `diffEditor.removedLineBackground #ff6b7a1e`, `diffEditorGutter.insertedLineBackground #4fcf8a40`, `diffEditorGutter.removedLineBackground #ff6b7a40`, `diffEditorOverview.insertedForeground #4fcf8a`, `diffEditorOverview.removedForeground #ff6b7a`.
- Colors, light: `editor.background #ffffff`, `editor.foreground #1f2330`, `editorLineNumber.foreground #b8bcc8`, `.activeForeground #6b7185`, `editor.lineHighlightBackground #f4f5f8`, border transparent, `editor.selectionBackground #4761d838`, `.inactiveSelectionBackground #4761d81a`, `editorCursor.foreground #4761d8`, `editorIndentGuide.background1 #eceef3`, `editorWidget.background #ffffff`, `editorWidget.border #d9dce6`, `input.background #f4f5f8`, `input.border #d9dce6`, `focusBorder #4761d8`, `diffEditor.insertedTextBackground #1f9d5b4d`, `.removedTextBackground #d63d4c40`, `.insertedLineBackground #1f9d5b1a`, `.removedLineBackground #d63d4c14`, `diffEditorGutter.insertedLineBackground #1f9d5b40`, `.removedLineBackground #d63d4c33`, `diffEditorOverview.insertedForeground #1f9d5b`, `.removedForeground #d63d4c`.

### 7.8 `components/Editor.tsx` (Monaco, Text mode)

Props: `ref: EditorHandle`, `filePath`, `openPaths`, `visible`, `theme`, `settings: AppSettings['editor']`, `cursorPolicy`, `reloads`, `getContent`, `isUnsupported`, `onChange(path, content)`, `onStats(stats)`.

`EditorHandle`: `focus`, `hasFocus` (`hasTextFocus`), `find` (run `actions.find`), `replace` (`editor.action.startFindReplaceAction`), `wrapSelection(prefix, suffix, placeholder?)`, `toggleLinePrefix(prefix)`, `insertBlock(before, after, placeholder?)`, `insertText(text)`, `getSelection(): {text, startLine, endLine} | null`, `undo`.

- **One editor instance**, created once on the host div, always mounted (hidden with `visibility: hidden; pointer-events: none` via `.is-hidden` when not visible or no file). Options: theme, `automaticLayout`, minimap off, `wordWrap` `'wordWrapColumn'` + `wordWrapColumn` when `wrapColumn > 0` else `'on'` (column 80 placeholder), `wrappingIndent 'same'`, line numbers per setting, font family/size, `lineHeight = round(fontSize × 1.65)`, `padding {top 18, bottom 40}`, `scrollBeyondLastLine false`, `renderLineHighlight 'line'`, `cursorBlinking 'smooth'`, `cursorSmoothCaretAnimation 'on'`, `smoothScrolling`, `tabSize 2`, unicode highlight off, `occurrencesHighlight 'off'`, `selectionHighlight false`, `renderWhitespace 'none'`, `folding false`, `glyphMargin false`, `lineDecorationsWidth 12`, `lineNumbersMinChars 3`, `overviewRulerBorder false`, `hideCursorInOverviewRuler`, scrollbar sizes 10 with no shadows, all suggestions/parameter hints off, `links`, `contextmenu`, `dragAndDrop`, `accessibilitySupport 'auto'`.
- `onDidChangeModelContent`: unless `applyingRef` is set, call `onChange(currentPath, model.getValue())` and schedule stats (200 ms debounce; stats = word count, cursor line/col, selected line count). Cursor/selection changes also schedule stats.
- Editor commands: `Ctrl+B` → wrap `**…**` ("bold text"), `Ctrl+I` → `*…*` ("italic text"), `Ctrl+K` → `[…](url)` ("link text").
- `wrapSelection`: read-only guard; if the selection already starts with prefix and ends with suffix, unwrap; else replace with `prefix + (selected || placeholder) + suffix` and, when nothing was selected, select the placeholder. `toggleLinePrefix(prefix)`: for each selected line, remove the prefix if present; if the prefix is heading-like (`/^#{1,6}\s/`) and the line already has a heading, swap levels; else insert the prefix at column 1. `insertBlock`: `before\n<text>\nafter`. `insertText` replaces the selection.
- **Models:** `Map<path, {model, viewState, appliedReload}>`. `getOrCreateModel(path)` creates from the store with `languageFor(path)` and records the current reload version. Dispose models whose path leaves `openPaths` (detach first if attached).
- **Attach effect** (on `filePath`/`visible` change): save the outgoing model's view state; if nothing to show, `setModel(null)`; else get/create the model, **reconcile it against the store** (`reconcileModel(entry, storeText, 'keep', null)` if they differ), set it, set `readOnly` for unsupported files, restore view state, focus, emit stats.
- **Reload effect:** for each `reloads` entry whose version is newer than `appliedReload`, reconcile the model with the store text using the cursor policy and the request's `firstChangedLine` hint.
- `reconcileModel(entry, text, policy, hint)`: `computeLineEdits(model.getValue(), text)` → convert each edit to a `Range` from `(fromLine, 1)` to `(toLine, 1)` (clamped to the last line's max column when past the end) → `model.pushEditOperations(null, ops, () => null)` with `applyingRef` set; if the result differs from `text` (defensive), push a full-range replace. Then, if this model is attached: policy `first-change` → move the cursor to `hint ?? firstChangedLine` (clamped) and reveal it centred if outside the viewport; `end` → cursor at the end, reveal; `keep` → nothing (Monaco has mapped the cursor through the edits).
- Runtime option updates (font, size, wrap, line numbers) and theme changes via `updateOptions` / `monaco.editor.setTheme`.

### 7.9 `components/MilkdownPreview.tsx` (Crepe, Visual mode)

Props: `ref: VisualHandle`, `content`, `onChange(markdown)`, `fontSize`, `theme`. `VisualHandle`: `focus`, `hasFocus` (container contains `activeElement`), `format(what)`, `getSelectionText()`.

- Import `@milkdown/crepe/theme/common/style.css` and `theme/frame.css`.
- Create `new Crepe({ root, defaultValue: content })` once; after `create()`, listen to `markdownUpdated` and, unless `applyingRef`, record `lastEmitted` and call `onChange(markdown)`. Destroy on unmount. The component is keyed by file path in App, so switching files remounts it.
- When `content` prop changes and differs from `lastEmitted`: parse with `parserCtx`, replace the whole ProseMirror doc (`tr.replace(0, size, new Slice(doc.content, 0, 0))`) with `applyingRef` set (cleared on a `setTimeout 0`), and set `lastEmitted = content`.
- `format`: bold/italic/inline code/paragraph/h1–h4/bullet/ordered/quote/hr/image/link map to the commonmark preset commands (`toggleStrongCommand`, `toggleEmphasisCommand`, `toggleInlineCodeCommand`, `turnIntoTextCommand`, `wrapInHeadingCommand(level)`, `wrapInBulletListCommand`, `wrapInOrderedListCommand`, `wrapInBlockquoteCommand`, `insertHrCommand`, `insertImageCommand({src:'', alt:'description'})`, `toggleLinkCommand({href:'https://'})` only with a non-empty selection); `strike` → gfm `toggleStrikethroughCommand`; `task` → insert the text `[ ] ` at the selection start (the task-list command key varies between versions).
- Host div: class `preview-host` plus `milkdown-theme-frame-dark` or `milkdown-theme-frame`, `font-size: fontSize + 2`, `spellCheck`.
- Known limitation, stated in Settings help: Milkdown re-serialises the whole document on every change, so formatting elsewhere in the file may be normalised. The raw view remains authoritative and reconciles on switch.

### 7.10 `components/DiffReview.tsx`

Props: `change: PendingChange`, `theme`, `fontFamily`, `fontSize`, `labels?: {title, sub, left, right, keep, apply}`, `onApply(text)`, `onKeepLeft()`, `onClose()`.

- A Monaco **diff editor** over `original = change.before`, `modified = change.after` (language from the path), side by side, original read-only, modified editable, `renderMarginRevertIcon`, overview ruler on, `ignoreTrimWhitespace false`, word wrap on both, `diffWordWrap 'on'`, `useInlineViewWhenSpaceIsLimited false`, `lineHeight = round(fontSize × 1.6)`, padding `{12, 24}`. Recreated when `change.path` or `change.at` changes.
- `onDidUpdateDiff` → `getLineChanges()` into state; on the first non-empty result reveal the first change centred.
- Header: diff icon, title, sub, spacer, `keep` ghost button (undo icon), `apply` primary button (check icon; passes `modified.getValue()`), × close. Esc closes.
- Nav bar: "Comparing…" until ready; "No differences remain. Apply to keep the text on the right." when empty; else `‹ n of N ›` with a description (`"<k> lines added at line L"`, `"<k> lines removed after line L"`, `"line(s) A–B changed"`), spacer, `Undo this change` (puts the original text back for the current change in the modified model via `pushEditOperations`, handling replace / pure insertion / pure deletion cases including document edges), `Keep` (advance).
- Labels row: left/right captions. Defaults: conflict → title `<name> changed on disk while you were editing`, sub `Nothing has been applied yet.`, left `Your unsaved text`, right `Now on disk (editable)`, keep `Keep my version`, apply `Use this version`; applied → title `<name> was changed on disk`, sub `Already in the editor. Undo any part below, then apply.`, left `Before`, right `Now on disk (editable)`, keep `Revert all`, apply `Apply`.
- Rendered as `.review` absolutely covering the editor area (`z-index 5`).

### 7.11 `components/TerminalPane.tsx`

Props: `ref: TerminalHandle`, `initialCwd`, `rootPath`, `activeFilePath`, `theme`, `settings: AppSettings['terminal']`, `onFocus`. Handle: `focus`, `hasFocus` (`activeElement === terminal.textarea`), `type(text)` (focus + send input), `run(text)` (adds `\r`), `restart(cwd)`, `clear`, `getCwd`.

- `new Terminal({ theme, fontFamily, fontSize, lineHeight 1.2, cursorBlink, cursorStyle 'bar', scrollback 10000, allowProposedApi, macOptionIsMeta, windowsPty: { backend: 'conpty' } on Windows })`. Addons: fit, unicode11 (activate version 11), search, clipboard, web-links (open via `window.open`, which main redirects to the system browser), and WebGL (try/catch; dispose on context loss; fall back to DOM renderer).
- `onData` → `sendTerminalInput`; `onTerminalData` → `terminal.write`; `onTerminalStopped` → show the stopped overlay. `focus` on the xterm textarea calls `onFocus`.
- Custom key handler: `Ctrl+Shift+C` copies the selection, `Ctrl+Shift+V` pastes from the clipboard; everything else passes through to the shell.
- After first layout (`requestAnimationFrame` fit), `createTerminal(initialCwd)`. The PTY is created once and outlives the component (HMR).
- Resize: `ResizeObserver` on the host → coalesce with one `requestAnimationFrame` plus a 120 ms trailing debounce → `fit()` and `resizeTerminal(cols, rows)`.
- Theme (dark card in both themes; only the background shifts): background `#0f1116` (dark) / `#15171c` (light), foreground `#dfe2ea`, cursor `#8399ff`, selection `rgba(131,153,255,.30)` / inactive `.18`, ANSI: black `#1e2028`, red `#ff6b7a`, green `#4fcf8a`, yellow `#f0b64a`, blue `#8399ff`, magenta `#c084fc`, cyan `#3fd0e0`, white `#dfe2ea`; bright: `#5f6575 #ff8a96 #6ee7a0 #fcd34d #9aacff #d4a5ff #67e8f9 #ffffff`.
- Header (`.term-head`): green live dot + "Claude"; cwd text: `<active file name> · ` prefix when a file is open, then `in <cwd basename or 'home'>` or, when the cwd differs from the root, `running in <cwd>, folder is <root>`; a small refresh button (`is-on` when mismatched) that restarts in `rootPath`.
- `restart(dir)`: clear the stopped flag, set cwd, clear the screen, `restartTerminal(dir)`, focus.
- Stopped overlay (`.term-stopped`): alert icon, "The terminal stopped after several crashes in a row.", primary `Restart terminal`.

### 7.12 `components/Sidebar.tsx`

Props: `rootPath`, `listings`, `activeFile`, `dirtyPaths`, `deletedPaths`, `changedPaths`, `width`, `onWidthChange`, `onCollapse`, `onQuickOpen`, `onOpen`, `onLoadDir`, `onRefresh`, `onOpenFolder`, `onOpenFile`, `onNewFileDialog`, `onCreateFile(dir, name)`, `onCreateFolder(dir, name)`, `onRename(path, newName)`, `onTrash(path)`, `onReveal`, `onCopyPath`, `onSendToClaude(path)`, `onError(message)`.

- Brand row: accent square with "D", "Drafting", small collapse button (`panel-left`, title "Hide sidebar  Ctrl+\").
- `.side-search` button: search icon, "Search documents…", kbd `Ctrl+P` → `onQuickOpen`.
- `.side-section` "Documents" (title = root path) with small buttons: new document (`file-plus`), new folder (`folder-plus`), refresh (spins ≥ 300 ms).
- Tree (`role="tree"`, `tabIndex 0`): rows flattened from `listings` starting at the root; a directory row is expanded when its path is in `expanded`. **Top-level folders start expanded** once per root when its listing first arrives. Expanding a directory not yet in `listings` shows "Loading…" and calls `onLoadDir`. Empty loaded directories show "empty".
- Row: chevron (rotates when open; hidden for files), icon (`folder`/`folder-open`; `file-text` for prose, `file` otherwise), name (`.md/.markdown/.mdx` extension hidden for files), a warn dot when dirty, an info-coloured dot when in `changedPaths` and not dirty. Classes: `is-dir`, `is-prose`, `is-active`, `is-focused`, `is-deleted` (strikethrough). Click: toggle a dir or open a file. `data-path` attribute; `title` = full path; indent `6 + depth × 16`px.
- Keyboard (when not editing): Up/Down move focus; Right expands or moves down; Left collapses or moves to the parent; Enter/Space open/toggle; F2 rename; Delete → trash (with `window.confirm("Move \"<name>\" to the Recycle Bin?")`); Home/End. The focused row follows `activeFile`.
- Inline editing (`.tree-input` row with placeholder `name.md` / `folder name`): rename (initial = current name, selection covers the stem), new file, new folder (rendered at the root top or under the target directory, which is expanded first). Commit on Enter/blur, cancel on Escape. Validation: empty → ignore; forbidden characters → `onError`; new file without an extension gets `.md`. Errors from IPC have the `Error invoking remote method '…': Error: ` prefix stripped.
- Context menu: on a file: Open, Send to Claude, sep; then New Document, New Folder (into the row's dir or the root); on any row: sep, Rename (F2), Copy Path, Reveal in Explorer, sep, Move to Recycle Bin (Del, danger); on empty tree space: New Document, New Folder, sep, Reveal in Explorer (root).
- Empty state (no root): text "Open the folder for a matter, or a single document, to start drafting." + accent `Open Folder`, `Open File`, `New Document` buttons.
- Bottom `.side-folder` button: folder icon, root basename (or "No folder open") and parent path (or "Choose a matter folder"), chevron → `onOpenFolder`.
- Resizer strip on the right edge: drag clamps width to `[200, 480]` and calls `onWidthChange` (persisted to settings).

### 7.13 `components/TabBar.tsx`

Tabs as pills. `TabInfo = {path, status: 'clean'|'dirty'|'change'|'conflict'|'deleted'}`. Each pill: icon (`file-text` for prose), name (extension `.md/.markdown/.mdx/.txt` stripped), a badge dot when status ≠ clean (colours: dirty warn, change info, conflict warn with a soft ring, deleted danger), and a × close. The badge hides on hover and the × shows; `is-deleted` strikes through the name. Title = path + status text (`Unsaved changes` / `Changed on disk. Review to see what changed.` / `Changed on disk while you had unsaved edits` / `Deleted on disk`). Click selects, middle-click closes, right-click menu: Close (Ctrl+W), Close Others, sep, Copy Path, Reveal in Explorer. Horizontal wheel scrolls the bar; the active tab is scrolled into view. A dashed `+ New` pill at the end calls `onNew`.

### 7.14 `components/Toolbar.tsx`

Props: `editor` ref, `visual` ref, `isProse`, `readOnly`, `viewMode`, `onViewMode`, `onSnapshot`, `onToggleSnapshots`, `snapshotsOpen`, `snapshotMessage`.

Left to right: `Snapshot` soft small button (camera; disabled when read-only), history icon toggle (on when the list is open), optional green snapshot message; then, when `isProse && !readOnly`: separator, **Paragraph** block picker (heading icon, label, chevron; opens a menu: Paragraph, Heading 1–4), separator, bold/italic/strikethrough/inline-code, separator, bullet/numbered/task/quote, separator, link/image/horizontal rule; then in Text mode: separator, Find (`Ctrl+F`) and Find-and-replace (`Ctrl+H`); spacer; and for prose & writable, a segmented `Visual | Text` control (eye/code icons; titles mention Ctrl+E).

Each formatting button calls `visual.format(what)` in Visual mode or a Monaco helper in Text mode: bold `**…**`, italic `*…*`, strike `~~…~~`, code `` `…` ``, bullet prefix `- `, ordered `1. `, task `- [ ] `, quote `> `, link `[…](url)`, image `![…](url)` ("description"), hr `insertText('\n---\n\n')`, headings `toggleLinePrefix('# '..'#### ')`, Paragraph → `toggleLinePrefix('# ')` (removes/swaps whichever heading is there).

Under a container query `main (max-width: 760px)` the segment labels, block-picker label and Snapshot label collapse to icons.

### 7.15 `components/DocumentPanel.tsx`

The "Publish card" translation. Props: `activeFile`, `saveState`, `lastSavedAt`, `deleted`, `pendingKind`, `words`, `snapshotCount`, `matterLabel`, `trackingEnabled`, `onReview`, `onSnapshots`, `onMatter(anchor)`, `onSend`, `onProofread`.

Rows (icon, key, value):
- **Status:** no file → `No document open` (muted); deleted → `Deleted on disk` (danger, trash); `error` → `Save failed` (danger, alert); `saving` → `Saving…` (save); `dirty` → `Unsaved changes` (warn, circle-dot); else `Saved <timeAgo>` or `Saved` (ok, check-circle). If `pendingKind`, an inline link `Conflict · Review` (warn) or `Changed · Review` (info) → `onReview`. A 10 s tick re-renders so `timeAgo` stays current.
- **Matter** (tracking only): label or `Not set` (muted), `Edit` button with `data-action="matter"` → `onMatter(button)`.
- **Time today** (tracking only): `<doc> here · <total> total` from `trackerToday(activeFile)`, polled every 30 s; `—` until loaded.
- **Length:** `<n> words` or `—`.
- **Snapshots:** count or `—`, `View` → `onSnapshots`.
- Actions: `Proofread` (sparkles) and primary `Send to Claude` (send; title mentions Ctrl+Enter), both disabled without a file.

`formatDuration(seconds)`: `0m`, `<m>m`, `<h>h`, `<h>h <m>m`. `timeAgo(ts)`: `just now` (<5 s), `<s>s ago`, `<m>m ago`, `<h>h ago`.

### 7.16 `components/MatterCard.tsx`

Headless: renders nothing until `open(anchor)` is called through its ref. Loads `getMatterContext(activeFile)` when enabled / the file changes and reports the current matter label through `onLabel`. When open, a `Popover` (right-aligned to the anchor) with heading `Matter for <name>`; if no matters: hint "No matters have been published yet. Connect your time tracker's folder sync, then come back here."; else a `<select>` (`— No matter —` plus `<label>` with ` (non-billable)` suffix where applicable) that on change calls `setMatter(activeFile, id | null, scope)`, reloads and closes; radio scope `Everything in this folder` (default) / `This document only`; a hint `Currently set on this document` / `the folder <name>` when a source exists.

### 7.17 `components/CommandPalette.tsx`

Modes `commands` and `files`. Overlay (click outside closes; Esc closes via a capture-phase document listener even if focus wandered). Input autofocused (next frame) with a mode icon and an `Esc` kbd. Fuzzy subsequence matcher: +3 for a contiguous match, +1 otherwise, +2 at a word start (`index 0` or after whitespace/`-_./\`), −0.02 per unmatched character; matched characters highlighted with `<mark>`. Commands: filter `enabled !== false`, sort by score. Files: match the basename, or the root-relative path when the query is longer than 2 characters; +0.5 for prose; top 60; each row shows the name and the relative directory. Up/Down/PageUp/PageDown (8)/Enter; hovering focuses. Empty state: `Open a folder first.` (files mode with no files) or `No matches.` Footer: `↑↓ navigate`, `Enter run/open`.

### 7.18 `components/SettingsPanel.tsx`

Overlay dialog ("Settings", "Changes apply immediately", × / Esc). Left nav: Appearance (monitor), Editor (text), Changes from disk (diff), Claude & terminal (terminal), Time tracking (clock). Inputs commit on blur/Enter (number fields clamp; text fields only when changed). Each change is a partial patch to `updateSettings`.

- **Appearance:** Theme select (Follow Windows / Dark / Light); Sidebar width number (180–480).
- **Editor:** Font select from a list (Cascadia Code…, Consolas…, JetBrains Mono…, Fira Code…, Source Code Pro…, Courier New…, Custom…); Custom font stack text (wide; empty → default); Font size (10–28); Wrap at column (0–200, help text); Line numbers switch; Autosave delay (100–5000, step 100; help "Claude only sees saved text."); Open markdown as (Raw markdown / Formatted, with the normalisation caveat).
- **Changes from disk:** cursor radio (Where it was / At the first change / At the end); Offer review switch.
- **Claude & terminal:** Launch command (mono, placeholder `claude`; empty = plain shell); Shell (placeholder `powershell.exe`); Terminal font size (10–24); Send to Claude prompt textarea (help lists the tokens); Proofread prompt textarea.
- **Time tracking:** Record time switch; Tracker folder text + `Browse…` (uses `pickDirectory`).

### 7.19 `components/ui.tsx` and `Icons.tsx`

- `ContextMenu({menu: {x, y, items}, onClose})`: fixed, clamped inside the window (8px margin), items `{label, icon?, shortcut?, danger?, disabled?, onSelect}` | `{kind:'sep'}` | `{kind:'label', label}`; closes on outside mousedown (capture), Esc, window blur; Up/Down/Enter keyboard; hover focuses.
- `Popover({anchor, onClose, align 'left'|'right', above?})`: fixed, positioned below (or above) the anchor, clamped to the window with 6px margins; closes on outside mousedown (excluding the anchor) or Esc.
- `Toasts` + `useToasts()`: `push(text, kind = 'info', ms = 2600)`; kinds ok/warn/danger/info with icons; bottom-right stack, `aria-live="polite"`.
- `IconButton({icon, title, onClick, on, disabled, size 15, small, className, spin})` → `button.btn-icon[.is-on][.sm][.ring]` with `aria-label`.
- `Switch({on, onChange, label})` → `button[role=switch]`.
- `Icons.tsx`: stroke-based 24-grid SVG icons rendered with `currentColor`, stroke 1.75, round caps/joins, `aria-hidden`. Names used: folder, folder-open, folder-plus, file, file-text, file-plus, plus, refresh, search, replace, camera, history, eye, code, bold, italic, strikethrough, heading, list, list-ordered, check-square, quote, link, image, minus, settings, terminal, chevron-right, chevron-down, x, alert, check, undo, send, sun, moon, panel-left, more, sparkles, diff, external, pencil, trash, clock, briefcase, check-circle, text, columns, command, info, save, circle-dot, monitor. Lucide-style geometry is fine; keep them visually uniform.

---

## Part 8 — Visual design and `global.css`

The look follows a light, card-based blog-editor reference: dark navy sidebar, pale ground, white rounded cards, pill tabs, a Document card with Proofread / Send to Claude where the reference had Save Draft / Publish, and the terminal as a dark card. Dark is a full peer theme, not an inversion. Tokens are the single source of every colour.

### Tokens — **verbatim**

```css
:root {
  /* ---- light ---- */
  --ground: #f3f4f7;               /* page ground behind the cards */
  --card: #ffffff;                 /* document, panels, menus */
  --card-2: #f7f8fa;               /* nested strips inside a card: toolbars, rows */
  --bg-hover: rgba(24, 28, 40, 0.05);
  --bg-active: rgba(24, 28, 40, 0.09);
  --line: rgba(24, 28, 40, 0.09);
  --line-strong: rgba(24, 28, 40, 0.16);

  --fg-0: #171a22;
  --fg-1: #3a3f4d;
  --fg-2: #6e7484;
  --fg-3: #9ba0ae;

  --accent: #4b63d6;
  --accent-hover: #3d54c2;
  --accent-fg: #ffffff;
  --accent-soft: rgba(75, 99, 214, 0.10);
  --accent-line: rgba(75, 99, 214, 0.35);

  --primary: #1d2130;              /* dark pill buttons, like the reference's Publish */
  --primary-hover: #2a2f42;
  --primary-fg: #ffffff;

  --ok: #1f9d5b;
  --ok-soft: rgba(31, 157, 91, 0.12);
  --warn: #b8770f;
  --warn-soft: rgba(184, 119, 15, 0.12);
  --danger: #d63d4c;
  --danger-soft: rgba(214, 61, 76, 0.10);
  --info: #2f7fd0;
  --info-soft: rgba(47, 127, 208, 0.10);

  /* sidebar: dark in both themes */
  --side-bg: #1b1f2c;
  --side-bg-2: #232838;
  --side-fg: #eef0f5;
  --side-muted: #8c93a8;
  --side-hover: rgba(255, 255, 255, 0.06);
  --side-active: rgba(255, 255, 255, 0.10);
  --side-line: rgba(255, 255, 255, 0.08);

  --term-bg: #15171c;

  --shadow-card: 0 1px 2px rgba(24, 28, 40, 0.04), 0 4px 16px rgba(24, 28, 40, 0.04);
  --shadow-menu: 0 12px 32px rgba(24, 28, 40, 0.16), 0 1px 3px rgba(24, 28, 40, 0.08);
  --scrollbar: rgba(24, 28, 40, 0.16);
  --scrollbar-hover: rgba(24, 28, 40, 0.28);
  --selection: rgba(75, 99, 214, 0.20);

  --radius-sm: 6px;
  --radius: 8px;
  --radius-lg: 12px;
  --radius-card: 14px;
  --radius-pill: 999px;

  --font-ui: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  --font-display: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --font-prose: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Cascadia Code", Consolas, "Courier New", monospace;

  --ease: 140ms cubic-bezier(0.2, 0, 0, 1);
  --topbar-h: 56px;
  --sidebar-w: 260px;

  color-scheme: light;
}

:root[data-theme="dark"] {
  --ground: #101218;
  --card: #181b23;
  --card-2: #1e222b;
  --bg-hover: rgba(255, 255, 255, 0.06);
  --bg-active: rgba(255, 255, 255, 0.10);
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.15);

  --fg-0: #eceef3;
  --fg-1: #c3c7d1;
  --fg-2: #8d93a3;
  --fg-3: #5f6575;

  --accent: #8399ff;
  --accent-hover: #9aacff;
  --accent-fg: #0e1220;
  --accent-soft: rgba(131, 153, 255, 0.14);
  --accent-line: rgba(131, 153, 255, 0.40);

  --primary: #eceef3;
  --primary-hover: #ffffff;
  --primary-fg: #14171f;

  --ok: #4fcf8a;
  --ok-soft: rgba(79, 207, 138, 0.13);
  --warn: #f0b64a;
  --warn-soft: rgba(240, 182, 74, 0.13);
  --danger: #ff6b7a;
  --danger-soft: rgba(255, 107, 122, 0.13);
  --info: #62b4ff;
  --info-soft: rgba(98, 180, 255, 0.13);

  --side-bg: #0b0d12;
  --side-bg-2: #13161e;
  --side-fg: #eceef3;
  --side-muted: #7d8398;
  --side-hover: rgba(255, 255, 255, 0.06);
  --side-active: rgba(255, 255, 255, 0.10);
  --side-line: rgba(255, 255, 255, 0.07);

  --term-bg: #0f1116;

  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 4px 16px rgba(0, 0, 0, 0.25);
  --shadow-menu: 0 12px 32px rgba(0, 0, 0, 0.55), 0 1px 3px rgba(0, 0, 0, 0.4);
  --scrollbar: rgba(255, 255, 255, 0.12);
  --scrollbar-hover: rgba(255, 255, 255, 0.22);
  --selection: rgba(131, 153, 255, 0.28);

  color-scheme: dark;
}
```

### Base and shell rules (summary; reproduce the intent)

- Reset (`box-sizing: border-box`, zero margins). `html, body, #root`: 100% size, `overflow hidden`, ground background, `--fg-0`, `--font-ui` 13.5px / 1.45, antialiased. Buttons inherit font, no background/border, pointer cursor; disabled `opacity .45`. `:focus-visible` 2px accent outline. 10px transparent-track scrollbars with rounded thumbs. `prefers-reduced-motion` kills transitions. Keyframes `spin`, `rise` (4px up + fade, 4px), `fade`.
- `.kbd`: 10.5px chip, `--card-2` background, 1px line border with a 2px bottom, 5px radius.
- `.app`: flex row, full size. `.content`: flex column. `.topbar`: `--topbar-h`, flex, gap 10, padding `0 20px 0 16px`; `.grow` flexes, `.right` flex gap 4. `.body`: flex, `padding 0 20px 20px`. `.column-main`: flex column, gap 12. `.column-side`: flex 1, column, gap 12. `.divider`: 16px wide, `col-resize`, a 3px × 20% pill in the middle that appears on hover/drag (accent).
- `.card`: `--card` background, 1px `--line` border, `--radius-card`, `--shadow-card`.
- Title card: flex, padding `10px 14px 10px 20px`; `.title-input` 18px/600 display font, transparent border that shows on hover and becomes accent with a soft ring on focus; `.ext` muted; `.crumbs` 11.5px muted, ellipsis, max 40%.
- Editor card: flex column, `overflow hidden`, `container: main / inline-size`. `.editor-area` relative flex 1; `.editor-host` and `.preview-host` absolutely fill it; `.editor-foot` 28px, 11.5px muted, tabular numerals.
- Empty card: centred, 60px accent-soft rounded glyph, 20px display heading, hints grid.
- Buttons: `.btn` pill 32px, 13px/500, `--line-strong` border, card background; variants `.primary` (dark navy pill, white text; in dark theme light pill), `.accent`, `.ghost`, `.soft` (`--card-2`), `.danger`, sizes `.sm` 26px / `.lg` 36px, `.block`. `.btn-icon` 30px square (`.sm` 26), `.is-on` accent on accent-soft, `.ring` bordered card background, `.spin` animation.
- Sidebar: `--side-bg`, column, relative; `.sidebar-resizer` 8px strip on the right edge; `.brand` (28px accent square mark, 15px name); `.side-search` 36px rounded input-like button; `.side-section` uppercase 11px letter-spaced label with 24px icon buttons; `.tree` scrolls; `.tree-row` 30px, radius 8, 13px, opacity .86 (1 on hover/active), `.is-active` `--side-active`, `.is-focused` inset 1px ring, chevron rotates 90° when open, prose/active icons accent, dir names 500, warn `.dot` 7px; `.tree-input`; `.side-empty`; `.side-folder` bottom button with a 30px icon tile.
- Tabs: `.tabbar` flex gap 6, horizontal scroll with hidden scrollbar; `.tab` pill 34px, `--line-strong` border, max 220px; `.is-active` = `--primary` background + `--primary-fg`; badges as above; `.close` 20px circle shown on hover; `.tab-new` dashed-border-less pill with plus.
- Toolbar: 46px, bottom line, horizontal scroll hidden, `.sep` 1×18, `.block-pick` 30px bordered, `.seg` segmented control (`--card-2` track, white `is-on` pill with a subtle shadow).
- Banners: `.banner` flex 8/14/16 padding, 12.5px, bottom line, `rise` animation; `.info` / `.warn` / `.danger` use the soft backgrounds and coloured icons.
- Snapshot list: `--card-2` strip, max 200px scroll; rows 12.5px with label, muted time, buttons.
- Review: absolute inset 0 over the editor area, `z-index 5`; `.review-head` 46px on `--card-2`; `.review-nav` 40px; `.review-labels` 2-column uppercase 11px captions; `.review-host` fills.
- Document card: `.doc-card` padding `4px 0 14px`; `.head h3` 14px display; `.doc-row` 12.5px rows with 16px icon column, key muted, value 500 with ok/warn/danger/info/muted colours, `.edit` small text button; `.doc-actions` two equal buttons.
- Claude card: `--term-bg`, faint white border; `.term-head` 40px with the green live dot and muted cwd; `.term-host` padding `8px 4px 6px 12px`, xterm 100% height, transparent viewport; `.term-stopped` overlay `rgba(15,17,22,.92)`.
- Menus/popovers: fixed, `z-index 1000`, card background, `--radius-lg`, `--shadow-menu`, `rise` animation; menu items 30px, accent-soft when hovered/focused, danger variant. `.overlay`: fixed, `z-index 900`, `rgba(20,23,32,.32)`, content aligned top with `12vh` padding. `.palette` `min(640px, 92vw)`, 50px input row, list max `50vh`, 36px items with accent `mark` highlights, footer hints. `.settings` `min(760px, 94vw)`, max `82vh`, 54px head, 180px nav on `--card-2`, `.field` two-column grid (`1fr 250px`; `.wide` single column) separated by top lines; `.input/.select/.textarea` 32px bordered controls with accent focus ring, `.num` 76px right-aligned; custom `.select` chevron via gradients; `.switch` 38×22 pill with a white knob; `.radio-row`. Toasts bottom-right, `z-index 1100`, `max-width 400px`.
- Visual editor typography: inside `.preview-host .milkdown`, map every `--crepe-color-*` and `--crepe-font-*` variable to the app tokens (background `--card`, on-background `--fg-0`, surface `--card-2`, outline `--line-strong`, primary `--accent`, secondary `--accent-soft`, inline-code `--accent`, error `--danger`, hover `--bg-hover`, selected `--accent-soft`, fonts display/prose/mono, shadows), `max-width 720px`, centred, padding `28px 40px 120px`, `--font-prose`; ProseMirror `line-height 1.7`, no outline, no padding; hide `.milkdown-block-handle`; paragraphs `margin 0 0 1em`; headings display font, 600, tight letter-spacing (h1 2em, h2 1.5em, h3 1.2em with the given margins); blockquote with a 3px `--accent-line` left border; links accent; hr 1px `--line-strong`; code mono 0.9em.

---

## Part 9 — Keyboard reference (must match)

| Shortcut | Action | Handled by |
|---|---|---|
| Ctrl+Shift+P | Command palette (works in the terminal too) | menu + renderer |
| Ctrl+P | Go to document | renderer (yields to terminal) |
| Ctrl+S / Ctrl+Shift+S | Save / Save all (works in the terminal) | menu |
| Ctrl+N, Ctrl+O, Ctrl+Shift+O | New document, open file, open folder | renderer |
| Ctrl+W | Close document | renderer |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous document | menu |
| Ctrl+E | Visual ⇄ Text | renderer |
| Ctrl+\ | Toggle sidebar | renderer |
| Ctrl+` | Focus document ⇄ Claude | menu |
| Ctrl+Enter | Send the current document to Claude | renderer |
| Ctrl+Shift+R | Review a change from disk | menu |
| Ctrl+B, Ctrl+I, Ctrl+K | Bold, italic, link (Text mode, inside Monaco) | Monaco commands |
| Ctrl+, | Settings | menu |
| F2, Delete (sidebar focused) | Rename, move to Recycle Bin | Sidebar |
| Esc | Close palette / settings / review / menus | components |
| Ctrl+Shift+C / Ctrl+Shift+V (terminal) | Copy / paste | xterm handler |

---

## Part 10 — Persistence and files on disk

| What | Where |
|---|---|
| Settings | `%AppData%\drafting-app\settings.json` (Electron `userData`; overridable with `DRAFTER_USER_DATA`) |
| Window bounds | `<userData>\window-state.json` |
| Renderer log | `<userData>\renderer.log` (rotates at 1 MB to `.1`) |
| Session (root, open files, active, split ratio) | renderer `localStorage['drafting-app-session']` |
| Snapshots | `<document folder>\.drafts\<stem>_<id><ext>` + `.meta.json` |
| Atomic-write temp files | `<document folder>\.<name>.<pid>.<t>.tmp` (hidden from listings and the watcher) |
| Time records | `<timeTracking.dir>\drafter-YYYY-MM-DD.json` |
| Matter map | `<timeTracking.dir>\drafter-matter-map.json` |
| Matter list (read only) | `<timeTracking.dir>\app-state.json` (written by the external tracker) |

---

## Part 11 — Build order

Each step should leave `npm run check` clean and `npm start` working.

1. **Scaffold.** `package.json`, tsconfig, eslint, vitest, the four webpack files, `forge.config.ts`, the postinstall patch script, `.gitignore`, `.gitattributes`. `npm install`. Confirm `electron-forge start` opens an empty window.
2. **Contract.** `src/shared/types.ts` verbatim. `src/renderer/global.d.ts`.
3. **Main process, files.** `settings.ts`, `file-manager.ts`, `file-watcher.ts`, `snapshot-manager.ts`, `ipc-handlers.ts` (file, watcher, settings, snapshot, log channels), `main.ts` (window, menu, theme, close handshake, script mode), `preload.ts`. Verify from DevTools that `window.drafting.listDirectory` works.
4. **Renderer skeleton.** `global.css` with the tokens and base/shell rules; `index.html`, `index.tsx`, `ErrorBoundary`, `Icons`, `ui.tsx`, `lib/paths.ts`, `lib/textDiff.ts` + tests (run `npm test`).
5. **State.** `useSettings`, `useFileSystem` complete, including watcher handling and pending changes.
6. **Editor path.** `monacoSetup.ts`, `Editor.tsx`, `Toolbar.tsx`, `TabBar.tsx`, `Sidebar.tsx`, `App.tsx` with Text mode only, session restore, palette, settings panel. Exercise: open a folder, edit, autosave, rename, trash, external change → banner → review → revert.
7. **Visual mode.** `MilkdownPreview.tsx`; wire the toolbar's Visual/Text switch and per-file view modes; verify store reconciliation when switching (edit in Visual, switch to Text, text is current; and back).
8. **Terminal.** `pty-manager.ts`, terminal IPC, `TerminalPane.tsx`, Send to Claude / Proofread prompts, auto-save on terminal focus, the cwd-mismatch toast and restart button, stopped overlay.
9. **Diff review.** `DiffReview.tsx` with change navigation and per-change undo; snapshot compare/restore.
10. **Time tracking.** `time-tracker.ts`, `matter-map.ts`, tracker IPC, `DocumentPanel.tsx`, `MatterCard.tsx`, the window title.
11. **Polish.** Both themes complete; container-query toolbar collapse; keyboard table verified; `README.md`, `CLAUDE.md`, `Rebuild-Drafting-App.cmd`.
12. **Package.** `npm run package`; confirm `out/Drafting App-win32-x64/Drafting App.exe` starts, the terminal spawns (node-pty copied), and script mode works with a scratch `DRAFTER_USER_DATA`.

---

## Part 12 — Acceptance checklist

Run through every line before reporting completion.

**Checks**
- [ ] `npm run check` → tsc clean, eslint 0 errors, 10 vitest tests passing.

**Sync loop**
- [ ] Type in Text mode; the file is written after the autosave delay; the sidebar/tab dirty dot appears and clears; the Document card shows `Saving…` then `Saved just now`.
- [ ] Type, then click into the terminal: the file is written immediately.
- [ ] Modify a clean open file from outside (e.g. PowerShell `Set-Content`): the editor updates within ~200 ms with the cursor in place; the info banner appears; Ctrl+Z undoes it; Review shows the diff; Revert writes the old text back (and the watcher does not bounce it back, because the write was marked).
- [ ] Modify a dirty open file from outside: nothing changes in the editor; the warn banner appears; Use disk version / Keep mine / Review each behave as specified; the tab shows the conflict badge.
- [ ] Delete an open file from outside: red banner, autosave stops, Keep and re-create writes it again; Close removes the tab. Re-creating it externally reloads it.
- [ ] The editor's own saves never trigger a reload (hash echo suppression), including large files (> 64 KiB).
- [ ] Close the window with unsaved edits: the file is on disk when the process exits.

**Editors**
- [ ] Markdown opens in Visual by default; Ctrl+E switches; edits made in Visual are present in Text and vice versa; the store is the truth.
- [ ] All toolbar buttons work in both modes; Paragraph picker swaps heading levels.
- [ ] Binary files (a `.docx`, a `.png`, an extensionless PE) open read-only with the placeholder, never written.
- [ ] Closing a tab disposes its model; reopening reads from disk.
- [ ] Snapshot save / list / compare / restore / delete; a restore keeps a "Before restore" snapshot.

**Terminal**
- [ ] `claude --dangerously-skip-permissions` is typed ~1.2 s after the shell starts; if `claude` is not on PATH the echo message appears instead; an auto-restart after a crash does not auto-launch; three crashes in 10 s show the stopped overlay.
- [ ] Send to Claude types `Edit @<relative path> ` (quoted if it has spaces) and leaves the cursor for the user; with a selection it appends the "Focus on…" sentence; Proofread types the full proofread prompt.
- [ ] Opening a different folder shows the "Claude is still running in …" toast; the header refresh button restarts in the new folder.
- [ ] Ctrl+C, arrow keys, Tab etc. reach the shell; Ctrl+S and Ctrl+Shift+P still work from the terminal; Ctrl+P does not.

**Shell and persistence**
- [ ] Session restores the folder, open tabs, the active tab and the split ratio; window bounds and maximized state persist; an off-screen saved position is discarded.
- [ ] Settings changes apply immediately (theme, fonts, wrap column, line numbers, autosave delay, default view, cursor policy, offer review, launch command, shell, prompts, tracking, sidebar width) and survive restart.
- [ ] Both themes have no unstyled or hard-coded colours; the sidebar and terminal stay dark in light mode.
- [ ] Command palette lists exactly the enabled commands; Quick Open finds files by name and by path.

**Time tracking (with a tracker folder containing an `app-state.json`)**
- [ ] The Matter row shows the resolved matter; Edit opens the picker; folder scope writes `byFolder`, file scope writes `byFile`; the window title includes `[Client · Matter]`.
- [ ] After a minute of focused activity, `drafter-<date>.json` appears with `documents` and `intervals`; idle/unfocused time is not counted.

---

## Part 13 — Gotchas learned the hard way

- **No Monaco worker stub.** A `MonacoEnvironment.getWorker` returning a blob no-op worker makes the diff editor show no changes. Leave `MonacoEnvironment` undefined.
- **No MonacoWebpackPlugin.** Import Monaco through `esm/vs/editor/editor.api` with explicit language contributions; renderer `target: 'web'`.
- **Milkdown needs `resolve.conditionNames`** including `import` first, or webpack cannot resolve `@milkdown/*`.
- **node-pty**: externalised in the main bundle, copied by the `postPackage` hook, `rebuildConfig.onlyModules: []`, `asar: false`, ASAR fuses off, Spectre patch in postinstall. Prebuilt binaries work; do not compile.
- **`sandbox: false`** in webPreferences: the preload bundle references `__dirname` (asset relocator). `contextIsolation` stays on.
- **No Edit menu on Windows/Linux**: clipboard roles would steal Ctrl+C from the shell.
- **`registerAccelerator: false`** on menu items whose keys must yield to the terminal; the renderer handles those keys.
- **Windows emits multiple watcher events per write**: keep echo entries for 5 s instead of deleting on first match; hash content instead of using a time window.
- **OneDrive locks**: retry the rename, then fall back to a direct write rather than losing the save.
- **Milkdown re-serialises the whole document**: reconcile the Monaco model against the store on every attach; never assume the model is current.
- **Keystrokes must not set React state**: put content in a ref; only dirty transitions render.
- **`current = null` before `kill()`** in the PTY manager, or the exit handler restarts the shell you just killed.
- **The desktop cannot be screenshotted by external tools** in some environments; use the app's script mode for visual checks.
