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
  herdr/              client.js (PTY client lifecycle), env.js (strips HERDR_* from the PTY env).
  git/                core.js (safe exec, repo/ref validation, diff/show/archive), refs.js (discovery and
                      selection), context.js (active repo + per-repo prefs), actions.js (copy/zip/delete),
                      artifacts.js (ZIP naming and guarded deletion).
  ipc/                index.js + dock.js, terminal.js, clipboard.js, git.js (channel registration by domain).
  persistence/        settings.js (config), ui-state.js (preferences), identity.js (persistent identifiers).
  platform/           executable.js (PATH/PATHEXT lookup), file-clipboard.js (CF_HDROP via PowerShell STA).
src/preload/index.js  contextBridge API (`window.dock`).
src/renderer/         index.html, terminal.js (xterm + tabs), git-panel.js (footer pickers), styles.css.
scripts/build.js      esbuild bundle + copy to dist/renderer.
test/                 node:test suites (no real repositories; temp repos only).
```

Only `index.js`, `window.js`, `chat-view.js` and the preload `require('electron')`; everything else is plain Node and unit-tested. Registration functions receive `electron` pieces by injection so IPC can be tested without launching the app.

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
| main → renderer | events | `dock:mode`, `dock:focus-terminal`, `pty:data`, `pty:exit`, `chat:status`, `chat:host`, `chat:error`. |

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

`npm run build` bundles `src/renderer/terminal.js` (xterm.js + CSS) with esbuild and copies `index.html`/`styles.css` to `dist/renderer` (git-ignored). `npm start` builds then launches `electron .` (`main` = `src/main/index.js`). `config.json` (local, git-ignored) overrides the versioned `config.example.json`; with neither valid, startup fails with a clear error.
