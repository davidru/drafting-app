import React, { useEffect, useState } from 'react';
import { Icon, IconName } from './Icons';
import { formatDuration, timeAgo } from './ui';
import { SaveState } from '../hooks/useFileSystem';
import { TrackerToday } from '../../shared/types';

interface DocumentPanelProps {
  activeFile: string | null;
  saveState: SaveState;
  lastSavedAt: number | null;
  deleted: boolean;
  pendingKind: 'applied' | 'conflict' | null;
  words: number;
  snapshotCount: number | null;
  matterLabel: string | null;
  trackingEnabled: boolean;
  onReview: () => void;
  onSnapshots: () => void;
  onMatter: (anchor: HTMLElement) => void;
  onSend: () => void;
  onProofread: () => void;
}

/**
 * The "Publish" card from the reference, translated: what state the document
 * is in, where its time bills, and the two actions that hand it to Claude.
 */
const DocumentPanel: React.FC<DocumentPanelProps> = ({
  activeFile, saveState, lastSavedAt, deleted, pendingKind, words, snapshotCount, matterLabel, trackingEnabled, onReview, onSnapshots, onMatter, onSend, onProofread,
}) => {
  const [today, setToday] = useState<TrackerToday | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!trackingEnabled) { setToday(null); return; }
    let cancelled = false;
    const load = () => window.drafting.trackerToday(activeFile).then((t) => { if (!cancelled) setToday(t); }).catch(() => undefined);
    void load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeFile, trackingEnabled]);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);

  let status: { cls: string; icon: IconName; text: string };
  if (!activeFile) status = { cls: 'muted', icon: 'file', text: 'No document open' };
  else if (deleted) status = { cls: 'danger', icon: 'trash', text: 'Deleted on disk' };
  else if (saveState === 'error') status = { cls: 'danger', icon: 'alert', text: 'Save failed' };
  else if (saveState === 'saving') status = { cls: '', icon: 'save', text: 'Saving…' };
  else if (saveState === 'dirty') status = { cls: 'warn', icon: 'circle-dot', text: 'Unsaved changes' };
  else status = { cls: 'ok', icon: 'check-circle', text: lastSavedAt ? `Saved ${timeAgo(lastSavedAt)}` : 'Saved' };

  return (
    <div className="card doc-card">
      <div className="head">
        <h3>Document</h3>
      </div>
      <div className="doc-row">
        <span className="ico"><Icon name={status.icon} size={14} /></span>
        <span className="k">Status:</span>
        <span className={`v ${status.cls}`}>{status.text}</span>
        {pendingKind && (
          <button className="edit" onClick={onReview} style={{ color: pendingKind === 'conflict' ? 'var(--warn)' : 'var(--info)' }}>
            {pendingKind === 'conflict' ? 'Conflict · Review' : 'Changed · Review'}
          </button>
        )}
      </div>
      {trackingEnabled && (
        <>
          <div className="doc-row">
            <span className="ico"><Icon name="briefcase" size={14} /></span>
            <span className="k">Matter:</span>
            <span className={`v${matterLabel ? '' : ' muted'}`}>{matterLabel ?? 'Not set'}</span>
            <button className="edit" data-action="matter" onClick={(e) => onMatter(e.currentTarget)} disabled={!activeFile}>Edit</button>
          </div>
          <div className="doc-row">
            <span className="ico"><Icon name="clock" size={14} /></span>
            <span className="k">Time today:</span>
            <span className="v">{today ? `${formatDuration(today.documentSeconds)} here · ${formatDuration(today.totalSeconds)} total` : '—'}</span>
          </div>
        </>
      )}
      <div className="doc-row">
        <span className="ico"><Icon name="text" size={14} /></span>
        <span className="k">Length:</span>
        <span className="v">{activeFile ? `${words.toLocaleString()} words` : '—'}</span>
      </div>
      <div className="doc-row">
        <span className="ico"><Icon name="camera" size={14} /></span>
        <span className="k">Snapshots:</span>
        <span className="v">{snapshotCount === null ? '—' : snapshotCount}</span>
        <button className="edit" onClick={onSnapshots} disabled={!activeFile}>View</button>
      </div>
      <div className="doc-actions">
        <button className="btn" onClick={onProofread} disabled={!activeFile} title="Ask Claude to proofread this document">
          <Icon name="sparkles" size={14} />Proofread
        </button>
        <button className="btn primary" onClick={onSend} disabled={!activeFile} title="Type an edit instruction for this document into Claude  (Ctrl+Enter)">
          <Icon name="send" size={14} />Send to Claude
        </button>
      </div>
    </div>
  );
};

export default DocumentPanel;
