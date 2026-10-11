'use strict';

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { loadSettings } = require('./persistence/settings');
const { loadUiState, saveUiState } = require('./persistence/ui-state');
const { USER_DATA_DIRNAME, UI_STATE_FILE, CHAT_BINDINGS_FILE } = require('./persistence/identity');
const { createBindingsStore } = require('./chat-bindings/store');
const { createChatBindings } = require('./chat-bindings/service');
const { startChatsPusher } = require('./ipc/chats');
const { startChatNavPusher } = require('./ipc/chatnav');
const { createHerdrClient } = require('./herdr/client');
const { createWindowController } = require('./window');
const { registerIpc } = require('./ipc');
const { startStatePusher } = require('./ipc/herdr');
const { createSessionLocator } = require('./herdr/session-locator');
const { createWorkspaceObserver } = require('./herdr/workspace-observer');
const { createWorkspaceSelection } = require('./herdr/workspace-selection');
const { PROJECT_ROOT, PRELOAD, OVERLAY_PRELOAD, RENDERER_HTML, OVERLAY_HTML } = require('./paths');

const { app } = electron;


// The product is ContextDeck, but its data still lives where the M00 release put it, so the
// ChatGPT login, preferences and ZIPs survive the rename. Pinned explicitly (not derived from
// the app name) and before anything reads userData, including the single-instance lock.
// CONTEXTDECK_USER_DATA is a development/test hook that points the app at a throwaway profile.
const userDataDir = process.env.CONTEXTDECK_USER_DATA || path.join(app.getPath('appData'), USER_DATA_DIRNAME);
app.setPath('userData', userDataDir);
app.setName(USER_DATA_DIRNAME);

// Two instances would share the same ChatGPT profile and attach to the same Herdr session.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();

async function bootstrap() {
  if (!fs.existsSync(RENDERER_HTML)) throw new Error(`${RENDERER_HTML} not found; run "npm run build" (or "npm start").`);
  const settings = loadSettings(PROJECT_ROOT);
  const uiStateFile = path.join(userDataDir, UI_STATE_FILE);
  const uiState = loadUiState(uiStateFile);
  const persist = () => saveUiState(uiStateFile, uiState);

  let win;
  let stopPusher = () => {};
  const herdr = createHerdrClient({ settings, homeDir: app.getPath('home'), send: (channel, data) => win.send(channel, data) });
  // Discovery of the workspaces of the configured Herdr session (M01-I1) and the selector state that
  // sits on top of it (M01-I2). Only the user's explicit selection ever sends workspace.focus.
  const observer = createWorkspaceObserver({ session: settings.herdrSession, locate: createSessionLocator({ herdrExecutable: settings.herdrExecutable }) });
  const selection = createWorkspaceSelection({
    session: settings.herdrSession,
    observer,
    preferences: { get: () => uiState.herdr, set: (patch) => { Object.assign(uiState.herdr, patch); persist(); } }
  });
  // Conversation <-> workspace bindings (M01-I3A): their own file, validated on load, written atomically.
  const bindings = createChatBindings({
    store: createBindingsStore({ file: path.join(userDataDir, CHAT_BINDINGS_FILE) }),
    session: settings.herdrSession,
    observer,
    selection
  });
  let navPusher = { notify() {}, stop() {} };
  // Conversation activity per workspace (derived from the loaded views, never persisted) rides on the Herdr state the
  // selector already receives; it is re-sent only when it actually changed.
  const activity = () => (win && win.getNavigator() ? win.getNavigator().getWorkspaceActivity() : {});
  let lastActivity = '{}';
  const chatsPusher = startChatsPusher({
    bindings,
    observer,
    selection,
    getUrl: () => win.getChatUrl(),
    send: (channel, data) => { win.send(channel, data); win.sendToOverlay('overlay:chats-push', data); }
  });
  const shutdown = () => { herdr.stop(); stopPusher(); chatsPusher.stop(); navPusher.stop(); selection.stop(); observer.stop(); };
  win = createWindowController({
    uiState,
    uiStateFile,
    preloadPath: PRELOAD,
    overlayPreloadPath: OVERLAY_PRELOAD,
    rendererHtml: RENDERER_HTML,
    overlayHtml: OVERLAY_HTML,
    onClosed: shutdown,
    onChatNavigated: () => chatsPusher.notify(),
    onNavChange: () => {
      navPusher.notify();
      chatsPusher.notify();
      const text = JSON.stringify(activity());
      if (text !== lastActivity) { lastActivity = text; stopPusher.notify?.(); }
    },
    chats: { session: settings.herdrSession, bindings, selection }
  });

  navPusher = startChatNavPusher({ getState: () => win.getNavigator()?.getState(), send: (channel, data) => win.send(channel, data) });
  registerIpc({ electron, win, herdr, observer, selection, activity, bindings, notifyChats: () => { chatsPusher.notify(); win.getNavigator()?.reconcile(); }, settings, uiState, persist, userDataDir });
  app.on('second-instance', () => win.focus());
  app.on('before-quit', shutdown);
  await win.create();
  // State goes to the UI window and, while the workspace menu is open, to the menu overlay too.
  stopPusher = startStatePusher({
    observer,
    selection,
    extra: activity,
    send: (channel, data) => { win.send(channel, data); if (channel === 'herdr:state') win.sendToOverlay('overlay:state-push', data); }
  });
  selection.start();
  observer.start();
}

if (hasInstanceLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    console.error('ContextDeck failed to start:', err);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
