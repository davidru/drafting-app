import React, { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { Icon } from './Icons';
import { IconButton } from './ui';
import { AppSettings } from '../../shared/types';
import { baseName } from '../lib/paths';

export interface TerminalHandle {
  focus: () => void;
  hasFocus: () => boolean;
  /** Type text at the prompt (no Enter). */
  type: (text: string) => void;
  /** Type text and press Enter. */
  run: (text: string) => void;
  restart: (cwd: string | null) => void;
  clear: () => void;
  getCwd: () => string | null;
}

interface TerminalPaneProps {
  ref?: React.Ref<TerminalHandle>;
  initialCwd: string | null;
  rootPath: string | null;
  activeFilePath: string | null;
  theme: 'dark' | 'light';
  settings: AppSettings['terminal'];
  onFocus: () => void;
}

// The terminal card is dark in both themes; the palette only shifts slightly.
const THEMES = {
  dark: {
    background: '#0f1116', foreground: '#dfe2ea', cursor: '#8399ff', cursorAccent: '#0f1116',
    selectionBackground: 'rgba(131, 153, 255, 0.30)', selectionInactiveBackground: 'rgba(131, 153, 255, 0.18)',
    black: '#1e2028', red: '#ff6b7a', green: '#4fcf8a', yellow: '#f0b64a', blue: '#8399ff', magenta: '#c084fc', cyan: '#3fd0e0', white: '#dfe2ea',
    brightBlack: '#5f6575', brightRed: '#ff8a96', brightGreen: '#6ee7a0', brightYellow: '#fcd34d', brightBlue: '#9aacff', brightMagenta: '#d4a5ff', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
  light: {
    background: '#15171c', foreground: '#dfe2ea', cursor: '#8399ff', cursorAccent: '#15171c',
    selectionBackground: 'rgba(131, 153, 255, 0.30)', selectionInactiveBackground: 'rgba(131, 153, 255, 0.18)',
    black: '#1e2028', red: '#ff6b7a', green: '#4fcf8a', yellow: '#f0b64a', blue: '#8399ff', magenta: '#c084fc', cyan: '#3fd0e0', white: '#dfe2ea',
    brightBlack: '#5f6575', brightRed: '#ff8a96', brightGreen: '#6ee7a0', brightYellow: '#fcd34d', brightBlue: '#9aacff', brightMagenta: '#d4a5ff', brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
};

const TerminalPane: React.FC<TerminalPaneProps> = ({ ref, initialCwd, rootPath, activeFilePath, theme, settings, onFocus }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [stopped, setStopped] = useState(false);
  const [cwd, setCwd] = useState<string | null>(initialCwd);
  const onFocusRef = useRef(onFocus);
  useEffect(() => { onFocusRef.current = onFocus; }, [onFocus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      theme: THEMES[theme],
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      windowsPty: navigator.platform.startsWith('Win') ? { backend: 'conpty' } : undefined,
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.loadAddon(new SearchAddon());
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(new WebLinksAddon((_e, uri) => { window.open(uri); }));
    terminal.unicode.activeVersion = '11';
    terminal.open(host);

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch (err) {
      console.warn('WebGL renderer unavailable, using DOM renderer:', err);
    }

    terminal.onData((data) => window.drafting.sendTerminalInput(data));
    const offData = window.drafting.onTerminalData((data) => terminal.write(data));
    const offStopped = window.drafting.onTerminalStopped(() => setStopped(true));

    const textarea = terminal.textarea;
    const onFocusIn = () => onFocusRef.current();
    textarea?.addEventListener('focus', onFocusIn);

    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = terminal.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        void navigator.clipboard.readText().then((t) => { if (t) terminal.paste(t); });
        return false;
      }
      return true;
    });

    requestAnimationFrame(() => { try { fit.fit(); } catch { /* not laid out yet */ } });
    window.drafting.createTerminal(initialCwd ?? undefined);

    let rafId: number | null = null;
    let debounceId: ReturnType<typeof setTimeout> | null = null;
    const doFit = () => {
      rafId = null;
      try {
        fit.fit();
        const dims = fit.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) window.drafting.resizeTerminal(dims.cols, dims.rows);
      } catch { /* teardown */ }
    };
    const scheduleFit = () => {
      if (rafId === null) rafId = requestAnimationFrame(doFit);
      if (debounceId !== null) clearTimeout(debounceId);
      debounceId = setTimeout(doFit, 120);
    };
    const ro = new ResizeObserver(scheduleFit);
    ro.observe(host);

    termRef.current = terminal;
    fitRef.current = fit;

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (debounceId !== null) clearTimeout(debounceId);
      ro.disconnect();
      textarea?.removeEventListener('focus', onFocusIn);
      offData();
      offStopped();
      terminal.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The PTY outlives this component (HMR); the shell is only created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.theme = THEMES[theme];
  }, [theme]);

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.fontFamily = settings.fontFamily;
    t.options.fontSize = settings.fontSize;
    try { fitRef.current?.fit(); } catch { /* noop */ }
  }, [settings.fontFamily, settings.fontSize]);

  const restart = (dir: string | null) => {
    setStopped(false);
    setCwd(dir);
    termRef.current?.clear();
    window.drafting.restartTerminal(dir ?? undefined);
    termRef.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    hasFocus: () => document.activeElement === termRef.current?.textarea,
    type: (text) => { termRef.current?.focus(); window.drafting.sendTerminalInput(text); },
    run: (text) => { termRef.current?.focus(); window.drafting.sendTerminalInput(text + '\r'); },
    restart,
    clear: () => termRef.current?.clear(),
    getCwd: () => cwd,
  }), [cwd]);

  const cwdMismatch = !!rootPath && (cwd ?? '').toLowerCase() !== rootPath.toLowerCase();
  const cwdLabel = cwd ? baseName(cwd) : 'home';

  return (
    <>
      <div className="term-head">
        <span className="label"><span className="live" />Claude</span>
        <span className="cwd" title={cwd ?? 'home folder'}>
          {activeFilePath ? `${baseName(activeFilePath)} · ` : ''}{cwdMismatch ? `running in ${cwdLabel}, folder is ${baseName(rootPath!)}` : `in ${cwdLabel}`}
        </span>
        <IconButton
          icon="refresh"
          small
          title={cwdMismatch ? `Restart Claude in ${baseName(rootPath!)}` : 'Restart terminal and Claude'}
          className={cwdMismatch ? 'is-on' : undefined}
          onClick={() => restart(rootPath)}
        />
      </div>
      <div ref={hostRef} className="term-host" onMouseDown={() => termRef.current?.focus()} />
      {stopped && (
        <div className="term-stopped">
          <span className="ico"><Icon name="alert" size={26} /></span>
          <div>The terminal stopped after several crashes in a row.</div>
          <button className="btn primary" onClick={() => restart(rootPath)}>Restart terminal</button>
        </div>
      )}
    </>
  );
};

export default TerminalPane;
