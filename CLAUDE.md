# Drafting App — notes for Claude Code sessions

Electron + React desktop app: markdown editor beside a terminal running `claude`, both editing one folder. Read `README.md` first.

## Where things live

- This repository is the source of truth. `Rebuild-Drafting-App.cmd` checks and packages the app to `out\`.

## Invariants to keep

- **Content lives in a ref** (`useFileSystem.filesRef`). Keystrokes never set React state. React sees dirty/clean transitions, open/close, and `reloads` version bumps only.
- **The store is the source of truth for text.** The Monaco model is reconciled against the store every time it is attached (`Editor.tsx`), because the formatted view may have edited the store meanwhile.
- **External text arrives through `applyExternalContent`** which bumps `reloads`; the editor applies it with `computeLineEdits` (minimal line edits), never a whole-document replace.
- **Writes are atomic** (`file-manager.writeFile`: temp + fsync + rename) and every write is registered with `markEditorWrite` so the watcher can suppress its echo by content hash.
- **Never clobber unsaved edits.** A disk change on a dirty file becomes a `conflict` pending change; nothing is applied until the user decides.
- **Models are disposed when their tab closes** (`Editor.tsx` effect on `openPaths`). Reopening must read fresh from disk.
- Menu accelerators registered in `main.ts` fire even when the terminal has focus; keep that set small. Everything else is handled in `App.tsx`'s keydown listener and yields to the terminal.

## Checks

```
npm run check      # tsc + eslint + vitest, must be clean before a rebuild
```

The desktop screenshot tools cannot see this window. To check a build visually, use the app's own script mode (README, "Checking a build without a person"): a scratch profile via `DRAFTER_USER_DATA`, a step script in `DRAFTER_SHOTS`, PNGs in `DRAFTER_SHOT_DIR`. Change a file from outside during a `wait` step to exercise the watcher and the diff review. Close the app afterwards with `CloseMainWindow()` from PowerShell so the flush handshake runs.

## Design direction

The look follows a light, card-based blog-editor reference the user chose: dark navy sidebar, pale ground, white rounded cards, pill tabs, a Document card with Proofread / Send to Claude where the reference has Save Draft / Publish, and the terminal as a dark card. Visual (Milkdown) is the default view for markdown; Text (Monaco) is the raw view. Keep both themes complete; tokens live at the top of `global.css`.

Tests live next to the code (`*.test.ts`). `textDiff.test.ts` proves the minimal-edit algorithm round-trips; add a test whenever a state-machine bug is fixed.

## Style

Design tokens are in `src/renderer/styles/global.css`; components use classes, not inline styles. Both themes must be defined for every colour. Icons come from `components/Icons.tsx`.
