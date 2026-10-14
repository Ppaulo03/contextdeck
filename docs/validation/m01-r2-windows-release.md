# M01-R2 Windows release candidate

Status: **packaging ready for manual homologation; not released**.

## Strategy

The candidate uses electron-builder 26.0.12 and an unsigned x64 NSIS installer.
`npm run dist:win` runs the renderer build and writes the installer under
`dist/win`. `npm run dist:dir` creates `dist/win/win-unpacked` for inspection;
`npm run dist:check` verifies the executable and ASAR contents, and
`npm run smoke:packaged` starts that executable with a disposable profile.

The package is ASAR based. `src/**`, generated renderer assets, and
`config.example.json` are included. `node-pty` Windows prebuilds are unpacked;
native rebuild is disabled because it requires optional Spectre-mitigation
libraries on this machine. No publisher or signing certificate is configured.
Windows SmartScreen may therefore show its standard unsigned-app warning.

## Data compatibility

The package preserves the existing identifiers and does not migrate or recreate
profiles:

- `%APPDATA%\\Project Dock M00`
- `persist:project-dock-m00-chat`
- Herdr session `project-dock-m00`

NSIS has `deleteAppDataOnUninstall: false`; uninstall does not remove the
profile, bindings, preferences, or authenticated Chromium data. Herdr remains
an external dependency. Git is read-only and continues to use the configured
workspace repositories. `CONTEXTDECK_PROJECTS=0` remains the opt-out.

## Automated validation

Validated by the agent:

- `npm test` — 710 tests passed.
- `npm run check` — tests and renderer build passed.
- `npm run smoke` — disposable-profile Electron smoke passed.
- `npm run dist:dir` — unpacked x64 application generated.
- `npm run dist:check` — executable and ASAR verified; no local profile or
  report files were present in the distribution.
- `npm run smoke:packaged` — packaged executable stayed running for the smoke
  interval with a disposable profile and no startup error output.
- `npm run dist:win` — unsigned x64 NSIS installer generated.

The generated installer and unpacked files are ignored build artifacts and are
not committed.

## Manual homologation checklist

Run on a disposable Windows profile first. Record each result and the exact
installer path.

- [ ] A. Install on a clean Windows 11 machine.
- [ ] B. Open from the Start menu and desktop shortcut.
- [ ] C. Authenticate ChatGPT through the normal web UI.
- [ ] D. Restart and confirm authentication persists.
- [ ] E. Connect to the real Herdr session.
- [ ] F. Switch between multiple workspaces.
- [ ] G. Create and open conversations.
- [ ] H. Link and open a ChatGPT Project; confirm Projects is enabled by default.
- [ ] I. Use Git per workspace with automatic and manual selection.
- [ ] J. Exercise Diff, Show, ZIP, and clipboard flows.
- [ ] K. Close and reopen while preserving preferences and bindings.
- [ ] L. Run the installer again over the existing installation.
- [ ] M. Verify all persistent data after the update.
- [ ] N. Uninstall and verify the profile remains.
- [ ] O. Start without Herdr and confirm a concise recoverable state.
- [ ] P. Confirm startup does not depend on the development repository path.

Items C–M and the real Herdr/Git paths require an authenticated human session;
they are not claimed by the automated smoke. The lifecycle suspension policy is
unchanged and remains conservative.

## Release limitations

This is an RC artifact, not a v1 release declaration. It has no automatic
updates, telemetry, publisher identity, or code-signing certificate. The
installer has been generated and the unpacked executable smoke-tested, but
clean-install, update, authentication, and uninstall scenarios remain pending
manual homologation.
