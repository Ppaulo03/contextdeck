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

// Permissions of the ChatGPT profile. Set on the session, which every ChatGPT view shares (one persistent
// partition: the login is common to all of them), so this runs once.
let sessionConfigured = false;
function configureChatSession() {
  if (sessionConfigured) return;
  sessionConfigured = true;
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
}

// One ChatGPT page: a sandboxed WebContentsView on the shared persistent partition, no preload and no Node. It
// never talks to the local UI. Main learns about it only through `onEvent` (consumed by the chat view manager)
// and `status` (the footer line, which the window only forwards for the view that is on screen).
// Every ChatGPT view of the application is created here, so they all have the same isolation, navigation and
// popup policy.
function createChatView({ onBeforeInput, onEvent, status, onNavigated }) {
  configureChatSession();
  const view = new WebContentsView({ webPreferences: chatWebPreferences(CHAT_PARTITION) });
  const contents = view.webContents;
  view.setBackgroundColor('#111827');
  contents.on('before-input-event', onBeforeInput);
  contents.on('did-start-loading', () => status?.('chat:status', 'Carregando ChatGPT...'));
  contents.on('did-stop-loading', () => { status?.('chat:status', 'Pagina carregada (login nao verificado)'); onEvent?.('loaded', {}); });
  contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      status?.('chat:error', `${description} (${code}) - ${validatedUrl}`);
      onEvent?.('load-failed', { error: { errno: code, description } });
    }
  });
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame !== false && !isInPlace) onEvent?.('navigation-started', {}); });
  contents.on('did-navigate', (_event, url) => {
    try { status?.('chat:host', new URL(url).hostname); } catch { /* Ignore. */ }
    onEvent?.('navigated', { url });
    onNavigated?.();
  });
  // SPA navigation (another conversation, same document): the address changes without a page load.
  contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame === false) return;
    onEvent?.('navigated', { url });
    onNavigated?.();
  });
  contents.on('render-process-gone', () => onEvent?.('process-gone', {}));
  contents.on('destroyed', () => onEvent?.('destroyed', {}));
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

  const alive = () => !contents.isDestroyed();
  return {
    view,
    contents,
    // Address of the page now loaded, read by main (never reported by the remote page).
    getUrl: () => (alive() ? contents.getURL() : ''),
    loadURL: (url) => contents.loadURL(url),
    goHome: () => { if (alive()) contents.loadURL(CHAT_HOME).catch((error) => status?.('chat:error', error.message)); },
    reload: () => { if (alive()) contents.reload(); },
    focus: () => { if (alive()) contents.focus(); },
    // Browser history of this page (the user's own navigation inside it); used by the conflict modal's "Voltar".
    canGoBack: () => alive() && contents.navigationHistory.canGoBack(),
    goBack: () => { if (alive() && contents.navigationHistory.canGoBack()) { contents.navigationHistory.goBack(); return true; } return false; },
    // OS process hosting this page (resource report only; shared with other views when Chromium reuses a renderer).
    getProcessId: () => (alive() ? contents.getOSProcessId() : 0),
    isDestroyed: () => !alive(),
    destroy: () => { if (alive()) contents.close(); }
  };
}

module.exports = { createChatView };
