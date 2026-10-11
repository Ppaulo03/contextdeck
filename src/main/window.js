'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');
const { saveUiState } = require('./persistence/ui-state');
const { createChatView } = require('./chat-view');
const { CHAT_HOME } = require('./persistence/identity');
const { createChatViewManager } = require('./chat-views/manager');
const { createChatNavigator } = require('./chat-views/navigator');
const { startChatObservation } = require('./chat');
const { createOverlay } = require('./overlay');
const { createShortcutHandler } = require('./shortcuts');
const { appWebPreferences } = require('./web-preferences');

const { TOPBAR_HEIGHT, CHATBAR_HEIGHT } = require('./window-metrics');   // CHATBAR: conversation strip, chat tab only
const DEFAULT_FOOTER_HEIGHT = 76; // The renderer reports the real value (it wraps on narrow windows).
const FOOTER_RANGE = [30, 420];

// Owns the main window, the ChatGPT views layered over its content area, the active mode
// (terminal | chat) and focus. Which ChatGPT view is on screen is decided by the navigator (chat-views/), which
// drives the manager; this module only provides how a view is attached to / detached from the window and where
// it is laid out. Switching modes or workspaces only attaches/detaches views, so no ChatGPT page and not the PTY
// is reloaded or restarted.
function createWindowController({ uiState, uiStateFile, preloadPath, overlayPreloadPath, rendererHtml, overlayHtml, onClosed, onChatNavigated, onNavChange, chats }) {
  let mainWindow;
  let manager;
  let navigator;
  let initialViewId = null;
  let chatObservation = null;   // experimental, off unless CONTEXTDECK_CHAT_OBSERVER=1 (see chat/index.js)
  let overlay;
  let lastChatBounds = null;
  let activeMode = 'terminal';
  let footerHeight = DEFAULT_FOOTER_HEIGHT;

  const alive = () => mainWindow && !mainWindow.isDestroyed();

  function send(channel, data) {
    if (alive() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, data);
  }

  function persist() {
    uiState.lastMode = activeMode;
    if (alive() && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      const { width, height } = mainWindow.getBounds();
      uiState.bounds = { width, height };
    }
    saveUiState(uiStateFile, uiState);
  }

  // The view that is attached to the window right now (at most one), or null (terminal tab, empty state).
  const attachedChat = () => {
    const id = manager && manager.getAttachedId();
    const handle = id ? manager.handleOf(id) : null;
    return handle && !handle.isDestroyed() ? handle : null;
  };

  // Lays out the attached ChatGPT view. Nothing to do while none is attached, and identical bounds are not
  // re-applied: both would only cost native layout work for no visible change.
  function resizeChat() {
    const chat = attachedChat();
    if (!alive() || !chat || activeMode !== 'chat') return;
    const { width, height } = mainWindow.getContentBounds();
    const top = TOPBAR_HEIGHT + CHATBAR_HEIGHT;
    const next = { x: 0, y: top, width: Math.max(width, 1), height: Math.max(height - top - footerHeight, 1) };
    const last = lastChatBounds;
    if (last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height) return;
    lastChatBounds = next;
    chat.view.setBounds(next);
  }

  // How the manager shows and hides a view in this window.
  const host = {
    attach(handle) {
      if (!alive()) return;
      mainWindow.contentView.addChildView(handle.view);
      lastChatBounds = null;
      overlay?.raise();            // an open menu stays above whatever view was just attached
    },
    detach(handle) {
      if (!alive()) return;
      try { mainWindow.contentView.removeChildView(handle.view); } catch { /* Already detached. */ }
    },
    setBounds: () => resizeChat()
  };

  // The experimental I3P observer is bound to the application's initial page only (diagnostic; see chat/index.js).
  let observerShown = false;
  function syncObserverVisibility() {
    if (!chatObservation || !manager) return;
    const shown = initialViewId !== null && manager.isVisible(initialViewId);
    if (shown === observerShown) return;
    observerShown = shown;
    chatObservation.setVisible(shown);
    if (shown) chatObservation.markViewed();
  }

  function focusChat() {
    const chat = attachedChat();
    if (chat) chat.focus();
    else if (alive()) mainWindow.webContents.focus();   // empty state: the strip and its buttons need the keyboard
  }

  function switchMode(mode) {
    if (mode !== 'terminal' && mode !== 'chat') return;
    if (!alive() || !manager) return;
    overlay?.hide();
    activeMode = mode;
    lastChatBounds = null;
    navigator.setMode(mode);       // picks the right conversation for the workspace, THEN attaches it (or detaches)
    resizeChat();
    syncObserverVisibility();
    persist();
    send('dock:mode', mode);
    if (mode === 'chat') {
      focusChat();
    } else {
      mainWindow.webContents.focus();
      send('dock:focus-terminal');
    }
  }

  function setFooterHeight(value) {
    const height = Math.round(Number(value));
    if (Number.isFinite(height) && height >= FOOTER_RANGE[0] && height <= FOOTER_RANGE[1] && height !== footerHeight) {
      footerHeight = height;
      resizeChat();
    }
  }

  async function create() {
    const handleShortcuts = createShortcutHandler(() => switchMode(activeMode === 'terminal' ? 'chat' : 'terminal'));
    mainWindow = new BrowserWindow({
      width: uiState.bounds?.width ?? 1240,
      height: uiState.bounds?.height ?? 820,
      minWidth: 800,
      minHeight: 480,
      backgroundColor: '#10141d',
      autoHideMenuBar: true,
      title: 'ContextDeck',
      webPreferences: appWebPreferences(preloadPath)
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
    mainWindow.webContents.on('before-input-event', handleShortcuts);
    overlay = createOverlay({
      getWindow: () => mainWindow,
      preloadPath: overlayPreloadPath,
      html: overlayHtml,
      onBeforeInput: handleShortcuts,
      onHidden: (kind) => send('overlay:closed', kind)
    });
    // A menu is modal and anchored to the current layout: any geometry change closes it.
    const relayout = () => { overlay.hide(); resizeChat(); };
    mainWindow.on('resize', relayout);
    mainWindow.on('maximize', relayout);
    mainWindow.on('unmaximize', relayout);
    mainWindow.on('minimize', () => overlay.hide());
    // After Alt+Tab the OS may hand focus to the wrong webContents; restore the active one.
    mainWindow.on('focus', () => {
      if (overlay.isOpen()) return;
      if (activeMode === 'chat') focusChat();
      else if (alive()) mainWindow.webContents.focus();
    });
    mainWindow.on('close', persist);
    mainWindow.on('closed', () => {
      onClosed?.();
      if (overlay) overlay.destroy();
      overlay = undefined;
      chatObservation?.stop();
      chatObservation = null;
      navigator?.stop();
      manager?.destroyAll();          // the only place a ChatGPT view is ever destroyed
      navigator = undefined;
      manager = undefined;
      mainWindow = undefined;
    });

    await mainWindow.loadFile(rendererHtml);
    manager = createChatViewManager({
      host,
      createView: ({ id, onEvent }) => createChatView({
        onBeforeInput: handleShortcuts,
        onEvent,
        onNavigated: () => onChatNavigated?.(),
        // The footer line describes the page the user is looking at, not a background one.
        status: (channel, data) => { if (manager && manager.isVisible(id)) send(channel, data); }
      })
    });
    navigator = createChatNavigator({
      manager,
      session: chats.session,
      bindings: chats.bindings,
      selection: chats.selection,
      homeUrl: CHAT_HOME,
      prefs: {
        getLast: (key) => uiState.chat.last[key] || null,
        setLast: (key, bindingId) => { uiState.chat.last[key] = bindingId; persist(); }
      }
    });
    navigator.onChange(() => { syncObserverVisibility(); onNavChange?.(); });
    // The application's own initial page (what M00 always had), loaded as before and kept unscoped until the user
    // hands it to a workspace ("new conversation"). Nothing else is loaded until it is asked for.
    initialViewId = manager.create({ url: CHAT_HOME, scope: null, pristine: true });
    chatObservation = startChatObservation({ contents: manager.handleOf(initialViewId).contents, userDataDir: path.dirname(uiStateFile) });
    if (uiState.lastMode === 'chat') switchMode('chat');
    else send('dock:mode', 'terminal');
  }

  return {
    create,
    send,
    persist,
    switchMode,
    setFooterHeight,
    getMode: () => activeMode,
    getWindow: () => mainWindow,
    getChat: attachedChat,
    getNavigator: () => navigator,
    getChatUrl: () => (navigator ? navigator.getVisibleUrl() : ''),
    isTrusted: (event) => Boolean(mainWindow) && event.sender === mainWindow.webContents,
    isOverlay: (event) => Boolean(overlay) && overlay.isOverlay(event),
    // The workspace menu overlay (see overlay.js). The anchor is the trigger's rectangle in the UI window.
    openMenu: (anchor, kind) => (overlay ? overlay.show(anchor, kind) : Promise.resolve(false)),
    closeMenu: () => (overlay ? overlay.hide() : false),
    sendToOverlay: (channel, data) => { if (overlay && overlay.isOpen()) overlay.send(channel, data); },
    focus: () => {
      if (!alive()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  };
}

module.exports = { createWindowController };
