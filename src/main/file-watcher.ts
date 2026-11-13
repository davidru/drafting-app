import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { IPC, FileChangeEvent } from '../shared/types';

let watcher: chokidar.FSWatcher | null = null;

// Open documents that live outside the watched folder. The folder watch never
// sees them, so an edit by Claude would go unnoticed; they are watched by file.
let extraFiles = new Set<string>();

// Echo suppression is content-based. When the editor writes a file we remember a
// hash of the bytes written. When the watcher fires for that path we re-read the
// file and compare: equal means it was our own write, different means someone
// else (Claude) wrote after us. A single write can produce more than one watcher
// event on Windows, so the entry is kept until it expires rather than deleted on
// first match.
const recentEditorWrites = new Map<string, { hash: string; ts: number }>();
const WRITE_ECHO_LIFETIME_MS = 5000;
const HASH_HEAD_BYTES = 64 * 1024;

export function hashBuffer(buf: Buffer): string {
  if (buf.length > HASH_HEAD_BYTES) {
    const head = buf.subarray(0, HASH_HEAD_BYTES);
    return crypto.createHash('sha1').update(head).update(String(buf.length)).digest('hex');
  }
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function pruneOldEntries(): void {
  const now = Date.now();
  for (const [p, e] of recentEditorWrites) {
    if (now - e.ts > WRITE_ECHO_LIFETIME_MS) recentEditorWrites.delete(p);
  }
}

export function markEditorWrite(filePath: string, content: string): void {
  recentEditorWrites.set(filePath, { hash: hashBuffer(Buffer.from(content, 'utf-8')), ts: Date.now() });
  pruneOldEntries();
}

/** Decide whether a change event is the editor's own echo. Exported for tests. */
export async function isEditorEcho(filePath: string, readDisk: (p: string) => Promise<Buffer> = (p) => fs.promises.readFile(p)): Promise<boolean> {
  const last = recentEditorWrites.get(filePath);
  if (!last) return false;
  if (Date.now() - last.ts > WRITE_ECHO_LIFETIME_MS) {
    recentEditorWrites.delete(filePath);
    return false;
  }
  try {
    return hashBuffer(await readDisk(filePath)) === last.hash;
  } catch {
    return false; // gone or unreadable: let the renderer decide
  }
}

export function startWatching(dirPath: string, window: BrowserWindow): void {
  stopWatching();

  watcher = chokidar.watch([dirPath, ...extraFiles], {
    ignored: [
      /(^|[/\\])\.git([/\\]|$)/,
      /(^|[/\\])\.DS_Store$/,
      /(^|[/\\])\.svn([/\\]|$)/,
      /(^|[/\\])\.hg([/\\]|$)/,
      /(^|[/\\])\.drafts([/\\]|$)/, // snapshot directory
      /(^|[/\\])node_modules([/\\]|$)/,
      /(^|[/\\])\.[^/\\]*\.tmp$/, // our own atomic-write temp files
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 30 },
  });

  const send = async (eventType: FileChangeEvent['eventType'], filePath: string) => {
    if (eventType === 'change' && (await isEditorEcho(filePath))) return;
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.WATCHER_EVENT, { filePath, eventType } satisfies FileChangeEvent);
    }
  };

  watcher
    .on('change', (p) => { void send('change', p); })
    .on('add', (p) => { void send('add', p); })
    .on('unlink', (p) => { void send('unlink', p); })
    .on('addDir', (p) => { void send('addDir', p); })
    .on('unlinkDir', (p) => { void send('unlinkDir', p); })
    .on('error', (err) => { console.error('[watcher] error:', err); });
}

/** Replace the set of out-of-folder files being watched. Safe to call before startWatching. */
export function setExtraWatched(paths: string[]): void {
  const next = new Set(paths);
  if (watcher) {
    const gone = [...extraFiles].filter((p) => !next.has(p));
    const added = [...next].filter((p) => !extraFiles.has(p));
    if (gone.length) void watcher.unwatch(gone);
    if (added.length) watcher.add(added);
  }
  extraFiles = next;
}

export function stopWatching(): void {
  if (watcher) {
    void watcher.close();
    watcher = null;
  }
  recentEditorWrites.clear();
}
