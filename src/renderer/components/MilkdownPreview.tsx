import React, { useEffect, useImperativeHandle, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx, parserCtx, serializerCtx, commandsCtx } from '@milkdown/core';
import { Slice } from '@milkdown/prose/model';
import {
  toggleStrongCommand, toggleEmphasisCommand, toggleInlineCodeCommand, wrapInHeadingCommand, turnIntoTextCommand,
  wrapInBulletListCommand, wrapInOrderedListCommand, wrapInBlockquoteCommand, toggleLinkCommand, insertImageCommand, insertHrCommand,
} from '@milkdown/preset-commonmark';
import { toggleStrikethroughCommand } from '@milkdown/preset-gfm';

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

/** Formatting the toolbar can drive in the visual editor. */
export type VisualFormat =
  | 'bold' | 'italic' | 'strike' | 'code' | 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4'
  | 'bullet' | 'ordered' | 'quote' | 'link' | 'image' | 'hr' | 'task';

export interface VisualHandle {
  focus: () => void;
  hasFocus: () => boolean;
  format: (what: VisualFormat) => void;
  getSelectionText: () => string;
}

interface MilkdownPreviewProps {
  ref?: React.Ref<VisualHandle>;
  content: string;
  onChange: (content: string) => void;
  fontSize: number;
  theme: 'dark' | 'light';
}

/**
 * The visual editor. Milkdown re-serialises the whole document on every
 * change, so formatting elsewhere in the file can be normalised; the raw
 * markdown view stays authoritative and reconciles on switch.
 */
const MilkdownPreview: React.FC<MilkdownPreviewProps> = ({ ref, content, onChange, fontSize, theme }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<Crepe | null>(null);
  const onChangeRef = useRef(onChange);
  const lastEmittedRef = useRef<string>(content);
  const applyingRef = useRef(false);
  /** Markdown as Milkdown serialises the text we last applied from outside. */
  const appliedMarkdownRef = useRef<string | null>(null);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!containerRef.current) return;
    const crepe = new Crepe({ root: containerRef.current, defaultValue: content });
    crepeRef.current = crepe;
    crepe.create().then(() => {
      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          if (applyingRef.current) return;
          // Milkdown reports document changes on a debounce, so the report for text we
          // applied ourselves arrives after `applyingRef` has cleared. It is our own
          // text re-serialised, not an edit: do not send it back as one.
          if (markdown === appliedMarkdownRef.current) return;
          appliedMarkdownRef.current = null;
          lastEmittedRef.current = markdown;
          onChangeRef.current(markdown);
        });
      });
    }).catch((err) => console.error('Milkdown failed to initialize:', err));
    return () => {
      crepe.destroy().catch(() => undefined);
      crepeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const crepe = crepeRef.current;
    if (!crepe || content === lastEmittedRef.current) return;
    try {
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const doc = parser(content);
        if (!doc) return;
        applyingRef.current = true;
        const state = view.state;
        view.dispatch(state.tr.replace(0, state.doc.content.size, new Slice(doc.content, 0, 0)));
        lastEmittedRef.current = content;
        appliedMarkdownRef.current = ctx.get(serializerCtx)(view.state.doc);
        setTimeout(() => { applyingRef.current = false; }, 0);
      });
    } catch (err) {
      console.error('Milkdown content sync failed:', err);
      applyingRef.current = false;
    }
  }, [content]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      crepeRef.current?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
    },
    hasFocus: () => !!containerRef.current?.contains(document.activeElement),
    getSelectionText: () => {
      let out = '';
      crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const { from, to } = view.state.selection;
        out = view.state.doc.textBetween(from, to, '\n');
      });
      return out;
    },
    format: (what) => {
      const crepe = crepeRef.current;
      if (!crepe) return;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const cmds = ctx.get(commandsCtx);
        view.focus();
        switch (what) {
          case 'bold': cmds.call(toggleStrongCommand.key); break;
          case 'italic': cmds.call(toggleEmphasisCommand.key); break;
          case 'strike': cmds.call(toggleStrikethroughCommand.key); break;
          case 'code': cmds.call(toggleInlineCodeCommand.key); break;
          case 'paragraph': cmds.call(turnIntoTextCommand.key); break;
          case 'h1': cmds.call(wrapInHeadingCommand.key, 1); break;
          case 'h2': cmds.call(wrapInHeadingCommand.key, 2); break;
          case 'h3': cmds.call(wrapInHeadingCommand.key, 3); break;
          case 'h4': cmds.call(wrapInHeadingCommand.key, 4); break;
          case 'bullet': cmds.call(wrapInBulletListCommand.key); break;
          case 'ordered': cmds.call(wrapInOrderedListCommand.key); break;
          case 'quote': cmds.call(wrapInBlockquoteCommand.key); break;
          case 'hr': cmds.call(insertHrCommand.key); break;
          case 'link': {
            const { from, to } = view.state.selection;
            if (from === to) break;
            cmds.call(toggleLinkCommand.key, { href: 'https://' });
            break;
          }
          case 'image': cmds.call(insertImageCommand.key, { src: '', alt: 'description' }); break;
          case 'task': {
            // The task-list command lives in the gfm preset under a different key
            // in each version; type the markdown shortcut instead.
            const { from } = view.state.selection;
            view.dispatch(view.state.tr.insertText('[ ] ', from));
            break;
          }
        }
      });
    },
  }), []);

  return (
    <div
      ref={containerRef}
      className={`preview-host${theme === 'dark' ? ' milkdown-theme-frame-dark' : ' milkdown-theme-frame'}`}
      style={{ fontSize: `${fontSize + 2}px` }}
      spellCheck
    />
  );
};

export default MilkdownPreview;
