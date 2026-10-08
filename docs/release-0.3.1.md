# SixLine v0.3.1 Windows release

Rebuilt on 2026-10-08 from application commit `f2da1f1`. This build includes single/multi-track views, custom instrument tunings and progressive practice, along with the playback and selection improvements first packaged on 2026-10-07. The version remains 0.3.1.

## Changes

- A single button switches between the selected instrument and an aligned view of all tracks. Staff clicks select the correct instrument; view changes preserve playback and selection, and the preference survives restarting.
- Guitar supports 6/7/8 strings, bass 4/5/6 strings, and keys/synth tracks offer notation or 1–8 strings. Each open string can use its own note, including repeated notes and non-descending tunings. Custom tunings survive save/reopen and retain the selected instrument sound.
- Practice bars loops an inclusive range of consecutive bars, starting at a configurable speed and increasing after each completed pass (default 5 percentage points). A configurable target caps the increases; looping continues at that speed. Enabled count-ins repeat before each pass at the increased speed, and the click track follows the same timing. Pause retains progress; Stop resets it; End practice exits. The bars, pass and current speed appear in the toolbar.
- Clicking a bar/note while stopped or paused chooses the next Play/Space start. A selection starts at its musical beginning, including reverse selections. Pause/resume continues from the paused position unless another score position is chosen. The progress slider and transport buttons explicitly choose playback time.
- Compact Return to bar 1, Back one bar and Forward one bar buttons seek actual bar boundaries, including meter changes and repeat occurrences. Seeking retains playing/paused state. Seeking outside an active loop disables looping while retaining the saved range; otherwise enabled loops still constrain playback.
- Plain click-drag selects complete measures. Shift-click/drag extends beats or an existing measure selection; Ctrl-click retains note/string-row selection. Pointer capture, a fixed anchor, reverse dragging, cross-row hit testing and edge scrolling make selecting passages predictable. Escape, pointer cancellation, focus loss and document changes end a gesture.
- Selecting or moving the caret during playback does not seek, regenerate or stop audio. Player auto-scroll yields during a mouse selection gesture.
- Queued renders begin after the previous alphaTab render callback finishes. Bulk changes to voice/beat counts also invalidate reused layout bounds. These fixes prevent clipped bottom strings, stale hit targets and a long-score renderer error.
- E2E runs use an isolated temporary profile shared across the suite, including restart-preference checks. Saved desktop drum preferences cannot change test results, and test input modes do not alter the desktop profile.

Projects continue to use the version-1 `.tabproj` format. Practice settings are per open document and do not change the song or its exported MIDI.

## Verification

- TypeScript/Vite production build: passed.
- Complete unit suite: **250 passed across 12 files**.
- Complete real Electron E2E suite: **122 checks passed**, including multi-track editing/playback, custom tuning persistence, and progressive practice audio timing and cancellation.
- New workflows cover clicked-note playback across tracks, pause/resume, exact bar navigation while stopped/playing, drag/copy/paste with song extension and undo/redo, reverse dragging and release outside the score, Shift-drag reversal, monotonic playback during selection, ordinary playback from a reversed selection, 40-bar edge scrolling/cancellation, and numbered drum selection/playback.
- Windows installer, portable and application executable version resources: **0.3.1**.
- Packaged ASAR version, main/preload and frontend assets exactly match the tested runtime files. Source maps are excluded.
- Both the installer and portable EXE embed an ASAR identical to the current Windows build; all 20 packaged runtime files match the rebuilt frontend, main/preload and icon.
- Source, build scripts, tests and this release report are committed. Built executables and other `release/` output remain local and git-ignored, following the previous release pattern.

This build was verified in the real Linux Electron application and by checking the packaged Windows payloads and executable version resources. Installed-Windows verification was not rerun over the user's installation during this pass; the running Windows application was left untouched. The previous installed-Windows results are recorded in [v0.3.0](release-0.3.0.md).

Testing also exposed an alphaTab AudioWorklet startup edge case when cancelling first playback before its audio source starts (`stop` before `start`). This remains outside this patch; the final playback tests verify musical advancement before pausing/stopping, and complete without page errors.

## Artifacts

Built files are in `release/0.3.1/` (git-ignored):

| Artifact | SHA-256 |
| --- | --- |
| `SixLine-Setup-0.3.1.exe` | `09dea0133b56dcac5e7f06d77db3803e6471e9f5f962ef5cf44f7f172cf7d60d` |
| `SixLine-0.3.1-portable.exe` | `4ba9886654929f30481f20242e09da9f20923f3a6837a43c05ad2bc5bf3cc81c` |

`SHA256SUMS.txt`, the installer blockmap, and `win-unpacked/` are also available locally. Save open work and close SixLine before installing the update.
