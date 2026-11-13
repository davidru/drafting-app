import { app, BrowserWindow, Menu, ipcMain, screen, nativeTheme, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerIpcHandlers, cleanupIpcHandlers } from './ipc-handlers';
import { initTimeTracker, disposeTimeTracker } from './time-tracker';
import { getSettings, onSettingsChanged } from './settings';
import { AppCommand, IPC } from '../shared/types';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

if (require('electron-squirrel-startup')) {
  app.quit();
}

// Developer aid: run against a separate profile (settings, session, logs).
if (process.env.DRAFTER_USER_DATA) {
  app.setPath('userData', process.env.DRAFTER_USER_DATA);
}

let mainWindow: BrowserWindow | null = null;

// ---------------------------------------------------------------------------
// Window state (size, position, maximised) persisted between launches.
// ---------------------------------------------------------------------------

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

function windowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState(): WindowState {
  const fallback: WindowState = { width: 1440, height: 900, maximized: false };
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath(), 'utf8')) as WindowState;
    if (typeof saved.width !== 'number' || typeof saved.height !== 'number') return fallback;
    // Only honour a position that is still on a connected display.
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const onScreen = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return saved.x! >= b.x - 50 && saved.y! >= b.y - 50 && saved.x! < b.x + b.width && saved.y! < b.y + b.height;
      });
      if (!onScreen) { delete saved.x; delete saved.y; }
    }
    return { ...fallback, ...saved };
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const maximized = win.isMaximized();
    const b = maximized ? (win.getNormalBounds?.() ?? win.getBounds()) : win.getBounds();
    const state: WindowState = { x: b.x, y: b.y, width: b.width, height: b.height, maximized };
    fs.writeFileSync(windowStatePath(), JSON.stringify(state), 'utf8');
  } catch {
    /* never critical */
  }
}

// ---------------------------------------------------------------------------
// Menu. Accelerators here fire regardless of which pane has focus, so this set
// is kept to the shortcuts that must work even inside the terminal. Everything
// else is handled in the renderer, where it can yield to the shell.
// ---------------------------------------------------------------------------

function buildMenu(send: (command: AppCommand) => void): Menu {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '&File',
      submenu: [
        { label: 'New File', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => send('file.new') },
        { label: 'Open File…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: () => send('file.open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', registerAccelerator: false, click: () => send('folder.open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('file.save') },
        { label: 'Save All', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file.saveAll') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: () => send('tab.close') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('view.settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Clipboard roles are only registered on macOS, where the menu is the only
    // way they work. On Windows and Linux they would steal Ctrl+C from the shell.
    ...(isMac ? [{ role: 'editMenu' as const }] : []),
    {
      label: '&View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('view.palette') },
        { label: 'Quick Open…', accelerator: 'CmdOrCtrl+P', registerAccelerator: false, click: () => send('view.quickOpen') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: () => send('view.toggleSidebar') },
        { label: 'Toggle Preview', accelerator: 'CmdOrCtrl+E', registerAccelerator: false, click: () => send('view.togglePreview') },
        { label: 'Switch Editor / Terminal', accelerator: 'CmdOrCtrl+`', click: () => send('view.focusToggle') },
        { label: 'Review Changes', accelerator: 'CmdOrCtrl+Shift+R', click: () => send('review.changes') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Tabs',
      submenu: [
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => send('tab.next') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => send('tab.prev') },
      ],
    },
    {
      label: '&Claude',
      submenu: [
        { label: 'Send File to Claude', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: () => send('claude.send') },
        { label: 'Proofread with Claude', click: () => send('claude.proofread') },
        { type: 'separator' },
        { label: 'Restart Terminal in Open Folder', click: () => send('terminal.restart') },
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Claude Code Documentation', click: () => { void shell.openExternal('https://docs.anthropic.com/en/docs/claude-code'); } },
        { label: 'Open Settings Folder', click: () => { void shell.openPath(app.getPath('userData')); } },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// ---------------------------------------------------------------------------

function applyTheme(): void {
  nativeTheme.themeSource = getSettings().theme;
}

const createWindow = (): void => {
  const state = loadWindowState();
  applyTheme();

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 540,
    title: 'Drafting App',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7fa',
    show: false,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs __dirname for webpack asset-relocator-loader
      spellcheck: true,
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  registerIpcHandlers(win);
  initTimeTracker(win);
  void win.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  // Developer aid for checking a build without a person at the keyboard.
  //   DRAFTER_SCREENSHOT=<file.png>   capture the window ~4 s after load
  //   DRAFTER_SHOTS="step;step;..."   run a script, where a step is one of
  //       cmd:<app command>[=payload]   e.g. cmd:folder.openPath=C:\docs
  //       key:<key>                     e.g. key:Escape
  //       click:<css selector>          e.g. click:[data-action=matter]
  //       wait:<ms>
  //       shot:<name>                   writes <DRAFTER_SHOT_DIR>/<name>.png
  const shotPath = process.env.DRAFTER_SCREENSHOT;
  const script = process.env.DRAFTER_SHOTS;
  if (shotPath || script) {
    const capture = async (file: string) => {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(file, image.toPNG());
        console.log(`[screenshot] wrote ${file}`);
      } catch (err) {
        console.error('[screenshot] failed:', err);
      }
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    win.webContents.once('did-finish-load', async () => {
      await sleep(Number(process.env.DRAFTER_SCREENSHOT_DELAY_MS) || 2500);
      if (shotPath) await capture(shotPath);
      if (!script) return;
      const dir = process.env.DRAFTER_SHOT_DIR || app.getPath('temp');
      for (const raw of script.split(';')) {
        const step = raw.trim();
        if (!step) continue;
        const i = step.indexOf(':');
        const kind = step.slice(0, i);
        const rest = step.slice(i + 1);
        if (kind === 'wait') await sleep(Number(rest) || 500);
        else if (kind === 'shot') await capture(path.join(dir, `${rest}.png`));
        else if (kind === 'click') {
          // click:<css selector>  clicks the first matching element in the page
          await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(rest)}); if (el) el.click(); return !!el; })()`);
          await sleep(500);
        } else if (kind === 'key') {
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: rest });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: rest });
          await sleep(400);
        } else if (kind === 'cmd') {
          const eq = rest.indexOf('=');
          const cmd = (eq >= 0 ? rest.slice(0, eq) : rest) as AppCommand;
          const payload = eq >= 0 ? rest.slice(eq + 1) : undefined;
          if (!win.isDestroyed()) win.webContents.send(IPC.APP_COMMAND, cmd, payload);
          await sleep(700);
        }
      }
      console.log('[screenshot] script finished');
    });
  }

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[Renderer:${event.level}] ${event.message}`);
    }
  });

  // Open external links in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const send = (command: AppCommand) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.APP_COMMAND, command);
  };
  Menu.setApplicationMenu(buildMenu(send));

  // Persist window bounds, debounced.
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => saveWindowState(win), 400);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);

  // Close handshake: ask the renderer to flush unsaved files, wait for the
  // acknowledgement (or a short timeout), then really close.
  let flushed = false;
  win.on('close', (event) => {
    if (flushed) return;
    event.preventDefault();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ipcMain.removeListener(IPC.APP_FLUSH_DONE, finish);
      flushed = true;
      saveWindowState(win);
      if (!win.isDestroyed()) win.close();
    };
    ipcMain.once(IPC.APP_FLUSH_DONE, finish);
    setTimeout(finish, 3000);
    send('app.flushRequest');
  });

  win.on('closed', () => {
    disposeTimeTracker();
    cleanupIpcHandlers();
    mainWindow = null;
  });
};

app.on('ready', () => {
  createWindow();
  onSettingsChanged(applyTheme);
});

app.on('before-quit', () => {
  disposeTimeTracker();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

export { mainWindow };
