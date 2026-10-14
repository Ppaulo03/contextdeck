# 0002 — Chat bindings: persistent, explicit, separate from runtime

- Status: Accepted (implemented in M01-I3A, awaiting homologation)
- Date: 2026-10-11
- Applies to: M01-I3A onwards (builds on [0001](0001-herdr-workspaces.md))

## Context

ADR 0001 says ContextDeck stores only explicit associations keyed by the Herdr workspace identity. M01-I3A implements the "workspace → ChatGPT conversations" half. Constraints that shaped it:

- Herdr ids (`w1`, `w2`…) are unique only **inside one session**; the CLI exposes no session UUID (`herdr session list --json` returns `name`, `socket_path`, `session_dir`, `default`, `running`). Within a running session ids are never reused and survive a server restart ([validation/m01-i1.md](../validation/m01-i1.md)), but a deleted-and-recreated session of the same name starts again at `w1`.
- The selector's "current workspace" is an optimistic estimate (Herdr's focus is session-wide, last writer wins).
- The I3P spike showed the live state of a ChatGPT page (generating, draft) is best-effort and can be `unknown`; its diagnostic hashes are not identifiers.

## Decisions

1. **Three separate concerns.** `ChatBinding` (persistent, one conversation ↔ one workspace), `WorkspaceChatContext` (the set of bindings of one workspace plus recovery metadata) and `ChatRuntime` (transient observations of a loaded page). The runtime is a *contract only* in this iteration ([runtime-contract.js](../../src/main/chat/runtime-contract.js)); the persistence modules may not import it, the detector or the observer (test-enforced). They will meet through the binding id in M01-I3B.
2. **Context identity = Herdr session name + workspace id.** Never the workspace name or directory. Because the session has no verifiable UUID, each workspace keeps a *recovery record* (last seen label and directory). A binding whose id still exists but whose label **and** directory both differ is `suspect` (probably a recreated session reusing the id) and is never silently trusted: the user re-confirms by reassigning it to that workspace. A rename alone keeps the directory, a directory change alone keeps the label, so both are tolerated; the record follows linked workspaces.
3. **Conversation identity = the UUID in the URL.** `/c/<uuid>` and `/g/<project>/c/<uuid>` map to the same key `c:<uuid>`, so a conversation reached through either route is one conversation. Anything without a durable id (`/`, a project's home, temporary chats) is *identity pending* and cannot be bound. Strict UUID matching: an unknown shape is refused rather than guessed.
4. **A file of its own: `chat-bindings.json`** in the userData folder (identifier added to `identity.js`). Not `ui-state.json`, because that file is a bag of disposable preferences rewritten whole by a sanitizer that drops what it does not know and resets to defaults on any error — the opposite of what user-authored data needs. Own file means: atomic write (temp + rename), independent schema version, and a corruption policy that never discards: a damaged file is *moved* to `chat-bindings.json.corrupt-<time>`; invalid entries inside a good file go to a persisted `quarantine`; a file from a newer schema is read-only and untouched; an unreadable file is read-only. `ui-state.json` and the Chromium partition are not modified.
5. **Writes need a verified, acknowledged destination.** Herdr connected, same session, workspace present, no selection pending, the workspace selected when the form opened still selected (`selectedAtOpen`), and — if the destination is only an estimate (selection followed Herdr's focus or was restored) — an explicit `confirmTarget`. Binding never moves Herdr's focus and never runs on observation, startup or reconnect.
6. **One workspace per conversation; conflicts are explicit.** Binding a conversation that already belongs elsewhere returns `conflict`; only `reassign` with `confirmReassign` moves it. Duplicates in the same workspace are refused. Unbinding removes only the binding (never the ChatGPT conversation). A workspace that disappears from Herdr leaves its bindings as **orphans**: preserved, listed, adoptable by explicit reassignment. Disconnected Herdr means `unverified`, never orphan.
7. **The management UI is the existing overlay** (a second mode of the same view, opened from the top-bar indicator that replaces "Chat sem projeto"): no new view, no permanent sidebar. Its channels are fixed and named (`chats:*`), accepted from the UI window and the overlay page only; the address of "the current conversation" is read by main from the ChatGPT view, never reported by the renderer or the remote page.

## Consequences

- Positive: no silent cross-project association; data survives crashes, bad edits and downgrades; the runtime can evolve without touching stored data.
- Negative: two UI senders may call `chats:*`; one extra file to back up; a recreated Herdr session whose first workspace shares neither name nor directory with the old one is only *flagged*, not auto-resolved; the project-URL shape is modelled, not yet validated against a logged-in Project.
- Not decided here: restoring the last selected conversation, the pool/eviction policy, and any automatic binding after the first message (M01-I3B/C).
