# Drafting App

A desktop drafting environment for working on documents alongside Claude Code. Your documents on the left, Claude on the right, one folder on disk that both of you edit.

- **You edit, Claude sees it.** Documents autosave; unsaved files are flushed the moment you turn to Claude, so it always reads your latest text.
- **Claude edits, you see it.** A file watcher reloads changed documents with a minimal edit, so your cursor and undo history survive. A "changed on disk" prompt lets you review the change as a side-by-side diff, revert individual hunks, or undo the lot with Ctrl+Z.
- **Nothing is lost silently.** Writes are atomic, unsaved files are flushed before the window closes, unsaved edits are never overwritten by a disk change, and a deleted file is not quietly re-created.
- **Time is recorded per document** for an external time tracker. The Document card shows today's time and lets you pick the matter it is billed to.

## Layout

```
┌───────────────────┬────────────────────────────────────────────┬───────────────────────┐
│ D Drafting        │ (Services Agreement) (Cover letter) + New  │ Document              │
│ [Search Ctrl+P]   │ Services Agreement  .md   testdocs         │ Status   Saved        │
│ DOCUMENTS         │ Snapshot | Paragraph ▾ | B I | Visual|Text │ Matter   Acme MSA Edit│
│ ▾ Correspondence  │                                            │ Time     42m · 2h     │
│     Cover letter  │ 1. Engagement                              │ Length   1,204 words  │
│   Services Agr…   │ 1.1 The Client engages the Firm …          │ Snapshots 2           │
│                   │                                            │ [Proofread] [Send]    │
│                   │                                            │ Claude                │
│                   │                                            │ ● terminal running    │
│ ▸ testdocs   ›    │ Ln 12, Col 4                      Markdown │ claude                │
└───────────────────┴────────────────────────────────────────────┴───────────────────────┘
```

Markdown documents open in the **Visual** editor (formatted, proportional type, editable) by default; **Text** shows the raw markdown in Monaco. Both use the same toolbar. The default view is a setting.

## Keyboard

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette (everything is in here) |
| `Ctrl+P` | Go to document by name |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save all (also works from the terminal) |
| `Ctrl+N`, `Ctrl+O`, `Ctrl+Shift+O` | New document, open file, open folder |
| `Ctrl+W` | Close document |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous document |
| `Ctrl+E` | Switch Visual / Text |
| `Ctrl+\` | Toggle sidebar |
| `` Ctrl+` `` | Jump between document and Claude |
| `Ctrl+Enter` | Send the current document to Claude |
| `Ctrl+Shift+R` | Review a change that arrived from disk |
| `Ctrl+B`, `Ctrl+I`, `Ctrl+K` | Bold, italic, link (Text mode) |
| `Ctrl+,` | Settings |
| `F2`, `Delete` (in the sidebar) | Rename, move to Recycle Bin |

Shortcuts other than Save, tab switching, the palette and Settings yield to the terminal when it has focus, so Claude Code's own keys keep working.

## Settings

`Ctrl+,` or the gear at the top right. Stored in `%AppData%\drafting-app\settings.json`.

- **Appearance**: Light, Dark, or follow Windows.
- **Editor**: font, size, wrap column, autosave delay, default view (Visual or Text).
- **Changes from disk**: where the cursor goes after a reload (stay put, jump to the change, or jump to the end), and whether to offer a review.
- **Claude & terminal**: the launch command (default `claude --dangerously-skip-permissions`), the shell, and the prompt templates behind *Send to Claude* and *Proofread*.
- **Time tracking**: on/off and the tracker folder.

## Development

```bash
npm install
npm start          # run with hot reload
npm run check      # typecheck + lint + tests
npm run package    # build out/Drafting App-win32-x64/Drafting App.exe
```

Requirements: Node 20+ and npm 11+. node-pty ships prebuilt binaries for Windows, so no compiler is needed. If npm blocks install scripts, approve them once:

```bash
npm install-scripts approve electron electron-winstaller node-pty
```

`Rebuild-Drafting-App.cmd` runs the checks and packages the app. Set `DEPLOY_DIR` first if you want the result mirrored to another folder.

### Checking a build without a person

The packaged app can photograph itself. With a scratch profile so your real session is untouched:

```powershell
$env:DRAFTER_USER_DATA = "$env:TEMP\drafter-profile"
$env:DRAFTER_SHOT_DIR  = "$env:TEMP\drafter-shots"
$env:DRAFTER_SHOTS     = "wait:1500;cmd:folder.openPath=C:\docs;wait:1500;cmd:file.openPath=C:\docs\Draft.md;wait:3000;shot:editor;cmd:view.palette;wait:700;shot:palette;key:Escape"
& "out\Drafting App-win32-x64\Drafting App.exe"
```

Steps: `cmd:<command>[=payload]`, `key:<key>`, `wait:<ms>`, `shot:<name>`. Command ids are the ones in the palette (`view.settings`, `theme.toggle`, `review.changes`, …).

### Layout of the source

```
src/main/       Electron main process: files, watcher, PTY, settings, time tracker
src/preload/    the typed bridge exposed to the renderer as window.drafting
src/renderer/   React UI: hooks/useFileSystem is the document state machine
src/shared/     types and IPC channel names shared by both sides
```

## Stack

Electron 41 · React 19 · TypeScript 5 · Monaco · Milkdown (Crepe) · xterm.js with WebGL · node-pty · chokidar · Vitest

MIT licence. Licences of the packages it builds on are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md); regenerate with `npm run notices` after changing dependencies.
