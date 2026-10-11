'use strict';

const { WebContentsView, session } = require('electron');
const { CHAT_PARTITION, CHAT_HOME } = require('./persistence/identity');
const { chatWebPreferences, authPopupWebPreferences } = require('./web-preferences');

const AUTH_POPUP_HOSTS = new Set([
  'chatgpt.com',
  'auth.openai.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com'
]);

function isHttps(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

// The ChatGPT page: a sandboxed WebContentsView with its own persistent partition, no preload and
// no Node. It never talks to the local UI; main only reflects its load status through `send`.
function createChatView({ send, onBeforeInput, onNavigated }) {
  const chatSession = session.fromPartition(CHAT_PARTITION);
  chatSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    let allowed = false;
    try {
      const requestingHost = new URL(details.requestingUrl).hostname;
      allowed = requestingHost === 'chatgpt.com' &&
        (permission === 'clipboard-sanitized-write' || permission === 'clipboard-write');
    } catch { /* Deny unknown origins. */ }
    callback(allowed);
  });
  // Synchronous permission checks (e.g. clipboard-read, media) are denied by default.
  chatSession.setPermissionCheckHandler(() => false);

  const view = new WebContentsView({ webPreferences: chatWebPreferences(CHAT_PARTITION) });
  const contents = view.webContents;
  view.setBackgroundColor('#111827');
  contents.on('before-input-event', onBeforeInput);
  contents.on('did-start-loading', () => send('chat:status', 'Carregando ChatGPT...'));
  contents.on('did-stop-loading', () => send('chat:status', 'Pagina carregada (login nao verificado)'));
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) send('chat:error', `${description} (${code}) - ${validatedUrl}`);
  });
  contents.on('did-navigate', (_event, url) => {
    try { send('chat:host', new URL(url).hostname); } catch { /* Ignore. */ }
    onNavigated?.();
  });
  // SPA navigation (another conversation, same document): the address changes without a page load.
  contents.on('did-navigate-in-page', () => onNavigated?.());
  contents.on('will-navigate', (event, url) => {
    if (!isHttps(url)) event.preventDefault();
  });

  // HTTPS authentication popups stay sandboxed and share this separate profile.
  // Other popups are denied; remote pages never launch OS URLs automatically.
  contents.setWindowOpenHandler(({ url }) => {
    if (!isHttps(url)) return { action: 'deny' };
    if (AUTH_POPUP_HOSTS.has(new URL(url).hostname)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 680,
          height: 780,
          autoHideMenuBar: true,
          webPreferences: authPopupWebPreferences(CHAT_PARTITION)
        }
      };
    }
    return { action: 'deny' };
  });

  const loadHome = () => contents.loadURL(CHAT_HOME).catch((error) => send('chat:error', error.message));
  void loadHome();

  return {
    view,
    contents,
    goHome: () => { void loadHome(); },
    reload: () => contents.reload(),
    // Address of the page now loaded, read by main (never reported by the remote page).
    getUrl: () => (contents.isDestroyed() ? '' : contents.getURL()),
    focus: () => contents.focus(),
    destroy: () => { if (!contents.isDestroyed()) contents.close(); }
  };
}

module.exports = { createChatView };
