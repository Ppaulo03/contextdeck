# M01-R3 final v1.0.0 validation

Status: **installer generated; final stable installer homologation pending**.

## Baseline

- Branch: `release/v1.0.0-preparation`
- Base: R2 commit `b692b0a`
- RC manual result: reported by the user as 7/7 PASS, without observations.
- The reported RC approval is retained as history; it does not substitute for
  final stable installer validation.

## Build and artifacts

Run:

```text
npm test
npm run check
npm run smoke
npm run dist:dir
npm run dist:check
npm run smoke:packaged
npm run dist:win
```

Expected stable artifact: `dist/win/ContextDeck-1.0.0-win.exe`.
Generated installers and unpacked application files remain ignored build
artifacts. Distribution contents must not include `archive.zip`, harness
reports, local `config.json`, ChatGPT profiles, logs, or credentials.

The validation scripts accept `CONTEXTDECK_DISTRIBUTION_DIR` and
`CONTEXTDECK_PACKAGED_EXECUTABLE` when an existing running instance locks the
default `dist/win` directory; this keeps verification isolated without
terminating that instance.

## Automated results

Record the exact test output, installer byte size, SHA-256, executable version,
and the packaged smoke result after building the stable artifact. The smoke
uses a disposable `CONTEXTDECK_USER_DATA` profile and does not claim ChatGPT
authentication or real Herdr behavior.

## RC to stable update procedure

Use a disposable Windows profile or a safe copy:

1. Install the `1.0.0-rc.1` installer.
2. Create test preferences, ChatBindings, ProjectBindings, and Git selection.
3. Close the application completely.
4. Install `1.0.0` over the RC.
5. Open the stable application and verify the displayed version.
6. Confirm bindings, preferences, Git selection, Projects availability, and the
   legacy Chromium profile remain available.

Do not run this procedure against the user's real profile. Credential contents
must not be inspected or copied.

## Residual manual checklist

- [ ] Install `ContextDeck-1.0.0-win.exe` on a clean Windows 11 profile.
- [ ] Open from Start menu and desktop shortcut.
- [ ] Authenticate ChatGPT normally and restart while preserving the session.
- [ ] Confirm Projects appears by default and create/open a Project conversation.
- [ ] Connect Herdr and switch workspaces.
- [ ] Exercise multi-chat, Git per workspace, Diff, Show, ZIP, and clipboard.
- [ ] Close/reopen and verify persistence.
- [ ] Install stable over RC and verify all test data survives.
- [ ] Uninstall and verify the legacy profile is not deleted.
- [ ] Start without Herdr and verify a recoverable state.
- [ ] Confirm no development-repository path is required.

The two-hour prolonged test is not declared complete unless separately recorded
by a human. No authenticated checks are claimed from the automated harness.
