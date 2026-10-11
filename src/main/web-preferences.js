'use strict';

// Single source of truth for the isolation settings of every web contents the app creates.
// Remote content (ChatGPT and its auth popups) never gets a preload, Node integration or an
// unsandboxed context; only the local UI window gets the preload bridge.
const ISOLATED = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true
});

const appWebPreferences = (preloadPath) => ({ preload: preloadPath, ...ISOLATED });
const chatWebPreferences = (partition) => ({ partition, ...ISOLATED, allowRunningInsecureContent: false });
const authPopupWebPreferences = (partition) => ({ partition, ...ISOLATED });

module.exports = { ISOLATED, appWebPreferences, chatWebPreferences, authPopupWebPreferences };
