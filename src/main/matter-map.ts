/**
 * Maps documents to matters in an external time tracker.
 *
 * The matter list is read from app-state.json, which the tracker publishes when
 * folder sync is connected. The mapping itself lives in drafter-matter-map.json
 * beside it, so the scheduled scans can read it too.
 *
 * A file-level assignment wins over a folder one; among folders, the nearest
 * ancestor wins, so a matter set on a client folder covers everything beneath it
 * unless a subfolder says otherwise.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MatterContext, MatterOption } from '../shared/types';
import { getSettings } from './settings';

interface MatterMap {
  byFolder: Record<string, string>;
  byFile: Record<string, string>;
}

export function timeDir(): string {
  return getSettings().timeTracking.dir;
}

function mapPath(): string {
  return path.join(timeDir(), 'drafter-matter-map.json');
}

/** Matters the tracker has published. Empty if folder sync was never connected. */
export function readMatters(): MatterOption[] {
  try {
    const dir = timeDir();
    if (!dir) return [];
    const file = path.join(dir, 'app-state.json');
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const root = raw && raw.state ? raw.state : raw;
    const matters: unknown[] = (root && root.matters) || [];
    return matters
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && !!(m as Record<string, unknown>).id && !(m as Record<string, unknown>).archived)
      .map((m) => ({
        id: String(m.id),
        client: String(m.client || ''),
        name: String(m.name || ''),
        label: `${m.client || '?'} · ${m.name || '?'}`,
        billable: m.billable !== false,
      }));
  } catch {
    return [];
  }
}

export function readMap(): MatterMap {
  try {
    const file = mapPath();
    if (timeDir() && fs.existsSync(file)) {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { byFolder: m.byFolder || {}, byFile: m.byFile || {} };
    }
  } catch {
    /* fall through to an empty map */
  }
  return { byFolder: {}, byFile: {} };
}

function writeMap(m: MatterMap): void {
  try {
    const dir = timeDir();
    if (!dir || !fs.existsSync(dir)) return;
    const payload = {
      note:
        'Maps Drafting App folders and files to matters in an external time tracker. ' +
        'Written by the Drafting App; safe to edit by hand. A file entry beats a folder entry; ' +
        'among folders the deepest matching path wins.',
      updatedAt: new Date().toISOString(),
      byFolder: m.byFolder,
      byFile: m.byFile,
    };
    fs.writeFileSync(mapPath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    /* a read-only folder should never break the editor */
  }
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Pure resolution against a given map. Exported for tests. */
export function resolveIn(map: MatterMap, filePath: string | null): { matterId: string | null; source: 'file' | 'folder' | null; sourcePath: string | null } {
  if (!filePath) return { matterId: null, source: null, sourcePath: null };
  const target = norm(filePath);

  for (const key of Object.keys(map.byFile)) {
    if (norm(key) === target) return { matterId: map.byFile[key], source: 'file', sourcePath: key };
  }

  let best: string | null = null;
  let bestKey: string | null = null;
  let bestLength = -1;
  for (const key of Object.keys(map.byFolder)) {
    const folder = norm(key);
    if (target.startsWith(folder + '/') && folder.length > bestLength) {
      best = map.byFolder[key];
      bestKey = key;
      bestLength = folder.length;
    }
  }
  return best ? { matterId: best, source: 'folder', sourcePath: bestKey } : { matterId: null, source: null, sourcePath: null };
}

export function resolveMatterId(filePath: string | null): string | null {
  return resolveIn(readMap(), filePath).matterId;
}

export function matterContext(filePath: string | null): MatterContext {
  const r = resolveIn(readMap(), filePath);
  return { matters: readMatters(), matterId: r.matterId, source: r.source, sourcePath: r.sourcePath };
}

export function labelFor(matterId: string | null): string | null {
  if (!matterId) return null;
  const found = readMatters().find((m) => m.id === matterId);
  return found ? found.label : null;
}

/** Assign (or clear, with null) the matter for a file or its containing folder. */
export function setMatter(filePath: string, matterId: string | null, scope: 'file' | 'folder'): void {
  const map = readMap();
  if (scope === 'file') {
    if (matterId) map.byFile[filePath] = matterId;
    else delete map.byFile[filePath];
  } else {
    const folder = path.dirname(filePath);
    if (matterId) map.byFolder[folder] = matterId;
    else delete map.byFolder[folder];
    // a folder decision should not be masked by a stale file override
    if (matterId) delete map.byFile[filePath];
  }
  writeMap(map);
}
