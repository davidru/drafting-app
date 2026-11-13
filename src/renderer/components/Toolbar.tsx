import React, { useRef, useState } from 'react';
import { IconButton, ContextMenu, MenuState } from './ui';
import { Icon } from './Icons';
import { EditorHandle } from './Editor';
import { VisualHandle, VisualFormat } from './MilkdownPreview';
import { ViewMode } from '../../shared/types';

interface ToolbarProps {
  editor: React.RefObject<EditorHandle | null>;
  visual: React.RefObject<VisualHandle | null>;
  isProse: boolean;
  readOnly: boolean;
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  onSnapshot: () => void;
  onToggleSnapshots: () => void;
  snapshotsOpen: boolean;
  snapshotMessage: string | null;
}

const BLOCKS: { id: VisualFormat; label: string; prefix: string }[] = [
  { id: 'paragraph', label: 'Paragraph', prefix: '' },
  { id: 'h1', label: 'Heading 1', prefix: '# ' },
  { id: 'h2', label: 'Heading 2', prefix: '## ' },
  { id: 'h3', label: 'Heading 3', prefix: '### ' },
  { id: 'h4', label: 'Heading 4', prefix: '#### ' },
];

/**
 * One toolbar for both views. In Text mode it edits markdown through the Monaco
 * handle; in Visual mode it calls Milkdown commands.
 */
const Toolbar: React.FC<ToolbarProps> = ({ editor, visual, isProse, readOnly, viewMode, onViewMode, onSnapshot, onToggleSnapshots, snapshotsOpen, snapshotMessage }) => {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const blockRef = useRef<HTMLButtonElement>(null);
  const raw = viewMode === 'raw';
  const canFormat = !readOnly && isProse;

  const run = (what: VisualFormat, rawAction: () => void) => {
    if (raw) rawAction(); else visual.current?.format(what);
  };
  const e = () => editor.current;

  const block = (b: typeof BLOCKS[number]) => run(b.id, () => {
    if (b.prefix) e()?.toggleLinePrefix(b.prefix);
    else e()?.toggleLinePrefix('# '); // toggling off the heading it has; a plain paragraph needs no prefix
  });

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <button className="btn sm soft" onClick={onSnapshot} disabled={readOnly} title="Save a snapshot of this document">
        <Icon name="camera" size={14} /><span className="pill-label">Snapshot</span>
      </button>
      <IconButton icon="history" title="Snapshots" on={snapshotsOpen} onClick={onToggleSnapshots} />
      {snapshotMessage && <span style={{ fontSize: 12, color: 'var(--ok)', marginLeft: 6 }}>{snapshotMessage}</span>}
      {canFormat && (
        <>
          <span className="sep" />
          <button
            ref={blockRef}
            className="block-pick"
            title="Paragraph style"
            onClick={() => {
              const r = blockRef.current!.getBoundingClientRect();
              setMenu({ x: r.left, y: r.bottom + 4, items: BLOCKS.map((b) => ({ label: b.label, onSelect: () => block(b) })) });
            }}
          >
            <Icon name="heading" size={14} /><span className="grow">Paragraph</span><Icon name="chevron-down" size={12} />
          </button>
          <span className="sep" />
          <IconButton icon="bold" title="Bold  Ctrl+B" onClick={() => run('bold', () => e()?.wrapSelection('**', '**', 'bold text'))} />
          <IconButton icon="italic" title="Italic  Ctrl+I" onClick={() => run('italic', () => e()?.wrapSelection('*', '*', 'italic text'))} />
          <IconButton icon="strikethrough" title="Strikethrough" onClick={() => run('strike', () => e()?.wrapSelection('~~', '~~', 'text'))} />
          <IconButton icon="code" title="Inline code" onClick={() => run('code', () => e()?.wrapSelection('`', '`', 'code'))} />
          <span className="sep" />
          <IconButton icon="list" title="Bullet list" onClick={() => run('bullet', () => e()?.toggleLinePrefix('- '))} />
          <IconButton icon="list-ordered" title="Numbered list" onClick={() => run('ordered', () => e()?.toggleLinePrefix('1. '))} />
          <IconButton icon="check-square" title="Task list" onClick={() => run('task', () => e()?.toggleLinePrefix('- [ ] '))} />
          <IconButton icon="quote" title="Quote" onClick={() => run('quote', () => e()?.toggleLinePrefix('> '))} />
          <span className="sep" />
          <IconButton icon="link" title="Link  Ctrl+K" onClick={() => run('link', () => e()?.wrapSelection('[', '](url)', 'link text'))} />
          <IconButton icon="image" title="Image" onClick={() => run('image', () => e()?.wrapSelection('![', '](url)', 'description'))} />
          <IconButton icon="minus" title="Horizontal rule" onClick={() => run('hr', () => e()?.insertText('\n---\n\n'))} />
        </>
      )}
      {raw && (
        <>
          <span className="sep" />
          <IconButton icon="search" title="Find  Ctrl+F" onClick={() => e()?.find()} />
          <IconButton icon="replace" title="Find and replace  Ctrl+H" onClick={() => e()?.replace()} />
        </>
      )}
      <span className="spacer" />
      {isProse && !readOnly && (
        <div className="seg" role="group" aria-label="View">
          <button className={!raw ? 'is-on' : ''} onClick={() => onViewMode('preview')} title="Visual editor  Ctrl+E"><Icon name="eye" size={13} /><span className="txt">Visual</span></button>
          <button className={raw ? 'is-on' : ''} onClick={() => onViewMode('raw')} title="Markdown text  Ctrl+E"><Icon name="code" size={13} /><span className="txt">Text</span></button>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
};

export default Toolbar;
