'use strict';

const MAX_TEXT = 1024 * 1024;

// Text clipboard for the terminal's Ctrl+Shift+C/V. Only the local UI may use it.
function registerClipboardIpc({ ipcMain, clipboard, trusted }) {
  ipcMain.handle('clipboard:write', async (event, text) => {
    if (!trusted(event) || typeof text !== 'string' || text.length > MAX_TEXT) return false;
    await Promise.resolve(clipboard.writeText(text));
    return true;
  });
  ipcMain.handle('clipboard:read', async (event) => {
    if (!trusted(event)) return '';
    return Promise.resolve(clipboard.readText());
  });
}

module.exports = { registerClipboardIpc };
