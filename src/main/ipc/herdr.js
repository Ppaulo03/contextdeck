'use strict';

// Herdr workspace channels for the local UI. Reads come from the observer; the only write is the
// explicit workspace selection (workspace.focus), validated again in main by the selection controller.
// There is no channel that creates, renames, moves or closes workspaces, and none that forwards a
// method name or arbitrary parameters to Herdr.
const denied = { ok: false, error: { code: 'untrusted', message: 'Untrusted IPC caller' } };

// `extra` (optional) adds per-workspace conversation activity (derived, never persisted) for the selector and its menu.
function herdrState(observer, selection, extra) {
  const state = { ...observer.getState(), selection: selection.getState() };
  if (extra) state.activity = extra();
  return state;
}

function registerHerdrIpc({ ipcMain, trusted, observer, selection, extra }) {
  ipcMain.handle('herdr:state', (event) => (trusted(event) ? herdrState(observer, selection, extra) : null));
  ipcMain.handle('herdr:refresh', async (event) => {
    if (!trusted(event)) return null;
    await observer.refresh().catch(() => {});
    return herdrState(observer, selection, extra);
  });
  // User picked a workspace in the selector. Only plain strings are forwarded; everything else is
  // rejected by the selection controller (session identity, existence, concurrency).
  ipcMain.handle('herdr:select-workspace', (event, args) => {
    if (!trusted(event)) return denied;
    return selection.select(typeof args?.session === 'string' ? args.session : null, typeof args?.workspaceId === 'string' ? args.workspaceId : null);
  });
  ipcMain.handle('herdr:set-sync-mode', (event, args) => {
    if (!trusted(event)) return denied;
    return selection.setMode(args?.mode);
  });
}

// Pushes the combined state to the UI as `herdr:state`, at most once per `intervalMs` (leading +
// trailing), so a burst of Herdr events does not become a burst of IPC messages.
function startStatePusher({ observer, selection, extra, send, intervalMs = 150, scheduler = { setTimeout, clearTimeout }, now = () => Date.now() }) {
  let last = -Infinity;   // the first change is always sent immediately
  let timer;
  const flush = () => { timer = undefined; last = now(); send('herdr:state', herdrState(observer, selection, extra)); };
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, intervalMs - (now() - last));
    if (wait === 0) flush(); else timer = scheduler.setTimeout(flush, wait);
  };
  const offObserver = observer.onChange(schedule);
  const offSelection = selection.onChange(schedule);
  const stop = () => { offObserver(); offSelection(); if (timer) scheduler.clearTimeout(timer); timer = undefined; };
  stop.notify = schedule;      // a change of conversation activity pushes the state too
  return stop;
}

module.exports = { registerHerdrIpc, startStatePusher, herdrState };
