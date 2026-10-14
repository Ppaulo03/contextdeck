'use strict';

// Decides what a before-input-event means. Pure so it can be unit-tested.
// Returns 'toggle' (switch tab once), 'swallow' (consume without acting) or null (not ours).
//
// Only the initial physical keyDown toggles. Auto-repeat keyDowns (key held) are swallowed so
// they neither toggle again nor leak a Tab into the terminal, and keyUp is ignored: with Ctrl
// still held it would otherwise match "ctrl+tab" again on the webContents that now has focus.
function decideShortcut(input) {
  if (!input || !input.control || input.alt || input.meta) return null;
  if ((input.key || '').toLowerCase() !== 'tab') return null;
  if (input.type !== 'keyDown') return null;
  return input.isAutoRepeat ? 'swallow' : 'toggle';
}

// Handler for `before-input-event`, installed on both the UI and the ChatGPT web contents so the
// shortcut works whichever one has focus.
function createShortcutHandler(toggle) {
  return (event, input) => {
    const decision = decideShortcut(input);
    if (!decision) return;
    event.preventDefault();
    if (decision === 'toggle') toggle();
  };
}

module.exports = { decideShortcut, createShortcutHandler };
