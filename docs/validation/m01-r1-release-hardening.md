# M01-R1 — Release Hardening & Stability

Status: audit and automated checks complete on 2026-10-14; manual authenticated and long-session homologation remains pending. This milestone does not authorize packaging, publishing, push, merge, or R2.

## Starting point and scope

- Homologated base: `feature/m01-i3d-1-workspace-git`, `39026b60332fcb14d96bfda1ff65298583108d78` (`feat: scope Git repositories to workspaces`). Confirmed before work.
- Working branch: `feature/m01-r1-release-hardening`.
- Existing untracked `archive.zip` and three `m01-i3c-1h2` report directories were preserved.
- Persistent identifiers remain `Project Dock M00`, `persist:project-dock-m00-chat`, and the configured Herdr session. No real profile was opened, copied, rewritten, or removed.

## Risk matrix

| Priority | Finding | Disposition |
|---|---|---|
| P0 | No confirmed P0 found in source review and existing regression suite. | None. |
| P1 | No new confirmed P1. Git context checks, workspace identity checks, view lifecycle gates, and store safeguards have regression coverage. | None. |
| P2 | Corrupt `ui-state.json` silently falls back to defaults and shutdown can later overwrite it, losing recoverable preferences. | Confirmed by code inspection; addressed by backup + atomic save in this milestone. |
| P2 | `config.json` parse/validation failure stops bootstrap, with no safe recovery path. | Confirmed by code inspection. Kept explicit/fail-fast because choosing example defaults could silently redirect Herdr session; diagnose in terminal, then correct the local config. |
| P2 | UI preference writes are best-effort and have no visible persistence-failure signal. | Residual; a visible recovery flow needs focused UX/API work and no disk failure was reproduced. |
| P3 | Installer metadata, icon, and packaged asset/runtime checks are not yet configured. | R2 requirement; no installer added. |

## Audit map

| Area | Current behavior / evidence | Risk |
|---|---|---|
| Electron startup/shutdown | Explicit legacy `userData`, single-instance lock, bootstrap catch, and shutdown stops PTY/pushers/observers; smoke starts actual app on a throwaway profile. | Config errors intentionally stop startup with a diagnostic. |
| Chromium session | One persistent named partition shared by views; cookies stay in Chromium. Each view gets sandbox/context isolation/no preload; permissions are denied except ChatGPT clipboard write. | Authenticated persistence requires manual account check. |
| Chat navigation/auth | HTTPS ChatGPT main navigation and bounded auth popup allowlist; untrusted popups denied; policy tests cover accepted/rejected origins. | Login and provider redirects require authenticated check. |
| Herdr | Read-only discovery/subscriptions, heartbeat reconciliation and reconnect backoff; only explicit selection sends `workspace.focus`. Unit tests cover pipe drop, reconnect, removal, ID reuse, and session unavailable. | Real start-after-app/reconnect remains manual. |
| Multi-chat/activity | Views are lazy, hidden by detaching, observation is boolean/control metadata only, and shutdown destroys managed views. Unit tests cover concurrency, navigation and deduplication; real Electron harnesses exercise logged-out pages. | Logged-out harness cannot prove authenticated behavior. |
| ChatBindings/ProjectBindings | Separate versioned stores, atomic sibling-temp writes, migrations backed up, corrupt files preserved, newer schemas read-only. Project support stays off unless opted in. | No data reset observed. Project route shape remains experimental. |
| Git per workspace | Every operation resolves active context and expected repo; manual choice is keyed to workspace identity evidence; refs validated/resolved; ZIPs managed under userData. Tests cover switch during operation and preference restart. | Clipboard and Explorer behavior need a person. |
| Preferences | `ui-state.json` now backed up when corrupt and saves atomically; schema sanitizer keeps old shapes. | A write failure remains best-effort and not surfaced in UI. |
| Lifecycle | Manual only, unknown unsent state blocks; destruction confirmed before record; restoration reloads URL and loses transient state. | Authenticated suspension remains disabled/unsupported for v1. |
| Errors/logs | App startup errors to stderr; trace flags opt-in; diagnostic logs bounded/rotated and omit message text, drafts, cookies and attachment details. | Config errors have no in-app screen because app cannot safely initialize. |

## Corrections and persistence recovery

`ui-state.json` parse errors are now preserved as a timestamped `.corrupt-<timestamp>` sibling. The app starts with safe defaults, remembers that recovery occurred, and writes defaults only after preserving the original. A failure to preserve keeps the store read-only so later shutdown cannot overwrite it. Saves use a temporary sibling and rename. Legacy valid shapes still sanitize and load.

`config.json` remains fail-fast on invalid content: falling back to `config.example.json` could silently attach to another Herdr session, while silently replacing it would discard user intent. The actionable message is printed by the existing bootstrap error handler; the local file remains untouched.

## Validation results

**Validated automatically**

- `npm test` after the recovery change: 707 passed, 0 failed.
- `npm run check` after the recovery change: 707 passed and renderer build succeeded.
- `npm run build`: succeeded.
- `npm run smoke`: actual Electron application remained running for 15 seconds on a throwaway profile.
- Existing suites cover settings, UI-state legacy shapes, atomic binding stores, Herdr reconnect and stale events, multi-chat/activity, navigation policy, Git context switching, Diff/Show/ZIP, and lifecycle refusal/restore models.

**Validated by harness**

- Start-up smoke passed with `CONTEXTDECK_USER_DATA` throwaway storage (15 seconds).
- Attempted `npx electron test/electron/multiview-harness.js`: the harness produced an IPC handler error because its `registerIpc` call omits the now-required `activityIpc.getPayload`, then failed to write its final report because the chosen `HARNESS_OUT` directory did not exist. This is a harness setup defect; the run is inconclusive, not a product pass or product failure. Existing reports remain untouched.
- Activity and lifecycle real-Electron harnesses were not run in this pass. Unit coverage and startup smoke pass; they need separate clean runs with a pre-created report directory.
- Authenticated manual and prolonged session behavior is not inferred from logged-out harnesses.

**Pending manual validation**

- Checklist below, especially real login persistence, auth redirects, clipboard file paste, Herdr reconnect against the intended non-default session, concurrent real responses, and prolonged stability.

**Blocked**

- None. The lifecycle limitation is known and documented; it does not block ordinary use.

## Manual homologation checklist

Use the existing real profile only for these human-driven checks; do not clear it. For destructive crash simulation, use a separate disposable profile.

- [ ] A. Clean launch with a disposable empty profile.
- [ ] B. Launch with existing profile; verify preferences and bindings remain.
- [ ] C. Confirm existing ChatGPT login persists and legitimate auth redirects complete.
- [ ] D. Start with Herdr online; disconnect/restart its named pipe/session and verify reconnect. Also start Herdr after ContextDeck.
- [ ] E. Switch repeatedly among multiple workspaces and multiple conversations; verify labels and bindings.
- [ ] F. Generate simultaneous responses and verify background indicators/attention without navigation or reload.
- [ ] G. Preserve a draft while switching views/workspaces; verify conflict flow and no accidental reassignment.
- [ ] H. Verify Project routes and creation only if `CONTEXTDECK_PROJECTS=1` has been deliberately enabled.
- [ ] I. Verify Git repository name, branch and path against each workspace; exercise automatic, manual, disconnected, return-to-auto, and repo missing.
- [ ] J. Exercise Diff, Show, ZIP, text clipboard, and Explorer file paste; verify ZIP export failure leaves the generated ZIP selectable.
- [ ] K. Close normally and relaunch; verify ChatGPT session, bindings, Git prefs and selected UI state.
- [ ] L. On disposable profile only, terminate the app unexpectedly and verify safe restart; do not simulate against the real profile.
- [ ] M. Run a representative session for at least 2 hours with several views and repeated workspace switches. Record `app.getAppMetrics()`/Task Manager memory and process counts at start, 30 min, 1 h, 2 h, after closing views, and after shutdown. Look for monotonic listener/process growth; one short run cannot prove absence of leaks.
- [ ] N. Test temporary network loss and recovery in ChatGPT; verify Herdr remains independently usable.
- [ ] O. Resize, minimize, restore and switch tabs while responses are running.

## Long-session observation procedure

Use the real account only with the user's direct observation. Record app version/commit, view count, approximate memory/CPU, `webContents` count, workspace switch count, and any recovery event at the checkpoints above. After closing, confirm ContextDeck-owned child processes exit and persisted files reopen. Do not record conversation content, drafts, cookies, or attachments. Repeat on another day before claiming leak-free operation.

## Known limitations / residual risks

- Lifecycle authenticated suspension is not homologated because the detector cannot prove absence of attachments or other unsent content. Unknown blocks suspension. No automatic or forced suspension; this is a known v1 limitation, not an application error.
- Restore reloads the conversation URL; it does not preserve unsent attachments, scroll position, or transient page state.
- ChatGPT login, Projects, real clipboard/Explorer paste, and long-session memory behavior remain manual.
- `ui-state.json` save errors are swallowed by the best-effort preference writer; bindings have stronger visible read-only/corruption notices. No failure reproduced in this audit.
- Invalid `config.json` blocks startup rather than silently changing Herdr target. Correct the file and retry.

## Windows packaging requirements for M01-R2

- Select and pin a Windows packaging mechanism; keep it minimal and compatible with Electron 44.
- Package `src/main`, built renderer assets, preloads, xterm assets, Electron resources, and `node-pty` runtime/prebuild. Verify ConPTY/PTY startup on a clean Windows account without a development checkout.
- Resolve `PROJECT_ROOT`, `PRELOAD`, `OVERLAY_PRELOAD`, and renderer paths from packaged resources; remove assumptions that `config.example.json` or source tree is beside the executable.
- Provide icon and executable metadata (product name, publisher/version, file description); define signing/update policy before distribution.
- Preserve `Project Dock M00` userData and `persist:project-dock-m00-chat` partition exactly. Test upgrade-in-place from an existing profile and rollback without deleting user data.
- Herdr remains an external runtime dependency: detect its absence with a clear recoverable status and document supported installation/version; do not bundle or modify its installation without a separate decision.
- Test installer/uninstaller behavior to ensure it never removes userData, generated artifacts, or Herdr workspaces.

## Git state

Branch: `feature/m01-r1-release-hardening`, based directly on the homologated I3D-1 commit. No push, merge, tag, or commit has been made. Existing untracked archive and reports remain untouched.
