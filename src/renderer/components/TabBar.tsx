import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './Icons';
import { ContextMenu, MenuState } from './ui';
import { baseName, isProse } from '../lib/paths';

export type TabStatus = 'clean' | 'dirty' | 'change' | 'conflict' | 'deleted';

export interface TabInfo {
  path: string;
  status: TabStatus;
}

interface TabBarProps {
  tabs: TabInfo[];
  activeTab: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onNew: () => void;
}

const STATUS_TITLE: Record<TabStatus, string> = {
  clean: '',
  dirty: 'Unsaved changes',
  change: 'Changed on disk. Review to see what changed.',
  conflict: 'Changed on disk while you had unsaved edits',
  deleted: 'Deleted on disk',
};

/** Open documents as pills, with a New pill at the end. */
const TabBar: React.FC<TabBarProps> = ({ tabs, activeTab, onSelect, onClose, onCloseOthers, onReveal, onCopyPath, onNew }) => {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeTab) return;
    const el = barRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activeTab)}"]`);
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeTab]);

  return (
    <div className="tabbar" ref={barRef} role="tablist" onWheel={(e) => { if (e.deltaY && barRef.current) barRef.current.scrollLeft += e.deltaY; }}>
      {tabs.map((tab) => {
        const isActive = tab.path === activeTab;
        const name = baseName(tab.path).replace(/\.(md|markdown|mdx|txt)$/i, '');
        const hasBadge = tab.status !== 'clean';
        const classes = ['tab', isActive ? 'is-active' : '', hasBadge ? 'has-badge' : '', tab.status === 'deleted' ? 'is-deleted' : ''].filter(Boolean).join(' ');
        return (
          <div
            key={tab.path}
            data-path={tab.path}
            className={classes}
            role="tab"
            aria-selected={isActive}
            title={`${tab.path}${STATUS_TITLE[tab.status] ? '\n' + STATUS_TITLE[tab.status] : ''}`}
            onClick={() => onSelect(tab.path)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(tab.path); } }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX, y: e.clientY, items: [
                  { label: 'Close', shortcut: 'Ctrl+W', onSelect: () => onClose(tab.path) },
                  { label: 'Close Others', onSelect: () => onCloseOthers(tab.path) },
                  { kind: 'sep' },
                  { label: 'Copy Path', icon: 'link', onSelect: () => onCopyPath(tab.path) },
                  { label: 'Reveal in Explorer', icon: 'external', onSelect: () => onReveal(tab.path) },
                ],
              });
            }}
          >
            <span className="ico"><Icon name={isProse(tab.path) ? 'file-text' : 'file'} size={14} /></span>
            <span className="name">{name}</span>
            {hasBadge && <span className={`badge ${tab.status}`} />}
            <span className="close" role="button" aria-label={`Close ${name}`} onClick={(e) => { e.stopPropagation(); onClose(tab.path); }}>
              <Icon name="x" size={12} />
            </span>
          </div>
        );
      })}
      <button className="tab-new" onClick={onNew} title="New document  Ctrl+N">
        <Icon name="plus" size={14} />New
      </button>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
};

export default TabBar;
