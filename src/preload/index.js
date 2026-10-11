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
  herdrState: () => ipcRenderer.invoke('herdr:state'),
  herdrRefresh: () => ipcRenderer.invoke('herdr:refresh'),
  openWorkspaceMenu: (anchor) => ipcRenderer.invoke('overlay:open-workspace-menu', anchor),
  onOverlayClosed: (cb) => listen('overlay:closed', cb),
  openChatsPanel: (anchor) => ipcRenderer.invoke('overlay:open-chats-panel', anchor),
  chatNavState: () => ipcRenderer.invoke('chatnav:state'),
  chatNavSelect: (args) => ipcRenderer.invoke('chatnav:select', args),
  chatNavSelectTemporary: (args) => ipcRenderer.invoke('chatnav:select-temporary', args),
  chatNavNew: (args) => ipcRenderer.invoke('chatnav:new', args),
  chatNavResolve: (args) => ipcRenderer.invoke('chatnav:resolve', args),
  chatNavOpenUnscoped: () => ipcRenderer.invoke('chatnav:open-unscoped'),
  activityState: () => ipcRenderer.invoke('activity:state'),
  openActivityCenter: (anchor) => ipcRenderer.invoke('overlay:open-activity-center', anchor),
  chatsState: () => ipcRenderer.invoke('chats:state'),
  chatsBind: (args) => ipcRenderer.invoke('chats:bind', args),
  chatsUpdate: (args) => ipcRenderer.invoke('chats:update', args),
  chatsUnbind: (args) => ipcRenderer.invoke('chats:unbind', args),
  chatsReassign: (args) => ipcRenderer.invoke('chats:reassign', args),
  projectsLink: (args) => ipcRenderer.invoke('projects:link', args),
  projectsUnlink: (args) => ipcRenderer.invoke('projects:unlink', args),
  herdrSelectWorkspace: (args) => ipcRenderer.invoke('herdr:select-workspace', args),
  herdrSetSyncMode: (args) => ipcRenderer.invoke('herdr:set-sync-mode', args),
  startTerminal: (dimensions) => ipcRenderer.invoke('pty:start', dimensions),
  writeTerminal: (text) => ipcRenderer.send('pty:write', text),
  resizeTerminal: (dimensions) => ipcRenderer.send('pty:resize', dimensions),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  readText: () => ipcRenderer.invoke('clipboard:read'),
  onMode: (cb) => listen('dock:mode', cb),
  onFocusTerminal: (cb) => listen('dock:focus-terminal', cb),
  onPtyData: (cb) => listen('pty:data', cb),
  onPtyExit: (cb) => listen('pty:exit', cb),
  onHerdrState: (cb) => listen('herdr:state', cb),
  onChatsState: (cb) => listen('chats:state', cb),
  onChatNavState: (cb) => listen('chatnav:state', cb),
  onActivityState: (cb) => listen('activity:state', cb),
  onChatStatus: (cb) => listen('chat:status', cb),
  onChatHost: (cb) => listen('chat:host', cb),
  onChatError: (cb) => listen('chat:error', cb)
});

