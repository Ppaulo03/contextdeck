'use strict';

const { registerDockIpc } = require('./dock');
const { registerTerminalIpc } = require('./terminal');
const { registerClipboardIpc } = require('./clipboard');
const { registerGitIpc } = require('./git');
const { registerHerdrIpc } = require('./herdr');

// Registers every IPC channel the local UI may use. `electron` is injected ({ ipcMain, shell,
// clipboard, dialog }) so the registration can be tested without launching Electron. Channel
// names and payloads are the contract with src/preload/index.js.
function registerIpc({ electron, win, herdr, observer, settings, uiState, persist, userDataDir }) {
  const { ipcMain, shell, clipboard, dialog } = electron;
  const trusted = (event) => win.isTrusted(event);
  registerDockIpc({ ipcMain, shell, trusted, win, settings });
  registerTerminalIpc({ ipcMain, trusted, herdr });
  registerClipboardIpc({ ipcMain, clipboard, trusted });
  registerHerdrIpc({ ipcMain, trusted, observer });
  registerGitIpc({ ipcMain, clipboard, dialog, trusted, win, settings, uiState, persist, userDataDir });
}

module.exports = { registerIpc };
