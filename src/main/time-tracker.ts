/**
 * Per-document time tracking for an external time tracker.
 *
 * Records not just how long each document was worked on, but WHEN, as a list of
 * contiguous sessions with start and end times. Intervals let the tracker detect
 * overlap exactly (a document open during a call is not separate billable time)
 * and draw a timeline of the day, neither of which daily totals can do.
 *
 * "Active" means this window is focused AND the OS has seen input recently, so
 * reading and reviewing count but walking away does not.
 *
 * Everything fails soft: if the output folder is missing or tracking is turned
 * off in Settings, this is a no-op.
 */
import { BrowserWindow, powerMonitor } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { resolveMatterId, labelFor } from './matter-map';
import { getSettings, onSettingsChanged } from './settings';
import { TrackerToday } from '../shared/types';

const TICK_MS = 10_000;             // how often we sample
const FLUSH_MS = 60_000;            // how often we write to disk
const IDLE_CUTOFF_SECONDS = 60;     // no OS input for this long => stop counting
const MIN_SECONDS_TO_RECORD = 60;   // ignore documents touched only briefly
const MIN_INTERVAL_SECONDS = 30;    // ignore very short session fragments
const MAX_INTERVALS = 500;          // hard cap so a long day can't bloat the file
const KEEP_DAYS = 45;               // prune older summaries

interface DocRecord {
  path: string;
  name: string;
  folder: string;
  matterId: string | null;
  matterLabel: string | null;
  seconds: number;
  firstAt: string;
  lastAt: string;
}

/** A contiguous stretch of work on one document. */
interface Session {
  path: string;
  name: string;
  folder: string;
  matterId: string | null;
  matterLabel: string | null;
  start: string;
  end: string;
  seconds: number;
}

let win: BrowserWindow | null = null;
let activePath: string | null = null;
let activeRoot: string | null = null;
let activeMatterId: string | null = null;
let activeMatterLabel: string | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let records = new Map<string, DocRecord>();
let sessions: Session[] = [];
let current: Session | null = null;
let lastTickMs = 0;
let day = localDate();
let dirty = false;
let offSettings: (() => void) | null = null;

function localDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function outDir(): string {
  const s = getSettings().timeTracking;
  return s.enabled ? s.dir : '';
}

function outFile(forDay: string): string {
  return path.join(outDir(), `drafter-${forDay}.json`);
}

/** Reload today's file so a restart doesn't discard time already recorded. */
function loadToday(): void {
  try {
    if (!outDir()) return;
    const file = outFile(day);
    if (!fs.existsSync(file)) return;
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));

    for (const d of prev.documents || []) {
      if (d && typeof d.path === 'string') {
        records.set(d.path, {
          path: d.path,
          name: d.name || path.basename(d.path),
          folder: d.folder || '',
          matterId: d.matterId ?? null,
          matterLabel: d.matterLabel ?? null,
          seconds: Number(d.seconds) || 0,
          firstAt: d.firstAt || new Date().toISOString(),
          lastAt: d.lastAt || new Date().toISOString(),
        });
      }
    }
    for (const s of prev.intervals || []) {
      if (s && s.start && s.end) {
        sessions.push({
          path: s.path || '',
          name: s.name || '',
          folder: s.folder || '',
          matterId: s.matterId ?? null,
          matterLabel: s.matterLabel ?? null,
          start: s.start,
          end: s.end,
          seconds: Number(s.seconds) || 0,
        });
      }
    }
  } catch {
    /* a corrupt or unreadable file should never stop the editor */
  }
}

function prune(): void {
  try {
    const dir = outDir();
    if (!dir || !fs.existsSync(dir)) return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^drafter-\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch {
    /* pruning is housekeeping, never critical */
  }
}

export function flush(): void {
  if (!dirty) return;
  try {
    const dir = outDir();
    if (!dir || !fs.existsSync(dir)) return;

    const documents = Array.from(records.values())
      .filter((d) => d.seconds >= MIN_SECONDS_TO_RECORD)
      .sort((a, b) => b.seconds - a.seconds)
      .map((d) => ({ ...d, minutes: Math.round(d.seconds / 6) / 10 }));

    if (documents.length === 0) return;

    const allSessions = current ? sessions.concat([current]) : sessions;
    const intervals = allSessions
      .filter((s) => s.seconds >= MIN_INTERVAL_SECONDS)
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(-MAX_INTERVALS)
      .map((s) => ({ ...s, minutes: Math.round(s.seconds / 6) / 10 }));

    const totalSeconds = documents.reduce((sum, d) => sum + d.seconds, 0);
    const payload = {
      date: day,
      source: 'AI Drafter (per-document active time)',
      generatedAt: new Date().toISOString(),
      idleCutoffSeconds: IDLE_CUTOFF_SECONDS,
      minSecondsIncluded: MIN_SECONDS_TO_RECORD,
      rootPath: activeRoot,
      totalActiveMinutes: Math.round(totalSeconds / 6) / 10,
      documents,
      intervals,
    };

    const file = outFile(day);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    dirty = false;
  } catch {
    /* never let a disk problem surface in the editor */
  }
}

function closeCurrentSession(): void {
  if (current) {
    sessions.push(current);
    current = null;
  }
}

function tick(): void {
  try {
    if (!outDir()) { closeCurrentSession(); return; }
    if (!activePath) { closeCurrentSession(); return; }
    if (!win || win.isDestroyed() || !win.isFocused()) { closeCurrentSession(); return; }
    if (powerMonitor.getSystemIdleTime() > IDLE_CUTOFF_SECONDS) { closeCurrentSession(); return; }

    const nowDay = localDate();
    if (nowDay !== day) {
      closeCurrentSession();
      flush();                 // close out the previous day before rolling over
      records = new Map();
      sessions = [];
      day = nowDay;
      loadToday();
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const existing = records.get(activePath);
    if (existing) {
      existing.seconds += TICK_MS / 1000;
      existing.lastAt = nowIso;
      existing.matterId = activeMatterId;
      existing.matterLabel = activeMatterLabel;
    } else {
      records.set(activePath, {
        path: activePath,
        name: path.basename(activePath),
        folder: path.basename(path.dirname(activePath)),
        matterId: activeMatterId,
        matterLabel: activeMatterLabel,
        seconds: TICK_MS / 1000,
        firstAt: nowIso,
        lastAt: nowIso,
      });
    }

    const contiguous = current !== null && current.path === activePath && nowMs - lastTickMs <= TICK_MS * 2.5;
    if (contiguous && current) {
      current.end = nowIso;
      current.seconds += TICK_MS / 1000;
      current.matterId = activeMatterId;
      current.matterLabel = activeMatterLabel;
    } else {
      closeCurrentSession();
      current = {
        path: activePath,
        name: path.basename(activePath),
        folder: path.basename(path.dirname(activePath)),
        matterId: activeMatterId,
        matterLabel: activeMatterLabel,
        start: new Date(nowMs - TICK_MS).toISOString(),
        end: nowIso,
        seconds: TICK_MS / 1000,
      };
    }

    lastTickMs = nowMs;
    dirty = true;
  } catch {
    /* sampling must never throw into the main process */
  }
}

function updateTitle(): void {
  if (!win || win.isDestroyed()) return;
  if (!activePath) {
    win.setTitle('Drafting App');
    return;
  }
  const name = path.basename(activePath);
  const folder = path.basename(path.dirname(activePath));
  const matter = activeMatterLabel ? ` [${activeMatterLabel}]` : '';
  win.setTitle(folder ? `${name} — ${folder}${matter} — Drafting App` : `${name}${matter} — Drafting App`);
}

function refreshActiveMatter(): void {
  activeMatterId = resolveMatterId(activePath);
  activeMatterLabel = labelFor(activeMatterId);
}

/** Re-read the mapping after the user picks a matter in the UI. */
export function matterAssignmentChanged(): void {
  refreshActiveMatter();
  if (activePath) {
    const rec = records.get(activePath);
    if (rec) { rec.matterId = activeMatterId; rec.matterLabel = activeMatterLabel; dirty = true; }
    if (current && current.path === activePath) {
      current.matterId = activeMatterId;
      current.matterLabel = activeMatterLabel;
    }
    for (const s of sessions) {
      if (s.path === activePath) { s.matterId = activeMatterId; s.matterLabel = activeMatterLabel; }
    }
  }
  updateTitle();
  flush();
}

export function setActiveDocument(filePath: string | null, rootPath: string | null): void {
  if (filePath !== activePath) closeCurrentSession();
  activePath = filePath;
  activeRoot = rootPath;
  refreshActiveMatter();
  updateTitle();
}

/** Seconds recorded today, for the status bar. */
export function todayFor(filePath: string | null): TrackerToday {
  let total = 0;
  for (const r of records.values()) total += r.seconds;
  const doc = filePath ? records.get(filePath)?.seconds ?? 0 : 0;
  return { documentSeconds: doc, totalSeconds: total };
}

export function initTimeTracker(window: BrowserWindow): void {
  win = window;
  day = localDate();
  records = new Map();
  sessions = [];
  current = null;
  lastTickMs = 0;
  loadToday();
  updateTitle();
  prune();
  tickTimer = setInterval(tick, TICK_MS);
  flushTimer = setInterval(flush, FLUSH_MS);
  offSettings = onSettingsChanged(() => {
    // Folder or enabled flag changed: close out what we have and re-read.
    closeCurrentSession();
    flush();
    records = new Map();
    sessions = [];
    loadToday();
    refreshActiveMatter();
    updateTitle();
  });
}

export function disposeTimeTracker(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (offSettings) { offSettings(); offSettings = null; }
  closeCurrentSession();
  flush();
  win = null;
}
