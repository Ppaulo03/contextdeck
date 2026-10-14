# M01-I3C-1H2 — Authenticated composer trace follow-up

## Existing trace analysis

The supplied `%APPDATA%\Project Dock M00\diagnostics\composer-trace.jsonl` contains 85 events: 55 probes, 26 eligibility changes and four trace-start records, across `v1`–`v3`.

For `v2`, 16 probes report `composerState=ambiguous`. Every one has six visible editable nodes, no selected composer form and no submit-form match in the fields collected by schema 1. The locator first checks known composer selectors, then chooses the last editable inside a form containing a submit control, then accepts a lone editable. With six editables and no matching form, it deliberately refuses to guess. The old trace does not include the ancestry of those six nodes, so it cannot distinguish message editors, document/tool editors, or an alternate composer surface.

In `v2`, one earlier probe had `draftState=present` with six editable nodes, followed by ambiguous probes. That proves text was present in the selected editable at that time; it does not establish which editable it was. The trace does not carry enough state to interpret the later disappearance as a particular UI transition.

Across the 55 probes, no composer-form file input was populated and no progressbar was seen. Four file inputs were counted inside the selected composer form on probes where a composer was found. Schema 1 did not record their visibility, placement around each editable, or changes during add/upload/remove actions. These zero/unchanged indicators do **not** prove attachment absence. No suspension was eligible, as expected under the conservative policy.

## Schema 2 diagnostic additions

With `CONTEXTDECK_COMPOSER_TRACE=1`, the existing per-view poll now records bounded structural evidence:

- Why the locator selected a composer or declined to select one.
- Counts of known composer selector hits and forms with an editable plus a submit control.
- Up to eight editable nodes, with tag/role enums, visibility, form relation, and up to five ancestor levels.
- Per-ancestor counts of buttons, images, file inputs, progressbars, busy nodes, test-id nodes, labeled nodes, list items, and selected attachment/upload attribute names.
- Document-level editable, form, progressbar and busy counts; file-input totals, visibility/populated counts and count inside the selected form.

The evidence is for comparing structure around operator-marked state changes. Candidate counts are **not** classified as attachment chips, and they never authorize `empty`. `unsentState` remains `unknown` unless a positive pending-work signal produces `present`; the diagnostic sanitizer also downgrades an unexpected raw `empty` to `unknown`.

`viewVisible` is the observation hub's interaction flag: the app window is shown, focused and not minimized **and** this view is selected/attached in the ChatGPT pane. `false` does not mean the WebContentsView was closed or destroyed; background views remain loaded and managed.

The probe does not return text or attribute values for the new structure. It does not read `innerHTML`, filenames, file bytes, URLs, cookies, tokens or message text. Tag and role names are allowlisted; counts and arrays are bounded. Existing generation/draft protections and the final lifecycle revalidation remain in place. The trace uses the existing observer poll and adds no observer or timer.

## Schema 4 diagnostic additions

The 85-event schema-1 collection found that `v2` was ambiguous because six editable nodes had no qualifying submit form. The later schema-2 collection resolved `v2` to one visible `div[role=textbox]` inside a qualifying form. It still did not identify staged-file chips. In the appended schema-2 observations, `v3` also had long ambiguous stretches with six visible editables and no eligible submit form; a single positive progress observation is useful for upload activity, but the surrounding zero counts do not establish an empty composer.

Schema 3 added bounded attachment candidate inspection only after the locator had selected a composer. That could not help explain `v3`, where six editables remain ambiguous.

The latest authenticated schema-3 sample for `v3` (2026-10-14 00:16 UTC) reports six visible `div[role=textbox]` editables, one document form, and zero eligible forms. Five editables are outside a form; the sixth is inside the one form, but no form qualifies with a recognized submit control. Thus the locator cannot use its “editable in a form with send/stop control” tier, and cannot use its single-editable fallback. It correctly returns `ambiguous`; it does not prove which of the six is the active composer.

Schema 3 emitted no attachment candidates for `v3` because no composer was selected and its neighborhood scan was not entered. Therefore that empty candidate list is not evidence about the actual UI. The log has no A–E operator markers, so it cannot distinguish the live empty, staged, removed or draft states.

Schema 4 applies the same bounded structural scan to each of up to eight visible editable candidates when the composer is ambiguous. Candidates carry the editable index only when a single editable is associated with the relevant form; a form shared by multiple candidates is marked `candidate-form` with no editable index. `selectedComposer=false` explicitly means the locator did not select that editable. Ancestor counts include submit controls, so the collection can compare each editable with nearby send controls and candidate attachment structures without choosing one.

Each candidate contains only an allowlisted tag/role, visibility, bounded depth, structural scope (`composer-form`, `candidate-form` or `editable-parent`), relation to a detected message boundary, and category hints such as `attachment-hint`, `upload-hint`, `remove-hint`, `file-input`, `progressbar`, `busy`, `list-item`, and `image`. Labels, test IDs, titles, class values, filenames, URLs, text and HTML are never emitted. Category matching happens locally and outputs only enums. A candidate hint is observational only; it never changes lifecycle state.

Candidates outside the selected form or inside a distinct message boundary are observations only; they are not classified as pending composer attachments. An absent boundary is `null`/unknown, not proof that the candidate belongs to the composer. Candidate presence does not itself change `unsentState`, and an empty candidate list never changes it from `unknown`. The instrumentation uses the existing per-view probe and adds no observer, polling timer, lifecycle action or suspension rule.

Automated DOM fixtures validate the category sanitizer and bounds only. They are not evidence of authenticated ChatGPT markup or attachment behavior.

## Authenticated collection protocol

This collection is discovery only. Do not suspend the tested conversation. Use one authenticated conversation and a disposable file. Start the app with only `CONTEXTDECK_COMPOSER_TRACE=1`; leave `CONTEXTDECK_CHAT_TRACE` and `CONTEXTDECK_CHAT_OBSERVER` unset. Schema 4 appears in a `trace-started` event. Keep a separate note of the local time and A–E label for each step so the corresponding probes can be grouped.

1. **A — Empty baseline:** leave the composer empty and unchanged until three accepted probes arrive.
2. **B — Text draft:** type a short disposable draft without sending; wait for three accepted probes.
3. **C — Uploaded attachment staged:** add a disposable file, wait until upload is complete, leave it attached and unsent, then wait for three accepted probes.
4. **D — Attachment removed:** remove the staged file and wait for three accepted probes after the UI settles.
5. **E — Empty after removal:** leave the composer empty and unchanged for three accepted probes.
6. **Historical attachment (if already available in the disposable conversation):** while the composer is empty, mark a probe window with the old sent attachment visible in history. Do not send a new message solely for this comparison. This distinguishes message-history candidates from composer candidates.

For every state transition, use the exact A–E label in the operator message and identify the view by its trace view ID. Count accepted probes, not merely elapsed time or discarded stale probes. Do not suspend during this discovery collection. If no schema-4 candidate changes consistently between staged and removed while staying distinct from historical attachments, preserve `unsentState=unknown` and stop adding heuristics.

Do not paste private content into the draft. The detector discards text locally and the trace only records `draftState`.

## Follow-up live collection (2026-10-13)

The operator walked through empty, attachment selected, upload completed, attachment removed, draft typed, and draft cleared in the authenticated view `v3`. These observations are from the schema-2 trace; the operator's action labels identify the stages, while the trace contains no private composer content.

| Stage | Sanitized observation | Conclusion |
|---|---|---|
| Empty and stable | At 23:47:50 UTC, composer found structurally and `draftState=empty`; `unsentState=unknown`. | Text absence was observable, but attachment absence was not proven. No suspension eligibility. |
| Attachment selected | At 23:49:29 UTC, a visible progressbar was detected and `unsentState=present` with reason `upload-progress`. | Positive evidence blocks during upload. |
| Upload completed, still staged | Subsequent probes no longer saw progress; file inputs remained unpopulated/invisible and `unsentState=unknown`. | No reliable completed-but-unsent signal was identified. Unknown correctly remains blocking. |
| Attachment removed | Around 23:52:03 UTC, a probe found the composer and `draftState=empty`, while `unsentState=unknown`; later probes became ambiguous. | Removal did not produce evidence sufficient to classify attachments as absent. |
| Draft typed | From around 23:55:25 UTC, the composer was found and `draftState=present`; eligibility included `draft` and `unsent-unknown`. | Text draft detection and its lifecycle block were demonstrated without collecting text. |
| Draft cleared (`limpo`) | From around 23:56:56 UTC, and in the latest probes through 23:58:26 UTC, six visible editables were reported, zero eligible submit forms, `locatorReason=multiple-editables-no-submit-form`, and both draft/unsent were `unknown`. | The trace cannot confirm the cleared state because it no longer identifies the composer. This is a locator ambiguity, not evidence that text remains. |

In the latest ambiguous samples, the document had one form and six visible editables; none of the forms qualified as containing an editable plus submit control. File-input totals varied with page structure (four in the latest sample), but none was visible or populated. Such counts and absences are not treated as proof about staged attachments. `viewVisible=true` in these samples means the view was selected and interactive under the observer's definition; it does not alter the ambiguity of the composer locator.

This live run confirms one positive signal during upload and confirms text-draft detection. It does **not** establish a structural marker for a completed staged attachment, does not establish trustworthy `unsentState=empty`, and did not attempt suspension or restoration. Keep the conservative block. A future collection should focus on the composer locator ambiguity and the upload-complete/removal transition; it must not infer empty from missing file inputs, progressbars, or chips.

When sharing results, provide only schema-4 lines for the test view plus the A–E operator markers. Do not provide screenshots, conversation content, filenames or the full profile. Existing schema-1 through schema-4 entries may coexist because the trace is append-only.

## Decision gate

Only a repeatable structural feature that is present for staged attachments, changes on removal, is scoped to the active composer rather than old messages, and is absent in the empty case can support a future detector rule. Upload-in-progress should be treated separately from upload-complete-but-unsent. If the trace does not establish these distinctions, retain `unknown`; do not add an absence-based empty rule.

After a detector change, a separate authenticated run must show both that a pending attachment blocks and that a truly empty composer can pass all other lifecycle checks, be suspended, and be restored as the same conversation. This trace alone does not homologate I3C-1.
