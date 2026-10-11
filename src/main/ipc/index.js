'use strict';

const { registerDockIpc } = require('./dock');
const { registerTerminalIpc } = require('./terminal');
const { registerClipboardIpc } = require('./clipboard');
const { registerGitIpc } = require('./git');
const { registerHerdrIpc } = require('./herdr');
const { registerOverlayIpc } = require('./overlay');
const { registerChatsIpc } = require('./chats');
const { registerChatNavIpc } = require('./chatnav');
const { registerActivityIpc } = require('./activity');

// Registers every IPC channel the local UI may use. `electron` is injected ({ ipcMain, shell,
// clipboard, dialog }) so the registration can be tested without launching Electron. Channel
// names and payloads are the contract with src/preload/index.js.
function registerIpc({ electron, win, herdr, observer, selection, activity, activityIpc, bindings, projects = null, newConversation = null, notifyChats, settings, uiState, persist, userDataDir }) {
  const { ipcMain, shell, clipboard, dialog } = electron;
  const trusted = (event) => win.isTrusted(event);
  registerDockIpc({ ipcMain, shell, trusted, win, settings });
  registerTerminalIpc({ ipcMain, trusted, herdr });
  registerClipboardIpc({ ipcMain, clipboard, trusted });
  registerHerdrIpc({ ipcMain, trusted, observer, selection, extra: activity });
  registerOverlayIpc({ ipcMain, trustedUi: trusted, trustedOverlay: (event) => win.isOverlay(event), win, observer, selection, extra: activity });
  // Chat bindings are managed from the UI window and from the overlay panel; never from the remote page.
  registerChatsIpc({ ipcMain, trusted: (event) => win.isTrusted(event) || win.isOverlay(event), win, bindings, notify: notifyChats, projects });
  // Conversation navigation: UI window only.
  registerChatNavIpc({ ipcMain, trusted, win, newConversation });
  // Global activity: state for the UI window and the overlay; "open" and "dismiss" only from the overlay's activity center / notices.
  registerActivityIpc({ ipcMain, trustedUi: trusted, trustedOverlay: (event) => win.isOverlay(event), ...activityIpc });
  registerGitIpc({ ipcMain, clipboard, dialog, trusted, win, settings, uiState, persist, userDataDir });
}

module.exports = { registerIpc };
