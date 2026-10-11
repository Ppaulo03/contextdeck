'use strict';

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { loadSettings } = require('./persistence/settings');
const { loadUiState, saveUiState } = require('./persistence/ui-state');
const { USER_DATA_DIRNAME, UI_STATE_FILE, CHAT_BINDINGS_FILE, PROJECT_BINDINGS_FILE } = require('./persistence/identity');
const projectModel = require('./project-bindings/model');
const { createProjectBindings } = require('./project-bindings/service');
const { createProjectCreation } = require('./project-bindings/creation');
const { createBindingsStore } = require('./chat-bindings/store');
const { createChatBindings } = require('./chat-bindings/service');
const { startChatsPusher } = require('./ipc/chats');
const { startChatNavPusher } = require('./ipc/chatnav');
const { startActivityPusher } = require('./ipc/activity');
const { createNoticeController } = require('./activity/notices');
const { createDirectOpen } = require('./activity/direct-open');
const { createUnboundActions } = require('./activity/unbound');
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
  // Project links (M01-I3B-3) are EXPERIMENTAL and off by default: the Project URL shape has not been validated on a real
  // account (docs/validation/m01-i3b-3.md). Off means no file is read or written and "Nova conversa" is unchanged.
  const projectsOn = process.env.CONTEXTDECK_PROJECTS === '1';
  const projects = projectsOn
    ? createProjectBindings({ store: createBindingsStore({ file: path.join(userDataDir, PROJECT_BINDINGS_FILE), model: projectModel }), session: settings.herdrSession, bindings, observer, selection })
    : null;
  let creation = null;
  let navPusher = { notify() {}, stop() {} };
  // Conversation activity per workspace (derived from the loaded views, never persisted) rides on the Herdr state the
  // selector already receives; it is re-sent only when it actually changed.
  const activity = () => (win && win.getNavigator() ? win.getNavigator().getWorkspaceActivity() : {});
  let lastActivity = '{}';
  // Global activity (M01-I3B-2H): a projection of the hub's summaries (top bar indicator, activity center), the in-app notices
  // and the "open this conversation" flow. No second source of truth: everything is derived from the navigator on demand.
  const notices = createNoticeController();
  const navigatorOf = () => win.getNavigator();
  const directOpen = createDirectOpen({
    session: settings.herdrSession,
    selection,
    navigator: {
      resolveActivityTarget: (a) => navigatorOf().resolveActivityTarget(a),
      selectBinding: (a) => navigatorOf().selectBinding(a),
      selectTemporary: (a) => navigatorOf().selectTemporary(a)
    },
    showChatTab: () => win.switchMode('chat'),
    getMode: () => win.getMode()
  });
  const unbound = createUnboundActions({ session: settings.herdrSession, bindings, navigator: { openUnbound: (a) => navigatorOf().openUnbound(a), newUnbound: () => navigatorOf().newUnbound(), unboundTarget: (v) => navigatorOf().unboundTarget(v), reconcile: () => navigatorOf().reconcile() }, showChatTab: () => win.switchMode('chat'), getMode: () => win.getMode() });
  const getActivityPayload = () => (navigatorOf() ? { global: navigatorOf().getGlobalActivity(), notices: notices.getState() } : null);
  const activityPusher = startActivityPusher({ getPayload: getActivityPayload, send: (payload) => { win.send('activity:state', payload); win.sendToOverlay('overlay:activity-push', payload); } });
  notices.onChange((s) => { win.setNotices(s.items.length + s.more); activityPusher.notify(); });
  const chatsPusher = startChatsPusher({
    bindings,
    observer,
    selection,
    getUrl: () => win.getChatUrl(),
    extra: (url) => ({ projectsEnabled: projectsOn, projects: projects ? projects.getState({ url }) : null }),
    send: (channel, data) => { win.send(channel, data); win.sendToOverlay('overlay:chats-push', data); }
  });
  const shutdown = () => { herdr.stop(); stopPusher(); chatsPusher.stop(); navPusher.stop(); activityPusher.stop(); notices.stop(); selection.stop(); observer.stop(); };
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
      creation?.resolve();
      navPusher.notify();
      chatsPusher.notify();
      const text = JSON.stringify(activity());
      if (text !== lastActivity) { lastActivity = text; stopPusher.notify?.(); }
      // A notice is only for attention that is still pending: a visit (or a reload) retires it.
      const pending = new Set(navigatorOf().getGlobalActivity().groups.flatMap((g) => g.items.filter((i) => i.attention).map((i) => i.viewId)));
      notices.retain((n) => pending.has(n.viewId));
      activityPusher.notify();
    },
    chats: { session: settings.herdrSession, bindings, selection, onAttention: (event) => notices.push(event) }
  });

  creation = projectsOn ? createProjectCreation({ session: settings.herdrSession, navigator: { newConversation: (a) => win.getNavigator().newConversation(a), selectTemporary: (a) => win.getNavigator().selectTemporary(a), viewInfo: (v) => win.getNavigator().viewInfo(v), reconcile: () => win.getNavigator().reconcile() }, bindings, projects, selection }) : null;
  navPusher = startChatNavPusher({ getState: () => win.getNavigator()?.getState(), send: (channel, data) => win.send(channel, data) });
  registerIpc({ electron, win, herdr, observer, selection, activity, activityIpc: { getPayload: getActivityPayload, directOpen, notices, unbound }, bindings, projects, newConversation: creation ? (a) => creation.start(a) : null, notifyChats: () => { chatsPusher.notify(); win.getNavigator()?.reconcile(); }, settings, uiState, persist, userDataDir });
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
