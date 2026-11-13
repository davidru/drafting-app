import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Popover } from './ui';
import { MatterContext } from '../../shared/types';
import { baseName } from '../lib/paths';

export interface MatterCardHandle {
  /** Open the picker, anchored to `anchor` (defaults to the card's own Change button). */
  open: (anchor?: HTMLElement | null) => void;
  label: () => string | null;
}

interface MatterCardProps {
  ref?: React.Ref<MatterCardHandle>;
  activeFile: string | null;
  enabled: boolean;
  onLabel?: (label: string | null) => void;
}

/**
 * The matter picker for the open document. Choosing a matter writes the shared
 * matter map, so the time tracker receives the time already attributed. It has
 * no chrome of its own: the Document card's Edit button opens it.
 */
const MatterCard: React.FC<MatterCardProps> = ({ ref, activeFile, enabled, onLabel }) => {
  const [matter, setMatter] = useState<MatterContext | null>(null);
  const [open, setOpen] = useState(false);
  const [externalAnchor, setExternalAnchor] = useState<HTMLElement | null>(null);
  const [scope, setScope] = useState<'folder' | 'file'>('folder');
  const onLabelRef = useRef(onLabel);
  useEffect(() => { onLabelRef.current = onLabel; }, [onLabel]);

  const load = useCallback(async () => {
    if (!enabled) { setMatter(null); return; }
    try {
      const ctx = await window.drafting.getMatterContext(activeFile);
      setMatter(ctx);
    } catch { /* optional feature */ }
  }, [activeFile, enabled]);

  useEffect(() => { void load(); }, [load]);

  const current = matter?.matters.find((m) => m.id === matter.matterId) ?? null;
  useEffect(() => { onLabelRef.current?.(current?.label ?? null); }, [current]);

  useImperativeHandle(ref, () => ({
    open: (anchor) => { setExternalAnchor(anchor ?? null); setOpen(true); },
    label: () => current?.label ?? null,
  }), [current]);

  const close = () => { setOpen(false); setExternalAnchor(null); };
  const anchorEl = externalAnchor;

  const pick = async (id: string | null) => {
    if (!activeFile) return;
    await window.drafting.setMatter(activeFile, id, scope);
    await load();
    close();
  };

  if (!enabled) return null;

  // Headless: nothing is drawn until the picker is opened from the Document card.
  return (
    <>
      {open && anchorEl && matter && (
        <Popover anchor={anchorEl} onClose={close} align={externalAnchor ? 'right' : 'left'}>
          <h4>Matter for {activeFile ? baseName(activeFile) : ''}</h4>
          {matter.matters.length === 0 ? (
            <div className="hint">No matters have been published yet. Open an external time tracker and connect folder sync, then come back here.</div>
          ) : (
            <>
              <select className="select grow" style={{ width: '100%' }} value={matter.matterId ?? ''} onChange={(e) => { void pick(e.target.value || null); }}>
                <option value="">— No matter —</option>
                {matter.matters.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}{m.billable ? '' : ' (non-billable)'}</option>
                ))}
              </select>
              <div className="row radio-row" style={{ marginTop: 10 }}>
                <label><input type="radio" name="matter-scope" checked={scope === 'folder'} onChange={() => setScope('folder')} /> Everything in this folder</label>
                <label><input type="radio" name="matter-scope" checked={scope === 'file'} onChange={() => setScope('file')} /> This document only</label>
              </div>
              {matter.source && (
                <div className="hint">Currently set on {matter.source === 'file' ? 'this document' : `the folder ${baseName(matter.sourcePath ?? '')}`}.</div>
              )}
            </>
          )}
        </Popover>
      )}
    </>
  );
};

export default MatterCard;
