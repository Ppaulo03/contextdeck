# 0001 — Herdr is the source of truth for workspaces

- Status: Accepted
- Date: 2026-10-10
- Applies to: M01 onwards

## Context

ContextDeck must support two or three projects at once, each with its own terminal agents and several ChatGPT conversations. M00 knows a single Herdr session name (`herdrSession`) and a single Git repository. Herdr already manages sessions, workspaces, tabs, panes and agents and exposes them through its CLI/API (`herdr workspace …`, `herdr session …`, `herdr api …`).

## Decision

**Herdr owns the workspaces.** What exists, how it is named and ordered, and which panes/agents live in it is decided and stored by Herdr. ContextDeck does not create a parallel registry of "projects" and does not recreate workspace functionality.

ContextDeck stores only **associations** keyed by the Herdr workspace identity:

- workspace → local directory / Git repository;
- workspace → ChatGPT conversations (URL and role, e.g. architecture, review, planning);
- workspace → UI state (last tab, selected Git refs).

Associations are explicit (chosen by the user, shown in the UI) so a message is never sent to the wrong project's conversation.

## Consequences

- ContextDeck reads Herdr state (read-only) instead of mirroring it; it never changes Herdr's configuration or kills sessions/agents it did not start.
- A workspace removed or renamed in Herdr leaves an *orphaned* association. It is shown as such and kept until the user removes it; it is never deleted automatically.
- Preferences move from "global" and "per repository" (current `ui-state.json`) to "per workspace"; the current per-repository record is designed to be attached to a workspace later, and M00 files must keep loading.
- The Herdr CLI/API becomes a dependency of the UI; failures must degrade to the M00 behaviour (single configured session).

## Alternatives considered

- **ContextDeck owns projects and launches one Herdr session per project.** Rejected: duplicates Herdr, drifts from what the user does inside Herdr, and conflicts with "do not recreate what Herdr already offers".
- **Free-form per-conversation notes with no workspace link.** Rejected: reintroduces the context-mixing risk this work exists to remove.

## Open questions (to resolve in M01-I1, not assumed here)

- Whether Herdr workspace identifiers (the `w<n>` ids seen in pane environments) are stable across Herdr restarts, or a different key (name, directory) is needed.
- Which Herdr command or socket call lists workspaces cheaply and reliably from outside a pane, and what it returns on Windows.
- How to present associations whose workspace no longer exists.
