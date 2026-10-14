# ContextDeck

Windows desktop workspace that puts **Herdr** (terminal multiplexer for coding agents) and **ChatGPT Web** in a single window, so you can flip between your agents and a planning/review conversation without splitting the screen and without losing the state of either.

- **Herdr:** xterm.js + node-pty/ConPTY running the Herdr client.
- **ChatGPT:** the regular chatgpt.com in an isolated Electron `WebContentsView` with its own persistent profile. You log in manually.
- **Git tools:** copy a diff, a `git show` or a ZIP of a commit (as a real file on the clipboard) to hand to ChatGPT yourself.

No inference APIs, no Codex CLI, no MCP, no scraping of conversations, no automatic prompt submission. You decide what is transferred.

> Status: **M00 homologated** (tag `m00-homologated`). This repository is at the R00 foundation: structure and docs only, no new features. See [docs/roadmap.md](docs/roadmap.md).

## Requirements

- Windows 10/11 x64.
- Node.js 22+ (24 LTS recommended) and npm.
- [Herdr](https://herdr.dev) installed (`herdr --version` works in PowerShell) and Git on `PATH`.
- No compiler toolchain: `node-pty` ships prebuilds for Windows. Do **not** run `electron-rebuild`.

## Quickstart

```powershell
git clone https://github.com/Ppaulo03/contextdeck.git
cd contextdeck
npm install
copy config.example.json config.json   # optional; the example is used if config.json is missing
npm start                              # builds dist/ and launches the app
```

`npm run check` runs the automated tests and the build. First start: open the **ChatGPT** tab and sign in manually; the login persists across restarts.

### Configuration

`config.json` is local and git-ignored; `config.example.json` is the versioned template.

```json
{
  "herdrExecutable": "herdr.exe",
  "herdrSession": "contextdeck",
  "workingDirectory": "C:\\Users\\you\\some-project"
}
```

| Key | Meaning |
|---|---|
| `herdrExecutable` | Bare name (searched in `PATH`/`PATHEXT`) or a full path. |
| `herdrSession` | Herdr session the app attaches to (`1-64` letters, digits, `_`, `-`). Use `default` to attach your existing default session; any other name is created on first use and is isolated from your other sessions. |
| `workingDirectory` | Optional. Start directory of the terminal and the initial *suggestion* for the Git repository. Defaults to your home folder. |

Existing `config.json` files (including the Project Dock M00 session name `project-dock-m00`) keep working unchanged.

## Using it

- **Switch views:** click the tabs or press `Ctrl+Tab` (one switch per physical press; holding the keys does not repeat). Both views keep their state; the ChatGPT page is never reloaded and the Herdr client is never restarted by switching.
- **Clipboard:** `Ctrl+Shift+C` / `Ctrl+Shift+V` in the terminal; normal `Ctrl+C` / `Ctrl+V` in ChatGPT. Pasted newlines may be treated as Enter by the receiving agent: review before pasting.
- **Conversations per workspace (ChatGPT tab):** a strip under the top bar lists the conversations bound to the selected workspace (and any temporary ones you opened there). Each opens in its own page, created the first time you click it and kept alive in the background, so switching never reloads it and drafts and answers in progress are not interrupted. Each workspace remembers the last conversation you picked; a workspace without conversations shows an empty state instead of another project's chat. **+** starts a new conversation (never bound automatically), **Gerenciar** opens the binding manager. Pages stay loaded until you close the app (≈ 135 MB each).
- **Global activity:** the top bar always shows how many conversations (of every workspace) are responding or have activity to review, on both tabs. Click it to open the activity center: all workspaces, their conversations and states, with **Abrir** to jump straight to a conversation (it switches the Herdr workspace only because you clicked, shows the ChatGPT tab and selects the conversation without reloading it). A small card appears at the top right when a background response ends ("Atividade para revisar"), without taking the keyboard from what you are typing; closing it does not clear the pending activity.
- **Conversation status:** each loaded conversation shows, on its tab, whether it is **responding** (spinner), has **activity to review** (● — something happened while you were not looking; it does not mean the answer was good or even finished), or has an **unsent draft** (✎); a `?` means the page could not be observed. The workspace selector and its menu show how many conversations of other workspaces are responding or need review. Opening the conversation (or coming back to the window with it on screen) acknowledges the activity. Only the presence of text in the composer is detected, never the text; nothing is notified or saved. Set `CONTEXTDECK_CHAT_STATUS=0` to turn it off.
- **Chat bindings (ChatGPT tab):** the indicator at the right of the top bar shows whether the current conversation is bound to the selected workspace, to another one, or to none. Click it to bind the current conversation (or one by URL) to a workspace, name it, give it a category, unbind it, or move it explicitly. Bindings are stored locally in `chat-bindings.json`; unbinding never deletes anything in ChatGPT, and a brand-new chat can be bound only after it has its own address. Nothing is bound automatically and the app never changes the Herdr workspace by itself.
- **Closing the app** only closes the Herdr *client*; Herdr's server and your agents keep running.
- **Workspace selector** (top bar): lists the workspaces of the configured Herdr session as `id · name`. Picking one moves Herdr to it (this is session-wide: it moves every client attached to the session, normally only ContextDeck). In **Auto** (default) it follows the workspace you switch to in Herdr; **Manual** keeps your choice. Auto is an estimate: with more than one Herdr client attached it follows whichever client moved last. Your last explicit choice is remembered; starting the app never moves Herdr.
- **Workspaces** (terminal view): a read-only diagnostic panel listing the workspaces of the configured Herdr session, the connection state and the last events. It cannot change Herdr, and it cannot tell which workspace *your* client is showing (Herdr's API has no per-client focus); see [docs/validation/m01-i1.md](docs/validation/m01-i1.md).

### Git tools (footer)

Operate on one repository, always read-only (except writing the ZIP to the app's artifacts folder):

- **Repo…** chooses the repository; **Base diff** and **Revisão** are searchable pickers fed by the repository (local/remote branches, tags, `HEAD`, the 30 latest commits) with a manual-expression entry (`HEAD~3`, a SHA). No `git fetch` is ever run; **↻** rereads refs. Selections are remembered **per repository**.
- **Copiar Diff** → `git diff <base>` (tracked files only; untracked files are not included). **Copiar Git Show** → `git show <revisão>`. Empty results and errors never overwrite your clipboard; output above 10 MB is refused.
- **Gerar + Copiar ZIP** → `git archive` of the selected revision (committed, tracked files only) saved in `%APPDATA%\Project Dock M00\artifacts\` and copied to the clipboard as a real file (paste into Explorer). Whether ChatGPT accepts a pasted ZIP depends on ChatGPT; otherwise attach it with the (+) button.
- **Excluir ZIP** (two clicks) removes only the last ZIP the app generated. Nothing is deleted automatically.

Details of every rule are in [docs/architecture.md](docs/architecture.md).

## Known limitations

- Embedded login can be blocked by the identity provider in the future; the app does not try to bypass it. **Abrir no navegador** opens chatgpt.com in your default browser (cookies are not shared).
- One instance at a time; a second launch focuses the first window.
- No packaged installer; run from source.
- ChatGPT conversations can be bound to Herdr workspaces (M01-I3A: top-bar indicator → panel); the app does not yet switch conversations by itself (M01-I3B).

## Documentation

| Doc | Purpose |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Modules, IPC contract, data flows, security boundaries, persistent identifiers. |
| [docs/development.md](docs/development.md) | Windows setup, commands, tests, harness techniques, troubleshooting. |
| [docs/roadmap.md](docs/roadmap.md) | M00 / M01 / M02. |
| [docs/validation/m00.md](docs/validation/m00.md) | Record of the M00 homologation. |
| [docs/decisions/](docs/decisions/0001-herdr-workspaces.md) | Architecture decision records. |
| [AGENTS.md](AGENTS.md) | Standing instructions for development agents. |
