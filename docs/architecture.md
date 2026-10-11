# Architecture

ContextDeck is an Electron app (main process in CommonJS, local UI bundled with esbuild). It has three kinds of web content, each with a different trust level.

```text
┌────────────────────────── Electron main process (src/main) ─────────────────────────┐
│  index.js (bootstrap) ── window.js ──┬─ local UI window ──(preload bridge)── renderer │
│                                      └─ chat-view.js ── ChatGPT WebContentsView       │
│  ipc/*  ── herdr/client.js ── node-pty ── herdr.exe (client) ── Herdr server/agents  │
│        └─ git/* ── git.exe (arg arrays)   platform/* (PATH lookup, file clipboard)    │
│  persistence/* (config.json, ui-state.json, persistent identifiers)                    │
│  chat-bindings/* (chat-bindings.json: conversation ↔ workspace, M01-I3A)               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| Content | Source | Privileges |
|---|---|---|
| Local UI | `dist/renderer` (built from `src/renderer`) via `file://`, strict CSP | `contextIsolation`, sandbox, no Node; talks to main only through the `window.dock` bridge (`src/preload`). |
| Overlay (workspace menu, chat bindings panel) | `dist/renderer/overlay.html`, local, transparent view above the ChatGPT view only while open | Same isolation as the UI window; its own preload exposes the menu channels (`state`, `choose`, `close`), the five `chats:*` channels and the push listeners. |
| ChatGPT page + auth popups | `https://chatgpt.com` (HTTPS only) | `contextIsolation`, sandbox, no Node, **no preload**, persistent partition. Cannot reach any IPC channel. Only `clipboard-write` is granted to `chatgpt.com`; every other permission is denied. |
| Herdr TUI | Bytes from a PTY, rendered by xterm.js | Text only; input is forwarded as bytes to the PTY. |

## Source layout

```text
src/main/
  index.js            Bootstrap: pin userData, single-instance lock, load settings/state, wire modules.
  paths.js            Project root, preload and built-UI locations.
  window.js           Main window, mode (terminal|chat), ChatGPT view layout, focus, UI-state persistence.
  chat-view.js        ChatGPT WebContentsView: partition, permissions, navigation and popup policy.
  chat/               Experimental, off by default (CONTEXTDECK_CHAT_OBSERVER=1): passive state model/observer of the ChatGPT page (plain Node). Diagnostic only; see validation/m01-i3p.md.
                      Always available and pure: conversation-identity.js (URL → durable conversation identity) and runtime-contract.js (transient ChatRuntime contract, no consumer yet).
  chat-bindings/      model.js (schema, validation, quarantine, migrations), store.js (chat-bindings.json: atomic write, corruption policy),
                      service.js (bind/update/unbind/reassign/list/orphans/indicator; the safety rules). Plain Node, no Electron.
  web-preferences.js  The only place that defines webPreferences (isolation for every web contents).
  shortcuts.js        Ctrl+Tab decision (pure) and the before-input-event handler.
  herdr/              client.js (PTY client lifecycle), env.js (strips HERDR_* from the PTY env);
                      api-client.js (named-pipe API client: read allowlist + workspace.focus), session-locator.js,
                      workspace-reader.js (snapshot normalizer + active-workspace identification),
                      workspace-observer.js, workspace-selection.js (selector state and focus sync).
  git/                core.js (safe exec, repo/ref validation, diff/show/archive), refs.js (discovery and
                      selection), context.js (active repo + per-repo prefs), actions.js (copy/zip/delete),
                      artifacts.js (ZIP naming and guarded deletion).
  ipc/                index.js + dock.js, terminal.js, clipboard.js, git.js, herdr.js, overlay.js, chats.js (channel registration by domain; chats.js also holds the state pusher).
  persistence/        settings.js (config), ui-state.js (preferences), identity.js (persistent identifiers).
  platform/           executable.js (PATH/PATHEXT lookup), file-clipboard.js (CF_HDROP via PowerShell STA).
src/preload/index.js  contextBridge API of the UI window (`window.dock`); overlay.js: the smaller bridge of the menu overlay.
src/renderer/         index.html, app.js (entry), components/ (header, terminal-view, workspace-selector, chat-link, git-panel,
                      herdr-panel, herdr-store, feedback, dom), overlay/ (overlay.js menu, chats-panel.js bindings panel), styles/ (tokens,
                      base, layout, components). See design-system.md.
src/shared/           Pure view-models used by the UI and the overlay (workspace-view.js, chat-bindings-view.js).
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
| `overlay:open-workspace-menu`, `overlay:open-chats-panel` | invoke (UI window only) | Asks main to show the workspace menu / the chat bindings panel in the overlay; the anchor rectangle is validated (four finite numbers within bounds). |
| `chats:state` | invoke (UI window **or** overlay) | Compact binding state: store status, Herdr connection, selected workspace (+origin), workspaces, all bindings with their status, and the indicator state of the page currently loaded (computed by main from the view's URL). |
| `chats:bind`, `chats:update`, `chats:unbind`, `chats:reassign` | invoke (UI window or overlay) | The binding operations. Arguments are picked field by field in main; "bind current" reads the address from the ChatGPT view itself. Rules in *Chat bindings* below. No path, command or Herdr method can be passed. |
| `overlay:state`, `overlay:choose`, `overlay:close` | invoke (**overlay only**) | The menu reads state, chooses a workspace (same validated selection path) and closes. Each handler refuses the other sender. |
| main → renderer | events | `dock:mode`, `dock:focus-terminal`, `pty:data`, `pty:exit`, `chat:status`, `chat:host`, `chat:error`, `herdr:state` (throttled push), `chats:state` (throttled, only when the content changed), `overlay:closed` (carries which overlay mode closed), and to the overlay `overlay:open`, `overlay:state-push`, `overlay:chats-push`. |

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

## Chat bindings (M01-I3A)

Decision record: [0002](decisions/0002-chat-bindings.md). Results and manual script: [validation/m01-i3a.md](validation/m01-i3a.md).

```text
top-bar indicator (chat-link) ──click──► overlay:open-chats-panel ──► overlay (mode 'chats') ──► chats:bind|update|unbind|reassign|state
                                                                                                   │ (validated in main, sender = UI window or overlay)
ChatGPT view ──getURL() (main reads it)──► chat-bindings/service ◄── observer (Herdr workspaces)    ▼
                                                    │  ◄── selection (selected + origin + pending)  chat-bindings.json (atomic)
                                                    └──► chats:state push (changed content only) ──► indicator + panel
```

**Entities.** `ChatBinding` = `{ bindingId, conversationKey, url, label, role, origin, workspaceIdentity: { session, workspaceId }, createdAt, updatedAt }`. `role` ∈ `general | architecture | review | planning` is organisational metadata, never sent anywhere. `WorkspaceChatContext` = the bindings sharing a `workspaceIdentity`, plus a recovery record per workspace (`contexts["<session>/<workspaceId>"]`: last seen label, directory). `ChatRuntime` is only a contract ([chat/runtime-contract.js](../src/main/chat/runtime-contract.js)).

**Invariants** (enforced on write and re-checked on load; a violating entry is quarantined, not dropped): `bindingId` unique; `conversationKey` unique across the file (one workspace per conversation); the stored URL parses to exactly the stored key; `role` in the list; label ≤ 80 chars without control characters; ≤ 300 bindings, ≤ 40 per workspace. The file holds no message, prompt, draft, cookie, token nor transient state (`generation`/`draft`/`attention` are never persisted).

**Conversation identity** ([conversation-identity.js](../src/main/chat/conversation-identity.js)): https, host exactly `chatgpt.com`, no credentials/port; `/c/<uuid>` and `/g/<project>/c/<uuid>` → key `c:<uuid>` (id lower-cased; the project route is kept in the URL but is not part of the identity); `/`, a project's home → *identity pending* (cannot be bound; the message says it must acquire an id first); other paths → not a conversation; query/fragment dropped. Titles, DOM and the I3P diagnostic hashes are never used.

**Workspace (context) identity.** `session` (name) + Herdr `workspaceId`. Status of a binding, computed against the live model on every read: `linked`, `suspect` (id present, label **and** directory differ from the recorded ones), `orphan` (this session, Herdr connected, id gone), `unverified` (Herdr disconnected), `other-session` (kept, never judged). Renaming a workspace does not change its identity; the record is refreshed while it stays `linked`. Removing a workspace never deletes its bindings.

**Write guard** (service.js, identical for `bind` and `reassign`): Herdr connected → session matches → no switch pending → `selectedAtOpen` equals the current selection (else `context_changed`, nothing written) → workspace exists → destination is explicit (single workspace, or selected with origin `dock`) or `confirmTarget: true` (else `confirmation_required`). Then duplicates (`already_bound`), conflicts (`conflict`, resolved only by `reassign` + `confirmReassign: true`) and limits. The service has no write access to Herdr and no handle on the chat view; it only reads the observer and the selection state.

**Persistence** ([store.js](../src/main/chat-bindings/store.js)): schema 1; temp file + rename; load statuses `missing | ok | recovered | unsupported | unreadable` (the last two are read-only so an old build cannot clobber data it does not understand); migrations are a table `n → n+1` with a `.bak-v<n>` copy first (empty today). Failure to write leaves memory and disk unchanged and is reported.

**Indicator** (`describeCurrent`): `bound-here` (bound to the selected workspace), `bound-elsewhere`, `unbound`, `unknown` (new chat, non-conversation page, no page). It never navigates, selects or focuses anything.

**Future interface with the runtime (M01-I3B).** A runtime provider exposes `getRuntime(bindingId)` and `subscribe(listener)`; a runtime is *looked up by binding id* and never embedded in or written to a binding. The binding exposes what a runtime manager needs to start from: `bindingId`, `url`, `conversationKey`, `workspaceIdentity`, `role`. Last-selected-conversation per workspace, runtime-per-binding, indicators and several views are I3B/I3C and are deliberately absent.

## Persistent identifiers (do not change casually)

The product was renamed from Project Dock M00 to ContextDeck. These identifiers locate user data and **keep their M00 values**; they are defined once in `src/main/persistence/identity.js` and locked by tests:

| Identifier | Value | Holds |
|---|---|---|
| userData folder | `%APPDATA%\Project Dock M00` (pinned in `index.js` before the instance lock) | Everything below. |
| ChatGPT partition | `persist:project-dock-m00-chat` | Cookies/login, storage. |
| Preferences | `ui-state.json` | Last tab, window size, repository, per-repo refs, last ZIP. |
| Artifacts | `artifacts\` | Generated ZIPs. |
| Herdr session | `herdrSession` in the user's `config.json` | Existing Herdr session (new installs default to `contextdeck`). |
| Chat bindings | `chat-bindings.json` (added in M01-I3A, new file; nothing existing was renamed) | Conversation ↔ workspace associations. Corrupt copies are kept as `chat-bindings.json.corrupt-<time>`, pre-migration copies as `.bak-v<n>`. |

Renaming any of them would log the user out, drop preferences or orphan ZIPs. A future move to a ContextDeck-named folder requires an idempotent migration (copy once, verify, leave the old folder untouched, never delete user data) and its own decision record. `CONTEXTDECK_USER_DATA` overrides the folder for tests/harnesses only.

`ui-state.json` is forward/backward tolerant: files from M00-I1, I2 (global refs) and I3 (per-repo refs) load; unknown or invalid values are dropped, never thrown.

## Build and configuration

`npm run build` bundles `src/renderer/app.js` (xterm.js + components) and the overlay page with esbuild, inlines the style files into `styles.css` and copies the HTML pages into `dist/renderer` (git-ignored). `npm start` builds then launches `electron .` (`main` = `src/main/index.js`). `config.json` (local, git-ignored) overrides the versioned `config.example.json`; with neither valid, startup fails with a clear error.
