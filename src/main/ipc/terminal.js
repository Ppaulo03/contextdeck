'use strict';

const MAX_WRITE = 1024 * 1024;

// PTY channels. The sender check applies to `on` channels too: they silently ignore strangers.
function registerTerminalIpc({ ipcMain, trusted, herdr }) {
  ipcMain.handle('pty:start', (event, dimensions) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return herdr.start(dimensions?.cols, dimensions?.rows);
  });
  ipcMain.on('pty:write', (event, text) => {
    if (!trusted(event) || !herdr.isRunning() || typeof text !== 'string' || text.length > MAX_WRITE) return;
    herdr.write(text);
  });
  ipcMain.on('pty:resize', (event, dimensions) => {
    if (!trusted(event) || !herdr.isRunning()) return;
    const cols = Math.floor(Number(dimensions?.cols));
    const rows = Math.floor(Number(dimensions?.rows));
    if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200) {
      herdr.resize(cols, rows);
    }
  });
}

module.exports = { registerTerminalIpc };
