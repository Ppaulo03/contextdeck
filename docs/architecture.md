# Architecture

ContextDeck is an Electron app (main process in CommonJS, local UI bundled with esbuild). It has three kinds of web content, each with a different trust level.

```text
┌────────────────────────── Electron main process (src/main) ─────────────────────────┐
│  index.js (bootstrap) ── window.js ──┬─ local UI window ──(preload bridge)── renderer │
│                                      └─ chat-view.js ── ChatGPT WebContentsView       │
│  ipc/*  ── herdr/client.js ── node-pty ── herdr.exe (client) ── Herdr server/agents  │
│        └─ git/* ── git.exe (arg arrays)   platform/* (PATH lookup, file clipboard)    │
│  persistence/* (config.json, ui-state.json, persistent identifiers)                    │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| Content | Source | Privileges |
|---|---|---|
| Local UI | `dist/renderer` (built from `src/renderer`) via `file://`, strict CSP | `contextIsolation`, sandbox, no Node; talks to main only through the `window.dock` bridge (`src/preload`). |
| Menu overlay | `dist/renderer/overlay.html`, local, transparent view above the ChatGPT view only while a menu is open | Same isolation as the UI window; its own preload exposes only `state`, `choose`, `close` and two push listeners. |
| ChatGPT page + auth popups | `https://chatgpt.com` (HTTPS only) | `contextIsolation`, sandbox, no Node, **no preload**, persistent partition. Cannot reach any IPC channel. Only `clipboard-write` is granted to `chatgpt.com`; every other permission is denied. |
| Herdr TUI | Bytes from a PTY, rendered by xterm.js | Text only; input is forwarded as bytes to the PTY. |

## Source layout

```text
src/main/
  index.js            Bootstrap: pin userData, single-instance lock, load settings/state, wire modules.
  paths.js            Project root, preload and built-UI locations.
  window.js           Main window, mode (terminal|chat), ChatGPT view layout, focus, UI-state persistence.
  chat-view.js        ChatGPT WebContentsView: partition, permissions, navigation and popup policy.
  web-preferences.js  The only place that defines webPreferences (isolation for every web contents).
  shortcuts.js        Ctrl+Tab decision (pure) and the before-input-event handler.
  herdr/              client.js (PTY client lifecycle), env.js (strips HERDR_* from the PTY env);
                      api-client.js (named-pipe API client: read allowlist + workspace.focus), session-locator.js,
                      workspace-reader.js (snapshot normalizer + active-workspace identification),
                      workspace-observer.js, workspace-selection.js (selector state and focus sync).
  git/                core.js (safe exec, repo/ref validation, diff/show/archive), refs.js (discovery and
                      selection), context.js (active repo + per-repo prefs), actions.js (copy/zip/delete),
                      artifacts.js (ZIP naming and guarded deletion).
  ipc/                index.js + dock.js, terminal.js, clipboard.js, git.js, herdr.js (channel registration by domain).
  persistence/        settings.js (config), ui-state.js (preferences), identity.js (persistent identifiers).
  platform/           executable.js (PATH/PATHEXT lookup), file-clipboard.js (CF_HDROP via PowerShell STA).
src/preload/index.js  contextBridge API of the UI window (`window.dock`); overlay.js: the smaller bridge of the menu overlay.
src/renderer/         index.html, app.js (entry), components/ (header, terminal-view, workspace-selector, git-panel,
                      herdr-panel, herdr-store, feedback, dom), overlay/ (menu page), styles/ (tokens, base, layout,
                      components). See design-system.md.
src/shared/           Pure view-models used by the UI and the overlay (workspace-view.js).
scripts/build.js      esbuild: app.bundle, overlay.bundle and styles.css -> dist/renderer.
test/                 node:test suites (no real repositories; temp repos only).
```

Only `index.js`, `window.js`, `chat-view.js`, `overlay.js` and the two preloads `require('electron')`; everything else is plain Node and unit-tested. Registration functions receive `electron` pieces by injection so IPC can be tested without launching the app.

## IPC contract (renderer ⇄ main)

Every handler first checks `event.sender` is the local UI window; strangers get a denied value and cause no side effect. Payloads are validated in main.

| Channel | Kind | Purpose |
|---|---|---|
| `dock:info`, `dock:switch`, `dock:layout` | invoke | Session/mode info, switch view, report footer height (clamped 30–420 px). |
| `dock:reload-chat`, `dock:chat-home`, `dock:external-chat` | invoke | Chat controls; external opens `https://chatgpt.com/` in the default browser. |
| `pty:start` | invoke | (Re)start the Herdr client with the terminal size. |
| `pty:write`, `pty:resize` | send | Keystrokes (≤ 1 MiB, string) and size (cols 20–500, rows 5–200). |
| `clipboard:read`, `clipboard:write` | invoke | Text clipboard for the terminal (≤ 1 MiB). |
| `git:status`, `git:refs`, `git:pick-repo`, `git:set-refs` | invoke | Repository state, discovered refs + validated selection, folder picker, store refs. |
| `git:diff`, `git:show`, `git:zip`, `git:delete-zip` | invoke | The four actions. `delete-zip` takes **no path**. |
| `herdr:state`, `herdr:refresh` | invoke | Observer + selection state for the selector and diagnostics panel; refresh re-reads. Read-only. |
| `herdr:select-workspace`, `herdr:set-sync-mode` | invoke | The user's explicit workspace choice (`workspace.focus`, validated again in main) and the Auto/Manual preference. No other Herdr write exists. |
| `overlay:open-workspace-menu` | invoke (UI window only) | Asks main to show the workspace menu overlay; the anchor rectangle is validated (four finite numbers within bounds). |
| `overlay:state`, `overlay:choose`, `overlay:close` | invoke (**overlay only**) | The menu reads state, chooses a workspace (same validated selection path) and closes. Each handler refuses the other sender. |
| main → renderer | events | `dock:mode`, `dock:focus-terminal`, `pty:data`, `pty:exit`, `chat:status`, `chat:host`, `chat:error`, `herdr:state` (throttled push). |

`test/structure.test.js` pins this list: the registered channels, the preload's channels and main's emitted events must match exactly.

## Flows

**View switching.** `Ctrl+Tab` (or a tab click) → `window.js#switchMode`. The chat view is attached to / detached from the window's `contentView`; nothing is reloaded or restarted. Focus goes to the chat contents or back to the renderer (`dock:focus-terminal`). Only a fresh physical `keyDown` toggles: auto-repeat is swallowed and `keyUp` ignored, on both web contents. The footer reports its own height so the chat view's bounds always exclude it (a native view would hide any DOM overlay, so pickers open *inside* the footer).

**Terminal.** xterm.js → `pty:write` → node-pty → `herdr.exe --session <name>`; output returns by `pty:data`. Closing or reconnecting kills only the client; Herdr's server and agents survive. `HERDR_*` variables are removed from the PTY environment (otherwise Herdr refuses to nest and could attach to the outer server).

**Git action.** The renderer sends `{repoRoot, ref}`. Main re-resolves the active repository (refusing if it is not `repoRoot`), re-validates the ref (`isSafeRef` + `rev-parse --verify <ref>^{commit}`), then runs git with an argument array and the resolved SHA. Outputs are capped at 10 MB; empty or failed results never reach the clipboard.

### Git rules

- Read-only: `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff`, `core.fsmonitor=false`; no `fetch`, checkout, commit or branch changes. The only write is `git archive --output` into the artifacts folder.
- Refs: option values are full refnames (`refs/heads/x`) so a branch and tag with the same name stay distinct; names outside the safe charset use the commit SHA as value.
- Defaults: base = saved ref for this repo → `dev` → `origin/dev` → `main` → `origin/main`, else empty (never `HEAD`); revision = saved ref or `HEAD`.
- `git diff <base>` covers tracked files only; `git archive` covers files tracked in the commit only.
- ZIPs live in `<userData>\artifacts` (never in the repo) with names `dock-<repo>-<sha8>-<timestamp>-<rand>.zip`. Deletion is limited to the last generated ZIP, requires that exact naming and folder, refuses symlinks, and never clears the clipboard.
- The file clipboard uses a constant PowerShell script (`Clipboard.SetFileDropList`, STA); the path travels in an environment variable and the result is read back and verified.

## Herdr workspace integration (M01-I1 discovery, M01-I2 selector)

Herdr remains the source of truth for sessions, workspaces, panes and agents ([ADR 0001](decisions/0001-herdr-workspaces.md)); ContextDeck *reads* them, and performs exactly one write: moving the focus (`workspace.focus`) when the **user** picks a workspace in the selector.

```text
workspace-observer ──subscribe (events = signals)──┐
        │                                          ▼
        └── session.snapshot ──► workspace-reader ──► model ──► herdr:state ──► diagnostic panel
 session-locator ('herdr session list --json') ─► api-client (\\.\pipe\<socket_path>, JSON lines, read allowlist)
```

- **Transport and contract:** named pipe `\\.\pipe\<socket_path>`; allowlisted methods `ping`, `session.snapshot`, `workspace.list`, `workspace.get`; subscriptions limited to workspace/tab/pane topology and focus events. Anything else is rejected before a connection is opened. Details and captured exchanges: [validation/m01-i1.md](validation/m01-i1.md).
- **State model:** one `session.snapshot` per read, Herdr ids verbatim, directory taken from the active tab pane's cwd. `sessionFocus` is the session-wide last focus change from *any* client; it is not the workspace visible in ContextDeck's client.
- **Reconciliation:** subscribe first, read, then treat every event only as "something changed" (coalesced, debounced re-read); a 60 s heartbeat and every reconnect re-read authoritative state; reconnect backoff 1 s → 15 s. Duplicated, delayed, reordered or lost events cannot corrupt the model.
- **Active workspace:** `known` only when the session has exactly one workspace; otherwise `ambiguous` (session focus offered only as a candidate) or `unknown`. Herdr exposes no per-client focus, and TUI parsing or "last event wins" are deliberately not used.
- **Boundaries:** the observer is created in `index.js`, started after the window exists and stopped on window close and quit; the remote ChatGPT page has no path to it. `HERDR_*` is stripped from the locator's child process as for the PTY.

### Workspace selector (M01-I2)

```text
dropdown 'change' (user) ──► herdr:select-workspace ──► workspace-selection.select() ──► observer.focusWorkspace() ──► api-client (workspace.focus)
        ▲                                                       │ fresh snapshot after the command (observer.refresh)
        └── herdr:state ◄── selection state ◄── observer (events = signals, snapshots = truth)   ← TUI focus changes arrive here, never answered with a command
```

- **Single write:** `ApiClient.focusWorkspace(id)` sends only `workspace.focus` with a validated id and requires Herdr to confirm that workspace; `request()` stays on the read allowlist. Focus is session-wide in Herdr, so the command moves **every** attached client; with ContextDeck as the normal single client this is invisible.
- **State kept apart** in `workspace-selection.js`: `selected` (+origin `dock`/`herdr`/`recovery`), `pending`, `observedId` (+reliability), `unavailableId`, `mode` (`auto` default | `manual`), connection and last error. Optimistic by design: the observed focus is the last client that moved, not proof of what our client shows.
- **Loop-free by construction:** only `select()` (the user's `change` event) sends a command; observation, reconciliation, reconnect, mode changes and preference restore never do. A pending request is not overwritten by snapshots, is bound to a token and to the observer's connection `epoch`, and is dropped (never replayed) if the connection changed. Confirmation uses a snapshot that started after the command.
- **Persistence:** `ui-state.json` → `herdr: { mode, lastWorkspace: { session, workspaceId } }`; only explicit selections are stored. Startup never sends a focus command.
- **Contract additions:** `herdr:select-workspace`, `herdr:set-sync-mode`; `herdr:state` carries `selection`. Validation and results: [validation/m01-i2.md](validation/m01-i2.md).

## Persistent identifiers (do not change casually)

The product was renamed from Project Dock M00 to ContextDeck. These identifiers locate user data and **keep their M00 values**; they are defined once in `src/main/persistence/identity.js` and locked by tests:

| Identifier | Value | Holds |
|---|---|---|
| userData folder | `%APPDATA%\Project Dock M00` (pinned in `index.js` before the instance lock) | Everything below. |
| ChatGPT partition | `persist:project-dock-m00-chat` | Cookies/login, storage. |
| Preferences | `ui-state.json` | Last tab, window size, repository, per-repo refs, last ZIP. |
| Artifacts | `artifacts\` | Generated ZIPs. |
| Herdr session | `herdrSession` in the user's `config.json` | Existing Herdr session (new installs default to `contextdeck`). |

Renaming any of them would log the user out, drop preferences or orphan ZIPs. A future move to a ContextDeck-named folder requires an idempotent migration (copy once, verify, leave the old folder untouched, never delete user data) and its own decision record. `CONTEXTDECK_USER_DATA` overrides the folder for tests/harnesses only.

`ui-state.json` is forward/backward tolerant: files from M00-I1, I2 (global refs) and I3 (per-repo refs) load; unknown or invalid values are dropped, never thrown.

## Build and configuration

`npm run build` bundles `src/renderer/app.js` (xterm.js + components) and the overlay page with esbuild, inlines the style files into `styles.css` and copies the HTML pages into `dist/renderer` (git-ignored). `npm start` builds then launches `electron .` (`main` = `src/main/index.js`). `config.json` (local, git-ignored) overrides the versioned `config.example.json`; with neither valid, startup fails with a clear error.
