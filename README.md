# TabEdit

A small, local-only desktop tablature editor in the spirit of Guitar Pro 5: keyboard-driven tab entry, standard notation + tab, MIDI/SoundFont playback, GP3/GP4/GP5 import.

## Run

```sh
npm install
npm start                    # build + launch the desktop app
npx electron . path/to/song.gp5   # open a file directly (after a build)
```

## Test

```sh
npm test          # unit tests (model, editor, GP import round-trip, project format)
npm run test:e2e  # builds, then drives the real Electron app with Playwright
```

## Architecture

- **Document model** (`src/model`): plain JSON `Song → MasterBar[] + Track[] → Measure → voices → Beat → Note`. Renderer-independent. This is the source of truth.
- **Editor** (`src/editor/editor.ts`): cursor + all mutations. Every edit goes through `Editor.edit()`, which takes a snapshot of the touched measure (or of the whole song for structural edits), so undo and redo are generic.
- **alphaTab bridge** (`src/io/alphatab.ts`): GP3/4/5 bytes → alphaTab `Score` → our `Song` (import). For rendering and playback, our `Song` → a fresh alphaTab `Score` → `api.renderScore(score, [track], { firstChangedMasterBar })`. alphaTab regenerates the playback MIDI when it gets a new score.
- **Project format** (`src/io/project.ts`): `.tabproj` = `{ format, version, song }` JSON with a migration table.
- **Shell** (`electron/`): window, native file dialogs, file read/write. Nothing else. The UI is in-window HTML (`src/main.ts`, `src/ui`).

## Keys

| Key | Action |
| --- | --- |
| ←/→ | previous/next beat (→ past the end of an unfilled bar adds a beat; past the last bar adds a bar) |
| ↑/↓ | previous/next string |
| Ctrl+←/→, PgUp/PgDn | previous/next bar |
| 0-9 | enter a fret (two quick digits = multi-digit fret, e.g. 1 2 → 12) |
| Del / Backspace | delete the note on the cursor string |
| Ins / Ctrl+Del | insert / delete a beat |
| Ctrl+Ins | insert a bar |
| Alt+1..6 | whole, half, quarter, eighth, 16th, 32nd |
| + / - | shorter / longer duration |
| . | dotted |
| T (tab tracks), Shift+T (any track) | triplet |
| Space | play / pause |
| Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z | undo, redo |
| Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S | new, open, save, save as |
| Ctrl+E | export Standard MIDI File (same generator as playback) |
| F6 (or double-click a track) | track properties (name, MIDI program, tuning presets, capo, volume, pan) |

### Drum tracks

A grid of the current bar appears under the score: rows are kit pieces, columns are beats. Click a cell to toggle it. The data is ordinary beats with General MIDI percussion notes.

| Key | Action |
| --- | --- |
| K S H O P C R B T M L F X | kick, snare, closed hat, open hat, pedal hat, crash, ride, ride bell, high/mid/low/floor tom, side stick (toggle on the current beat) |
| ↑/↓ then Enter | choose a kit row and toggle it |
| Del | remove the piece on the cursor row |

### Keys / synth tracks (standard notation only)

| Key | Action |
| --- | --- |
| A–G | toggle that note in the octave nearest the cursor pitch |
| ↑/↓, Ctrl+↑/↓ | move the cursor pitch by a semitone / an octave |
| Shift+↑/↓, Ctrl+Shift+↑/↓ | transpose the note under the cursor by a semitone / an octave |
| Enter / Del | toggle / delete the note at the cursor pitch |

The current pitch or kit piece is shown in the status bar. Pick a GM instrument with F6.

Clicking in the score moves both the edit caret and the playback position. Click the time signature in the toolbar to change it from the current bar on. Add or remove tracks from the Track menu.

## Fixtures

`fixtures/fixture.gp{3,4,5}` are trivial original riffs generated with PyGuitarPro (`scripts/make_fixtures.py`). Private GP3/GP4/GP5 files can be placed in `gp5-examples/`. They are git-ignored, and tests use them when present and skip them when absent (see `gp5-examples/README.md`).
