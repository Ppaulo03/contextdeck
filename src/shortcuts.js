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

module.exports = { decideShortcut };
