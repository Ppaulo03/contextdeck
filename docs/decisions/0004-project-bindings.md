# 0004 — Project bindings: a workspace's ChatGPT Project, never inferred

- Status: **Proposed / experimental** (behind `CONTEXTDECK_PROJECTS=1`). The Project/conversation URL shapes were observed on a real account (see validation); rename behaviour and a verified sign of a first send are NOT.
- Date: 2026-10-11
- Applies to: M01-I3B-3 (builds on [0002](0002-chat-bindings.md) and [0003](0003-multi-view-navigation.md))

## Context

A ChatGPT Project is a native entity of ChatGPT. ContextDeck does not manage Projects (no instructions, files or remote state). The only goal: "+ Nova conversa" in a workspace can start in that workspace's Project, and the resulting conversation can be attached to the workspace — without ever inventing the association.

What is known and what is not:

- **Observed in this repository / by tests only:** the conversation parser of I3A already models `/g/<project>/c/<uuid>` (a conversation reached through a Project route); nothing in the repository records a real logged-in Project URL.
- **Not observed (hypothesis, see [validation/m01-i3b-3.md](../validation/m01-i3b-3.md)):** the exact shape of a Project's home (`/g/g-p-<32 hex>[-slug]/project`), whether the id is 32 hex digits, whether the slug changes on rename, the URL of a new chat inside a Project before its first message, and what the UI does on navigation out of a Project. The agent session has no logged-in ChatGPT, and reading a real account's pages is excluded by the project's hard constraints.

## Decisions

1. **ProjectBinding ≠ ChatBinding.** A ProjectBinding says "new conversations of this workspace start in this Project". It never says anything about an existing conversation, and linking one moves, binds, reloads or edits nothing. Own file `project-bindings.json` (schema 1, atomic write, same corruption/future-schema/quarantine policy as chat-bindings.json — the store is shared code parametrised by model), created only when a link is made and only when the feature is on.
2. **Identity = the Project id from the URL, never the name.** The parser is strict (`src/main/chat/project-identity.js`): `g-p-` + exactly 32 lower-case hex digits, optional slug. Hex has no hyphen, so the id/slug split is exact; anything else is refused, not split by guess. The slug only proposes an editable label. Linking the same id with another slug is a rename and updates the same record.
3. **Workspace identity = session + workspace id + recovery metadata**, judged by the *same* function as chat bindings (`workspaceStatus`: linked / suspect / orphan / unverified). A suspect (recreated) workspace cannot be written to — or have its Project used for new conversations — without an explicit `replace`. A Project is never attached to a new workspace because it reused `w1`.
4. **Write rules are shared, not copied.** The destination is verified by the chat service's own `verifyTarget` (Herdr connected, session, no pending switch, `selectedAtOpen`, workspace exists, explicit destination or `targetChosen`). One Project per workspace and one workspace per Project; replacing or moving is explicit (`replace`, `move`), never silent.
5b. **Identifying the Project is not proving a creation (hardening).** The observed new-chat URL equals the Project home and a created conversation has the same URL shape as an old one, so the Project id in a `/c/` URL says nothing about when the conversation was created. Automatic binding therefore needs an independent `evidence(viewId)`; none is verified, so none is wired and the user binds explicitly. Pages from failed intents are released to "Sem workspace" so they stay reachable.
5. **Creation is an intent held in its own module** (`project-bindings/creation.js`), not in the navigator and not persisted. "Nova conversa" opens the Project page in a **new** temporary view scoped to the workspace captured at the click. The conversation is bound — by the ordinary `bindings.bind`, origin `project-new` — only when its id appears AND: the view is alive and still in that workspace; the selected workspace is still the captured one; the workspace's ProjectBinding is the same record; the conversation URL carries **that** Project's id; nothing else binds it; the destination is explicit. Otherwise the intent ends with a code (`context-changed`, `project-changed`, `outside-project`, `navigated-away`, `already-bound`, `view-closed`, `refused:*`) and the page stays a recoverable temporary conversation. No retry, no compensating `workspace.focus`, no automatic return to the previous workspace.
6. **Off by default.** Until a person records the real routes, `CONTEXTDECK_PROJECTS` must be `1` for any of it to exist: no file is read or written, no UI section, and "Nova conversa" behaves exactly as before. Turning the default on is a separate decision that needs the evidence.

## Consequences

- Positive: the Project integration cannot create a wrong association by construction; everything it cannot prove leaves the conversation recoverable (and the "Sem workspace" box of block 1 keeps it reachable when it is not in a workspace).
- Negative: if the real routes differ from the hypothesis the feature simply never binds (it refuses, it does not guess) and the parser must be corrected with evidence. A conversation started in a Project while the selection is only an estimate (Auto followed Herdr) is not bound automatically.
- Not decided: whether to open a Project (not only to start a conversation), automatic detection of a Project from the sidebar, sharing one Project between workspaces.
