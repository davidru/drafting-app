import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, IconName } from './Icons';

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export type MenuItem =
  | { kind?: 'item'; label: string; icon?: IconName; shortcut?: string; danger?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: 'sep' }
  | { kind: 'label'; label: string };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export const ContextMenu: React.FC<{ menu: MenuState; onClose: () => void }> = ({ menu, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  const [focus, setFocus] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 8);
    const y = Math.min(menu.y, window.innerHeight - r.height - 8);
    setPos({ x: Math.max(4, x), y: Math.max(4, y) });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      const selectable = menu.items.map((it, i) => ({ it, i })).filter(({ it }) => (it.kind ?? 'item') === 'item' && !(it as { disabled?: boolean }).disabled);
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = selectable.findIndex(({ i }) => i === focus);
        const next = e.key === 'ArrowDown' ? selectable[(idx + 1) % selectable.length] : selectable[(idx - 1 + selectable.length) % selectable.length];
        if (next) setFocus(next.i);
      } else if (e.key === 'Enter' && focus >= 0) {
        e.preventDefault();
        const it = menu.items[focus];
        if (it && (it.kind ?? 'item') === 'item') { (it as { onSelect: () => void }).onSelect(); onClose(); }
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
    };
  }, [menu.items, focus, onClose]);

  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {menu.items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="menu-sep" />;
        if (it.kind === 'label') return <div key={i} className="menu-label">{it.label}</div>;
        return (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? ' danger' : ''}${focus === i ? ' is-focused' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => { it.onSelect(); onClose(); }}
          >
            <span className="ico">{it.icon && <Icon name={it.icon} size={14} />}</span>
            <span className="grow">{it.label}</span>
            {it.shortcut && <span className="kbd">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Popover anchored to an element
// ---------------------------------------------------------------------------

export const Popover: React.FC<{ anchor: HTMLElement; onClose: () => void; children: React.ReactNode; align?: 'left' | 'right'; above?: boolean }> = ({ anchor, onClose, children, align = 'left', above = false }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = align === 'left' ? a.left : a.right - r.width;
    left = Math.max(6, Math.min(left, window.innerWidth - r.width - 6));
    const top = above ? a.top - r.height - 6 : a.bottom + 6;
    setStyle({ left, top: Math.max(6, top) });
  }, [anchor, align, above]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose]);

  return <div ref={ref} className="popover" style={style}>{children}</div>;
};

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export type ToastKind = 'ok' | 'warn' | 'danger' | 'info';
export interface Toast { id: number; kind: ToastKind; text: string }

const TOAST_ICON: Record<ToastKind, IconName> = { ok: 'check-circle', warn: 'alert', danger: 'alert', info: 'info' };

export const Toasts: React.FC<{ toasts: Toast[] }> = ({ toasts }) => (
  <div className="toasts" aria-live="polite">
    {toasts.map((t) => (
      <div key={t.id} className={`toast ${t.kind}`}>
        <span className="ico"><Icon name={TOAST_ICON[t.kind]} size={15} /></span>
        <span>{t.text}</span>
      </div>
    ))}
  </div>
);

let toastSeq = 1;
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = React.useCallback((text: string, kind: ToastKind = 'info', ms = 2600) => {
    const id = toastSeq++;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ms);
  }, []);
  return { toasts, push };
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

export const IconButton: React.FC<{
  icon: IconName; title: string; onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void; on?: boolean; disabled?: boolean; size?: number; small?: boolean; className?: string; spin?: boolean;
}> = ({ icon, title, onClick, on, disabled, size = 15, small, className, spin }) => (
  <button className={`btn-icon${on ? ' is-on' : ''}${small ? ' sm' : ''}${className ? ' ' + className : ''}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
    <span className={spin ? 'spin' : undefined} style={{ display: 'grid', placeItems: 'center' }}><Icon name={icon} size={size} /></span>
  </button>
);

export const Switch: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string }> = ({ on, onChange, label }) => (
  <button role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' is-on' : ''}`} onClick={() => onChange(!on)} />
);

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 1) return '0m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
