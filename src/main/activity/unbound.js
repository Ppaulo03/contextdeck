'use strict';

// Actions on conversations that belong to no workspace (M01-I3B-3). Plain Node.
//
//   open  shows the conversation: it brings up the chat tab and selects the view. It never sends workspace.focus, never
//         changes the selected workspace and never binds anything (the destination of a conversation is a choice).
//   bind  attaches the conversation to the workspace the user picked, through the I3A operation (same destination rules,
//         conflict protection and status checks). The view is untouched: the navigator re-scopes it on its next reconcile,
//         so the page, its observation, draft and pending attention survive.
//   create  a fresh page that belongs to no workspace.
function createUnboundActions({ session, bindings, navigator, showChatTab, getMode }) {
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  function open({ viewId } = {}) {
    if (getMode() !== 'chat') showChatTab();
    return navigator.openUnbound({ viewId });
  }

  function create() {
    if (getMode() !== 'chat') showChatTab();
    return navigator.newUnbound();
  }

  function bind({ viewId, workspaceId, label, selectedAtOpen, confirmTarget } = {}) {
    if (typeof workspaceId !== 'string') return fail('invalid_target', 'Destino invalido.');
    const target = navigator.unboundTarget(viewId);
    if (!target.ok) return target;
    // The workspace was picked from a list in the form: that is the explicit choice (`targetChosen`).
    const result = bindings.bind({
      target: { session, workspaceId },
      url: target.url,
      origin: 'current-page',
      label,
      selectedAtOpen,
      confirmTarget: confirmTarget === true,
      targetChosen: true
    });
    if (result.ok) navigator.reconcile();
    return result;
  }

  return { open, create, bind };
}

module.exports = { createUnboundActions };
