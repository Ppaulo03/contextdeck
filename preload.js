'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('dock', {
  info: () => ipcRenderer.invoke('dock:info'),
  switchTo: (mode) => ipcRenderer.invoke('dock:switch', mode),
  reloadChat: () => ipcRenderer.invoke('dock:reload-chat'),
  chatHome: () => ipcRenderer.invoke('dock:chat-home'),
  openExternalChat: () => ipcRenderer.invoke('dock:external-chat'),
  reportLayout: (layout) => ipcRenderer.invoke('dock:layout', layout),
  gitStatus: () => ipcRenderer.invoke('git:status'),
  gitPickRepo: () => ipcRenderer.invoke('git:pick-repo'),
  gitRefs: () => ipcRenderer.invoke('git:refs'),
  gitSetRefs: (args) => ipcRenderer.invoke('git:set-refs', args),
  gitCopyDiff: (args) => ipcRenderer.invoke('git:diff', args),
  gitCopyShow: (args) => ipcRenderer.invoke('git:show', args),
  gitMakeZip: (args) => ipcRenderer.invoke('git:zip', args),
  gitDeleteZip: () => ipcRenderer.invoke('git:delete-zip'),
  startTerminal: (dimensions) => ipcRenderer.invoke('pty:start', dimensions),
  writeTerminal: (text) => ipcRenderer.send('pty:write', text),
  resizeTerminal: (dimensions) => ipcRenderer.send('pty:resize', dimensions),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  readText: () => ipcRenderer.invoke('clipboard:read'),
  onMode: (cb) => listen('dock:mode', cb),
  onFocusTerminal: (cb) => listen('dock:focus-terminal', cb),
  onPtyData: (cb) => listen('pty:data', cb),
  onPtyExit: (cb) => listen('pty:exit', cb),
  onChatStatus: (cb) => listen('chat:status', cb),
  onChatHost: (cb) => listen('chat:host', cb),
  onChatError: (cb) => listen('chat:error', cb)
});

