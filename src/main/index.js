'use strict';

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { loadSettings } = require('./persistence/settings');
const { loadUiState, saveUiState } = require('./persistence/ui-state');
const { USER_DATA_DIRNAME, UI_STATE_FILE } = require('./persistence/identity');
const { createHerdrClient } = require('./herdr/client');
const { createWindowController } = require('./window');
const { registerIpc } = require('./ipc');
const { startStatePusher } = require('./ipc/herdr');
const { createSessionLocator } = require('./herdr/session-locator');
const { createWorkspaceObserver } = require('./herdr/workspace-observer');
const { PROJECT_ROOT, PRELOAD, RENDERER_HTML } = require('./paths');

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
  // Read-only discovery of the workspaces of the configured Herdr session (M01-I1).
  const observer = createWorkspaceObserver({ session: settings.herdrSession, locate: createSessionLocator({ herdrExecutable: settings.herdrExecutable }) });
  const shutdown = () => { herdr.stop(); stopPusher(); observer.stop(); };
  win = createWindowController({
    uiState,
    uiStateFile,
    preloadPath: PRELOAD,
    rendererHtml: RENDERER_HTML,
    onClosed: shutdown
  });

  registerIpc({ electron, win, herdr, observer, settings, uiState, persist, userDataDir });
  app.on('second-instance', () => win.focus());
  app.on('before-quit', shutdown);
  await win.create();
  stopPusher = startStatePusher({ observer, send: (channel, data) => win.send(channel, data) });
  observer.start();
}

if (hasInstanceLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    console.error('ContextDeck failed to start:', err);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}
