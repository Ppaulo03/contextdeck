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
| `components.css` | Buttons, controls and select triggers, tabs, toggle, badges, menus, status line, diagnostics panel. |

Rules enforced by `test/structure.test.js`: no raw hex/rgb colors, no literal `z-index`, no font stacks outside
`tokens.css`. State is expressed with `aria-*` (`aria-busy`, `aria-pressed`, `aria-disabled`) or `.is-*` classes.
Animation exists in one place (the pending spinner) and is disabled by `prefers-reduced-motion`.

## Components (`src/renderer/components/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `dom.js` | `$`, `el`, `setAttr`, `setText` (text is always set with `textContent`, never HTML). | – |
| `feedback.js` | The status line in the footer, with an error level. | `dom` |
| `herdr-store.js` | The single subscription to Herdr state pushed by main, plus one initial read; components subscribe to it. | bridge |
| `header.js` | View tabs, per-view controls, session label. | `dom`, bridge |
| `terminal-view.js` | xterm.js, copy/paste, PTY resize (frame-coalesced, only when the grid changes). Theme from tokens. | bridge, `feedback` |
| `workspace-selector.js` | Combobox-style trigger + Auto/Manual toggle; opens the menu overlay. | `store`, `feedback`, shared view-model |
| `git-panel.js` | Git tools and pickers in the footer. | `dom`, `feedback`, bridge |
| `herdr-panel.js` | Read-only diagnostics over the terminal area. | `dom`, `store`, bridge |

`app.js` only creates the components and connects them. `src/shared/workspace-view.js` is a pure view-model
(trigger text/tone/busy, menu items, filtering) used by the trigger and by the menu, and unit-tested in Node.

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
