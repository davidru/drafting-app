import * as fs from 'fs';
import * as path from 'path';
import { dialog, shell, BrowserWindow } from 'electron';
import { FileEntry, BatchReadResult } from '../shared/types';

export async function readFile(filePath: string): Promise<string> {
  return fs.promises.readFile(filePath, 'utf-8');
}

// Known binary magic-byte signatures. If a file's first bytes match, it's not text.
const BINARY_SIGNATURES: Buffer[] = [
  Buffer.from('%PDF', 'ascii'),
  Buffer.from([0x50, 0x4B, 0x03, 0x04]), // ZIP / Office
  Buffer.from([0x50, 0x4B, 0x05, 0x06]),
  Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07]), // RAR
  Buffer.from([0x1F, 0x8B]), // GZIP
  Buffer.from([0xFF, 0xD8, 0xFF]), // JPEG
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG
  Buffer.from('GIF87a', 'ascii'),
  Buffer.from('GIF89a', 'ascii'),
  Buffer.from([0x42, 0x4D]), // BMP
  Buffer.from([0x00, 0x00, 0x01, 0x00]), // ICO
  Buffer.from([0x4D, 0x5A]), // Windows PE
  Buffer.from([0x7F, 0x45, 0x4C, 0x46]), // ELF
  Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]), // Mach-O
  Buffer.from([0xCF, 0xFA, 0xED, 0xFE]),
  Buffer.from('ID3', 'ascii'), // MP3
  Buffer.from([0x66, 0x4C, 0x61, 0x43]), // FLAC
  Buffer.from([0x49, 0x49, 0x2A, 0x00]), // TIFF
  Buffer.from([0x4D, 0x4D, 0x00, 0x2A]),
  Buffer.from([0x38, 0x42, 0x50, 0x53]), // PSD
];

/** Sniff the first bytes of a file for a binary signature. Never throws. */
export async function isBinaryByMagic(filePath: string): Promise<boolean> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    const head = buf.subarray(0, bytesRead);
    for (const sig of BINARY_SIGNATURES) {
      if (head.length >= sig.length && head.subarray(0, sig.length).equals(sig)) return true;
    }
    // A NUL byte in the first 16 bytes is a strong hint of binary content.
    return head.includes(0);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch((): void => undefined);
  }
}

/** Read several files in parallel; one failure does not fail the batch. */
export async function readFiles(paths: string[]): Promise<BatchReadResult[]> {
  const results = await Promise.allSettled(paths.map((p) => fs.promises.readFile(p, 'utf-8')));
  return results.map((r, i) => {
    const filePath = paths[i];
    if (r.status === 'fulfilled') return { path: filePath, content: r.value };
    return { path: filePath, error: String(r.reason?.message ?? r.reason) };
  });
}

const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 60;

/**
 * Atomic write: the content goes to a temp file beside the target, is fsynced,
 * then renamed over the target. Readers (Claude, OneDrive) never see a
 * truncated file, and a crash mid-write leaves the old version intact.
 *
 * OneDrive occasionally holds a short lock on a file it is syncing, which makes
 * the rename fail with EPERM/EBUSY. Retry briefly, then fall back to a direct
 * write rather than lose the save.
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (retryable && attempt < RENAME_RETRIES) {
        await new Promise((r) => setTimeout(r, RENAME_RETRY_MS * attempt));
        continue;
      }
      // Last resort: write directly so the save is not lost, then clean up.
      await fs.promises.writeFile(filePath, content, 'utf-8');
      await fs.promises.unlink(tmp).catch((): void => undefined);
      return;
    }
  }
}

export async function createFile(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, '', { flag: 'wx' }); // fails if the file exists
}

export async function createDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function renamePath(from: string, to: string): Promise<void> {
  if (fs.existsSync(to)) throw new Error(`${path.basename(to)} already exists`);
  await fs.promises.rename(from, to);
}

/** Move to the OS recycle bin rather than deleting outright. */
export async function trashPath(target: string): Promise<void> {
  await shell.trashItem(target);
}

export function revealPath(target: string): void {
  shell.showItemInFolder(target);
}

export function pathExists(target: string): boolean {
  return fs.existsSync(target);
}

// Names that should never appear in the explorer.
const HIDDEN_NAMES = new Set(['.git', '.DS_Store', '.svn', '.hg', '.drafts', 'node_modules', 'Thumbs.db', 'desktop.ini']);

export async function listDirectory(dirPath: string, depth = 0, maxDepth = 1): Promise<FileEntry[]> {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const result: FileEntry[] = [];

  for (const entry of entries) {
    if (HIDDEN_NAMES.has(entry.name)) continue;
    if (/\.tmp$/i.test(entry.name) && entry.name.startsWith('.')) continue; // our own atomic-write temp files
    const fullPath = path.join(dirPath, entry.name);
    const fileEntry: FileEntry = { name: entry.name, path: fullPath, isDirectory: entry.isDirectory() };
    if (entry.isDirectory() && depth < maxDepth) {
      try {
        fileEntry.children = await listDirectory(fullPath, depth + 1, maxDepth);
      } catch {
        fileEntry.children = [];
      }
    }
    result.push(fileEntry);
  }

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
  return result;
}

export async function openDirectoryDialog(window: BrowserWindow, defaultPath?: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openDirectory'],
    title: 'Open Folder',
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

const TEXT_EXTENSIONS = ['md', 'markdown', 'mdx', 'txt', 'json', 'yaml', 'yml', 'xml', 'csv', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'cs', 'sh', 'bat', 'ps1', 'cfg', 'ini', 'conf', 'log', 'svg', 'toml'];

export async function openFileDialog(window: BrowserWindow, defaultPath?: string): Promise<string[] | null> {
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile', 'multiSelections'],
    title: 'Open File',
    defaultPath,
    filters: [
      { name: 'Text Files', extensions: TEXT_EXTENSIONS },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
}

export async function newFileDialog(window: BrowserWindow, defaultDir?: string): Promise<string | null> {
  const result = await dialog.showSaveDialog(window, {
    title: 'New File',
    defaultPath: defaultDir ? path.join(defaultDir, 'untitled.md') : 'untitled.md',
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.mkdir(path.dirname(result.filePath), { recursive: true });
  await fs.promises.writeFile(result.filePath, '', 'utf-8');
  return result.filePath;
}
