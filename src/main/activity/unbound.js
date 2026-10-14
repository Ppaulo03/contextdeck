'use strict';

// Pages that live in no workspace (M01-I3B-3, exceptional). Plain Node.
//
// Workspace-first: the normal way to attach a conversation to a workspace is to open it IN that workspace (see
// chat-bindings/context-adoption.js). This module only keeps such a page reachable: "open" brings up the chat tab and shows
// it. With a workspace selected the navigator puts the page in that workspace's context (the user's explicit act) where the
// normal rules apply; with none selected it stays as it is. It never sends workspace.focus and never binds anything itself.
function createUnboundActions({ navigator, showChatTab, getMode }) {
  function open({ viewId } = {}) {
    if (getMode() !== 'chat') showChatTab();
    return navigator.openUnbound({ viewId });
  }
  return { open };
}

module.exports = { createUnboundActions };
