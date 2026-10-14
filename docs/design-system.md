# Design system and renderer components

A compact dark theme in the spirit of IDE tooling. Everything visual comes from design tokens; components
are small modules with one responsibility each. No CSS framework and no UI framework.

## Styles (`src/renderer/styles/`)

Built by `scripts/build.js` into one `dist/renderer/styles.css` (the `@import`s are inlined). The overlay page
loads the same file plus `overlay/overlay.css`.

| File | Contents |
|---|---|
| `tokens.css` | The **only** place with raw values: surfaces, borders, text, accent, status colors, typography, spacing scale (`--space-1…6`), radii, control heights, layers (`--z-panel`, `--z-menu`), shadow, motion, terminal palette. |
| `base.css` | Reset, element defaults, one `:focus-visible` ring, `[hidden]`, `prefers-reduced-motion`. |
| `layout.css` | App frame (top bar, content, footer), mode-dependent visibility (`.terminal-only` / `.chat-only`), responsive breakpoints. |
| `components.css` | Buttons, controls and select triggers, the segmented view switch, toggle, badges, menus, status line, diagnostics panel. |

Rules enforced by `test/structure.test.js`: no raw hex/rgb colors, no literal `z-index`, no font stacks outside
`tokens.css`. State is expressed with `aria-*` (`aria-busy`, `aria-pressed`, `aria-disabled`) or `.is-*` classes.
Animation exists in one place (the pending spinner) and is disabled by `prefers-reduced-motion`.

## Components (`src/renderer/components/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `dom.js` | `$`, `el`, `setAttr`, `setText` (text is always set with `textContent`, never HTML). | – |
| `feedback.js` | The status line in the footer, with an error level. | `dom` |
| `herdr-store.js` | The single subscription to Herdr state pushed by main, plus one initial read; components subscribe to it. | bridge |
| `header.js` | Terminal/ChatGPT segmented switch (`aria-selected`), per-view controls. | `dom`, bridge |
| `terminal-view.js` | xterm.js, copy/paste, PTY resize (frame-coalesced, only when the grid changes). Theme from tokens. | bridge, `feedback` |
| `workspace-selector.js` | Combobox-style trigger + Auto/Manual toggle; opens the menu overlay. | `store`, `feedback`, shared view-model |
| `git-panel.js` | Git tools and pickers in the footer. | `dom`, `feedback`, bridge |
| `herdr-panel.js` | Read-only diagnostics over the terminal area. | `dom`, `store`, bridge |
| `dropdown.js` | Select-like trigger + the shared list, for the overlay panels (replaces the native `<select>`). | `dom` |

`app.js` only creates the components and connects them. `src/shared/workspace-view.js` is a pure view-model
(trigger text/tone/busy, menu items, filtering) used by the trigger and by the menu, and unit-tested in Node.

## Top bar

Order: ContextDeck name · Terminal/ChatGPT segmented switch · workspace selector and Auto/Manual · global activity indicator · contextual actions · "Chat sem projeto" hint (ChatGPT view only). The switch is one fixed-size group (`.segmented` / `.segment`, same height family as the workspace controls); the selected segment is a filled pill, hover and `:focus-visible` states use the shared tokens, and nothing changes size when switching. The Herdr session name is not in the bar: it is shown in the diagnostics panel. Narrow windows hide the name and the "Workspace" label (≤1000 px) and let the actions scroll (≤700 px effective).

## Opened lists and the spinner (shared, M01-I3B-2H polish)

- **One look for every list that opens.** The workspace menu (`.menu-panel`), the Git pickers (`.picker-panel`) and the dropdowns inside the overlay panels (`.dd-popup`) share ONE container rule in `components.css` (surface `--bg-raised`, `--border-strong`, `--radius-lg`, `--shadow-popover`, `--space-3` padding) and ONE row rule (`.menu` / `.menu-item`: same padding, hover/active/selected states, keyboard focus ring). Only placement and maximum height differ per list. A test fails if a list gets a look of its own.
- **No native `<select>`.** The operating system draws its open list, which cannot match. `components/dropdown.js` is the replacement used by the bindings panel (destination): the same trigger as the workspace selector (`.control.select`) and a list of `.menu-item` rows; ↑/↓/Home/End/Enter/Space, Esc closes only the list (a second Esc closes the panel), a click outside closes it.
- **One spinner.** A thin arc whose tail fades out (conic gradient cut into a ring by a mask), one rule for every use: the pending caret of the workspace selector, a loading tab, the "responding" indicators. The only `@keyframes` of the application; with `prefers-reduced-motion` the arc stays as a static ring.
- The × of the activity center and of the bindings panel closes the overlay like Esc and a click outside.

## Global activity (M01-I3B-2H)

- **Indicator** (`activity-indicator.js`): a pill in the top bar after the workspace selector, on every tab. Shapes carry the meaning, not color: a spinning ring for responding (`↻` in menus and text), `●` for activity to review, `✎` for an unsent draft, `○ Atividade` when quiet. Fixed minimum width (96 px, 52 px under 1000 px where the label is dropped), accessible name and tooltip spell out the counts and what is observed; the only animation is the existing spinner keyframes (off under `prefers-reduced-motion`).
- **Activity center and notices** (`overlay/activity-center.js`, `overlay.css`): two more modes of the overlay page, built from the menu panel tokens. Group titles show workspace name and id exactly as they are (no upper-casing: homonyms). Notice cards sit in a small non-focusing rectangle and use no animation or transition.
- Wording is part of the design: **"Atividade para revisar"**, never "concluída"/"terminou"; a conversation never loaded is absent, never "ociosa".

## Workspace menu (`src/renderer/overlay/`, `src/main/overlay.js`)

The ChatGPT page is a native `WebContentsView`; it always paints over the local UI's DOM, so an HTML popover (or any
`z-index`) would be hidden in the ChatGPT tab. The menu therefore lives in its own transparent local view that main adds
on top of the window only while it is open, which works in both tabs.

- Opens from the trigger (click, Enter/Space, ↓/↑); the trigger sends its rectangle, main validates it.
- Keyboard: ↑/↓/Home/End move, Enter chooses, Esc and Tab close; a search box appears when there are 7 or more
  workspaces. Focus returns to the trigger on close.
- Closes on click outside (the view covers the window), resize, minimize, or tab switch (including `Ctrl+Tab`).
- Choosing goes through the same validated selection channel as everything else; failures stay visible inside the
  menu, which stays open.
- Accessibility: trigger is `role=combobox` with `aria-haspopup/expanded`; the menu is a dialog with a
  `listbox` and `aria-activedescendant`; the visible focus ring is the active row. Trade-off: the trigger and the menu
  are different documents, so `aria-controls` cannot link them; the dialog gets focus and a label instead.
- Cost: one extra renderer process, created on first use and kept (see `validation/m01-i2-5.md` for the measurement).

## Transitions

The trigger keeps the last known workspace label while a switch is pending; only a small spinner replaces the caret
and the tooltip says what is happening. Its width is fixed per breakpoint. Disconnection dims the last label instead
of replacing it. Requested, observed and confirmed state stay distinguishable in the tooltip and the diagnostics panel;
failures and uncertainty are never hidden.

**Binding panel (M01-I3B-3).** The destination is a dropdown whose current choice is the confirmation: no checkbox. A destination that is only an estimate is not preselected; the panel says so and asks for a workspace. The Project section and the "Sem workspace" rows reuse `.chats-row`, `.chats-note`, `.chats-banner` and `.btn`; a decision that replaces or moves something is a banner with an explicit button.
