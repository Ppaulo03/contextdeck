'use strict';

const path = require('node:path');
const { BrowserWindow, app } = require('electron');
const { saveUiState } = require('./persistence/ui-state');
const { createChatView } = require('./chat-view');
const { CHAT_HOME } = require('./persistence/identity');
const { createChatViewManager } = require('./chat-views/manager');
const { createChatNavigator } = require('./chat-views/navigator');
const { createObservationHub } = require('./chat-views/observation');
const { createViewLifecycle } = require('./chat-views/lifecycle');
const { buildResourceReport } = require('./chat-views/resource-report');
const { createDiagnosticsLog } = require('./chat/diagnostics');
const { startChatObservation } = require('./chat');
const { createOverlay } = require('./overlay');
const { createShortcutHandler } = require('./shortcuts');
const { appWebPreferences } = require('./web-preferences');
const { bannerOf } = require('../shared/chat-nav-view');

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
  let hub = null;               // per-view status observation (see chat-views/observation.js)
  let lifecycle = null;         // which views can give their resources back, and the explicit suspension (see chat-views/lifecycle.js)
  let noticeCount = 0;          // activity notices wanted on screen (see syncNotices)
  let interactive = false;
  let overlay;
  let lastChatBounds = null;
  let activeMode = 'terminal';
  let footerHeight = DEFAULT_FOOTER_HEIGHT;
  let conflictOpen = false;     // a CONFLICT modal must be on screen: the one that cannot be dismissed (see syncConflict)
  let decisionOpen = false;     // a decision modal (any kind) was opened by syncConflict
  let lastNavState = null;
  let lastConflictText = '';

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

  // The rectangle the ChatGPT page occupies; the decision modals cover exactly this.
  function chatArea() {
    const { width, height } = mainWindow.getContentBounds();
    const top = TOPBAR_HEIGHT + CHATBAR_HEIGHT;
    return { x: 0, y: top, width: Math.max(width, 1), height: Math.max(height - top - footerHeight, 1) };
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

  // Can the user look at the window right now? Not minimized, shown and focused. A response that ends while this is
  // false is "not seen", even if its view is the attached one.
  function updatePresence() {
    interactive = alive() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
    if (hub) hub.setInteractive(interactive);
    syncNotices();
  }

  // Activity notices: small cards in the overlay view, top right under the bars. Shown only while the user can see the
  // window and no modal owns the overlay; never focused, so typing in the terminal or the page is not interrupted.
  const NOTICE_WIDTH = 372;
  const NOTICE_ROW = 78;
  function syncNotices() {
    if (!overlay || !alive()) return;
    if (noticeCount === 0 || !interactive || overlay.isOpen()) { overlay.hideNotice(); return; }
    const { width } = mainWindow.getContentBounds();
    const top = TOPBAR_HEIGHT + (activeMode === 'chat' ? CHATBAR_HEIGHT : 0) + 6;
    const rows = Math.min(noticeCount, 3);
    const rect = { x: Math.max(0, width - NOTICE_WIDTH - 12), y: top, width: NOTICE_WIDTH, height: rows * NOTICE_ROW + 8 + (noticeCount > 3 ? 22 : 0) };
    void overlay.showNotice(rect);
  }

  // Decisions the user must take about the page on screen (M01-I3B-3) are shown as a MODAL in the overlay view, STATE-driven:
  //   conflict   the conversation belongs to another workspace: cannot be dismissed, the tab shortcut is ignored, and anything that
  //              closes the overlay (resize, minimize, a menu) is undone; it closes only when the conflict is gone;
  //   offer / confirm / pending   (link this Project; confirm a chat outside the linked Project; an association that failed):
  //              dismissible (Esc = the negative answer), they never interrupt a menu or panel the user opened, and they appear
  //              after it is closed. Nothing is decided here; the modal only shows what the navigator reports.
  function syncConflict() {
    if (!overlay || !alive()) return;
    const state = lastNavState;
    const banner = state && activeMode === 'chat' ? bannerOf(state, false) : null;
    if (banner) {
      const sticky = banner.kind === 'conflict';
      const text = JSON.stringify(banner);
      const ours = decisionOpen && overlay.isOpen() && overlay.kind() === 'conflict';
      if (ours) {
        conflictOpen = sticky;
        if (text !== lastConflictText) { lastConflictText = text; overlay.send('overlay:conflict-push', { banner }); }
        return;
      }
      if (overlay.isOpen() && !sticky) return;          // the user's own menu/panel is not interrupted by a question
      decisionOpen = true;
      conflictOpen = sticky;
      lastConflictText = text;
      // Only the chat area is covered: the Terminal tab, the workspace selector and the conversation strip stay usable.
      void overlay.show({ banner }, 'conflict', { bounds: chatArea });
      return;
    }
    if (decisionOpen) {
      decisionOpen = false;
      conflictOpen = false;
      lastConflictText = '';
      if (overlay.isOpen() && overlay.kind() === 'conflict') overlay.hide();
    }
  }

  function focusChat() {
    const chat = attachedChat();
    if (chat) chat.focus();
    else if (alive()) mainWindow.webContents.focus();   // empty state: the strip and its buttons need the keyboard
  }

  // `user: false` is the restoration of the last tab at startup: not a visit.
  function switchMode(mode, { user = true } = {}) {
    if (mode !== 'terminal' && mode !== 'chat') return;
    if (!alive() || !manager) return;
    overlay?.hide();
    activeMode = mode;
    lastChatBounds = null;
    navigator.setMode(mode);       // picks the right conversation for the workspace, THEN attaches it (or detaches)
    resizeChat();
    updatePresence();
    syncNotices();
    if (mode === 'chat' && user) navigator.visitVisible();
    persist();
    send('dock:mode', mode);
    if (mode === 'chat') {
      focusChat();
    } else {
      mainWindow.webContents.focus();
      send('dock:focus-terminal');
    }
  }

  // Resource picture of the ChatGPT views (chat-views/resource-report.js). Built on demand only; never attributes a process to one view.
  function resourceReport() {
    const pids = {};
    if (manager) for (const v of manager.list()) { const h = manager.handleOf(v.id); pids[v.id] = h && h.getProcessId ? h.getProcessId() : 0; }
    return buildResourceReport({
      summary: lifecycle ? lifecycle.summary() : null, inventory: lifecycle ? lifecycle.inventory() : [],
      metrics: app.getAppMetrics(), pids, hubStats: hub ? hub.stats() : null
    });
  }

  function setFooterHeight(value) {
    const height = Math.round(Number(value));
    if (Number.isFinite(height) && height >= FOOTER_RANGE[0] && height <= FOOTER_RANGE[1] && height !== footerHeight) {
      footerHeight = height;
      resizeChat();
    }
  }

  async function create() {
    const toggleShortcut = createShortcutHandler(() => switchMode(activeMode === 'terminal' ? 'chat' : 'terminal'));
    const handleShortcuts = toggleShortcut;
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
      onHidden: (kind) => { send('overlay:closed', kind); syncNotices(); if (kind === 'conflict') { decisionOpen = false; conflictOpen = false; lastConflictText = ''; } setImmediate(syncConflict); }
    });
    // A menu is modal and anchored to the current layout: any geometry change closes it.
    const relayout = () => { overlay.hide(); resizeChat(); syncNotices(); };
    mainWindow.on('resize', relayout);
    mainWindow.on('maximize', relayout);
    mainWindow.on('unmaximize', relayout);
    mainWindow.on('minimize', () => overlay.hide());
    // After Alt+Tab the OS may hand focus to the wrong webContents; restore the active one.
    for (const name of ['blur', 'minimize', 'restore', 'show', 'hide']) mainWindow.on(name, updatePresence);
    mainWindow.on('focus', () => {
      updatePresence();
      if (conflictOpen) { syncConflict(); return; }
      navigator?.visitVisible();      // coming back to the window with a conversation on screen is a visit
      if (overlay.isOpen()) return;
      if (activeMode === 'chat') focusChat();
      else if (alive()) mainWindow.webContents.focus();
    });
    mainWindow.on('close', persist);
    mainWindow.on('closed', () => {
      onClosed?.();
      if (overlay) overlay.destroy();
      overlay = undefined;
      lifecycle?.stop();
      lifecycle = null;
      hub?.stop();                    // observers first: nothing may probe a view that is being closed
      hub = null;
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
        // Typing into the page is the user being there: a visit (a no-op unless attention is pending).
        onBeforeInput: (event, input) => { handleShortcuts(event, input); if (input && input.type === 'keyDown') navigator?.visitVisible(); },
        onEvent,
        onNavigated: () => onChatNavigated?.(),
        // The footer line describes the page the user is looking at, not a background one.
        status: (channel, data) => { if (manager && manager.isVisible(id)) send(channel, data); }
      })
    });
    // One status observer per loaded view (the I3P detector), unless disabled with CONTEXTDECK_CHAT_STATUS=0.
    const statusOn = process.env.CONTEXTDECK_CHAT_STATUS !== '0';
    hub = createObservationHub({
      manager,
      startObserver: ({ viewId, handle, onChange, phaseMs }) => (statusOn || process.env.CONTEXTDECK_CHAT_OBSERVER === '1'
        ? startChatObservation({ contents: handle.contents, userDataDir: path.dirname(uiStateFile), viewId, status: statusOn, onChange, phaseMs })
        : null)
    });
    navigator = createChatNavigator({
      manager,
      activity: hub,
      onAttention: chats.onAttention,
      session: chats.session,
      bindings: chats.bindings,
      selection: chats.selection,
      homeUrl: CHAT_HOME,
      prefs: {
        getLast: (key) => uiState.chat.last[key] || null,
        setLast: (key, bindingId) => { uiState.chat.last[key] = bindingId; persist(); }
      }
    });
    // Explicit suspension only (no timers, no automatic policy): the navigator asks it what to offer on each tab.
    // CONTEXTDECK_LIFECYCLE_LOG=1 appends each suspension, refusal and restoration (with a resource snapshot) to
    // <userData>\diagnostics\lifecycle.jsonl: evidence for the manual homologation, never read back as state.
    const lifecycleLog = process.env.CONTEXTDECK_LIFECYCLE_LOG === '1' ? createDiagnosticsLog({ file: path.join(path.dirname(uiStateFile), 'diagnostics', 'lifecycle.jsonl') }) : null;
    lifecycle = createViewLifecycle({ manager, navigator, hub, onEvent: lifecycleLog ? (event) => lifecycleLog.note({ lifecycle: event, resources: resourceReport().totals }) : null });
    navigator.setLifecycle(lifecycle);
    navigator.onChange((state) => { lastNavState = state; onNavChange?.(); syncConflict(); });
    // The application's own initial page (what M00 always had), loaded as before and kept unscoped until the user
    // hands it to a workspace ("new conversation"). Nothing else is loaded until it is asked for.
    initialViewId = manager.create({ url: CHAT_HOME, scope: null, pristine: true });
    updatePresence();
    if (uiState.lastMode === 'chat') switchMode('chat', { user: false });
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
    getLifecycle: () => lifecycle,
    getResourceReport: resourceReport,
    getObservationStats: () => (hub ? hub.stats() : null),
    getChatUrl: () => (navigator ? navigator.getVisibleUrl() : ''),
    isTrusted: (event) => Boolean(mainWindow) && event.sender === mainWindow.webContents,
    isOverlay: (event) => Boolean(overlay) && overlay.isOverlay(event),
    // The workspace menu overlay (see overlay.js). The anchor is the trigger's rectangle in the UI window.
    openMenu: (anchor, kind) => (overlay ? overlay.show(anchor, kind) : Promise.resolve(false)),
    closeMenu: () => (overlay ? overlay.hide() : false),
    sendToOverlay: (channel, data) => { if (overlay && overlay.isShown()) overlay.send(channel, data); },
    // How many activity notices the overlay should show (0 hides them).
    setNotices: (count) => { noticeCount = Math.max(0, Math.min(Number(count) || 0, 50)); syncNotices(); },
    focus: () => {
      if (!alive()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  };
}

module.exports = { createWindowController };
