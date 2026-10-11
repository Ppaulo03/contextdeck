# Project Dock - M00 (Windows)

Minimal **feasibility spike**, not a product. One application window with two full-width views:

- **Herdr:** terminal emulated via xterm.js and node-pty/Windows ConPTY.
- **ChatGPT:** actual chatgpt.com inside an Electron WebContentsView with its own persistent browser session.

The goal is to test the experience of switching between the two without splitting the screen. There are **no APIs, Codex CLI calls, MCP tools, DOM scraping, agent automation, or background jobs** in this prototype.

## Prerequisites

- Windows 10/11, x64 (ConPTY-capable release).
- Node.js 22+ (Node.js 24 LTS recommended) and npm.
- Herdr installed and callable using `herdr --version` in PowerShell.
- Internet for npm installation and chatgpt.com.
- No compiler toolchain needed: `node-pty` 1.1.0 ships N-API prebuilds for win32-x64/arm64 that load in Electron as-is. **Do not run `electron-rebuild`** — it needs Python + VS Build Tools and fails on a plain machine (winpty `GetCommitHash.bat`); it is not required.

## Install and run (PowerShell)

Open PowerShell inside the `project-dock-m00` folder:

```powershell
node --version
herdr --version
npm install
npm start
```

No system-wide installation or admin privileges are required. `npm start` bundles the renderer (xterm.js + CSS) with esbuild and launches Electron. `npm run check` runs syntax checks, unit tests and the renderer build.

### Configuring the Herdr session

`config.json`:

```json
{
  "herdrExecutable": "herdr.exe",
  "herdrSession": "project-dock-m00",
  "workingDirectory": "C:\\Users\\you\\some-project"
}
```

`workingDirectory` is optional (defaults to your home folder). `herdrExecutable` can be a bare name (resolved through `PATH`/`PATHEXT`) or a full path; if it cannot be found the terminal shows an explicit error. All `HERDR_*` environment variables are stripped from the terminal environment, so launching Project Dock from inside a Herdr pane neither triggers "nested herdr is disabled" nor attaches to the outer server.

The default session name **project-dock-m00** is isolated from your existing Herdr sessions. Herdr servers and agent processes can remain alive if the UI client detaches. To **attach your existing default session instead**, stop the app, set `herdrSession` to `default`, then restart `npm start`. This only changes the session to which the app connects; it does not import or reconfigure agents.

If Herdr is not on PATH, set `herdrExecutable` to its full `.exe` path using double backslashes in JSON (e.g., `C:\\tools\\herdr\\herdr.exe`). Keep Herdr's accompanying Windows ConPTY runtime files together with the binary.

## Keyboard and clipboard

- `Ctrl+Tab`: switch between Herdr and ChatGPT, once per physical press. Holding the keys does **not** repeat the switch (auto-repeat is ignored); release and press again to switch back. You can also click the tabs.
- Select terminal text, then `Ctrl+Shift+C` to copy.
- `Ctrl+Shift+V` to paste into Herdr (the destination app handles the pasted text). **Newlines in pasted content may be interpreted as Enter by the receiving terminal/agent.** Review the clipboard and target project first.
- Inside ChatGPT, standard browser `Ctrl+C` / `Ctrl+V` should work if supported by the embedded page.

The app does not auto-submit messages, read ChatGPT message content, or infer which project a chat belongs to. **Make sure you are in the right ChatGPT conversation** before sending or pasting project materials. Multi-project management is deliberately deferred to M01.

## Git tools (footer)

The footer works in both views and operates on one configured repository. Git runs in the main process with argument arrays (no shell), read-only (`GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff`, no fsmonitor hook) and never changes branches, the index or the working tree.

- **Repo...** picks the repository folder (any folder inside the work tree works; the root is resolved with `git rev-parse --show-toplevel`). Until you pick one, `workingDirectory` from `config.json` is used as a *suggestion* if it is a repository (the label says "sugerido"); otherwise the buttons are disabled and the footer says the repository is not configured. The choice is saved in `ui-state.json` (Electron userData).
- **Base diff** and **Revisão** are searchable pickers fed by the repository itself (read-only `git for-each-ref` / `log` / `rev-parse`; **no `git fetch`** — remote branches are whatever the repo already knows). Click a picker (or focus it and press `↓`), type to filter, `↑/↓` to move, `Enter` to choose, `Esc` to close. Groups: local branches, remote branches, tags; **Revisão** also lists `HEAD` and the 30 most recent commits (short SHA, subject, date, author). The list opens inside the footer, not as a floating popover (the ChatGPT view would hide a popover), so the footer simply grows while it is open.
- **Manual reference:** type any expression (`HEAD~3`, a SHA, `origin/x`) and press `Enter` on the "manual" entry; it is validated by Git in the main process and rejected (picker stays open) if it is not a commit of *this* repository.
- **Default base**, in order: the ref saved for this repository (if it still exists), `dev`, `origin/dev`, `main`, `origin/main`. If none exists the base stays empty and **Copiar Diff** is disabled until you pick one — it never falls back to `HEAD`. If a saved ref disappeared, a red hint says so. **Revisão** defaults to `HEAD`.
- The **↻** button re-reads the refs (also done when the window regains focus and after each action). Selections are saved **per repository** (keyed by its root path), so switching repositories never reuses refs from another one; before every action the main process re-resolves the repository and the ref and refuses the call if the active repository changed.
- The revision that will be shown/exported is always visible next to the picker (`→ <short sha>`, subject in the tooltip) and repeated in the result message.
- **Copiar Diff** = `git diff <base>` (working tree and index vs the base, **tracked files only; untracked files are not included**). Empty diffs and errors are reported and the clipboard is left untouched. Output is limited to 10 MB; larger output is refused, never truncated.
- **Copiar Git Show** = `git show <revisão>`, same limits.
- **Gerar + Copiar ZIP** = `git archive --format=zip <revisão>` into `%APPDATA%\Project Dock M00\artifacts\dock-<repo>-<sha>-<timestamp>-<random>.zip` (never inside the repo), then copies the file to the Windows clipboard as a real file (`CF_HDROP`/FileDropList via PowerShell STA, verified by reading it back) — like Ctrl+C on a file in Explorer. `git archive` contains only files **tracked in that commit**: uncommitted changes and untracked files are not included. The ZIP stays on disk; name, size and folder are shown in the footer. If the clipboard step fails the ZIP is still kept and the message gives its path so you can attach it manually.
- **Excluir ZIP** is a separate button with a two-click confirmation. It only deletes the last ZIP generated by this app, and only if its name matches the generated pattern and it sits in the artifacts folder. It never deletes automatically and never clears your clipboard; keep the file until the paste/attach is finished. Older ZIPs from previous generations stay on disk (no auto-cleanup in this iteration); remove them from the artifacts folder yourself.
- Whether ChatGPT Web accepts a pasted ZIP is **not assumed**. If pasting fails, use the attach (+) button in ChatGPT and pick the file from the artifacts folder shown in the footer.
## Test checklist

1. Herdr starts inside the app and responds to keyboard/mouse input.
2. Switching to ChatGPT does not kill the Herdr client.
3. ChatGPT loads and allows manual sign-in.
4. ChatGPT messaging and project navigation work.
5. Copy and paste work in both directions.
6. Close/reopen the app: ChatGPT session persists; Herdr session reconnects.

### Manual checklist M00-I2 (needs a real keyboard / Explorer / ChatGPT)

1. `Ctrl+Tab` pressed once: switches exactly once.
2. `Ctrl+Tab` held for 2-3 s: switches once, no flicker; release and press again switches back.
3. `Ctrl+Tab` with focus in the terminal, and again with focus in ChatGPT (click inside the page first).
4. After each switch the target view has focus (type in the terminal / the ChatGPT box), the ChatGPT page did not reload and the Herdr screen is intact.
5. `Ctrl+Alt+1` / `Ctrl+Alt+2` do nothing; tab clicks still work; `Ctrl+Shift+C/V` still copy/paste in the terminal.
6. **Repo...** on a real repository, **Base diff** `dev` -> **Copiar Diff**, paste somewhere and compare with `git diff dev`.
7. **Copiar Git Show** with `HEAD`, then `HEAD~1`.
8. **Gerar + Copiar ZIP**, then paste (`Ctrl+V`) in an Explorer folder: the ZIP file must appear.
9. Try pasting the ZIP in the ChatGPT message box; if it is not accepted, attach it through (+) / file picker.
10. **Excluir ZIP** (two clicks) removes only that file; nothing is deleted before.
11. No regressions: Herdr still reconnects to its session; ChatGPT is still logged in after restart.

### Manual checklist M00-I3 (Git pickers)

1. Open **Repo...** on a repository that has **no** `main` (e.g. only `develop`): the base is not guessed; **Copiar Diff** stays disabled until you pick one; Base never falls back to `HEAD`.
2. On a repository with `dev`, Base is preselected as `dev`; with only `main`, as `main`.
3. Open **Base diff**: groups for local/remote branches and tags; type a few letters, `↓/↑`, `Enter`; `Esc` closes and returns focus to the button. Same with the mouse.
4. Open **Revisão**: `HEAD`, the recent commits (short SHA + subject), then branches/tags; choose a previous commit and check the `→ <sha>` indicator, then **Copiar Git Show** and **Gerar + Copiar ZIP** use exactly that commit (the result message names it).
5. Type `HEAD~3` or a SHA in the search box and press `Enter` on the "manual" entry; type a bogus ref: a red message appears and nothing is stored.
6. Make a commit / create a branch in Herdr, return to the app (or press **↻**): the lists update; no `git fetch` is ever run.
7. Switch **Repo...** between two repositories: each keeps its own Base/Revisão; a ref that exists only in the other repository is never used.
8. Rename/delete the saved base branch outside the app, press **↻**: the red hint says it no longer exists.
9. With the picker open, switch to ChatGPT (`Ctrl+Tab`): the page is not covered and the footer is not hidden.
10. Remote branches: in a clone, `origin/...` entries appear without fetching (they reflect the last fetch you did yourself).

## Important limitations

- **Embedded login is not guaranteed**: ChatGPT or an identity provider may block authentication inside an embedded Chromium-based app. In that case, the prototype is not viable without another architecture; do not attempt to bypass login restrictions. **Abrir no navegador** opens the normal ChatGPT website in your default browser, but does not share cookies with the embedded view.
- The ChatGPT profile is separate from Chrome/your ChatGPT Desktop app. Manual sign-in is needed the first time if allowed.
- There is no binding between ChatGPT conversations and Herdr projects in M00. Do not use this spike for parallel project workflows yet.
- A visual terminal emulator may have rendering/input differences compared to Windows Terminal. Report them before building M01.
- node-pty is a native module; the bundled prebuilds were verified to load in Electron 44.7.0 on Windows 11 x64.
- Only one instance can run at a time (single-instance lock); a second launch focuses the first window.
- Window size and last active tab are saved to `ui-state.json` in Electron's userData folder. No credentials are stored by the app.
- Opening an allowed authentication popup may display another small window. Non-auth popups are denied; remote pages do not automatically launch external applications. The prototype never reads or stores your password itself; cookies/session data are persisted by Chromium under Electron's user data directory.
- Closing the app stops the **Herdr client process managed by this app**, not the Herdr background server. Confirm agent/server behavior on your installed Herdr version.
- Source-only: no packaged `.exe` is produced.
- Not validated yet: ChatGPT login inside the embedded view, real `Ctrl+Tab`/clipboard keystrokes, Herdr mouse input. See the validation matrix delivered with M00.

## Architecture and security

- UI: local `file://` page with a restrictive CSP and no Node integration.
- Terminal: Node `node-pty` in the Electron main process; only local UI's IPC sender can control it.
- Web page: sandboxed `WebContentsView`, no preload, no Node, persistent partition `persist:project-dock-m00-chat`.
- IPC only exposes terminal I/O, view switching, reload and local clipboard operations. There is no generic shell API exposed to remote web content.
- Only clipboard-write permission is granted to chatgpt.com; other web permissions are denied.
- No third-party remote code is injected into ChatGPT pages.

## Verification in development environment

```powershell
npm run check
```

This checks source syntax and unit tests, **not** Windows/Electron/ChatGPT behavior.


