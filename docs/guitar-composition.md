# Guitar and bass composition pass

Implemented and verified on 2026-10-07 using the real Linux Electron application. The existing document, selection, clipboard, import/export, playback and practice architecture remains in place.

## Canonical model and preservation

`NoteEffects` remains the canonical, renderer-independent representation. Bends retain their quarter-tone points with offsets from 0–60. Hammer/pull flags identify an origin and its following same-string, same-voice note. Slide-in/out types retain GP/alphaTab values. Palm mute and let ring retain per-note flags; alphaTab derives the corresponding spans and sounding durations.

This pass adds a typed harmonic `{ type, value }`, including all six imported variants, and wide vibrato alongside the existing boolean normal vibrato. Existing version-1 projects continue to load without a destructive migration or format bump. Native saves preserve all imported curve points and harmonic values exactly. Retyping an unchanged fret leaves a custom imported harmonic node intact.

The alphaTab bridge now carries harmonic type/value and wide vibrato in both directions. Empty secondary voices are padded only in the renderer model so imported multi-voice passages can render/play when subsequent bars lack that voice. Canonical voices are not changed, and second-voice note editing was not added.

## Technique editing and keyboard interaction

The compact Guitar menu works on guitar and bass. Commands apply to the current note or selected notes. String restrictions are respected; complete measure selections include imported secondary voices. Invalid applications report a status message before editing. Each application is one undo action.

| Shortcut | Operation |
| --- | --- |
| H | Hammer-on / pull-off toggle |
| B | Bend editor |
| S | Slide editor |
| V / Shift+V | Normal vibrato toggle / wide vibrato |
| P / L | Palm mute / let ring toggle |
| N | Harmonic editor |
| Q | Chord Entry on/off |
| Ctrl+Shift+K | Clear the entire caret chord |
| Shift+Up/Down | Move chord/selected frets +1/−1 |
| Ctrl+Shift+Up/Down | Move chord/selected frets +12/−12 |
| Alt+Up/Down | Move chord/notes to neighbouring strings, preserving fretted pitch |

These letter bindings are scoped by track type; existing drums and keys bindings remain available. There is one chord-mode toolbar button and a short current-note technique indicator. Simple toggles do not open dialogs.

The bend editor supports quarter, half, whole and 1½ steps, hold and release, and removal. Imported arbitrary curves default to “Keep current curve”; explicitly choosing an amount creates a standard curve. This preserves imported curves without building a graphical curve editor.

Shift and legato slides validate their following note. Slide-in from above/below and slide-out up/down are editable; imported pick-slide variants are retained. Hammer-on versus pull-off follows fret direction. New transitions require different struck frets on the same string in consecutive beats, without intervening rests or ties. A cross-bar transition requires a filled source measure. Imported relationships remain intact during unrelated edits.

P/L toggle a note or passage; explicit apply/remove menu commands handle mixed selections predictably. Natural harmonics use valid touch frets, including 5, 7, 12, 19 and 24. Artificial and pinch harmonics expose a relative touch node, defaulting to twelve. Other imported harmonic types remain available for preservation/removal without exposing an exhaustive creation taxonomy.

## Chord entry and manipulation

Q fixes entry to a beat. Type a fret, press Tab/Enter for the next string; Shift reverses direction. X mutes/skips a string. Right moves to the next beat on the top string. For the requested C chord: `0 Tab 1 Tab 0 Tab 2 Tab 3 Tab X`.

Multi-digit frets use the existing one-second entry window. Navigation commits the string, so fast consecutive chord tones do not combine accidentally. If a prefix would temporarily invalidate a harmonic or linked transition, it is buffered without changing the song; Escape/Backspace cancels it and incomplete input expires. Normal entry outside chord mode is preserved.

A vertical chord entry groups into one undo action, respects duration and prevents duplicate strings. Explicit caret movement, beat changes and intervening commands start new undo groups. Guitar string count is not assumed; four-string bass and other existing tunings use the same implementation.

Chord clearing, fret shifts and string moves are atomic. Operations reject negative frets, frets above 30, missing strings, duplicate string assignments and broken ties/linked transitions. Natural harmonic touch-fret changes require valid touch nodes. Harmonic restringing is rejected because ordinary fretted-pitch relocation cannot preserve its sounding pitch reliably.

## Workflow and import/export audit

Save/load and snapshot undo/redo retain all technique fields. Copy/cut/paste, beat duplication and measure duplication retain internal relationships and complete effect data. A copied linked origin must include its target; unsupported boundaries are rejected clearly. Deleting/cutting/replacing a target detaches its old origin rather than attaching it to unrelated material. Cross-bar repairs are included in the same undo action as the edit.

GP3/4/5 preservation is checked against alphaTab's decoded effects note by note, including public fixtures and all available private fixtures. Electron workflow C changes two imported effects, saves a new `.tabproj`, reopens and compares the complete edited song; a SHA-256 check verifies the original GP5 stays unchanged.

MIDI export uses the existing alphaTab playback generator. Supported sounding pitches, timing and pitch bends become ordinary MIDI events. Technique-specific notation does not survive MIDI round-trip. No proprietary technique metadata or new export format was introduced.

Mode, caret, selection, track and panel changes continue to use UI-only events. Musical changes retain the existing regeneration path, restoring playback tick/state. Full playback continuity and practice workflows remain in the E2E suite.

## Verification and remaining limits

- TypeScript and Vite production build passed.
- Full unit suite: **211 passed across 10 files**, including all 152 pre-pass tests and 59 new guitar/bass tests.
- Full Electron E2E suite: **87 checks passed, 0 failed**, including all 75 existing checks and 12 new checks.
- Workflow A creates every requested articulation, checks alphaTab relationships/rendering, saves/closes/reopens, compares the complete song and plays to completion without page errors.
- Workflow B enters a chord progression vertically, checks multi-digit frets/duration, duplicates and edits it, undoes/redoes, clears/restores chords and independently parses exported MIDI pitches. Additional bass checks exercise chord entry, transposition, pitch-preserving string moves and invalid-move feedback.
- Workflow C edits two imported techniques in an available private GP5 and verifies native persistence and source-file integrity.
- GP tests verify imported effects directly, native persistence, legacy version-1 compatibility, renderer conversion, and ordinary MIDI events. Editing tests cover atomic selection validation, relationships, undo/redo, clipboard/duplication, chord creation/navigation and rejected fret/string operations.
- Rendered examples were visually inspected: `e2e/out/guitar-articulated.png` and `e2e/out/guitar-chords.png`.

No regressions or page errors were detected by the complete suites. The Windows installer/portable package and installed-Windows verification were not rebuilt in this pass.

Existing limits remain: partial paste/duplicate cannot implicitly split notes over bar lines, the clipboard stays inside the running window, and existing alphaTab velocity quantization applies. Imported secondary voices remain preserved but do not gain full note-entry controls. Natural harmonic touch-fret moves are node changes rather than an automatic alternative fingering operation; harmonic string relocation is intentionally rejected. Simple new transitions require consecutive beats; more unusual imported relationships are retained.

The next highest-value guitar editing improvements are repeating the last bend/slide settings without reopening their editor, and effect-aware tied splitting for more flexible paste/duplication across bar lines. Neither was added in this pass.
