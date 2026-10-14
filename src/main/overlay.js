'use strict';

const { WebContentsView } = require('electron');
const { appWebPreferences } = require('./web-preferences');

// A local, transparent view layered ABOVE the ChatGPT view while a menu is open.
//
// Why a view and not an HTML popover: the ChatGPT page is a native WebContentsView that always paints
// over the local UI's DOM, so a popover (or any z-index) would be hidden in the ChatGPT tab. Native
// views are ordered by the main process, so adding this one last puts it on top in both tabs.
//
// It is created on first use and kept for IDLE_RELEASE_MS after the menu closes (one extra renderer process;
// reopening within that time costs nothing, after it ~100 ms),
// covers the whole content area so a click anywhere outside the menu closes it, and is removed from
// the window whenever it is not open so it never intercepts input. It has the local preload bridge
// of the menu only and the same isolation as every other web contents (see web-preferences.js).
const IDLE_RELEASE_MS = 30000;

function createOverlay({ getWindow, preloadPath, html, onBeforeInput, onHidden }) {
  let view;
  let ready;
  let open = false;
  let openKind = 'workspaces';
  let noticeOpen = false;      // the small, non-focusing notice card area (see showNotice)
  let idleTimer;
  let boundsFn = null;         // a modal that covers only part of the window (decisions: the chat area), see show()

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
    if (boundsFn) { view.setBounds(boundsFn()); return; }
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  // `bounds` (optional, () => rect): the modal covers only that rectangle, so the rest of the window (top bar, conversation strip)
  // keeps working and can be used to leave the question (another tab, another conversation, another workspace).
  async function show(anchor, kind = 'workspaces', { bounds = null } = {}) {
    const win = liveWindow();
    if (!win) return false;
    clearTimeout(idleTimer);
    await ensure();
    if (!liveWindow()) return false;
    noticeOpen = false;                   // a modal replaces the notices (they stay listed in the activity center)
    boundsFn = bounds;
    fit();
    win.contentView.addChildView(view);   // re-adding an existing child moves it to the top
    open = true;
    openKind = kind;
    view.webContents.focus();
    view.webContents.send('overlay:open', { ...anchor, kind });   // kind: 'workspaces' (menu) | 'chats' (bindings panel)
    return true;
  }

  // Activity notices: the SAME overlay view, laid out as a small rectangle (so everything outside it keeps receiving input),
  // added on top and NEVER focused: whatever has the keyboard (the terminal, the ChatGPT page) keeps it. A modal wins.
  async function showNotice(rect) {
    const win = liveWindow();
    if (!win || open) return false;
    clearTimeout(idleTimer);
    await ensure();
    if (!liveWindow() || open) return false;
    view.setBounds(rect);
    win.contentView.addChildView(view);
    noticeOpen = true;
    view.webContents.send('overlay:open', { kind: 'notice' });
    return true;
  }

  function hideNotice() {
    if (!noticeOpen) return false;
    noticeOpen = false;
    const win = liveWindow();
    if (!open) {
      const contents = liveContents();
      if (contents) contents.send('overlay:open', null);
      if (win && view) { try { win.contentView.removeChildView(view); } catch { /* Already detached. */ } }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(release, IDLE_RELEASE_MS);
      idleTimer.unref?.();
    }
    return true;
  }

  function hide() {
    if (!open) return false;
    open = false;
    boundsFn = null;
    const contents = liveContents();
    if (contents) contents.send('overlay:open', null);   // the page hides itself before the view is removed
    const win = liveWindow();
    if (win && view) {
      try { win.contentView.removeChildView(view); } catch { /* Already detached. */ }
      win.webContents.focus();
    }
    onHidden?.(openKind);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(release, IDLE_RELEASE_MS);
    idleTimer.unref?.();
    return true;
  }

  // Frees the extra renderer process (~115 MB measured) when the menu has not been used for a while.
  function release() {
    if (open || noticeOpen || !view) return;
    const contents = liveContents();
    if (contents) contents.close();
    view = undefined;
    ready = undefined;
  }

  return {
    show,
    hide,
    fit: () => { if (open) fit(); },
    showNotice,
    hideNotice,
    isNoticeOpen: () => noticeOpen,
    // Anything of the overlay on screen (modal or notices): where state pushes may go.
    isShown: () => open || noticeOpen,
    // Re-adding an existing child moves it to the top: called when another view is attached while the overlay is open.
    raise: () => { const win = liveWindow(); if ((open || noticeOpen) && view && win) win.contentView.addChildView(view); },
    isOpen: () => open,
    kind: () => openKind,
    isOverlay: (event) => Boolean(view) && event.sender === view.webContents,
    send: (channel, data) => { const c = liveContents(); if (c) c.send(channel, data); },
    destroy() {
      hide();
      hideNotice();
      clearTimeout(idleTimer);
      release();
    }
  };
}

module.exports = { createOverlay };
