'use strict';

const { CHAT_HOME } = require('../persistence/identity');

// View switching, chat controls and layout reports from the local UI.
function registerDockIpc({ ipcMain, shell, trusted, win, settings }) {
  ipcMain.handle('dock:layout', (event, layout) => {
    if (!trusted(event)) return false;
    win.setFooterHeight(layout?.footerHeight);
    return true;
  });
  ipcMain.handle('dock:info', (event) => {
    if (!trusted(event)) return null;
    return { sessionName: settings.herdrSession, mode: win.getMode(), chatHome: CHAT_HOME };
  });
  ipcMain.handle('dock:switch', (event, mode) => {
    if (!trusted(event)) return false;
    win.switchMode(mode);
    return true;
  });
  ipcMain.handle('dock:reload-chat', (event) => {
    if (!trusted(event)) return false;
    win.getChat()?.reload();
    return true;
  });
  ipcMain.handle('dock:chat-home', (event) => {
    if (!trusted(event)) return false;
    win.getChat()?.goHome();
    return true;
  });
  ipcMain.handle('dock:external-chat', (event) => {
    if (!trusted(event)) return false;
    void shell.openExternal(CHAT_HOME);
    return true;
  });
}

module.exports = { registerDockIpc };
