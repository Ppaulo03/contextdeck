# Development (Windows)

For release readiness, use the [M01-R1 audit and homologation checklist](validation/m01-r1-release-hardening.md). `npm run smoke` starts Electron against disposable `CONTEXTDECK_USER_DATA`; it does not validate ChatGPT authentication or real Herdr behavior.

## Setup

```powershell
node --version        # 22+ (24 LTS recommended)
git --version
herdr --version       # needed to run the app, not to run the tests
npm install
npm start             # = npm run build && electron .
```

| Script | Does |
|---|---|
| `npm run build` | `scripts/build.js`: esbuild bundle (JS+CSS) + static files → `dist/renderer`. |
| `npm start` | Build, then launch Electron. `dist/` must exist or startup fails with a message. |
| `npm test` | `node --test test/*.test.js`. |
| `npm run check` | Tests, then build. Run before every commit. |

`node-pty` 1.1.0 is N-API with Windows prebuilds: it loads in Electron as is. `electron-rebuild` fails on a plain machine (winpty `GetCommitHash.bat` needs Python + VS Build Tools) and is not needed.

ChatGPT Projects are enabled by default. `CONTEXTDECK_PROJECTS=0` opts out for a launch; unset or `1` enables them. The single decision is read at startup and shared by Project persistence, IPC, conversation creation and renderer state. Opting out does not read, rewrite or delete `project-bindings.json`; enabling again loads its existing links.

## Repository workflow

- Branches: `feature/<ticket>-<short-name>` or `fix/<ticket>-<short-name>`; never commit to `main`; rebase on `origin/main` before a PR.
- Conventional Commits in English; one logical change per commit; run `git status`/`git diff` before staging (no blind `git add -A`).
- The tag `m00-homologated` marks the last commit before the R00 restructuring.
- `config.json` and `AGENTS.local.md` are local and git-ignored. Never commit `.env`, tokens, cookies or Chromium profiles.

## Tests

- Automated tests never use real repositories: Git tests create temporary repos (`git init` in `os.tmpdir()`), configured inline (`-c user.name=…`), and clean them up.
- `test/structure.test.js` guards the layout: entrypoints, syntax of every source file, build output, resource paths, preload isolation, the IPC channel contract, persistent identifiers and `ui-state.json` compatibility with M00. Update it deliberately when you change those contracts.
- Modules that need Electron are limited to `index.js`, `window.js`, `chat-view.js` and the preload (enforced by a test); keep logic in plain-Node modules so it stays testable.

### Testing renderer components

`test/helpers/fake-dom.js` bundles a real renderer module with esbuild (so imports resolve as in the build) and runs
it against a minimal fake DOM; `test/components.test.js` uses it for the selector trigger, the menu overlay, the
store, the header and the feedback line. `src/shared/*` view-models are plain CommonJS and tested directly. The fake DOM
models only what the components use; it is not a browser, so layout, focus rings and the native overlay view still need a
real run (see below). When a behaviour matters, mutate the code once and confirm a test fails.

### What automated tests cannot prove

Real keyboard auto-repeat, the Explorer paste of the ZIP file, ChatGPT login and ChatGPT accepting a pasted ZIP need a person at the keyboard. Say so explicitly in reports; never mark them as passed from synthetic events.

### Driving the real app from a harness

A throwaway script run with `electron <script>` can `require('src/main/index.js')` and then drive the window. Techniques that worked:

- Set `CONTEXTDECK_USER_DATA` to a temp folder **before** requiring `index.js` so the real profile is untouched (the real ChatGPT login lives in `%APPDATA%\Project Dock M00`; back up `ui-state.json` before any run against it, and do not capture screenshots of the chat view: it shows personal conversations).
- Pass `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`. Without it an idle/occluded window reports `visibilityState: hidden`, never paints and `capturePage()` hangs. External `PrintWindow` captures return black.
- `capturePage()` of the main window excludes the ChatGPT `WebContentsView`; capture `webContents.getAllWebContents()` entry for chatgpt.com separately.
- `sendInputEvent` does **not** trigger `before-input-event`; exercise the shortcut wiring with `webContents.emit('before-input-event', { preventDefault() {} }, { control: true, key: 'Tab', type: 'keyDown', isAutoRepeat: false, … })`. Typing into a focused renderer input works with `sendInputEvent`/`insertText`.
- Electron's `clipboard.readText()` in the main process did not reflect writes in a harness; verify the clipboard from an external `powershell -STA` process (`[Windows.Forms.Clipboard]::GetText()` / `GetFileDropList()`), and `trim()` the trailing newline.

### Herdr lab sessions

Experiments that create, focus, rename or close workspaces must use a throwaway session (`herdr --session m01i1-lab` or similar), never `default` or the app's session. Techniques that worked (details in [validation/m01-i1.md](validation/m01-i1.md)): `herdr api schema --output <file>` for the contract; `herdr session list --json` for the endpoint; connect to `\\.\pipe\<socket_path>` and exchange JSON lines; point extra clients at a lab config with `HERDR_CONFIG_PATH` (for example direct `next_workspace` keys) instead of touching your Herdr config; read what a client displays by feeding its PTY output to `@xterm/headless` (install it in a temp folder, not in the project) and looking for a marker echoed into each workspace. Clean up with `herdr session stop <name>` and `herdr session delete <name>`, for your own lab sessions only.

M01-I2 additions ([validation/m01-i2.md](validation/m01-i2.md)): to drive the real app, point it at a lab session through a `config.json` in a throwaway clone (not your own `config.json`) and set `CONTEXTDECK_USER_DATA`; count the focus commands the app really sends by wrapping `focusWorkspace` on the object returned by `createApiClient` *before* requiring `src/main/index.js`; switch workspace in the TUI by writing an SGR mouse report (`ESC[<0;col;rowM` + `…m`) into the PTY at the sidebar row of the workspace (`dock.writeTerminal`); choose in the dropdown by setting `select.value` and dispatching a `change` event in the renderer; in test fakes answer `session.snapshot` with the state at request time (not after a simulated delay) or staleness bugs are invisible.

### Chat observation diagnostics (M01-I3P)

`$env:CONTEXTDECK_CHAT_OBSERVER='1'; npm start` writes state transitions to `<userData>diagnosticschat-observer.jsonl` (hashed ids, control attributes, no content). Harness techniques that worked: `webContents.executeJavaScriptInIsolatedWorld(1001, [{ code }])` for passive probes (booleans only); an observer attached to a throwaway-profile `WebContentsView` loading logged-out chatgpt.com (never send a message); injecting stand-in DOM elements into that throwaway page to test the pipeline; `history.pushState` in the page to exercise `did-navigate-in-page` (Electron also emits `did-start-loading` for it: use `did-start-navigation` with `isInPlace` to tell real loads apart). Details and results: [validation/m01-i3p.md](validation/m01-i3p.md).

### Chat bindings (M01-I3A)

Bindings live in `%APPDATA%\Project Dock M00\chat-bindings.json` (own file; `CONTEXTDECK_USER_DATA` redirects it for harnesses). Back it up together with `ui-state.json` before testing on the real profile. Tests never touch it: `test/helpers/bindings-world.js` wires the real store and service to a temporary directory and a fake Herdr observer/selection. Learned while building it:

- `herdr session list --json` has no session UUID (only `name`, `socket_path`, `session_dir`, `default`, `running`) and workspace ids restart at `w1` in a recreated session. That is why each workspace keeps a label/directory recovery record and a mismatch is `suspect`, not trusted ([ADR 0002](decisions/0002-chat-bindings.md)).
- The fake DOM of the component tests does not model mixed text + child nodes (the `textContent` of a node with children ignores its own text) nor `disabled` buttons ignoring clicks: build panels from `el()` pieces (a `span` for text next to a button) and assert `disabled` instead of clicking.
- The WHATWG `URL` turns a backslash in the path of an https URL into `/`, so `https://chatgpt.com/c\<uuid>` is the same address as `/c/<uuid>`; the identity parser rebuilds the URL from parsed parts, so nothing raw is stored.
- A feature that needs the page address must read it in main (`win.getChatUrl()`), never accept it from the renderer or the remote page.

### Multi-view navigation (M01-I3B-1)

Unit tests use mock views (`test/helpers/views-world.js`: views whose events and load completions the test controls, a host that records attach/detach order, the real bindings service on a temporary directory). What mocks cannot prove runs in real Electron:

```powershell
npm run build
npx electron test/electron/multiview-harness.js    # ~2-3 min, needs network (logged-out chatgpt.com), throwaway profile
```

It drives the real window controller, chat views, manager, navigator and IPC with a fake Herdr (no PTY client, no Herdr session) and writes `multiview-report.json` (set `HARNESS_OUT` to choose the folder). Never run it against the real profile and never type into the ChatGPT pages; it injects stand-in DOM (a textarea, counters) into the throwaway pages instead. Learned while building it:

- A *bound* conversation address (`/c/<uuid>`) does not exist for a logged-out profile: the page redirects to `/`, so the view reports relation `left`. Use `history.pushState(…, '/c/<uuid>')` in the page to make it "be" that conversation (it fires `did-navigate-in-page`, which is what the SPA does).
- Hiding a view is `removeChildView` (detach); the harness compares it with `setVisible(false)` on an attached view and with a visible one (timers, `requestAnimationFrame`, `MessageChannel`, draft, `performance.timeOrigin`). Do not assume the three behave alike; the numbers are in [validation/m01-i3b-1.md](validation/m01-i3b-1.md).
- `app.getAppMetrics()` gives per-process working set and CPU; `capturePage()` of a view in an occluded window fails with `UnknownVizError`: screenshots are best effort.
- `webContents.on('destroyed')` is not relied on for correctness (the manager closes views itself); events from a closed view are dropped by id.
- The manager's tests assert *events never rewrite an expectation*: a transient redirect (`/c/<id>` → `/auth/…` → `/c/<id>`, seen in the I3P run as a brief `other`) must not detach a view from its conversation.
- After editing the mutation-sensitive code (`navigator.js` scope/confirmation checks, `manager.js` attach order and destroy rules) re-run the mutation checks listed in the validation document.

### View lifecycle (M01-I3C-1)

```powershell
npm run build
npx electron test/electron/lifecycle-harness.js     # ~3-4 min, needs network, throwaway profile; HARNESS_OUT picks the report folder
```

Writes `lifecycle-report.json` (memory / processes / CPU by view count, before and after suspending at +0/+3/+10 s, release and restore times, switching time, what is pushed to the UI at rest) and exits 0/1/2/3/77/78 like the activity harness (`EXPECTED_MIN_CHECKS` = 25). Unit tests: `test/view-lifecycle.test.js` (the status world of `helpers/views-world.js` now also builds the lifecycle). Learned while building it:

- `contents.close()` is asynchronous: for a few ms after `manager.suspend()` the page is still in `webContents.getAllWebContents()`. A harness check that looks for "the page is gone" must wait (`waitFor`), or it is a race.
- A response simulated on a *hidden* page leaves **attention pending** when it ends (correct): the page stays ineligible until the user visits it. In a harness, `pick()` the page and then another one to acknowledge it before expecting eligibility.
- The model needs a second reading to see a draft disappear: after clearing a draft, wait (or advance the virtual clock) before expecting the page to be eligible. The fresh reading taken by `suspend()` catches a draft that APPEARED at once.
- `app.getAppMetrics()` working sets include shared pages in every process; compare deltas, and expect Chromium to trim background renderers by itself (an earlier sample can be hundreds of MB above a later one).
- `CONTEXTDECK_LIFECYCLE_LOG=1` makes the real app append suspension / refusal / restoration events (with a resource snapshot) to `<userData>\diagnostics\lifecycle.jsonl`; no conversation content, never read back as state.

### Lifecycle hardening (M01-I3C-1H)

- The ChatGPT page currently provides no authenticated, validated DOM marker that proves the composer has no staged attachment or upload. The one-shot isolated-world check recognizes a populated file input or visible progress bar inside the selected composer form as `present`; otherwise it returns `unknown`. Production code does not currently emit `empty`, and unknown blocks the final suspension decision. It never reads file names, file bytes, or message text. Validate the real DOM before adding any `empty` signal.
- To collect authenticated composer evidence, use `CONTEXTDECK_COMPOSER_TRACE=1` with the app closed before launch. The trace is `%APPDATA%\Project Dock M00\diagnostics\composer-trace.jsonl`; schema 2 adds bounded editable ancestry and nearby structural counts through the existing per-view observer poll. It never records the values of those DOM attributes and does not classify candidates as attachments or `empty`. Do not enable the separate, broader `CONTEXTDECK_CHAT_TRACE` for this collection. See [I3C-1H2 validation](validation/m01-i3c-1h2-authenticated-trace.md).
- Observer freshness advances only on an accepted probe result. Old-epoch and out-of-order results are discarded and cannot renew the freshness timestamp used by suspension.
- `manager.suspend()` keeps a view entry while in `SUSPENDING`, then records suspension only after `destroyed` or `isDestroyed()` confirms release. A live handle after an exception or timeout stays managed and can be retried. A destroyed event removes references immediately and the observation hub stops its observer.
- Herdr does not expose a durable workspace generation. The directory normalized by `workspace-reader.js` is an active-pane `cwd`, not a workspace root. A mismatch in recorded label or cwd is therefore treated as suspect; explicit reconfirmation updates recovery metadata. Identical id + label + cwd after recreation remains indistinguishable with the current API.
- Residual unbound pages cannot be suspended because their recovery record is memory-only. Keep them alive through restart; do not add a permanent residual catalog as part of I3C-1H.
- Embedded main-frame navigation allows only HTTPS ChatGPT and current authentication origins. Manual authenticated login and redirect validation is still required before changing this list.
- Restore-report IDs are pruned when their managed view disappears and when lifecycle observation stops; a 100-cycle test pins bounded behavior.
- On Node 24, bare `node --test` recursively discovers `test/electron/*.js` harness entrypoints and runs them without Electron, producing false test failures. Use the project command `npm test` (`node --test test/*.test.js`) for the unit suite; run Electron harnesses with `npx electron test/electron/<harness>.js` separately.

### Conversation status (M01-I3B-2)

Unit tests run the REAL I3P observer on a fake `WebContents` with virtual time (`test/helpers/views-world.js`: `createStatusWorld`, `createClock`; the clock replaces `Date.now` and the observers' timers, so hours of polling run in milliseconds and `cleanup0()` restores it). Real Electron:

```powershell
npm run build
npx electron test/electron/status-harness.js                                    # status observers on  -> status-report-on.json
$env:CONTEXTDECK_CHAT_STATUS='0'; npx electron test/electron/status-harness.js   # baseline, observers off -> status-report-off.json
```

Since M01-I3B-2R the harness also runs the **document scenario** (a stop-labelled button outside the composer's form: the response must stay `responding` + `uncertain` with no attention, and end only after the stop button is removed). To supply diagnostics from a manual run see [validation/m01-i3b-2r.md](validation/m01-i3b-2r.md) §5 (`CONTEXTDECK_CHAT_OBSERVER=1`, `%APPDATA%\Project Dock M00\diagnostics\chat-observer.jsonl`).

Same rules as the multi-view harness (throwaway profile, logged-out chatgpt.com, fake Herdr, no message sent). The "responding" and "draft" fixtures are the I3P synthetic ones: the page's own send/stop control gets the aria-label `Interromper geração` (matches the detector's stop labels) and the composer `textarea` gets a value through the native setter. Learned:

- The model compares conversation identity by **id**, not by key: `/g/<project>/c/<id>` and `/c/<id>` are one conversation, otherwise opening a Project route would silently reset the state it had learned.
- A probe whose renderer is busy never answers; without a timeout the poll chain would end there. The harness freezes one page for 7.5 s to prove polling resumes.
- Detection latency of a hidden view is its poll interval (responding 1 s, visible idle 2 s, hidden idle 5 s); a response shorter than that can be missed.
- Chromium throttles hidden pages (timers 1/s, no `requestAnimationFrame`): the probe runs through `executeJavaScriptInIsolatedWorld`, not from the page, so it does not depend on either.
- `startStatePusher(...)` returns the stop function itself (with `.notify`), not an object.
- Diagnostics (`CONTEXTDECK_CHAT_OBSERVER=1`) now tag every line with the view id; one file for all views.

### Global activity (M01-I3B-2H)

Unit/integration tests: `test/activity-global.test.js` (projection, attention events, notices, direct navigation, on the status world), `test/activity-ui.test.js` (view-models, IPC, indicator, activity center and notices in the real overlay script on the fake DOM). Real Electron:

```powershell
npm run build
npx electron test/electron/activity-harness.js     # ~3 min, needs network; writes activity-report.json
```

It wires the same pieces as `src/main/index.js` (notices, activity pusher, direct open) with a fake Herdr, clicks the real indicator, reads the real overlay DOM, and checks focus (`webContents.isFocused()`), sizes (`getBoundingClientRect`), markers in the pages (no reload) and the explicit workspace commands. Learned:

- The overlay is ONE view: the notice cards are the same view laid out as a small rectangle (everything outside it keeps its input), added on top and never focused; a modal replaces them. `overlay.isOpen()` means "a modal"; `isShown()` is "anything of the overlay".
- CSS cascade: `components.css` is bundled after `layout.css`, so a responsive override of a component needs higher specificity (`.topbar .activity-ind`), not just a media query.
- `innerText` applies `text-transform`; read `textContent` when asserting names and ids (and do not upper-case workspace ids in the UI: homonyms).
- The fake DOM of the component tests ignores a node's own text once it has children: put text in spans next to badges/buttons.
- A request that is refused (a switch in flight) must not invalidate the one being served: `directOpen` increments its sequence only after validation.
- Notices are fed by the hub's `onAttention`, which fires only on a new `none → pending` of a ready view with a valid identity; the baseline of a first summary is not an event.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `…\dist\renderer\index.html not found; run "npm run build"` | Launched `electron .` without building. Use `npm start`. |
| Terminal shows "nested herdr is disabled" | `HERDR_*` leaked from the parent shell. Already stripped in `herdr/env.js`; if it reappears, check that module. |
| "Herdr nao encontrado" | `herdrExecutable` not on `PATH`; set the full path in `config.json`. |
| Window opens but is blank/black in automation | Occlusion, see harness notes. |
| `git archive`/diff fails with ownership errors | Git `safe.directory` for that repository; fix in your Git config. |
| Herdr logs | `%APPDATA%\herdr\herdr*.log`. |
| Lost ChatGPT login after a change | An identifier in `persistence/identity.js` or the `userData` pin changed. Revert it. |

## Windows/PowerShell pitfalls (learned the hard way)

- **Do not edit source files with `Get-Content`/`Set-Content` in Windows PowerShell 5.1**: `Get-Content` without `-Encoding UTF8` reads UTF-8 as ANSI (mojibake) and `Set-Content -Encoding utf8` writes a BOM. Backticks in double-quoted strings become control characters (`` `v ``, `` `r ``). Use the editor tools, or .NET with `New-Object Text.UTF8Encoding($false)` and absolute paths (`[IO.File]` resolves relative paths against the process cwd, not PowerShell's location).
- `node --test test/` fails on Node 24 (treated as a module); use the glob `test/*.test.js`.
- A dependency version in `package.json` is exact-pinned; keep `package-lock.json` in sync (`npm install`).

### Electron harness exit codes (activity-harness, lifecycle-harness)
`0` every check passed; `1` a check failed or an error was recorded; `2` fewer than 20 checks ran (stopped early); `3` timeout (9 min); `77` SKIPPED because chatgpt.com is not reachable (reason printed). The report is `activity-report.json` in `HARNESS_OUT` or, by default, `%TEMP%\contextdeck-harness-out` (it used to be written into the throwaway profile and deleted, and the exit code was always 0). Known on the base commit: 2 failing checks and an unhandled script error in the logged-out environment (see validation/m01-i3b-3.md).

### Start-up smoke and harness exit 78
`npm run smoke` starts the real application on a throwaway profile (`CONTEXTDECK_USER_DATA`) and fails if it logs a start-up error or exits (exit 0 = stayed up; `SMOKE_WAIT_MS` changes the wait). It exists because unit tests never run `src/main/index.js`. The activity harness additionally exits **78 (BLOCKED)** when the main application is open.
