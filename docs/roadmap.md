# Roadmap

Scope boundaries are deliberate: each milestone adds one capability and keeps the constraints of [AGENTS.md](../AGENTS.md) (no inference APIs, no scraping, manual ChatGPT login, Herdr untouched).

## M00 — Herdr + ChatGPT in one window ✅ homologated

Delivered in three iterations plus a foundation pass; record in [validation/m00.md](validation/m00.md).

- **I1:** Electron shell, Herdr in xterm.js/ConPTY, ChatGPT in an isolated persistent view, tab switching, clipboard.
- **I2:** `Ctrl+Tab` fix (no repeat), removal of redundant shortcuts/buttons, Git tools: diff, show, ZIP as a clipboard file, guarded ZIP deletion.
- **I3:** Git pickers fed by the repository, per-repository preferences, revalidation in main.
- **R00:** ContextDeck identity, modular `src/` layout, `dist/` build output, config split, documentation. No functional change.

## M01 — Workspaces (I1–I3A implemented)

Goal: work on two or three projects at once without mixing contexts. Direction fixed by [ADR 0001](decisions/0001-herdr-workspaces.md): **Herdr owns the workspaces**; ContextDeck stores only the associations, and they are explicit:

- Herdr workspace → local directory / Git repository (implemented in M01-I3D-1; manual override per workspace).
- Herdr workspace → several ChatGPT conversations, each with a role (architecture, review, planning…).
- Per-workspace UI state (last tab, selected refs).
- Visible workspace ↔ conversation labelling so a message is never sent to the wrong project.

Starts with M01-I1. Out of scope: automatic prompt transfer, reading conversations, new inference integrations.

- **M01-I1 — implemented, awaiting homologation.** Read-only discovery of the workspaces of the configured Herdr session, change tracking, recovery, and a diagnostic panel ([validation/m01-i1.md](validation/m01-i1.md)). Finding: Herdr's API has **no per-client focus**, so the workspace visible in ContextDeck's own client cannot be identified (reported as `ambiguous`; `known` only with a single workspace). Nothing is associated with ChatGPT yet.
- **M01-I2 — implemented, awaiting homologation.** Top-bar workspace selector with optimistic bidirectional focus sync: picking a workspace sends `workspace.focus` (the only write); TUI focus changes update the selector in Auto mode (Manual ignores them); startup/recovery never send a command. Assumes ContextDeck is normally Herdr's only client; the multi-client limitation stays explicit ([validation/m01-i2.md](validation/m01-i2.md)).
- **M01-I2.5 — implemented, awaiting homologation.** UX, component architecture and performance hardening: design tokens, renderer components, a workspace menu overlay that works over the ChatGPT view, measured fixes and the M01-I3 view-strategy study ([validation/m01-i2-5.md](validation/m01-i2-5.md)). No features.
- **M01-I3P — spike done, awaiting review.** Feasibility of observing ChatGPT response/draft state and conversation identity ([validation/m01-i3p.md](validation/m01-i3p.md)). Result: lifecycle, URL identity and draft presence are observable; "response in progress" is a best-effort signal not yet validated against a live response; completed vs interrupted vs failed is not distinguishable. A disabled-by-default diagnostic observer exists (`CONTEXTDECK_CHAT_OBSERVER=1`); no UI, no unloading, no multi-chat. Lifecycle must default to preserving views.
- **M01-I3A — implemented, awaiting homologation.** Persistent chat ↔ workspace bindings: several conversations per workspace, each with a label and a category; identity by Herdr session + workspace id and by the conversation UUID in the URL; own versioned file (`chat-bindings.json`) with atomic writes and a never-discard corruption policy; explicit confirmation for estimated destinations, conflicts and reassignment; orphans preserved; the top-bar indicator now reflects the real binding of the page and opens a management panel in the existing overlay. The ChatGPT view is still a single `WebContentsView`; the transient `ChatRuntime` is only a contract. Decision: [0002](decisions/0002-chat-bindings.md); results and manual script: [validation/m01-i3a.md](validation/m01-i3a.md).
- **M01-I3B-1 — implemented, awaiting homologation.** Functional multi-chat navigation: a `ChatViewManager` (views created on demand, one attached at a time, preserved in the background, closed only at shutdown) and a `ChatNavigator` (the selected workspace shows only its own conversations, restores the last one the user chose, temporary new conversations, protection against in-ChatGPT navigation), a conversation strip under the top bar and an empty state. No pool, no unloading, no indicators. Decision: [0003](decisions/0003-multi-view-navigation.md); results, measurements and manual script: [validation/m01-i3b-1.md](validation/m01-i3b-1.md). Requires the integrated I3A + I3B-1 homologation.
- **M01-I3B-2 — implemented, awaiting homologation.** Per-view status: one I3P observer per loaded conversation, indicators on the conversation strip (responding, activity to review, unsent draft, unknown), per-workspace counts in the workspace selector and its menu, an attention policy with explicit visits, background-safe (the status keeps working on detached views). No notifications, sounds, history, unloading or view limit. Results, measurements and manual script: [validation/m01-i3b-2.md](validation/m01-i3b-2.md).
- **M01-I3B-2H — implemented, awaiting homologation.** Global activity UX: a permanent top-bar indicator (every tab, every workspace), an activity center listing all workspaces with direct navigation to a conversation (explicit workspace selection, then the chat tab, then the conversation, with the existing visit/attention rules), and discreet in-app notices ("Atividade para revisar") that never take focus. A projection of the I3B-2 hub: no second detector, no new view, no notifications from Windows. Results, measurements and manual script: [validation/m01-i3b-2h.md](validation/m01-i3b-2h.md).
- **M01-I3B-3 — implemented and manually homologated.** Workspace -> ChatGPT Project links and creation of new conversations inside a linked Project. Projects are enabled by default; `CONTEXTDECK_PROJECTS=0` is an explicit opt-out. The earlier opt-in behavior is recorded in [validation/m01-i3b-3.md](validation/m01-i3b-3.md). Decision history: [0004](decisions/0004-project-bindings.md).
- **Later — not defined.** Quick keyboard navigation between conversations, refined recovery for in-ChatGPT navigation ("bind this page here"), notifications if ever wanted. Needs approval.
- **M01-I3C-1 — implemented, pending authenticated manual homologation.** Explicit suspension and URL-based restoration. Unknown draft or unsent-content state blocks; a page without a persistent binding cannot be suspended. See [validation/m01-i3c-1.md](validation/m01-i3c-1.md).
- **M01-I3C-1H — lifecycle safety hardening.** Conservative attachment fallback, confirmed native destruction, workspace identity reconfirmation, unexpected-view cleanup, trusted main-frame navigation, and bounded restoration bookkeeping. No automatic suspension. Results and manual checklist: [validation/m01-i3c-1h.md](validation/m01-i3c-1h.md).
- **M01-I3D-1 — implemented, pending manual homologation.** Git follows the selected workspace directory, displays repository/branch/source/path, and supports a persistent manual override per workspace with an explicit return to Herdr automatic discovery. Legacy global `git.repoDir` remains readable until the user returns to automatic mode. Checklist: [validation/m01-i3d-1.md](validation/m01-i3d-1.md).
- **M01-I3C-2 — not started.** Automatic release remains out of scope pending authenticated evidence and a separate decision record.

## M01-R1 — Release hardening & stability

- **M01-R1 — audit complete, manual homologation pending.** No feature scope added. Automated regressions and disposable-profile startup smoke pass. The audit, risk matrix, known lifecycle limitation, manual checklist and M01-R2 Windows packaging requirements are in [validation/m01-r1-release-hardening.md](validation/m01-r1-release-hardening.md). Do not begin R2 automatically.

## M02 — Not defined yet

No scope has been decided. It will be defined after M01 is homologated. Items noted during M00 that are *not* commitments:

- Move user data to a ContextDeck-named folder with an idempotent migration (see Persistent identifiers in [architecture.md](architecture.md)).
- Packaged distribution (installer) instead of running from source.
- Wide-character (CJK/emoji) width handling in the terminal (xterm unicode addon) if it proves necessary.
