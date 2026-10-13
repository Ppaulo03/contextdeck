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

## Authenticated collection protocol

This collection is discovery only. Do not suspend the tested conversation. Use one authenticated conversation and a disposable file. Start the app with only `CONTEXTDECK_COMPOSER_TRACE=1`; leave `CONTEXTDECK_CHAT_TRACE` and `CONTEXTDECK_CHAT_OBSERVER` unset. Schema 2 appears in a `trace-started` event. Keep a separate note of the UTC timestamp when each step begins so the corresponding probes can be grouped.

1. **Empty:** leave the composer empty and unchanged for at least three accepted probes.
2. **Selected attachment:** add a disposable file. Note the instant the file appears in the composer and leave it there for at least three probes.
3. **Upload:** if the UI shows upload activity, note its start and finish separately. Keep the attachment staged after upload and collect at least three probes.
4. **Removed:** remove the staged file and collect at least three probes after the UI is settled.
5. **Text draft:** type a short disposable draft (do not send), collect three probes, then clear it and collect three more.

Do not paste private content into the draft. The detector discards text locally and the trace only records `draftState`.

When sharing results, provide only schema-2 lines for the test view plus the UTC scenario marker times. Do not provide screenshots, conversation content, filenames or the full profile. Existing schema-1 and schema-2 entries may coexist because the trace is append-only.

## Decision gate

Only a repeatable structural feature that is present for staged attachments, changes on removal, is scoped to the active composer rather than old messages, and is absent in the empty case can support a future detector rule. Upload-in-progress should be treated separately from upload-complete-but-unsent. If the trace does not establish these distinctions, retain `unknown`; do not add an absence-based empty rule.

After a detector change, a separate authenticated run must show both that a pending attachment blocks and that a truly empty composer can pass all other lifecycle checks, be suspended, and be restored as the same conversation. This trace alone does not homologate I3C-1.
