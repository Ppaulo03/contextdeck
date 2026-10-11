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

- Herdr workspace → local directory / Git repository (replaces the single global repository).
- Herdr workspace → several ChatGPT conversations, each with a role (architecture, review, planning…).
- Per-workspace UI state (last tab, selected refs).
- Visible workspace ↔ conversation labelling so a message is never sent to the wrong project.

Starts with M01-I1. Out of scope: automatic prompt transfer, reading conversations, new inference integrations.

- **M01-I1 — implemented, awaiting homologation.** Read-only discovery of the workspaces of the configured Herdr session, change tracking, recovery, and a diagnostic panel ([validation/m01-i1.md](validation/m01-i1.md)). Finding: Herdr's API has **no per-client focus**, so the workspace visible in ContextDeck's own client cannot be identified (reported as `ambiguous`; `known` only with a single workspace). Nothing is associated with ChatGPT yet.
- **M01-I2 — implemented, awaiting homologation.** Top-bar workspace selector with optimistic bidirectional focus sync: picking a workspace sends `workspace.focus` (the only write); TUI focus changes update the selector in Auto mode (Manual ignores them); startup/recovery never send a command. Assumes ContextDeck is normally Herdr's only client; the multi-client limitation stays explicit ([validation/m01-i2.md](validation/m01-i2.md)). Still no conversation association and no Git behaviour tied to the workspace.
- **M01-I2.5 — implemented, awaiting homologation.** UX, component architecture and performance hardening: design tokens, renderer components, a workspace menu overlay that works over the ChatGPT view, measured fixes and the M01-I3 view-strategy study ([validation/m01-i2-5.md](validation/m01-i2-5.md)). No features.
- **M01-I3P — spike done, awaiting review.** Feasibility of observing ChatGPT response/draft state and conversation identity ([validation/m01-i3p.md](validation/m01-i3p.md)). Result: lifecycle, URL identity and draft presence are observable; "response in progress" is a best-effort signal not yet validated against a live response; completed vs interrupted vs failed is not distinguishable. A disabled-by-default diagnostic observer exists (`CONTEXTDECK_CHAT_OBSERVER=1`); no UI, no unloading, no multi-chat. Lifecycle must default to preserving views.
- **M01-I3A — implemented, awaiting homologation.** Persistent chat ↔ workspace bindings: several conversations per workspace, each with a label and a category; identity by Herdr session + workspace id and by the conversation UUID in the URL; own versioned file (`chat-bindings.json`) with atomic writes and a never-discard corruption policy; explicit confirmation for estimated destinations, conflicts and reassignment; orphans preserved; the top-bar indicator now reflects the real binding of the page and opens a management panel in the existing overlay. The ChatGPT view is still a single `WebContentsView`; the transient `ChatRuntime` is only a contract. Decision: [0002](decisions/0002-chat-bindings.md); results and manual script: [validation/m01-i3a.md](validation/m01-i3a.md).
- **M01-I3B — not started.** Navigation between a workspace's conversations (selected/last conversation, quick switching), runtime per binding (generation/draft/attention indicators), several views. Needs approval and I3A homologation.
- **M01-I3C — not started.** View lifecycle/eviction policy (default: preserve everything; see the I3P recommendations).

## M02 — Not defined yet

No scope has been decided. It will be defined after M01 is homologated. Items noted during M00 that are *not* commitments:

- Move user data to a ContextDeck-named folder with an idempotent migration (see Persistent identifiers in [architecture.md](architecture.md)).
- Packaged distribution (installer) instead of running from source.
- Wide-character (CJK/emoji) width handling in the terminal (xterm unicode addon) if it proves necessary.
