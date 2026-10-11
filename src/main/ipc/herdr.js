'use strict';

// Read-only view of the Herdr workspace observer for the diagnostic panel. There is no channel that
// creates, selects, renames or closes workspaces, and none that forwards a method name to Herdr.
function registerHerdrIpc({ ipcMain, trusted, observer }) {
  ipcMain.handle('herdr:state', (event) => (trusted(event) ? observer.getState() : null));
  ipcMain.handle('herdr:refresh', async (event) => {
    if (!trusted(event)) return null;
    await observer.refresh();
    return observer.getState();
  });
}

// Pushes observer state to the UI as `herdr:state`, at most once per `intervalMs` (leading + trailing),
// so a burst of Herdr events does not become a burst of IPC messages.
function startStatePusher({ observer, send, intervalMs = 150, scheduler = { setTimeout, clearTimeout }, now = () => Date.now() }) {
  let last = 0;
  let timer;
  const flush = () => { timer = undefined; last = now(); send('herdr:state', observer.getState()); };
  const off = observer.onChange(() => {
    if (timer) return;
    const wait = Math.max(0, intervalMs - (now() - last));
    if (wait === 0) flush(); else timer = scheduler.setTimeout(flush, wait);
  });
  return () => { off(); if (timer) scheduler.clearTimeout(timer); timer = undefined; };
}

module.exports = { registerHerdrIpc, startStatePusher };
