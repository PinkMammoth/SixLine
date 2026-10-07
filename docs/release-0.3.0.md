# SixLine v0.3.0 Windows release

Built and verified on 2026-10-07. This release packages the composition/practice workflows, numeric drum entry/view, and editable guitar/bass techniques with vertical chord entry.

## Artifacts

Generated files are in `release/0.3.0/` (git-ignored):

- `SixLine-Setup-0.3.0.exe`: Windows x64 installer.
- `SixLine-0.3.0-portable.exe`: Windows x64 portable application.
- `win-unpacked/`: unpacked application.
- `SHA256SUMS.txt`: installer/portable checksums.

| Artifact | SHA-256 |
| --- | --- |
| Installer | `687712059ac21ec520a19188586deadb09319b4fb8ceca517035b221a298c036` |
| Portable | `bf34a7fdf2494c6ba524bba00247f56c465955514c15a10c7f7efc78f8575f28` |

## Verification

- TypeScript and Vite production build: passed.
- Complete unit suite: **211 passed across 10 files**.
- Complete real Electron E2E suite: **87 checks passed**.
- Actual installed Windows application: **18 checks passed**, zero failures or page errors in the final run.

Windows checks cover installer/executable version resources, runtime `app.getVersion()`, per-user installation, Start Menu entry, no silent-install desktop shortcut, uninstaller registration and `.tabproj` association. The installed application runs its packaged `app://` content with DevTools disabled, loads its SoundFont, plays, edits imported GP5 tablature, saves/reopens and exports independently parsed MIDI. Explorer opening reuses an existing window, shell opening starts the application, the portable executable opens a project, and silent uninstall cleans up the application, shortcuts, association and uninstall registration.

A new installed-app workflow enters a C chord vertically, verifies grouped undo/redo, applies palm mute/vibrato/a half-step bend, checks alphaTab's rendered effect state, then saves, closes and reopens the native project with an exact song comparison. The verification script now checks the version from `package.json` rather than hard-coding 0.1.0. It waits for the bend dialog's asynchronous edit before checking rendering.

The existing inactive v0.1.0 Windows installation was backed up before verification. A temporary wrapper restored the original application, preferences/profile, shortcuts and Windows registration after the installer/uninstaller tests. Application/profile files were compared byte-for-byte via SHA-256. The existing installation was preserved; this release build does not permanently upgrade it.

Final Windows verification artifacts: `C:\Users\matth\AppData\Local\Temp\sixline-verify-R5AoUc`. Preservation backup: `C:\Users\matth\AppData\Local\Temp\sixline-existing-backup-yKIFjG`. These contain local test/backup data and are not included in the release binaries or repository.
