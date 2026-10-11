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

## Findings (M01-I1, Herdr 0.9.3 — see [validation/m01-i1.md](../validation/m01-i1.md))

- Workspace ids (`w<n>`) are opaque, **not reused** and **stable across a Herdr server restart**, so the verbatim id plus the session name is a usable association key (the id is only meaningful inside one session).
- Workspaces can be listed and observed from outside a pane through the local API (Windows named pipe, `session.snapshot` + event signals); the endpoint comes from `herdr session list --json`.
- The API has **no per-client focus**: ContextDeck cannot tell which workspace its own client shows when several exist. Associations must therefore never depend on following Herdr's focus.

## Open questions

- How to present associations whose workspace no longer exists (design question for M01-I2).
- Whether ids stay stable across a server **rebuild** from scratch (deleted session), not only a restart: not tested.
