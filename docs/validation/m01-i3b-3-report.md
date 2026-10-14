# M01-I3B-3 - final review report

Branch `feature/m01-i3b-3-project-integration`, base `8061d60`. Code HEAD at the time of the measurements below: `b947beb` (this report and the harness reports were committed after it, docs only). No push, no merge. Projects stay **off by default** (`CONTEXTDECK_PROJECTS=1`). I3C not started.

## 1. State by component
| Component | State | Evidence |
| --- | --- | --- |
| Workspace-first association (`context-adoption.js`, `ChatBindingsService.adopt`) | Implemented | `workspace-first.test.js` (56 tests) |
| Conflict decision (modal over the chat area; go / transfer / back) | Implemented | `conflict-modal.test.js` (17) |
| Deduplication (one page per conversation) | Implemented | transfer / focus-existing / sync tests |
| Unbind | Implemented | tab removed, not re-bound, page kept |
| Binding panel (no category, no checkbox, current workspace as default) | Implemented | `bind-simplification.test.js`, `chat-bindings-ui.test.js` |
| Project bindings, parser, panel, offer, outside-Project question | Implemented, experimental | `project-*.test.js`, `workspace-first.test.js` |
| Harness / start-up smoke | Reliable / added | section 5 |
| Manual homologation | **PENDENTE** | checklist in `m01-i3b-3.md` |

## 2. Findings of the final review
| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | High | The conflict modal covered the whole window and swallowed Ctrl+Tab: the user could not reach the Terminal or other conversations without answering | The modal covers only the chat area; the shortcut works; leaving the page closes the modal |
| 2 | High | Going back in history (Voltar, Transferir, opening an already-open conversation) could drop an unsent draft or an answer in progress; the reading of a page is dropped when its address changes, so "busy" was invisible at that moment | `isBusy` remembers the last reading before navigation; busy pages are moved/released instead of navigated |
| 3 | Moderate | *Ir para* left the page first and could fail afterwards (unverified or disconnected destination), leaving no place to show the error | Destination (`linked`, no switch in flight) is checked before the page leaves |
| 4 | Moderate | Unit tests never ran `index.js`; a use-before-create there went unnoticed until the app was started | `npm run smoke` (real start-up) |
| 5 | Moderate | The harness could run with the main application open and give misleading focus results | Exit 78 BLOCKED, verified |
| 6 | Info | Policy checks (no change needed): ProjectBinding is only the preferred destination for NEW conversations; a general conversation can be bound to a workspace that has a Project (the *Vincular* choice), existing bound conversations are never questioned, ProjectBindings are never altered by associations | Documented |

Audit of `context-adoption.js` (no code change needed, now covered by tests): creation in A with B selected later; Herdr offline then back; recreated session / reused `w1` (suspect); orphan; unverified; reload and passive redirects; explicit unbind; late events (state is re-read, never trusted from the event); adoption vs reassignment race (conflict, never moved). No automatic association happens unless the destination is proven (`adopt` requires connected + same session + workspace present + not suspect).

## 3. Residual risks
- Nothing has been exercised by a person on the authenticated account.
- Project rename behaviour (id/slug) is unobserved.
- Windows-native behaviour of the modal (minimize/restore/resize re-open) is covered by code and a structural test, not by an automated GUI test.
- Pages released from a workspace are kept loaded until the application closes (no lifecycle policy; I3C).
- The outside-Project question appears for every unbound conversation of a workspace with a Project; that was the requested behaviour and can be relaxed later.

## 4. Tests and metrics
`node --test`: **625 pass, 0 fail** (509 at the start of the iteration). `npm run check`: ok. Start-up smoke: ok. 31 commits since `8061d60`. Measurements of cost: a decision modal reuses the existing overlay view (no new renderer process); one extra navigation event per address change between id-less pages; no extra polling.

## 5. Harness (three consecutive runs at the final code HEAD, main application closed)
| Run | Exit | Checks | Report |
| --- | --- | --- | --- |
| 1 | 0 | 29/29 | `harness-reports/m01-i3b-3-harness-run1.json` |
| 2 | 0 | 29/29 | `harness-reports/m01-i3b-3-harness-run2.json` |
| 3 | 0 | 29/29 | `harness-reports/m01-i3b-3-harness-run3.json` |

History (kept): base commit failed 2 checks and hung; before the race fix 3/3 runs failed identically; after it 6/6 passed; two runs made with the application open were discarded as invalid (they are what motivated exit 78). Page-address re-assertions were needed in 0/3 of these runs (the race it handles occurs intermittently). The harness exercises a logged-out ChatGPT: it validates the plumbing, not behaviour that needs a login.

## 6. Blocking and non-blocking
- **Blocking for calling the iteration homologated:** the manual checklist (A-L).
- **Non-blocking:** Project rename evidence; lifecycle of released pages (I3C); GUI automation of native modal behaviour.

## 7. Git
Working tree clean after the docs commit. Commits are listed by `git log --oneline 8061d60..HEAD`.
