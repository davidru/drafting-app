import React, { useEffect, useState } from 'react';
import { AppSettings, DEFAULT_SETTINGS } from '../../shared/types';
import { Icon, IconName } from './Icons';
import { IconButton, Switch } from './ui';

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (patch: unknown) => void;
  onClose: () => void;
}

type Section = 'appearance' | 'editor' | 'changes' | 'claude' | 'time';

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'monitor' },
  { id: 'editor', label: 'Editor', icon: 'text' },
  { id: 'changes', label: 'Changes from disk', icon: 'diff' },
  { id: 'claude', label: 'Claude & terminal', icon: 'terminal' },
  { id: 'time', label: 'Time tracking', icon: 'clock' },
];

const FONT_CHOICES = [
  'Cascadia Code, Consolas, "Courier New", monospace',
  'Consolas, "Courier New", monospace',
  '"JetBrains Mono", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  '"Source Code Pro", Consolas, monospace',
  '"Courier New", monospace',
];

const Field: React.FC<{ label: string; help?: string; wide?: boolean; children: React.ReactNode }> = ({ label, help, wide, children }) => (
  <div className={`field${wide ? ' wide' : ''}`}>
    <div className="label">{label}</div>
    {help && <div className="help">{help}</div>}
    <div className="control">{children}</div>
  </div>
);

/** Number input that commits on blur or Enter, so typing does not fight the settings round-trip. */
const NumberField: React.FC<{ value: number; min: number; max: number; step?: number; onCommit: (v: number) => void }> = ({ value, min, max, step = 1, onCommit }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n)) onCommit(Math.max(min, Math.min(max, n)));
    else setText(String(value));
  };
  return <input className="input num" value={text} step={step} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} />;
};

const TextField: React.FC<{ value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; grow?: boolean }> = ({ value, onCommit, placeholder, mono, grow }) => {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return (
    <input
      className={`input${grow ? ' grow' : ''}`}
      style={mono ? { fontFamily: 'var(--font-mono)' } : undefined}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== value) onCommit(text); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
    />
  );
};

const TextArea: React.FC<{ value: string; onCommit: (v: string) => void }> = ({ value, onCommit }) => {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  return <textarea className="textarea" value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} onBlur={() => { if (text !== value) onCommit(text); }} />;
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onChange, onClose }) => {
  const [section, setSection] = useState<Section>('appearance');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const s = settings;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings" role="dialog" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <span style={{ fontSize: 12, color: 'var(--fg-3)' }}>Changes apply immediately</span>
          <IconButton icon="x" title="Close  Esc" onClick={onClose} />
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            {SECTIONS.map((sec) => (
              <button key={sec.id} className={section === sec.id ? 'is-on' : ''} onClick={() => setSection(sec.id)}>
                <span className="ico"><Icon name={sec.icon} size={14} /></span>{sec.label}
              </button>
            ))}
          </nav>
          <div className="settings-page">
            {section === 'appearance' && (
              <>
                <h3>Appearance</h3>
                <p className="lead">The theme applies to the editor, the terminal and every panel.</p>
                <Field label="Theme">
                  <select className="select grow" value={s.theme} onChange={(e) => onChange({ theme: e.target.value })}>
                    <option value="system">Follow Windows</option>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </Field>
                <Field label="Sidebar width" help="Drag the sidebar's edge to change this too.">
                  <NumberField value={s.sidebar.width} min={180} max={480} onCommit={(v) => onChange({ sidebar: { width: v } })} />
                </Field>
              </>
            )}

            {section === 'editor' && (
              <>
                <h3>Editor</h3>
                <p className="lead">How documents look and how often they save.</p>
                <Field label="Font" help="A monospaced font keeps the cursor and selection exact. Pick any installed font by typing its name.">
                  <select className="select grow" value={FONT_CHOICES.includes(s.editor.fontFamily) ? s.editor.fontFamily : '__custom'} onChange={(e) => { if (e.target.value !== '__custom') onChange({ editor: { fontFamily: e.target.value } }); }}>
                    {FONT_CHOICES.map((f) => <option key={f} value={f}>{f.split(',')[0].replace(/"/g, '')}</option>)}
                    <option value="__custom">Custom…</option>
                  </select>
                </Field>
                <Field label="Custom font stack" wide>
                  <TextField value={s.editor.fontFamily} mono grow onCommit={(v) => onChange({ editor: { fontFamily: v || DEFAULT_SETTINGS.editor.fontFamily } })} />
                </Field>
                <Field label="Font size">
                  <NumberField value={s.editor.fontSize} min={10} max={28} onCommit={(v) => onChange({ editor: { fontSize: v } })} />
                </Field>
                <Field label="Wrap at column" help="0 wraps at the window edge. Around 80 to 100 gives a comfortable reading measure.">
                  <NumberField value={s.editor.wrapColumn} min={0} max={200} onCommit={(v) => onChange({ editor: { wrapColumn: v } })} />
                </Field>
                <Field label="Line numbers">
                  <Switch on={s.editor.showLineNumbers} label="Show line numbers" onChange={(v) => onChange({ editor: { showLineNumbers: v } })} />
                </Field>
                <Field label="Autosave delay" help="Milliseconds after your last keystroke before the file is written. Claude only sees saved text.">
                  <NumberField value={s.editor.autosaveDelayMs} min={100} max={5000} step={100} onCommit={(v) => onChange({ editor: { autosaveDelayMs: v } })} />
                </Field>
                <Field label="Open markdown as" help="Raw shows the markdown source. Formatted is an editable rendered view; it may normalise formatting elsewhere in the file when you edit.">
                  <select className="select grow" value={s.editor.defaultView} onChange={(e) => onChange({ editor: { defaultView: e.target.value } })}>
                    <option value="raw">Raw markdown</option>
                    <option value="preview">Formatted</option>
                  </select>
                </Field>
              </>
            )}

            {section === 'changes' && (
              <>
                <h3>Changes from disk</h3>
                <p className="lead">What happens when Claude, or anything else, rewrites a document you have open.</p>
                <Field label="After a reload, put the cursor" wide>
                  <div className="radio-row">
                    <label><input type="radio" name="cursor" checked={s.externalChange.cursor === 'keep'} onChange={() => onChange({ externalChange: { cursor: 'keep' } })} /> Where it was. Only the changed lines move.</label>
                    <label><input type="radio" name="cursor" checked={s.externalChange.cursor === 'first-change'} onChange={() => onChange({ externalChange: { cursor: 'first-change' } })} /> At the first change, so you see what Claude did.</label>
                    <label><input type="radio" name="cursor" checked={s.externalChange.cursor === 'end'} onChange={() => onChange({ externalChange: { cursor: 'end' } })} /> At the end of the document.</label>
                  </div>
                </Field>
                <Field label="Offer a review" help="Keep the previous text so the change can be reviewed as a diff and reverted. Turning this off still reloads the file; it just skips the Review prompt.">
                  <Switch on={s.externalChange.offerReview} label="Offer review of external changes" onChange={(v) => onChange({ externalChange: { offerReview: v } })} />
                </Field>
              </>
            )}

            {section === 'claude' && (
              <>
                <h3>Claude &amp; terminal</h3>
                <p className="lead">The command that starts Claude, and the prompts the buttons type for you.</p>
                <Field label="Launch command" help="Typed into the shell when the terminal starts. Leave empty to start a plain shell." wide>
                  <TextField value={s.terminal.launchCommand} mono grow placeholder="claude" onCommit={(v) => onChange({ terminal: { launchCommand: v } })} />
                </Field>
                <Field label="Shell" help="Leave empty for PowerShell on Windows." wide>
                  <TextField value={s.terminal.shell} mono grow placeholder="powershell.exe" onCommit={(v) => onChange({ terminal: { shell: v } })} />
                </Field>
                <Field label="Terminal font size">
                  <NumberField value={s.terminal.fontSize} min={10} max={24} onCommit={(v) => onChange({ terminal: { fontSize: v } })} />
                </Field>
                <Field label="Send to Claude prompt" help="Tokens: {relpath} {path} {name} {selection} {lines}. A trailing space lets you keep typing." wide>
                  <TextArea value={s.prompts.sendToClaude} onCommit={(v) => onChange({ prompts: { sendToClaude: v } })} />
                </Field>
                <Field label="Proofread prompt" wide>
                  <TextArea value={s.prompts.proofread} onCommit={(v) => onChange({ prompts: { proofread: v } })} />
                </Field>
              </>
            )}

            {section === 'time' && (
              <>
                <h3>Time tracking</h3>
                <p className="lead">Records active time per document for an external time tracker. Nothing is recorded while the window is unfocused or idle.</p>
                <Field label="Record time">
                  <Switch on={s.timeTracking.enabled} label="Record time" onChange={(v) => onChange({ timeTracking: { enabled: v } })} />
                </Field>
                <Field label="Tracker folder" help="The folder holding the tracker's app-state.json. Daily drafter-*.json files are written here." wide>
                  <div style={{ display: 'flex', gap: 6, width: '100%' }}>
                    <TextField value={s.timeTracking.dir} grow onCommit={(v) => onChange({ timeTracking: { dir: v } })} placeholder="Not set" />
                    <button className="btn" onClick={async () => { const d = await window.drafting.pickDirectory(s.timeTracking.dir || undefined); if (d) onChange({ timeTracking: { dir: d } }); }}>Browse…</button>
                  </div>
                </Field>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
