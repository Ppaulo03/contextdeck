'use strict';

// Bridge for the menu overlay (a local view layered above the ChatGPT view while a menu is open).
// It exposes what the workspace menu needs (read the state, choose a workspace, close, receive "open" and state
// pushes) and the chat bindings panel's own channels (state, bind, update, unbind, reassign). No other channel is reachable from the overlay.
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
  activityState: () => ipcRenderer.invoke('activity:state'),
  activityOpen: (args) => ipcRenderer.invoke('activity:open', args),
  activityDismiss: (args) => ipcRenderer.invoke('activity:dismiss', args),
  activityOpenUnbound: (args) => ipcRenderer.invoke('activity:open-unbound', args),
  activityBindUnbound: (args) => ipcRenderer.invoke('activity:bind-unbound', args),
  activityNewUnbound: () => ipcRenderer.invoke('activity:new-unbound'),
  chatsState: () => ipcRenderer.invoke('chats:state'),
  chatsBind: (args) => ipcRenderer.invoke('chats:bind', args),
  chatsUpdate: (args) => ipcRenderer.invoke('chats:update', args),
  chatsUnbind: (args) => ipcRenderer.invoke('chats:unbind', args),
  chatsReassign: (args) => ipcRenderer.invoke('chats:reassign', args),
  onOpen: (cb) => listen('overlay:open', cb),
  onState: (cb) => listen('overlay:state-push', cb),
  onChatsState: (cb) => listen('overlay:chats-push', cb),
  onActivityState: (cb) => listen('overlay:activity-push', cb)
});
