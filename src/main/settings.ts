/**
 * Persistent app settings, stored as JSON in the Electron userData folder.
 *
 * Reads are cached in memory; writes are atomic (temp + rename) so a crash
 * mid-write never leaves a half-written settings file. Unknown keys in the file
 * are preserved on disk but ignored, and missing keys fall back to defaults, so
 * older and newer builds can share one file.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings, DEFAULT_SETTINGS } from '../shared/types';

type Listener = (settings: AppSettings) => void;

let cached: AppSettings | null = null;
const listeners = new Set<Listener>();

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` over `base`, keeping only keys that exist in `base`. */
function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isObject(base) || !isObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(base as Record<string, unknown>)) {
    if (!(key in patch)) continue;
    const b = (base as Record<string, unknown>)[key];
    const p = patch[key];
    if (isObject(b)) {
      out[key] = mergeKnown(b, p);
    } else if (typeof p === typeof b || b === null) {
      out[key] = p;
    }
  }
  return out as T;
}

export function getSettings(): AppSettings {
  if (cached) return cached;
  let fromDisk: unknown = {};
  try {
    fromDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    /* first run, or unreadable: use defaults */
  }
  const merged = mergeKnown(DEFAULT_SETTINGS, fromDisk);
  if (!merged.timeTracking.dir) {
    merged.timeTracking.dir = process.env.DRAFTER_TIME_DIR || '';
  }
  cached = merged;
  return merged;
}

export function updateSettings(patch: unknown): AppSettings {
  const next = mergeKnown(getSettings(), patch);
  cached = next;
  try {
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[settings] write failed:', err);
  }
  for (const l of listeners) l(next);
  return next;
}

export function onSettingsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
