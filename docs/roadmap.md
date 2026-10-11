# Roadmap

Scope boundaries are deliberate: each milestone adds one capability and keeps the constraints of [AGENTS.md](../AGENTS.md) (no inference APIs, no scraping, manual ChatGPT login, Herdr untouched).

## M00 — Herdr + ChatGPT in one window ✅ homologated

Delivered in three iterations plus a foundation pass; record in [validation/m00.md](validation/m00.md).

- **I1:** Electron shell, Herdr in xterm.js/ConPTY, ChatGPT in an isolated persistent view, tab switching, clipboard.
- **I2:** `Ctrl+Tab` fix (no repeat), removal of redundant shortcuts/buttons, Git tools: diff, show, ZIP as a clipboard file, guarded ZIP deletion.
- **I3:** Git pickers fed by the repository, per-repository preferences, revalidation in main.
- **R00:** ContextDeck identity, modular `src/` layout, `dist/` build output, config split, documentation. No functional change.

## M01 — Workspaces (not started)

Goal: work on two or three projects at once without mixing contexts. Direction fixed by [ADR 0001](decisions/0001-herdr-workspaces.md): **Herdr owns the workspaces**; ContextDeck stores only the associations, and they are explicit:

- Herdr workspace → local directory / Git repository (replaces the single global repository).
- Herdr workspace → several ChatGPT conversations, each with a role (architecture, review, planning…).
- Per-workspace UI state (last tab, selected refs).
- Visible workspace ↔ conversation labelling so a message is never sent to the wrong project.

Starts with M01-I1 (discovery of Herdr workspaces and the association model); anything beyond that is refined there. Out of scope: automatic prompt transfer, reading conversations, new inference integrations.

## M02 — Not defined yet

No scope has been decided. It will be defined after M01 is homologated. Items noted during M00 that are *not* commitments:

- Move user data to a ContextDeck-named folder with an idempotent migration (see Persistent identifiers in [architecture.md](architecture.md)).
- Packaged distribution (installer) instead of running from source.
- Wide-character (CJK/emoji) width handling in the terminal (xterm unicode addon) if it proves necessary.
