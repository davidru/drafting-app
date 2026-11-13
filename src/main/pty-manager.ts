import * as pty from 'node-pty';
import * as os from 'os';
import { exec } from 'child_process';
import { BrowserWindow } from 'electron';
import { IPC } from '../shared/types';
import { getSettings } from './settings';

interface Instance {
  proc: pty.IPty;
  id: number;
  cwd: string;
}

let current: Instance | null = null;
let nextId = 1;
let restartCount = 0;
let lastStartTime = 0;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10000;
const AUTO_LAUNCH_DELAY_MS = 1200;

function isWindows(): boolean {
  return os.platform() === 'win32';
}

/** Resolve whether an executable exists on PATH. Never rejects. */
function commandExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = isWindows() ? `where ${name}` : `which ${name}`;
    exec(cmd, { timeout: 2000 }, (err, stdout) => resolve(!err && !!stdout && stdout.trim().length > 0));
  });
}

export function terminalCwd(): string | null {
  return current ? current.cwd : null;
}

/**
 * Start a shell. `autoLaunch` types the configured launch command (normally
 * `claude ...`) once the shell is up. Auto-restarts after a crash never
 * auto-launch, so a failing command cannot loop.
 */
export function createTerminal(window: BrowserWindow, cwd?: string, autoLaunch = true): void {
  if (current) return;

  const now = Date.now();
  if (now - lastStartTime < RESTART_WINDOW_MS) {
    restartCount++;
    if (restartCount >= MAX_RESTARTS) {
      if (!window.isDestroyed()) window.webContents.send(IPC.TERMINAL_STOPPED);
      restartCount = 0;
      return;
    }
  } else {
    restartCount = 0;
  }
  lastStartTime = now;

  const settings = getSettings();
  const shell = settings.terminal.shell || (isWindows() ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
  const workDir = cwd || os.homedir();

  let proc: pty.IPty;
  try {
    proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workDir,
      env: { ...process.env, TERM_PROGRAM: 'DraftingApp' } as Record<string, string>,
    });
  } catch (err) {
    console.error('[pty] spawn failed:', err);
    if (!window.isDestroyed()) window.webContents.send(IPC.TERMINAL_STOPPED);
    return;
  }

  const id = nextId++;
  const instance: Instance = { proc, id, cwd: workDir };
  current = instance;

  proc.onData((data) => {
    if (!window.isDestroyed()) window.webContents.send(IPC.TERMINAL_DATA, data);
  });

  proc.onExit(({ exitCode }) => {
    console.log(`[pty] shell ${id} exited with code ${exitCode}`);
    // Only the live instance schedules a restart; an instance we killed on
    // purpose (restart, dispose) has already been replaced or cleared.
    if (current?.id !== id) return;
    current = null;
    if (!window.isDestroyed()) {
      setTimeout(() => createTerminal(window, workDir, false), 1000);
    }
  });

  const launch = settings.terminal.launchCommand.trim();
  if (autoLaunch && launch) {
    setTimeout(async () => {
      if (current?.id !== id) return;
      const exe = launch.split(/\s+/)[0];
      const exists = await commandExists(exe);
      if (current?.id !== id) return;
      if (exists) {
        proc.write(`${launch}\r`);
      } else {
        proc.write(`echo "${exe} was not found on PATH. Install it, or change the launch command in Settings."\r`);
      }
    }, AUTO_LAUNCH_DELAY_MS);
  }
}

export function writeToTerminal(data: string): void {
  current?.proc.write(data);
}

export function resizeTerminal(cols: number, rows: number): void {
  try {
    if (cols > 0 && rows > 0) current?.proc.resize(cols, rows);
  } catch {
    /* can happen during shutdown */
  }
}

function killCurrent(): void {
  if (!current) return;
  const inst = current;
  current = null; // clear first so onExit does not schedule a restart
  try { inst.proc.kill(); } catch { /* already gone */ }
}

export function disposeTerminal(): void {
  killCurrent();
}

/** Fresh shell (optionally in a new folder) with the launch command typed again. */
export function restartTerminal(window: BrowserWindow, cwd?: string): void {
  killCurrent();
  restartCount = 0;
  lastStartTime = 0;
  createTerminal(window, cwd, true);
}
