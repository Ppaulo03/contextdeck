'use strict';

// Chat binding channels (M01-I3A). Callable only by the local UI window and by the local overlay page; the
// remote ChatGPT page has no preload and no path here. Every argument is picked field by field and validated
// in main; the service re-validates the domain rules. There is no channel that takes a path, a command or a
// Herdr method, and none that reads the conversation.
//
// "Bind the current conversation" never trusts the renderer for the address: main reads it from the ChatGPT
// view itself. "Bind by URL" takes a string that the identity parser (host, protocol, shape) must accept.
const denied = { ok: false, error: { code: 'untrusted', message: 'Untrusted IPC caller' } };
const invalid = (message = 'Pedido invalido.') => ({ ok: false, error: { code: 'invalid_request', message } });

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const optionalString = (v) => (typeof v === 'string' ? v : undefined);

// A workspace identity is two strings; anything else becomes null and is refused by the service.
function pickTarget(value) {
  return isPlainObject(value) && typeof value.session === 'string' && typeof value.workspaceId === 'string'
    ? { session: value.session, workspaceId: value.workspaceId } : null;
}
// string | null are the only valid answers; a missing/odd value stays undefined so the service refuses it.
const pickSelected = (v) => (v === null || typeof v === 'string' ? v : undefined);

// Project links (M01-I3B-3, experimental, off unless CONTEXTDECK_PROJECTS=1): `projects` is null when off.
// "Link the current Project" never trusts the renderer for the address: main reads it from the ChatGPT view, like for chats.
// `onUnbind(conversationKey)` (optional): told when the user removed a binding, so the page that still shows that conversation is
// not bound again by the workspace-first rule (unbinding is a decision, not a state to be "repaired").
function registerChatsIpc({ ipcMain, trusted, win, bindings, notify, projects = null, onUnbind = null, lifecycleState = () => ({}) }) {
  const guard = (fn) => (event, args) => {
    if (!trusted(event)) return denied;
    if (!isPlainObject(args)) return invalid();
    const result = fn(args);
    if (result && result.ok) notify();
    return result;
  };

  ipcMain.handle('chats:state', (event) => {
    if (!trusted(event)) return null;
    const url = win.getChatUrl();
    return { ...bindings.getState({ url }), projectsEnabled: Boolean(projects), projects: projects ? projects.getState({ url }) : null, lifecycle: lifecycleState() };
  });

  ipcMain.handle('chats:bind', guard((args) => {
    let url;
    let origin;
    if (args.source === 'current') { url = win.getChatUrl(); origin = 'current-page'; }
    else if (args.source === 'url' && typeof args.url === 'string') { url = args.url; origin = 'url'; }
    else return invalid();
    return bindings.bind({
      target: pickTarget(args.target),
      url,
      origin,
      label: optionalString(args.label),
      selectedAtOpen: pickSelected(args.selectedAtOpen),
      confirmTarget: args.confirmTarget === true,
      targetChosen: args.targetChosen === true
    });
  }));

  const off = { ok: false, error: { code: 'projects_disabled', message: 'A integracao com Projects do ChatGPT esta desativada.' } };

  ipcMain.handle('projects:link', guard((args) => {
    if (!projects) return off;
    let url;
    if (args.source === 'current') url = win.getChatUrl();
    else if (args.source === 'url' && typeof args.url === 'string') url = args.url;
    else return invalid();
    if (args.label !== undefined && typeof args.label !== 'string') return invalid();
    return projects.link({
      target: pickTarget(args.target),
      url,
      label: optionalString(args.label),
      selectedAtOpen: pickSelected(args.selectedAtOpen),
      confirmTarget: args.confirmTarget === true,
      targetChosen: args.targetChosen === true,
      replace: args.replace === true,
      move: args.move === true
    });
  }));

  ipcMain.handle('projects:unlink', guard((args) => {
    if (!projects) return off;
    const target = pickTarget(args.target);
    return target ? projects.unlink({ workspaceIdentity: target }) : invalid();
  }));

  ipcMain.handle('chats:update', guard((args) => {
    if (typeof args.bindingId !== 'string') return invalid();
    if (typeof args.label !== 'string') return invalid();
    return bindings.update({ bindingId: args.bindingId, label: args.label });
  }));

  ipcMain.handle('chats:unbind', guard((args) => {
    if (typeof args.bindingId !== 'string') return invalid();
    const known = bindings.all().find((b) => b.bindingId === args.bindingId);
    const result = bindings.unbind({ bindingId: args.bindingId });
    if (result && result.ok && known && onUnbind) onUnbind(known.conversationKey);
    return result;
  }));

  // Release the resources of one loaded conversation (M01-I3C-1), on the user's explicit request: a binding (its page) or a page of the
  // exceptional list. The arguments only NAME the target; whether it may be released is decided in main, from fresh state and a fresh
  // reading (chat-views/lifecycle.js), never from anything the renderer says. It changes no binding and sends nothing to Herdr.
  const VIEW_RE = /^v[0-9]{1,6}$/;
  const BINDING_RE = /^b_[0-9a-f]{16}$/;
  const notReady = { ok: false, error: { code: 'not_ready', message: 'O ChatGPT ainda nao esta pronto.' } };
  ipcMain.handle('chats:suspend', async (event, args) => {
    if (!trusted(event)) return denied;
    if (!isPlainObject(args)) return invalid();
    const navigator = win.getNavigator();
    const lifecycle = win.getLifecycle();
    if (!navigator || !lifecycle) return notReady;
    const byBinding = args.bindingId !== undefined;
    if (byBinding === (args.viewId !== undefined)) return invalid();                  // exactly one of them
    let viewId;
    if (byBinding) {
      if (typeof args.bindingId !== 'string' || !BINDING_RE.test(args.bindingId)) return invalid();
      viewId = navigator.viewIdOfBinding(args.bindingId);
      if (!viewId) return { ok: false, error: { code: 'not_loaded', message: 'Esta conversa nao esta carregada.' } };
    } else {
      if (typeof args.viewId !== 'string' || !VIEW_RE.test(args.viewId)) return invalid();
      viewId = args.viewId;
    }
    const result = await lifecycle.suspend({ viewId });
    if (result && result.ok) notify();
    return result;
  });

  ipcMain.handle('chats:reassign', guard((args) => {
    if (typeof args.bindingId !== 'string') return invalid();
    return bindings.reassign({
      bindingId: args.bindingId,
      target: pickTarget(args.target),
      selectedAtOpen: pickSelected(args.selectedAtOpen),
      confirmTarget: args.confirmTarget === true,
      targetChosen: args.targetChosen === true,
      confirmReassign: args.confirmReassign === true
    });
  }));
}

// Pushes the compact state to the UI (and the overlay while the panel is open) when it changes, at most once
// per `intervalMs` (leading + trailing) and only if the content differs from what was sent last.
function startChatsPusher({ bindings, getUrl, extra = () => ({}), observer, selection, send, intervalMs = 150, scheduler = { setTimeout, clearTimeout }, now = () => Date.now() }) {
  let last = -Infinity;
  let lastText = '';
  let timer;
  let stopped = false;
  const flush = () => {
    timer = undefined;
    if (stopped) return;
    last = now();
    const url = getUrl();
    const state = { ...bindings.getState({ url }), ...extra(url) };
    const text = JSON.stringify(state);
    if (text === lastText) return;
    lastText = text;
    send('chats:state', state);
  };
  const notify = () => {
    if (stopped || timer) return;
    const wait = Math.max(0, intervalMs - (now() - last));
    if (wait === 0) flush(); else timer = scheduler.setTimeout(flush, wait);
  };
  const offs = [observer.onChange(notify), selection.onChange(notify)];
  return {
    notify,
    stop() { stopped = true; for (const off of offs) off(); if (timer) scheduler.clearTimeout(timer); timer = undefined; }
  };
}

module.exports = { registerChatsIpc, startChatsPusher, pickTarget };
