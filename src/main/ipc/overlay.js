'use strict';

const { herdrState } = require('./herdr');

// Channels of the overlay (workspace menu and chat bindings panel). Least privilege: the UI window may only ask for the menu to
// open (with the trigger's rectangle); the overlay page may only read the state, choose a workspace
// (through the same validated selection controller as everything else) and close itself.
const denied = { ok: false, error: { code: 'untrusted', message: 'Untrusted IPC caller' } };
const LIMIT = 20000;

// The anchor is only used to place the menu. Anything that is not four sane numbers is refused.
function sanitizeAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = anchor[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > LIMIT) return null;
    out[key] = Math.round(value);
  }
  return out;
}

function registerOverlayIpc({ ipcMain, trustedUi, trustedOverlay, win, observer, selection }) {
  ipcMain.handle('overlay:open-workspace-menu', async (event, anchor) => {
    if (!trustedUi(event)) return denied;
    const rect = sanitizeAnchor(anchor);
    if (!rect) return { ok: false, error: { code: 'invalid_anchor', message: 'Posicao do menu invalida.' } };
    return { ok: await win.openMenu(rect) };
  });
  // The chat bindings panel lives in the same overlay view (a second page mode); same anchor rules.
  ipcMain.handle('overlay:open-chats-panel', async (event, anchor) => {
    if (!trustedUi(event)) return denied;
    const rect = sanitizeAnchor(anchor);
    if (!rect) return { ok: false, error: { code: 'invalid_anchor', message: 'Posicao do painel invalida.' } };
    return { ok: await win.openMenu(rect, 'chats') };
  });
  ipcMain.handle('overlay:state', (event) => (trustedOverlay(event) ? herdrState(observer, selection) : null));
  ipcMain.handle('overlay:choose', (event, args) => {
    if (!trustedOverlay(event)) return denied;
    return selection.select(typeof args?.session === 'string' ? args.session : null, typeof args?.workspaceId === 'string' ? args.workspaceId : null);
  });
  ipcMain.handle('overlay:close', (event) => (trustedOverlay(event) ? win.closeMenu() : false));
}

module.exports = { registerOverlayIpc, sanitizeAnchor };
