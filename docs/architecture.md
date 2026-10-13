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
| ChatGPT pages (one per loaded conversation) + auth popups | `https://chatgpt.com` (HTTPS only) | `contextIsolation`, sandbox, no Node, **no preload**, the one persistent partition (shared by every view). Cannot reach any IPC channel. Only `clipboard-write` is granted to `chatgpt.com`; every other permission is denied. |
| Herdr TUI | Bytes from a PTY, rendered by xterm.js | Text only; input is forwarded as bytes to the PTY. |

## Source layout

```text
src/main/
  index.js            Bootstrap: pin userData, single-instance lock, load settings/state, wire modules.
  paths.js            Project root, preload and built-UI locations.
  window.js           Main window, mode (terminal|chat), ChatGPT view layout, focus, UI-state persistence.
  chat-view.js        ChatGPT WebContentsView: partition, permissions, navigation and popup policy.
  chat/               The I3P detector, state model and observer of ONE page (plain Node), now used for the per-view status (see *Conversation status and activity*); diagnostics log only with CONTEXTDECK_CHAT_OBSERVER=1. See validation/m01-i3p.md.
                      Always available and pure: conversation-identity.js (URL → durable conversation identity) and runtime-contract.js (transient ChatRuntime contract, no consumer yet).
  activity/           notices.js (in-app activity notices: one per view, ttl, retained while attention is pending), direct-open.js (open a conversation of any workspace through the explicit selection). Plain Node.
  chat-views/         observation.js (one status observer per loaded view, summaries, attention/visits, expiry sweep), manager.js (the ChatGPT views: lazy creation, one attached, destroyed only at shutdown), navigator.js (which view for which workspace;
                      reconcile, explicit selection, temporary conversations, runtime provider). Plain Node, injected view factory and host.
  window-metrics.js   Vertical layout shared by the window and the stylesheet (top bar + conversation strip).
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
  ipc/                index.js + dock.js, terminal.js, clipboard.js, git.js, herdr.js, overlay.js, chats.js, chatnav.js, activity.js (channel registration by domain; chats.js/chatnav.js also hold the state pushers).
  persistence/        settings.js (config), ui-state.js (preferences), identity.js (persistent identifiers).
  platform/           executable.js (PATH/PATHEXT lookup), file-clipboard.js (CF_HDROP via PowerShell STA).
src/preload/index.js  contextBridge API of the UI window (`window.dock`); overlay.js: the smaller bridge of the menu overlay.
src/renderer/         index.html, app.js (entry), components/ (header, terminal-view, workspace-selector, chat-link, git-panel,
                      herdr-panel, herdr-store, chat-strip, activity-indicator, feedback, dom), overlay/ (overlay.js menu, chats-panel.js bindings panel, activity-center.js center and notices), styles/ (tokens,
                      base, layout, components). See design-system.md.
src/shared/           Pure view-models used by the UI and the overlay (workspace-view.js, chat-bindings-view.js, chat-nav-view.js, activity-view.js).
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
| `chatnav:state`, `chatnav:select`, `chatnav:select-temporary`, `chatnav:new`, `chatnav:open-unscoped` | invoke (**UI window only**) | Conversation navigation (see *Multi-view conversation navigation*). Ids only: main opens the stored binding address; stale or unverified requests are refused. Never moves Herdr's focus. |
| `activity:state` | invoke (UI window **or** overlay) | `{ global, notices }`: totals, groups by workspace (name + id) with conversation states, and the notices to show. Derived; nothing is observed or loaded for it. |
| `activity:open`, `activity:dismiss` | invoke (**overlay only**) | The activity center's "Abrir" (direct navigation, see *Global activity*) and closing a notice card (never acknowledges attention). |
| `overlay:open-activity-center` | invoke (UI window only) | Opens the activity center under the top-bar indicator (anchor validated). |
| `chats:state` | invoke (UI window **or** overlay) | Compact binding state: store status, Herdr connection, selected workspace (+origin), workspaces, all bindings with their status, and the indicator state of the page currently loaded (computed by main from the view's URL). |
| `chats:bind`, `chats:update`, `chats:unbind`, `chats:reassign` | invoke (UI window or overlay) | The binding operations. Arguments are picked field by field in main; "bind current" reads the address from the ChatGPT view itself. Rules in *Chat bindings* below. No path, command or Herdr method can be passed. |
| `overlay:state`, `overlay:choose`, `overlay:close` | invoke (**overlay only**) | The menu reads state, chooses a workspace (same validated selection path) and closes. Each handler refuses the other sender. |
| main → renderer | events | `dock:mode`, `dock:focus-terminal`, `pty:data`, `pty:exit`, `chat:status`, `chat:host`, `chat:error`, `herdr:state` (throttled push), `chats:state`, `chatnav:state`, `activity:state` and `herdr:state` (throttled, only when the content changed; `herdr:state` also carries `activity`, the per-workspace counts), `overlay:closed` (carries which overlay mode closed), and to the overlay `overlay:open`, `overlay:state-push`, `overlay:chats-push`, `overlay:activity-push`. |

`test/structure.test.js` pins this list: the registered channels, the preload's channels and main's emitted events must match exactly.

## Flows

**View switching.** `Ctrl+Tab` (or a tab click) → `window.js#switchMode`. The visible ChatGPT view (chosen by the navigator, see *Multi-view conversation navigation*) is attached to / detached from the window's `contentView`; nothing is reloaded or restarted. Focus goes to the chat contents or back to the renderer (`dock:focus-terminal`). Only a fresh physical `keyDown` toggles: auto-repeat is swallowed and `keyUp` ignored, on both web contents. The footer reports its own height and `window-metrics.js` gives the top offset (top bar + conversation strip), so the chat view's bounds always exclude them (a native view would hide any DOM overlay, so pickers open *inside* the footer).

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

**Write guard** (service.js, identical for `bind` and `reassign`): Herdr connected → session matches → no switch pending → `selectedAtOpen` equals the current selection (else `context_changed`, nothing written) → workspace exists → destination is explicit (single workspace, selected with origin `dock`, `targetChosen: true` or the legacy `confirmTarget: true`; else `confirmation_required`). `targetChosen` (M01-I3B-3) means only "the user picked this workspace in the form"; it replaces the old checkbox and satisfies **only** the estimate rule — session, connection, pending switch, `selectedAtOpen`, workspace existence, conflicts, limits and the suspect rule all still run. `bind` into a workspace that has a `suspect` binding is refused (`workspace_suspect`): writing there would rewrite its recovery record; the user re-confirms by `reassign`. New bindings carry no `role` (the fixed category was removed from the UI and the IPC; stored values are still validated, kept and ignored). Then duplicates (`already_bound`), conflicts (`conflict`, resolved only by `reassign` + `confirmReassign: true`) and limits. The service has no write access to Herdr and no handle on the chat view; it only reads the observer and the selection state.

**Persistence** ([store.js](../src/main/chat-bindings/store.js)): schema 1; temp file + rename; load statuses `missing | ok | recovered | unsupported | unreadable` (the last two are read-only so an old build cannot clobber data it does not understand); migrations are a table `n → n+1` with a `.bak-v<n>` copy first (empty today). Failure to write leaves memory and disk unchanged and is reported.

**Indicator** (`describeCurrent`): `bound-here` (bound to the selected workspace), `bound-elsewhere`, `unbound`, `unknown` (new chat, non-conversation page, no page). It never navigates, selects or focuses anything.

**Future interface with the runtime (M01-I3B).** A runtime provider exposes `getRuntime(bindingId)` and `subscribe(listener)`; a runtime is *looked up by binding id* and never embedded in or written to a binding. The binding exposes what a runtime manager needs to start from: `bindingId`, `url`, `conversationKey`, `workspaceIdentity`, `role`. Last-selected-conversation per workspace, runtime-per-binding, indicators and several views are I3B/I3C and are deliberately absent.

## Multi-view conversation navigation (M01-I3B-1)

Decision record: [0003](decisions/0003-multi-view-navigation.md). Results, measurements and manual script: [validation/m01-i3b-1.md](validation/m01-i3b-1.md).

```text
selection (workspace, origin, pending) ──┐
bindings (I3A: status per binding) ──────┼──► ChatNavigator.reconcile() ──► ChatViewManager ──host.attach/detach──► window (one view attached)
prefs.chat.last[workspace] (ui-state) ───┘        ▲  explicit actions: select / new / temporary   │ createView() (chat-view.js, one partition)
                                                  │  (chatnav:* from the UI window, validated)    └ events: navigation-started, navigated, loaded, load-failed, process-gone, destroyed
```

**Manager** ([chat-views/manager.js](../src/main/chat-views/manager.js)). Entries `{ id, handle, scope, expectedKey, identity, epoch, page, loadSeq, pristine }`. `create()` loads an address once; `show(id)`/`hide()` change the logical visible view; `setAttached()` is the chat tab appearing/disappearing (the logical view is kept); the only attached view is detached *before* the next one is attached. `findByKey(key)` finds the view that **shows** a conversation (identity), preferring the one opened for it; `duplicates()` reports two views on one conversation (both are kept). Page events carry no authority: a `loaded` for an older request, an aborted navigation (`ERR_ABORTED`) or anything after `destroyed` is ignored. A view is closed in exactly two places: `destroyAll()` (window `closed`) and `suspend()` (the user's explicit request, M01-I3C-1H, see below). No pool, eviction or *automatic* suspension exists (test-enforced); the explicit destruction-confirmation timeout exists only during a user's request.

**Relation** (derived from identity, never stored): `match`, `loading`, `diverged` (a different durable conversation: the user navigated inside ChatGPT), `left` (a page without a durable id), `temporary`, `acquired` (a temporary view that received an address; *not* bound).

**Navigator** ([chat-views/navigator.js](../src/main/chat-views/navigator.js)). `reconcile()` runs on selection, observer, binding and view changes and on tab changes; it is idempotent and synchronous. It (1) syncs views with bindings (a view whose binding vanished becomes temporary; one whose binding moved follows it only while it still shows that conversation; a temporary view showing a conversation bound in its own scope becomes that binding's view), (2) keeps the visible view if it is scoped to the selected workspace, otherwise (3) detaches it and chooses the explicit in-session pick, else the persisted last conversation if its binding is `linked`, creating a view only when the chat tab is showing and no switch is pending, else (4) shows the empty state. With no workspace selected it shows the unscoped M00 page. User actions (`selectBinding`, `newConversation`, `selectTemporary`, `openUnscoped`) name the workspace they were rendered for and fail with `context_changed` / `selection_pending` / `confirmation_required` / `not_in_workspace` without side effects.

**State pushed to the UI** (`chatnav:state`): workspace, `tabs` (bindings of that workspace: label, role, status, hint for homonyms, loaded/loading/failed, active, needsConfirm), `temporaries` (views opened under it: label from identity, warning), `empty` (`no-workspace | no-conversations | select-conversation | not-verified`), `duplicates`. A tab is *active* when the visible view **shows** that conversation, so a page that navigated elsewhere never keeps highlighting its old tab.

**Window.** `window.js` provides `host` (add/remove the child view, reset bounds, raise an open overlay) and lays the attached view out below the top bar and the conversation strip (`window-metrics.js` pins 52 + 34 px to `--topbar-h` / `--chatbar-h`). Terminal tab: the navigator is told the mode first, nothing is created, the view is detached. Chat tab: the right view is chosen *before* it is attached.

**UI.** `chat-strip.js` renders the strip (`role=tablist`, roving tabindex, arrows/Home/End; spinner inside a tab while loading; the first click on an unverified conversation arms it, the second opens it), the `+` button, **Gerenciar** (opens the I3A panel) and the empty state that replaces the chat when no view is attached.

**IPC (UI window only).** `chatnav:state`, `chatnav:select`, `chatnav:select-temporary`, `chatnav:new`, `chatnav:open-unscoped`; push `chatnav:state`. They take ids, never addresses; main opens the stored URL. The overlay and the remote page cannot call them.

**Persistence.** `ui-state.json` → `chat: { last: { "<session>/<workspaceId>": "<bindingId>" } }` (explicit choices only; ids validated; ≤100; older files load with `{}`).

## Conversation status and activity (M01-I3B-2)

Decision record: [0003](decisions/0003-multi-view-navigation.md) (amended). Results, measurements and manual script: [validation/m01-i3b-2.md](validation/m01-i3b-2.md).

```text
view created ──► manager.onChange ──► ObservationHub.sync() ──► startChatObservation(handle.contents, status:true)   one I3P observer per view
                                                              │  (detector probe + state model, unchanged; first poll staggered)
observer onChange (only on meaningful change) ──► hub.refresh(view) ──► signature changed? ──► navigator.emit() ──► chatnav:state (+ herdr:state.activity)
window: focus / blur / minimize / restore ──► hub.setInteractive()      user visit: tab click, chat tab shown, window focus, typing in the page ──► hub.visit()
```

**Contract per view** (`hub.summaryOf(viewId)`, fed by the I3P model through `runtime-contract.fromObserverState`):

| Field | Values | Notes |
|---|---|---|
| `phase` (PageLifecycle) | loading, ready, error, destroyed | from navigation events |
| `generation` (GenerationState) | unknown, idle, responding, ended-unclassified, completed, interrupted, error | `responding` is **observed** (stop control); `ended-unclassified` is the real-world end signal; `completed`/`interrupted`/`error` only with their own corroborating signal (inferred) and never derived from `ended-unclassified` |
| `draft` (DraftState) | unknown, empty, present | presence only, computed inside the probe; the text never leaves the page |
| `attention` (AttentionState) | none, pending | independent of the other two |
| `identityKey` / `identityOk` | `c:<uuid>` / bool | the observer's identity (by conversation id, so `/c/<id>` and `/g/<project>/c/<id>` are one) must equal the manager's, or everything degrades to unknown |
| `evidence`, `observedAt`, `stale` | observed / inferred / unknown, last probe answer, reading expired | readings expire `ttl` (20 s) after the last answer |

**One observer per loaded view.** Created when the manager has the view, stopped when it is gone; keyed by view id (never twice); no view is created, loaded, attached or reloaded to observe it; a conversation that was never opened has no observer and no indicator (it is *not* reported idle). The first polls are spread (`phaseMs`), a probe that never answers times out after 5 s (the chain continues), a single shared sweep timer lets expired readings show as unknown, and nothing is sent to the UI unless a view's summary signature changed. `CONTEXTDECK_CHAT_STATUS=0` turns the status observers off (the app then behaves exactly as in M01-I3B-1); `CONTEXTDECK_CHAT_OBSERVER=1` additionally writes the sanitized diagnostics log, tagged by view.

**Attention policy.** `pending` is set by the model when a response that was observed `responding` stops being observed while the view is not **user-visible** (attached, chat tab showing, window not minimized, shown and focused). It means *activity that must be reviewed*, not *it finished successfully*. It is not set by lost probes, reloads, identity changes, destroyed views or expired readings. It is cleared only by a **visit**: an explicit user action that shows the view (tab click, new conversation, selecting it), the chat tab or the window becoming interactive with the view on screen, or typing into it — and only while the view is user-visible. A workspace selection, an automatic restore, creating or pre-loading a view, or a state push never clears it. A visit means "the user could see it", not "the user read it".

**Identity.** Navigating A → B inside a view resets what was learned (the model's epoch rule) and the tab of A shows nothing about that page; B's tab shows B's state only after B is observed; a stale probe answer in flight is discarded by epoch. A new chat that gets its address *while responding* keeps its state (same conversation) and is not bound. A redirect away from the conversation leaves the placeholder tab without status.

**Interface.** Each tab has a fixed-size status slot (always present, `aria-hidden`; the tab gets an accessible name and a tooltip with the same information): a ring spinner for responding (the only animation, disabled by `prefers-reduced-motion`), `●` for attention, `✎` for a draft, a dashed `?` for unknown (only for a loaded, probed view whose signals are unusable). The workspace selector shows `↻n ●m` for the *other* workspaces next to its label, and each row of the workspace menu shows the same for its workspace; a workspace with no loaded conversation has no badge. Counts are derived (`navigator.getWorkspaceActivity()`), never persisted, and ride on the Herdr state the selector already receives.

### Generation reliability (M01-I3B-2R)

Details, diagnosis and results: [validation/m01-i3b-2r.md](validation/m01-i3b-2r.md). Rule: **the temporary absence of a signal is not proof of an ending.** Only the strong stop signal (in the composer) starts `responding`; `stopWide` (a stop-labelled control anywhere), a bounded `busy` flag and *unusable* observations (composer missing, probe failed or timed out) only **sustain** it, flagged `uncertain` in the summary. A response ends only after `END_CONFIRMATIONS` (3) consecutive observations of "composer ready, no stop control anywhere, nothing busy"; `UNUSABLE_LIMIT` (20) observations of nothing usable drop the claim to `unknown` (never to an ending, never to attention). `ended-unclassified` is still never `completed`. Attention follows only a sustained ending. Diagnostic mode logs signals, counters, reason and observation spacing per transition.

## Global activity (M01-I3B-2H)

Decision record: [0003](decisions/0003-multi-view-navigation.md) (second amendment). Results, measurements and manual script: [validation/m01-i3b-2h.md](validation/m01-i3b-2h.md).

```text
observation hub (one I3P observer per loaded view) ──summaries──► navigator.getGlobalActivity()   projection of the SAME summaries, all workspaces
        │ onAttention (none→pending, once)                              │ totals + groups (workspace name+id → conversations → states)
        ▼                                                               ▼
 notices controller (≤3 cards, ttl, one timer) ──► activity pusher ──► UI window `activity:state`  ──► top-bar indicator (Terminal and ChatGPT tabs)
        │                                                  └────────► overlay `overlay:activity-push` ──► notice cards / activity center
        └─► window.setNotices(n) ─► overlay.showNotice(rect)  (the SAME overlay view, small rectangle, never focused)

activity center "Abrir" ──► activity:open ──► directOpen.open(): resolve target ─► (other workspace?) selection.select() ─► check ─► chat tab ─► navigator.selectBinding()  (= the visit)
```

**No second source of truth.** Everything is derived on demand from the hub's per-view summaries (`getGlobalActivity()`); nothing is stored, nothing is observed or loaded because the center is open, and a conversation that was never loaded is simply absent. Totals (`responding`, `attention`, `drafts`, `observed`, `loaded`) cover every loaded view of every workspace (plus the unscoped page); groups only list conversations that have something to say, each with `viewId`, `bindingId`, `kind` (`binding` | `temporary`), label, states, binding status and whether it can be opened.

**Indicator.** `#activity-indicator` in the top bar (after the workspace selector, before the contextual actions), outside the tab-specific blocks, so it exists on the Terminal and the ChatGPT tab. `↻n ●m ✎k` (spinner ring, dot, pencil; numbers; accessible name and tooltip say what is observed: "N conversas observadas de M carregadas"); neutral `○ Atividade` when quiet; fixed minimum width (96 px; 52 px below 1000 px, where the label is dropped); the DOM is rebuilt only when the displayed content changes.

**Activity center.** A third page mode of the overlay (`kind: 'activity'`): modal, opens under the indicator from either tab, closes with Esc or a click outside (the scrim), arrows/Home/End move between the "Abrir" buttons. Groups carry workspace name **and id** so homonyms are told apart; items state their condition in words ("Respondendo", "Atividade para revisar", "Rascunho não enviado"); updates are re-rendered in place keeping the focused button.

**Direct navigation** ([activity/direct-open.js](../src/main/activity/direct-open.js)). The user's explicit action only. (1) The target is resolved against the current state (the binding exists in that workspace; orphans/other sessions never open; suspect/unverified need `confirm`, asked *before* anything is sent). (2) If another workspace is selected: the existing explicit selection (`selection.select` → `workspace.focus`, validated by the M01-I2 controller, honouring Auto/Manual); a failure stops here — the chat tab is not shown, no conversation is selected, the message says so. (3) The latest request wins; a refused or late one changes nothing; after the switch the selected workspace must equal the target (Auto may have followed another focus: `context_changed`). (4) The chat tab is shown and `navigator.selectBinding()` selects the conversation: it reuses the loaded view, never reloads, never creates a binding, and is the *same visit* that acknowledges attention (no second rule). Two systems are involved, so atomicity is not pretended: a partial outcome (workspace changed, conversation not opened) is reported as such.

**Notices.** The hub emits an event only for a NEW `none → pending` attention on a valid, ready view (a view already pending when first seen is a baseline; reload, timeout, identity change, expiry and startup never emit). The notice controller keeps one card per view, newest first, at most three shown (the rest counted), a shared timer (8 s), and retires a card when its attention is acknowledged. The cards live in the overlay view laid out as a small rectangle at the top right (outside it everything keeps receiving input), added on top and **never focused**, shown only while the window is interactive and no modal owns the overlay (then they remain in the center). Closing or expiring a card never acknowledges attention. Wording: **"Atividade para revisar"**, never "concluída".

**IPC** (new, named): `activity:state` (UI window or overlay), `activity:open` and `activity:dismiss` (overlay only), `overlay:open-activity-center` (UI window only); pushes `activity:state` (UI) and `overlay:activity-push`. Arguments are ids validated in main (exactly one of `bindingId`/`viewId`); no address, path, command or Herdr method can be passed.

## View lifecycle and resource management (M01-I3C-1H)

Decision: [0005](decisions/0005-view-lifecycle.md). Results, measurements, limits and manual script: [validation/m01-i3c-1.md](validation/m01-i3c-1.md).

```text
navigator.lifecycleFacts(view) ──► lifecycle.blockers(facts)  (pure; [] = eligible)      describe / inventory / summary / byBinding  (reads)
UI: "Suspender conversa" ──chats:suspend──► lifecycle.suspend: judge → fresh status + unsent-state check → judge → manager.suspend(view, url)
                                                    manager: SUSPENDING → destroy request → confirmed destroyed → suspended record
                                                    destroy failure/timeout: entry remains managed and retryable
                                                    manager.suspended: conversationKey → { id, url, at }   (memory only)
select a suspended tab / open a suspended residual ──► viewFor() / openUnbound() ──► manager.create() (consumes the record; page `loading` = restoring)
```

- **No second source of truth.** The binding says what a conversation is; a suspended conversation is one without a page. The only addition is the manager's in-memory record, dropped when the conversation has a page again or at shutdown. Nothing about activity is persisted; `ChatBinding`, `ProjectBinding`, `ui-state.json` and the Chromium session are untouched.
- **States** are derived, not stored: `created`, `restoring`, `active`, `background`, `suspended`. Kinds: `binding`, `residual`, `temporary`, `pristine`.
- **Judgement** (`chat-views/lifecycle.js#blockers`) is a closed list of reasons; unknown / stale / unreadable always blocks suspension. Unknown attachment state keeps the view ineligible. If it is the only blocker, the UI offers **Verificar e suspender**; main still requires a fresh `empty` result. Current ChatGPT DOM has no authenticated validated signal that proves absence, so real views remain unsuspendable. A populated file input or visible progress bar inside the selected composer form proves pending work; the probe never reads file names or contents.
- **Recovery.** Only conversations with a persistent ChatBinding may be suspended. Residual unbound pages stay alive because the only in-memory recovery record is lost on application restart. Suspension uses `ACTIVE → SUSPENDING → SUSPENDED` only after native destruction is observed; an exception or timeout with a live handle restores `ACTIVE` and returns an explained refusal.
- **Unexpected destruction.** The `destroyed` event removes the manager entry immediately, detaches it if needed, and causes observers and navigator bookkeeping to clean up. Durable bindings remain the recovery source.
- **UI.** *Gerenciar* rows show the reason or the button, the strip marks suspended tabs distinctly, and the exceptional list keeps residuals available to open. Words: `shared/lifecycle-view.js`.
- **IPC.** One channel, `chats:suspend` (UI window and overlay): `{ bindingId }` or `{ viewId }`, validated, no address, no Herdr. `chats:state` carries `lifecycle: { bindingId: { state, eligible, reasons } }`; `chatnav:state` tabs carry `suspended` / `lifecycle`; global totals carry `suspended`.
- **Diagnostics.** `chat-views/resource-report.js` (pure) + `window.getResourceReport()`: processes joined with the views that run in them, shared processes marked, never divided; built on demand only. `CONTEXTDECK_LIFECYCLE_LOG=1` appends lifecycle events with a snapshot to `diagnostics\lifecycle.jsonl`. `CONTEXTDECK_COMPOSER_TRACE=1` records allowlisted composer structure, eligibility reasons and origin-only navigation decisions to `diagnostics\composer-trace.jsonl` using the existing observer poll. Harness: `test/electron/lifecycle-harness.js`.

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

`ui-state.json` also holds `chat.last` (last explicit conversation per workspace, ids only) since M01-I3B-1. It is forward/backward tolerant: files from M00-I1, I2 (global refs) and I3 (per-repo refs) load; unknown or invalid values are dropped, never thrown.

## Build and configuration

`npm run build` bundles `src/renderer/app.js` (xterm.js + components) and the overlay page with esbuild, inlines the style files into `styles.css` and copies the HTML pages into `dist/renderer` (git-ignored). `npm start` builds then launches `electron .` (`main` = `src/main/index.js`). `config.json` (local, git-ignored) overrides the versioned `config.example.json`; with neither valid, startup fails with a clear error.

## Project bindings (M01-I3B-3, experimental)

Decision: [0004](decisions/0004-project-bindings.md). `ProjectBinding` (workspace -> ChatGPT Project, `project-bindings.json`, [project-bindings/](../src/main/project-bindings/)) is separate from `ChatBinding`; neither implies the other. `chat/project-identity.js` is a strict, **unvalidated** URL parser (Project id = `g-p-` + 32 hex). `project-bindings/service.js` reuses the chat service's `verifyTarget` and `judge` (one implementation of the destination and recovery rules). `project-bindings/creation.js` holds the transient creation intent (workspace, Project record, view) and binds only through `bindings.bind` when every condition holds; the navigator only gained `newConversation({ entryUrl })` (main-supplied) and a read-only `viewInfo`. Everything is wired in `index.js` only when `CONTEXTDECK_PROJECTS=1`. Channels `projects:link` / `projects:unlink` (UI window and overlay): the address of the "current Project" is read by main from the view.

**Unbound conversations (M01-I3B-3, block 1).** "Sem workspace" is a projection of the views with `scope: null` (not a registry): `navigator.getUnbound()`, shown in the activity center with `activity:open-unbound` / `activity:bind-unbound` / `activity:new-unbound` (overlay only, `activity/unbound.js`). Opening never moves Herdr or binds; binding goes through the I3A `bind` with `targetChosen`, which only satisfies the "estimate" rule (all other checks run; binding into a `suspect` workspace is refused with `workspace_suspect`). Not persisted: an unbound conversation lives for the session only.

**Workspace-first association (M01-I3B-3, supersedes the "Sem workspace" box).** `chat-bindings/context-adoption.js` binds a conversation shown by a page that lives in a workspace to THAT workspace (`ChatBindingsService.adopt`, origin `context`), for pages the user is looking at or a creation started in that workspace; passive events never bind; a conversation bound elsewhere is a conflict (banner: go / transfer / back; `chatnav:resolve`). The navigator only reports facts (`contextViews`, `conflict`, `pending`) and never writes bindings. Pages that live in no workspace remain only as an exceptional list. See validation/m01-i3b-3.md.
