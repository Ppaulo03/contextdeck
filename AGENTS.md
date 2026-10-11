# AGENTS.md — ContextDeck

Standing instructions for development agents (Claude Code, Codex, etc.). They complement the user's global `AGENTS.md`; this file is the project-level source of truth. Human-oriented docs: [README.md](README.md), [docs/architecture.md](docs/architecture.md), [docs/development.md](docs/development.md).

## What this is

Windows Electron app: Herdr (xterm.js + node-pty) and ChatGPT Web (isolated `WebContentsView`) in one window, plus read-only Git tools. Currently the M00 feature set (homologated) on the R00 foundation. See [docs/roadmap.md](docs/roadmap.md) for what is and is not in scope.

## Hard constraints

- No OpenAI/other inference APIs, Codex CLI, MCP, scraping/reading of ChatGPT conversations, credential interception, or automatic prompt submission. ChatGPT is used through its web UI with a manual login. If login is blocked, document it; never bypass.
- Do not modify Herdr's installation or global config, and never kill/delete Herdr sessions or agents the app did not start. The user's `default` Herdr session is off limits for tests.
- Do not expose capabilities to remote (ChatGPT) content: no preload, no Node, sandbox + context isolation, no IPC reachable from it. All `webPreferences` come from `src/main/web-preferences.js`.
- IPC: fixed named channels only, sender-checked, arguments validated in main. Never add a generic "run command" channel. Channel names are a contract with the preload (`test/structure.test.js` pins them).
- Git: argument arrays, no shell; read-only operations; refs validated in main (`isSafeRef` + `rev-parse`) and passed as resolved SHAs; outputs capped. The only write is the ZIP in `<userData>\artifacts`; deletion only of the last generated, correctly named ZIP.
- No new frameworks or build tools without need; keep modules small and avoid abstractions without a consumer. Do not start milestones that were not requested (M01 is not started).

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
