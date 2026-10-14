'use strict';

// Global conversation activity channels (M01-I3B-2H). The data is a projection of the observation hub's per-view summaries
// (nothing is observed or loaded for it); the only action is "open this conversation", which goes through the explicit
// workspace selection and the navigator (see activity/direct-open.js). Arguments are picked field by field; no path,
// address, command or Herdr method can be passed; the remote ChatGPT page has no path here.
//   activity:state    UI window or overlay   { global, notices } (also pushed: `activity:state` to the UI, `overlay:activity-push`)
//   activity:open     overlay only           the activity center's "Abrir"
//   activity:dismiss  overlay only           closes a notice card (does NOT acknowledge the attention)
//   activity:open-unbound  overlay only     a page that lives in no workspace (exceptional, M01-I3B-3): open it; never moves Herdr
const denied = { ok: false, error: { code: 'untrusted', message: 'Untrusted IPC caller' } };
const invalid = (message = 'Pedido invalido.') => ({ ok: false, error: { code: 'invalid_request', message } });

const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const BINDING_RE = /^b_[0-9a-f]{16}$/;
const VIEW_RE = /^v[0-9]{1,6}$/;
const NOTICE_RE = /^n:v[0-9]{1,6}$/;
const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function registerActivityIpc({ ipcMain, trustedUi, trustedOverlay, getPayload, directOpen, notices, unbound }) {
  ipcMain.handle('activity:state', (event) => (trustedUi(event) || trustedOverlay(event) ? getPayload() : null));

  ipcMain.handle('activity:open', async (event, args) => {
    if (!trustedOverlay(event)) return denied;
    if (!isPlainObject(args) || typeof args.workspaceId !== 'string' || !WORKSPACE_RE.test(args.workspaceId)) return invalid();
    const byBinding = typeof args.bindingId === 'string';
    const byView = typeof args.viewId === 'string';
    if (byBinding === byView) return invalid();                        // exactly one of them
    if (byBinding && !BINDING_RE.test(args.bindingId)) return invalid();
    if (byView && !VIEW_RE.test(args.viewId)) return invalid();
    return directOpen.open({ workspaceId: args.workspaceId, ...(byBinding ? { bindingId: args.bindingId } : { viewId: args.viewId }), confirm: args.confirm === true });
  });

  const unboundGuard = (fn) => (event, args) => {
    if (!trustedOverlay(event)) return denied;
    if (!unbound) return { ok: false, error: { code: 'not_ready', message: 'O ChatGPT ainda nao esta pronto.' } };
    return fn(args);
  };

  ipcMain.handle('activity:open-unbound', unboundGuard((args) => {
    if (!isPlainObject(args) || typeof args.viewId !== 'string' || !VIEW_RE.test(args.viewId)) return invalid();
    return unbound.open({ viewId: args.viewId });
  }));

  ipcMain.handle('activity:dismiss', (event, args) => {
    if (!trustedOverlay(event)) return denied;
    if (!isPlainObject(args) || typeof args.id !== 'string' || !NOTICE_RE.test(args.id)) return invalid();
    notices.dismiss(args.id);
    return { ok: true };
  });
}

// Pushes the payload when its content changed, at most once per `intervalMs` (leading + trailing).
function startActivityPusher({ getPayload, send, intervalMs = 120, scheduler = { setTimeout, clearTimeout }, now = () => Date.now() }) {
  let last = -Infinity;
  let lastText = '';
  let timer;
  let stopped = false;
  const flush = () => {
    timer = undefined;
    if (stopped) return;
    last = now();
    const payload = getPayload();
    if (!payload) return;
    const text = JSON.stringify(payload);
    if (text === lastText) return;
    lastText = text;
    send(payload);
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

module.exports = { registerActivityIpc, startActivityPusher };
