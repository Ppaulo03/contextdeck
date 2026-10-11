'use strict';

const { registerDockIpc } = require('./dock');
const { registerTerminalIpc } = require('./terminal');
const { registerClipboardIpc } = require('./clipboard');
const { registerGitIpc } = require('./git');
const { registerHerdrIpc } = require('./herdr');
const { registerOverlayIpc } = require('./overlay');
const { registerChatsIpc } = require('./chats');

// Registers every IPC channel the local UI may use. `electron` is injected ({ ipcMain, shell,
// clipboard, dialog }) so the registration can be tested without launching Electron. Channel
// names and payloads are the contract with src/preload/index.js.
function registerIpc({ electron, win, herdr, observer, selection, bindings, notifyChats, settings, uiState, persist, userDataDir }) {
  const { ipcMain, shell, clipboard, dialog } = electron;
  const trusted = (event) => win.isTrusted(event);
  registerDockIpc({ ipcMain, shell, trusted, win, settings });
  registerTerminalIpc({ ipcMain, trusted, herdr });
  registerClipboardIpc({ ipcMain, clipboard, trusted });
  registerHerdrIpc({ ipcMain, trusted, observer, selection });
  registerOverlayIpc({ ipcMain, trustedUi: trusted, trustedOverlay: (event) => win.isOverlay(event), win, observer, selection });
  // Chat bindings are managed from the UI window and from the overlay panel; never from the remote page.
  registerChatsIpc({ ipcMain, trusted: (event) => win.isTrusted(event) || win.isOverlay(event), win, bindings, notify: notifyChats });
  registerGitIpc({ ipcMain, clipboard, dialog, trusted, win, settings, uiState, persist, userDataDir });
}

module.exports = { registerIpc };
