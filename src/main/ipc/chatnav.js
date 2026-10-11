'use strict';

// Conversation navigation channels (M01-I3B-1). Callable only by the local UI window (not by the overlay and
// never by the remote ChatGPT page). Every argument is picked field by field and checked in main; the navigator
// re-validates the rules (selected workspace, status of the binding, pending switches). None of them takes an
// address: main opens a conversation from the stored binding, never from what the renderer says, and none of
// them moves Herdr's focus.
const denied = { ok: false, error: { code: 'untrusted', message: 'Untrusted IPC caller' } };
const invalid = (message = 'Pedido invalido.') => ({ ok: false, error: { code: 'invalid_request', message } });

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const BINDING_RE = /^b_[0-9a-f]{16}$/;
const VIEW_RE = /^v[0-9]{1,6}$/;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// `newConversation` (optional) replaces the navigator call of chatnav:new: main uses it to start the conversation in the
// workspace's Project. Its only input is still the workspace key.
function registerChatNavIpc({ ipcMain, trusted, trustedOverlay = () => false, win, newConversation = null, resolve = null }) {
  const nav = () => win.getNavigator();
  const guarded = (fn) => (event, args) => {
    if (!trusted(event)) return denied;
    const navigator = nav();
    if (!navigator) return { ok: false, error: { code: 'not_ready', message: 'O ChatGPT ainda nao esta pronto.' } };
    if (!isPlainObject(args)) return invalid();
    return fn(navigator, args);
  };

  ipcMain.handle('chatnav:state', (event) => (trusted(event) && nav() ? nav().getState() : null));

  ipcMain.handle('chatnav:select', guarded((navigator, args) => {
    if (typeof args.bindingId !== 'string' || !BINDING_RE.test(args.bindingId) || typeof args.workspaceKey !== 'string' || !KEY_RE.test(args.workspaceKey)) return invalid();
    return navigator.selectBinding({ bindingId: args.bindingId, workspaceKey: args.workspaceKey, confirm: args.confirm === true });
  }));

  ipcMain.handle('chatnav:select-temporary', guarded((navigator, args) => {
    if (typeof args.viewId !== 'string' || !VIEW_RE.test(args.viewId) || typeof args.workspaceKey !== 'string' || !KEY_RE.test(args.workspaceKey)) return invalid();
    return navigator.selectTemporary({ viewId: args.viewId, workspaceKey: args.workspaceKey });
  }));

  ipcMain.handle('chatnav:new', guarded((navigator, args) => {
    if (typeof args.workspaceKey !== 'string' || !KEY_RE.test(args.workspaceKey)) return invalid();
    return newConversation ? newConversation({ workspaceKey: args.workspaceKey }) : navigator.newConversation({ workspaceKey: args.workspaceKey });
  }));

  // The user's decision on a page of the workspace: retry its association, or resolve a conflict (go to the other workspace,
  // transfer the binding here, go back). The arguments are the page and the action; main decides everything else.
  ipcMain.handle('chatnav:resolve', guarded((navigator, args) => {
    if (!resolve) return { ok: false, error: { code: 'not_ready', message: 'O ChatGPT ainda nao esta pronto.' } };
    if (typeof args.viewId !== 'string' || !VIEW_RE.test(args.viewId) || !['retry', 'go', 'transfer', 'back', 'skip', 'link-project'].includes(args.action)) return invalid();
    return resolve({ viewId: args.viewId, action: args.action });
  }));

  // The conflict modal (overlay page) takes the same three decisions. Only the overlay may call this one.
  ipcMain.handle('conflict:resolve', (event, args) => {
    if (!trustedOverlay(event)) return denied;
    if (!resolve) return { ok: false, error: { code: 'not_ready', message: 'O ChatGPT ainda nao esta pronto.' } };
    if (!isPlainObject(args) || typeof args.viewId !== 'string' || !VIEW_RE.test(args.viewId) || !['go', 'transfer', 'back'].includes(args.action)) return invalid();
    return resolve({ viewId: args.viewId, action: args.action });
  });

  ipcMain.handle('chatnav:open-unscoped', (event) => {
    if (!trusted(event)) return denied;
    const navigator = nav();
    return navigator ? navigator.openUnscoped() : { ok: false, error: { code: 'not_ready', message: 'O ChatGPT ainda nao esta pronto.' } };
  });
}

// Pushes the navigation state to the UI when its content changed, at most once per `intervalMs` (leading + trailing).
function startChatNavPusher({ getState, send, intervalMs = 100, scheduler = { setTimeout, clearTimeout }, now = () => Date.now() }) {
  let last = -Infinity;
  let lastText = '';
  let timer;
  let stopped = false;
  const flush = () => {
    timer = undefined;
    if (stopped) return;
    last = now();
    const state = getState();
    if (!state) return;
    const text = JSON.stringify(state);
    if (text === lastText) return;
    lastText = text;
    send('chatnav:state', state);
  };
  return {
    notify() {
      if (stopped || timer) return;
      const wait = Math.max(0, intervalMs - (now() - last));
      if (wait === 0) flush(); else timer = scheduler.setTimeout(flush, wait);
    },
    stop() { stopped = true; if (timer) scheduler.clearTimeout(timer); timer = undefined; }
  };
}

module.exports = { registerChatNavIpc, startChatNavPusher };
