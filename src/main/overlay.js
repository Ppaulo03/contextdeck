'use strict';

const { WebContentsView } = require('electron');
const { appWebPreferences } = require('./web-preferences');

// A local, transparent view layered ABOVE the ChatGPT view while a menu is open.
//
// Why a view and not an HTML popover: the ChatGPT page is a native WebContentsView that always paints
// over the local UI's DOM, so a popover (or any z-index) would be hidden in the ChatGPT tab. Native
// views are ordered by the main process, so adding this one last puts it on top in both tabs.
//
// It is created on first use and kept (one extra renderer process, no reload cost on later openings),
// covers the whole content area so a click anywhere outside the menu closes it, and is removed from
// the window whenever it is not open so it never intercepts input. It has the local preload bridge
// of the menu only and the same isolation as every other web contents (see web-preferences.js).
function createOverlay({ getWindow, preloadPath, html, onBeforeInput, onHidden }) {
  let view;
  let ready;
  let open = false;

  const liveWindow = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : null; };
  const liveContents = () => (view && !view.webContents.isDestroyed() ? view.webContents : null);

  function ensure() {
    if (view) return ready;
    view = new WebContentsView({ webPreferences: appWebPreferences(preloadPath) });
    view.setBackgroundColor('#00000000');
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('before-input-event', onBeforeInput);
    ready = contents.loadFile(html);
    return ready;
  }

  function fit() {
    const win = liveWindow();
    if (!win || !view) return;
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  async function show(anchor) {
    const win = liveWindow();
    if (!win) return false;
    await ensure();
    if (!liveWindow()) return false;
    fit();
    win.contentView.addChildView(view);   // re-adding an existing child moves it to the top
    open = true;
    view.webContents.focus();
    view.webContents.send('overlay:open', anchor);
    return true;
  }

  function hide() {
    if (!open) return false;
    open = false;
    const contents = liveContents();
    if (contents) contents.send('overlay:open', null);   // the page hides itself before the view is removed
    const win = liveWindow();
    if (win && view) {
      try { win.contentView.removeChildView(view); } catch { /* Already detached. */ }
      win.webContents.focus();
    }
    onHidden?.();
    return true;
  }

  return {
    show,
    hide,
    fit: () => { if (open) fit(); },
    isOpen: () => open,
    isOverlay: (event) => Boolean(view) && event.sender === view.webContents,
    send: (channel, data) => { const c = liveContents(); if (c) c.send(channel, data); },
    destroy() {
      hide();
      const contents = liveContents();
      if (contents) contents.close();
      view = undefined;
    }
  };
}

module.exports = { createOverlay };
