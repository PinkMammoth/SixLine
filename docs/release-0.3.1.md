# SixLine v0.3.1 Windows release

Built on 2026-10-07. This patch improves choosing a playback start in the score and selecting passages with the mouse.

## Changes

- Clicking a bar/note while stopped or paused chooses the next Play/Space start. A selection starts at its musical beginning, including reverse selections. Pause/resume continues from the paused position unless another score position is chosen. The progress slider and transport buttons explicitly choose playback time.
- Compact Return to bar 1, Back one bar and Forward one bar buttons seek actual bar boundaries, including meter changes and repeat occurrences. Seeking retains playing/paused state. Seeking outside an active loop disables looping while retaining the saved range; otherwise enabled loops still constrain playback.
- Plain click-drag selects complete measures. Shift-click/drag extends beats or an existing measure selection; Ctrl-click retains note/string-row selection. Pointer capture, a fixed anchor, reverse dragging, cross-row hit testing and edge scrolling make selecting passages predictable. Escape, pointer cancellation, focus loss and document changes end a gesture.
- Selecting or moving the caret during playback does not seek, regenerate or stop audio. Player auto-scroll yields during a mouse selection gesture.
- Queued renders begin after the previous alphaTab render callback finishes. Bulk changes to voice/beat counts also invalidate reused layout bounds. These fixes prevent clipped bottom strings, stale hit targets and a long-score renderer error.
- E2E runs use an isolated temporary profile shared across the suite, including restart-preference checks. Saved desktop drum preferences cannot change test results, and test input modes do not alter the desktop profile.

The song format, editing model, clipboard semantics and playback generator remain unchanged.

## Verification

- TypeScript/Vite production build: passed.
- Complete unit suite: **222 passed across 11 files**, including 11 new interaction/timing tests.
- Complete real Electron E2E suite: **98 checks passed**, including 11 new mouse/transport workflows.
- New workflows cover clicked-note playback across tracks, pause/resume, exact bar navigation while stopped/playing, drag/copy/paste with song extension and undo/redo, reverse dragging and release outside the score, Shift-drag reversal, monotonic playback during selection, ordinary playback from a reversed selection, 40-bar edge scrolling/cancellation, and numbered drum selection/playback.
- Windows installer, portable and application executable version resources: **0.3.1**.
- Packaged ASAR version, main/preload and frontend assets exactly match the tested runtime files. Source maps are excluded.

This patch was verified in the real Linux Electron application. Installed-Windows verification was not rerun over the user's installation during this pass; the running Windows application was left untouched. The previous installed-Windows results are recorded in [v0.3.0](release-0.3.0.md).

Testing also exposed an alphaTab AudioWorklet startup edge case when cancelling first playback before its audio source starts (`stop` before `start`). This remains outside this patch; the final playback tests verify musical advancement before pausing/stopping, and complete without page errors.

## Artifacts

Files are in `release/0.3.1/` (git-ignored):

| Artifact | SHA-256 |
| --- | --- |
| `SixLine-Setup-0.3.1.exe` | `8d9f13c43d8e103f7a2d2831de5d532cbbf931602bd96f447c5c1e0a6f41f960` |
| `SixLine-0.3.1-portable.exe` | `a62af4fb4295ba00244fb77309be4f8c78d0b1cebd53c44e657c00edc7031b4c` |

`win-unpacked/` and `SHA256SUMS.txt` are also available. Save open work and close SixLine before installing the update.
