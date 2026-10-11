'use strict';

const { BrowserWindow } = require('electron');
const { saveUiState } = require('./persistence/ui-state');
const { createChatView } = require('./chat-view');
const { createOverlay } = require('./overlay');
const { createShortcutHandler } = require('./shortcuts');
const { appWebPreferences } = require('./web-preferences');

const TOPBAR_HEIGHT = 52;
const DEFAULT_FOOTER_HEIGHT = 76; // The renderer reports the real value (it wraps on narrow windows).
const FOOTER_RANGE = [30, 420];

// Owns the main window, the ChatGPT view layered over its content area, the active mode
// (terminal | chat) and focus. Switching modes only attaches/detaches the chat view, so neither
// the ChatGPT page nor the PTY is reloaded or restarted.
function createWindowController({ uiState, uiStateFile, preloadPath, overlayPreloadPath, rendererHtml, overlayHtml, onClosed }) {
  let mainWindow;
  let chat;
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

  // Lays out the ChatGPT view. Nothing to do while it is detached (terminal tab), and identical bounds are
  // not re-applied: both would only cost native layout work for no visible change.
  function resizeChat() {
    if (!alive() || !chat || activeMode !== 'chat') return;
    const { width, height } = mainWindow.getContentBounds();
    const next = { x: 0, y: TOPBAR_HEIGHT, width: Math.max(width, 1), height: Math.max(height - TOPBAR_HEIGHT - footerHeight, 1) };
    const last = lastChatBounds;
    if (last && last.x === next.x && last.y === next.y && last.width === next.width && last.height === next.height) return;
    lastChatBounds = next;
    chat.view.setBounds(next);
  }

  function switchMode(mode) {
    if (mode !== 'terminal' && mode !== 'chat') return;
    if (!alive() || !chat) return;
    overlay?.hide();
    if (mode === 'chat' && activeMode !== 'chat') {
      mainWindow.contentView.addChildView(chat.view);
      activeMode = 'chat';
      lastChatBounds = null;
      resizeChat();
    } else if (mode === 'terminal' && activeMode !== 'terminal') {
      mainWindow.contentView.removeChildView(chat.view);
    }
    activeMode = mode;
    persist();
    send('dock:mode', mode);
    if (mode === 'chat') {
      chat.focus();
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
      onHidden: () => send('overlay:closed')
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
      if (activeMode === 'chat' && chat && !chat.contents.isDestroyed()) chat.focus();
      else if (alive()) mainWindow.webContents.focus();
    });
    mainWindow.on('close', persist);
    mainWindow.on('closed', () => {
      onClosed?.();
      if (overlay) overlay.destroy();
      overlay = undefined;
      if (chat) chat.destroy();
      chat = undefined;
      mainWindow = undefined;
    });

    await mainWindow.loadFile(rendererHtml);
    chat = createChatView({ send, onBeforeInput: handleShortcuts });
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
    getChat: () => chat,
    isTrusted: (event) => Boolean(mainWindow) && event.sender === mainWindow.webContents,
    isOverlay: (event) => Boolean(overlay) && overlay.isOverlay(event),
    // The workspace menu overlay (see overlay.js). The anchor is the trigger's rectangle in the UI window.
    openMenu: (anchor) => (overlay ? overlay.show(anchor) : Promise.resolve(false)),
    closeMenu: () => (overlay ? overlay.hide() : false),
    sendToOverlay: (channel, data) => { if (overlay && overlay.isOpen()) overlay.send(channel, data); },
    focus: () => {
      if (!alive()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  };
}

module.exports = { createWindowController, TOPBAR_HEIGHT };
