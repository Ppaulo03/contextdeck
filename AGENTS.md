# AGENTS.md — ContextDeck

Standing instructions for development agents (Claude Code, Codex, etc.). They complement the user's global `AGENTS.md`; this file is the project-level source of truth. Human-oriented docs: [README.md](README.md), [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md).

## What this is

Windows Electron app: Herdr (xterm.js + node-pty) and ChatGPT Web (isolated `WebContentsView`) in one window, plus read-only Git tools. M00 is homologated; M01-I3B-2 and I3B-3 are homologated; I3C-1 is implemented pending authenticated manual homologation; I3C-1H hardens explicit suspension. See [docs/roadmap.md](docs/roadmap.md).

## Hard constraints

- No OpenAI/other inference APIs, Codex CLI, MCP, scraping/reading of ChatGPT conversations, credential interception, or automatic prompt submission. ChatGPT is used through its web UI with a manual login. If login is blocked, document it; never bypass.
- Do not modify Herdr's installation or global config, and never kill/delete Herdr sessions or agents the app did not start. The user's `default` Herdr session is off limits for tests.
- Do not expose capabilities to remote (ChatGPT) content: no preload, no Node, sandbox + context isolation, no IPC reachable from it. All `webPreferences` come from `src/main/web-preferences.js`.
- Herdr integration is **read-only except one write**: the allowlisted reads in `src/main/herdr/api-client.js` (`ping`, `session.snapshot`, `workspace.list/get`), workspace/tab/pane subscriptions, and `workspace.focus` through `focusWorkspace()` — sent only by an explicit user selection (`workspace-selection.js#select`), never in response to observation, reconnect, startup or preferences, and never replayed. Never create, rename, move or close workspaces from the app, never touch the user's `default` session, and run experiments that mutate only in disposable `m01i1-lab*`/`m01i2-lab`-style sessions. `workspace.focus` is session-wide (moves every client). The workspace visible in our own client is not observable (see `docs/validation/m01-i1.md`): the selector's auto mode is an optimistic estimate; do not present it as identification, infer it by parsing the TUI, or use it to drive Git or ChatGPT behaviour.
- ChatGPT page observation (`src/main/chat/`) is passive and boolean-only: isolated-world probe plus Electron navigation events; never read or store message text, never use `webRequest`/`debugger`/cookies, no preload or IPC for the remote page, no MutationObserver on the whole page. Enabled only with `CONTEXTDECK_CHAT_OBSERVER=1`; its state must never authorize destroying a view.
- IPC: fixed named channels only, sender-checked, arguments validated in main. Never add a generic "run command" channel. Channel names are a contract with the preload (`test/structure.test.js` pins them).
- Git: argument arrays, no shell; read-only operations; refs validated in main (`isSafeRef` + `rev-parse`) and passed as resolved SHAs; outputs capped. The only write is the ZIP in `<userData>\artifacts`; deletion only of the last generated, correctly named ZIP.
- Herdr owns workspace lifecycle; ContextDeck reads workspace snapshots and subscriptions and may send `workspace.focus` only after an explicit user selection. Workspace identity uses session + opaque ID plus recorded label and observed directory evidence; disagreement requires explicit reconfirmation.
- ChatBindings associate individual conversations with workspaces. ProjectBindings associate a workspace with a ChatGPT Project for new conversations; neither implies the other. Workspace-first adoption remains explicit to the context the user opened.
- Global activity is a projection of existing per-view observers. ChatGPT observation returns bounded control metadata and booleans only, never message text or file details.
- Conversation suspension is manual only. It requires fresh generation/draft evidence, a persistent recovery binding, and confirmed native view destruction. Unknown unsent-content state blocks suspension. No automatic suspension, LRU, inactivity timer, or memory threshold is in scope.
- Restoring reloads the conversation URL; unsent attachments, scroll position, and transient visual state are not preserved. Do not claim otherwise.
- No new frameworks or build tools without need; keep modules small and avoid abstractions without a consumer. Do not start milestones that were not requested.

## Persistent data — handle with care

`src/main/persistence/identity.js` holds identifiers that keep M00 values: userData folder `%APPDATA%\Project Dock M00`, partition `persist:project-dock-m00-chat`, `ui-state.json`, `artifacts`. Changing them logs the user out and orphans preferences/ZIPs; a rename needs an idempotent, non-destructive migration plus an ADR. Never delete or rewrite user data, cookies or profiles; back up `ui-state.json` before running anything against the real profile. `ui-state.json` must stay backward compatible (see its tests).

## Layout and commands

```text
src/main (bootstrap, window, chat-view, ipc/, git/, herdr/, persistence/, platform/)  src/preload  src/renderer
scripts/build.js → dist/ (git-ignored)   test/   docs/   config.example.json (versioned) / config.json (local)
```

`npm install` · `npm start` (build + launch) · `npm test` · `npm run check` (tests + build; run before committing). Only `index.js`, `window.js`, `chat-view.js` and the preload may `require('electron')`.

## Testing rules

- Behaviour changes need automated tests. Git tests use temporary repositories only, never the user's.
- Separate **validated automatically**, **validated by harness**, **pending manual validation** and **blocked** in every report. Do not claim keyboard, Explorer paste, ChatGPT login or ChatGPT-ZIP-paste results without a person executing them.
- Synthetic input (`sendInputEvent`) does not trigger `before-input-event`; see [docs/development.md](docs/development.md) for harness techniques. Never screenshot the ChatGPT view of the real profile (personal conversations).

## Git workflow

Branches `feature/…` / `fix/…`; never commit to `main`; Conventional Commits in English; one logical change per commit; check `git status`/`git diff` before staging; rebase before PR; no history rewrites or force pushes without explicit approval; do not push to `main`/`master` unless asked. Local, untracked files: `config.json`, `AGENTS.local.md`.

## Editing pitfalls on Windows

Do not rewrite source files through Windows PowerShell 5.1 `Get-Content`/`Set-Content` (encoding corruption, BOM, backtick escapes). Use the editor tools or .NET with UTF-8 without BOM and absolute paths.

## Where learnings go

Permanent technical knowledge belongs in `docs/` (development/architecture/decisions). `AGENTS.local.md` (git-ignored) is only for machine-specific notes. When you find a root cause or an environment quirk, add it to `docs/development.md` instead of only fixing it.
