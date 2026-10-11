'use strict';

// Bridge for the menu overlay (a local view layered above the ChatGPT view while a menu is open).
// It exposes only what the workspace menu needs: read the state, choose a workspace, close, and
// receive "open" and state pushes. No other channel is reachable from the overlay.
const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('overlay', {
  getState: () => ipcRenderer.invoke('overlay:state'),
  choose: (args) => ipcRenderer.invoke('overlay:choose', args),
  close: () => ipcRenderer.invoke('overlay:close'),
  onOpen: (cb) => listen('overlay:open', cb),
  onState: (cb) => listen('overlay:state-push', cb)
});
