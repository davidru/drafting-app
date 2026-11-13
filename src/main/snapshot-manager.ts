import * as fs from 'fs';
import * as path from 'path';
import { SnapshotInfo } from '../shared/types';

const SNAPSHOTS_DIR = '.drafts';

function getSnapshotsDir(filePath: string): string {
  return path.join(path.dirname(filePath), SNAPSHOTS_DIR);
}

function getSnapshotFileName(originalName: string, id: string): string {
  const ext = path.extname(originalName);
  const base = path.basename(originalName, ext);
  return `${base}_${id}${ext}`;
}

export async function saveSnapshot(filePath: string, label?: string): Promise<SnapshotInfo> {
  const snapshotsDir = getSnapshotsDir(filePath);
  await fs.promises.mkdir(snapshotsDir, { recursive: true });

  const id = Date.now().toString(36);
  const snapshotPath = path.join(snapshotsDir, getSnapshotFileName(path.basename(filePath), id));
  await fs.promises.copyFile(filePath, snapshotPath);

  const meta: SnapshotInfo = {
    id,
    filePath,
    timestamp: new Date().toISOString(),
    label: label || `Snapshot ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    snapshotPath,
  };
  await fs.promises.writeFile(snapshotPath + '.meta.json', JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

export async function listSnapshots(filePath: string): Promise<SnapshotInfo[]> {
  const snapshotsDir = getSnapshotsDir(filePath);
  const originalName = path.basename(filePath);
  const base = path.basename(originalName, path.extname(originalName));

  try {
    const entries = await fs.promises.readdir(snapshotsDir);
    const metaFiles = entries.filter((f) => f.startsWith(base + '_') && f.endsWith('.meta.json'));
    const snapshots: SnapshotInfo[] = [];
    for (const metaFile of metaFiles) {
      try {
        const meta = JSON.parse(await fs.promises.readFile(path.join(snapshotsDir, metaFile), 'utf-8'));
        if (fs.existsSync(meta.snapshotPath)) snapshots.push(meta);
      } catch {
        /* skip corrupted meta files */
      }
    }
    snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return snapshots;
  } catch {
    return [];
  }
}

export async function readSnapshot(snapshotPath: string): Promise<string> {
  return fs.promises.readFile(snapshotPath, 'utf-8');
}

/** Restore a snapshot's content. The current file is snapshotted first so the restore itself can be undone. */
export async function restoreSnapshot(snapshotPath: string, targetPath: string): Promise<string> {
  if (fs.existsSync(targetPath)) {
    await saveSnapshot(targetPath, 'Before restore');
  }
  const content = await fs.promises.readFile(snapshotPath, 'utf-8');
  await fs.promises.writeFile(targetPath, content, 'utf-8');
  return content;
}

export async function deleteSnapshot(snapshotPath: string): Promise<void> {
  await fs.promises.unlink(snapshotPath).catch((): void => undefined);
  await fs.promises.unlink(snapshotPath + '.meta.json').catch((): void => undefined);
}
