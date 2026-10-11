'use strict';

const path = require('node:path');
const { app, BrowserWindow, WebContentsView, ipcMain, shell, clipboard, session, dialog } = require('electron');
const fs = require('node:fs');
const { loadSettings, resolveExecutable } = require('./src/settings');
const { loadUiState, saveUiState } = require('./src/ui-state');
const { buildPtyEnv } = require('./src/pty-env');
const { decideShortcut } = require('./src/shortcuts');
const { createGitContext } = require('./src/git-context');
const { createGitActions, formatSize } = require('./src/git-actions');
const { copyFileToClipboard } = require('./src/file-clipboard');

const TOPBAR_HEIGHT = 52;
let footerHeight = 76; // Reported by the renderer (it wraps on narrow windows).
const CHAT_HOME = 'https://chatgpt.com/';
const CHAT_PARTITION = 'persist:project-dock-m00-chat';
const AUTH_POPUP_HOSTS = new Set([
  'chatgpt.com',
  'auth.openai.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com'
]);

const settings = loadSettings(__dirname);
let mainWindow;
let chatView;
let chatSession;
let terminalProcess;
let activeMode = 'terminal';
let uiState;
let uiStateFile;

app.setName('Project Dock M00');

// Two instances would share the same ChatGPT profile and attach to the same Herdr session.
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

function persistUiState() {
  if (!uiStateFile || !uiState) return;
  uiState.lastMode = activeMode;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized() && !mainWindow.isMinimized()) {
    const { width, height } = mainWindow.getBounds();
    uiState.bounds = { width, height };
  }
  saveUiState(uiStateFile, uiState);
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function isHttps(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

function resizeChat() {
  if (!mainWindow || !chatView || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getContentBounds();
  chatView.setBounds({
    x: 0,
    y: TOPBAR_HEIGHT,
    width: Math.max(width, 1),
    height: Math.max(height - TOPBAR_HEIGHT - footerHeight, 1)
  });
}

function switchMode(mode) {
  if (mode !== 'terminal' && mode !== 'chat') return;
  if (!mainWindow || !chatView) return;
  if (mode === 'chat' && activeMode !== 'chat') {
    mainWindow.contentView.addChildView(chatView);
    resizeChat();
  } else if (mode === 'terminal' && activeMode !== 'terminal') {
    mainWindow.contentView.removeChildView(chatView);
  }
  activeMode = mode;
  persistUiState();
  send('dock:mode', mode);
  if (mode === 'chat') {
    chatView.webContents.focus();
  } else {
    mainWindow.webContents.focus();
    send('dock:focus-terminal');
  }
}

// Installed on both webContents. Only a fresh physical keyDown toggles; auto-repeat is swallowed
// (see src/shortcuts.js), so holding Ctrl+Tab cannot flip back and forth between the views.
function handleShortcuts(event, input) {
  const decision = decideShortcut(input);
  if (!decision) return;
  event.preventDefault();
  if (decision === 'toggle') switchMode(activeMode === 'terminal' ? 'chat' : 'terminal');
}

function stopClient() {
  if (!terminalProcess) return;
  const previous = terminalProcess;
  terminalProcess = undefined;
  try { previous.kill(); } catch { /* Client may have exited already. */ }
}

function startHerdr(cols, rows) {
  stopClient();
  if (process.platform !== 'win32') {
    return { ok: false, error: 'This M00 package is scoped to native Windows.' };
  }
  const executable = resolveExecutable(settings.herdrExecutable);
  if (!executable) {
    return {
      ok: false,
      error: `Herdr nao encontrado ("${settings.herdrExecutable}"). Instale o Herdr ou ajuste herdrExecutable em config.json com o caminho completo.`
    };
  }
  try {
    // Lazy require allows the UI to show a readable error if the native module fails to load.
    const pty = require('node-pty');
    // This is only the Herdr *client*; the Herdr server and its agents outlive it.
    const proc = pty.spawn(executable, ['--session', settings.herdrSession], {
      name: 'xterm-256color',
      cols: Math.max(20, Math.min(500, Math.round(cols) || 100)),
      rows: Math.max(5, Math.min(200, Math.round(rows) || 30)),
      cwd: settings.workingDirectory || app.getPath('home'),
      env: buildPtyEnv(process.env)
    });
    terminalProcess = proc;
    proc.onData((data) => {
      if (terminalProcess === proc) send('pty:data', data);
    });
    proc.onExit(({ exitCode }) => {
      if (terminalProcess === proc) {
        terminalProcess = undefined;
        send('pty:exit', { exitCode });
      }
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Git tools: a fixed set of IPC channels, each validating its arguments. There is no generic
// "run command" channel, and nothing here is reachable from the remote ChatGPT page (no preload).
function installGitIpc(trusted) {
  const artifactsDir = path.join(app.getPath('userData'), 'artifacts');
  const gitActions = createGitActions({
    artifactsDir,
    clipboard: { writeText: (text) => clipboard.writeText(text), writeFile: copyFileToClipboard }
  });
  let busy = false;

  let context;
  const ctx = () => (context ||= createGitContext({ state: uiState, persist: persistUiState, suggestedDir: settings.workingDirectory }));

  function zipInfo() {
    const file = uiState.git.lastZip;
    if (!file) return undefined;
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() ? { name: path.basename(file), size: stat.size, sizeText: formatSize(stat.size) } : undefined;
    } catch { return undefined; }
  }

  async function status() {
    const dir = ctx().effectiveDir();
    const info = await gitActions.inspectRepo(dir);
    return {
      configured: info.ok,
      root: info.root,
      name: info.name,
      error: info.ok ? undefined : (dir ? info.error : 'Repositorio nao configurado. Use "Repo..." para escolher a pasta.'),
      suggested: info.ok && !uiState.git.repoDir,
      zip: zipInfo()
    };
  }

  // Serializes git operations so two clicks cannot race on the same ZIP/clipboard.
  async function exclusive(task) {
    if (busy) return { ok: false, error: 'Outra operacao Git ainda esta em andamento.' };
    busy = true;
    try { return await task(); } catch (error) { return { ok: false, error: `Erro inesperado: ${error?.message || error}` }; } finally { busy = false; }
  }

  // Every action re-validates in the main process: the renderer only says which repository it
  // was looking at (`repoRoot`) and which ref; both are re-resolved here before git runs.
  async function withActiveRepo(args, run) {
    const repo = await ctx().activeRepo(typeof args?.repoRoot === 'string' ? args.repoRoot : null);
    if (!repo.ok) return repo;
    return run(repo.root);
  }

  ipcMain.handle('git:status', async (event) => (trusted(event) ? status() : null));
  ipcMain.handle('git:refs', async (event) => (trusted(event) ? ctx().loadRefs() : { ok: false, error: 'Untrusted IPC caller' }));

  ipcMain.handle('git:pick-repo', async (event) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Escolha a pasta do repositorio Git',
      defaultPath: ctx().effectiveDir(),
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    const info = await gitActions.inspectRepo(picked.filePaths[0]);
    if (!info.ok) return { ok: false, error: info.error };
    uiState.git.repoDir = info.root;
    persistUiState();
    return { ok: true, message: `Repositorio: ${info.root}` };
  });

  ipcMain.handle('git:set-refs', (event, args) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return ctx().setRefs(typeof args?.repoRoot === 'string' ? args.repoRoot : null, { baseRef: args?.baseRef, revision: args?.revision });
  });

  ipcMain.handle('git:diff', (event, args) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return exclusive(() => withActiveRepo(args, (root) => gitActions.copyDiff(root, args?.baseRef)));
  });

  ipcMain.handle('git:show', (event, args) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return exclusive(() => withActiveRepo(args, (root) => gitActions.copyShow(root, args?.revision)));
  });

  ipcMain.handle('git:zip', (event, args) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return exclusive(() => withActiveRepo(args, async (root) => {
      const result = await gitActions.makeZip(root, args?.revision);
      // The ZIP exists on disk even if the file-clipboard step failed: keep it selectable/deletable.
      if (result.zip) { uiState.git.lastZip = result.zip.path; persistUiState(); }
      return result;
    }));
  });

  // Takes no path from the renderer: only the ZIP this app generated last can be removed.
  ipcMain.handle('git:delete-zip', (event) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return exclusive(async () => {
      const result = gitActions.deleteZip(uiState.git.lastZip);
      if (result.ok || result.missing) { uiState.git.lastZip = undefined; persistUiState(); }
      return result;
    });
  });
}

function installIpc() {
  const trusted = (event) => mainWindow && event.sender === mainWindow.webContents;
  installGitIpc(trusted);

  ipcMain.handle('dock:layout', (event, layout) => {
    if (!trusted(event)) return false;
    const height = Math.round(Number(layout?.footerHeight));
    if (Number.isFinite(height) && height >= 30 && height <= 420 && height !== footerHeight) {
      footerHeight = height;
      resizeChat();
    }
    return true;
  });

  ipcMain.handle('dock:info', (event) => {
    if (!trusted(event)) return null;
    return { sessionName: settings.herdrSession, mode: activeMode, chatHome: CHAT_HOME };
  });
  ipcMain.handle('dock:switch', (event, mode) => {
    if (!trusted(event)) return false;
    switchMode(mode);
    return true;
  });
  ipcMain.handle('dock:reload-chat', (event) => {
    if (!trusted(event)) return false;
    chatView.webContents.reload();
    return true;
  });
  ipcMain.handle('dock:chat-home', (event) => {
    if (!trusted(event)) return false;
    void chatView.webContents.loadURL(CHAT_HOME).catch((error) => {
      send('chat:error', error.message);
    });
    return true;
  });
  ipcMain.handle('dock:external-chat', (event) => {
    if (!trusted(event)) return false;
    void shell.openExternal(CHAT_HOME);
    return true;
  });
  ipcMain.handle('pty:start', (event, dimensions) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted IPC caller' };
    return startHerdr(dimensions?.cols, dimensions?.rows);
  });
  ipcMain.on('pty:write', (event, text) => {
    if (!trusted(event) || !terminalProcess || typeof text !== 'string' || text.length > 1024 * 1024) return;
    terminalProcess.write(text);
  });
  ipcMain.on('pty:resize', (event, dimensions) => {
    if (!trusted(event) || !terminalProcess) return;
    const cols = Math.floor(Number(dimensions?.cols));
    const rows = Math.floor(Number(dimensions?.rows));
    if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 20 && cols <= 500 && rows >= 5 && rows <= 200) {
      try { terminalProcess.resize(cols, rows); } catch { /* During exit. */ }
    }
  });
  ipcMain.handle('clipboard:write', async (event, text) => {
    if (!trusted(event) || typeof text !== 'string' || text.length > 1024 * 1024) return false;
    await Promise.resolve(clipboard.writeText(text));
    return true;
  });
  ipcMain.handle('clipboard:read', async (event) => {
    if (!trusted(event)) return '';
    return Promise.resolve(clipboard.readText());
  });
}

function createChatView() {
  chatSession = session.fromPartition(CHAT_PARTITION);
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

  chatView = new WebContentsView({
    webPreferences: {
      partition: CHAT_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  chatView.setBackgroundColor('#111827');
  chatView.webContents.on('before-input-event', handleShortcuts);
  chatView.webContents.on('did-start-loading', () => send('chat:status', 'Carregando ChatGPT...'));
  chatView.webContents.on('did-stop-loading', () => send('chat:status', 'Pagina carregada (login nao verificado)'));
  chatView.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3) send('chat:error', `${description} (${code}) - ${validatedUrl}`);
  });
  chatView.webContents.on('did-navigate', (_event, url) => {
    try { send('chat:host', new URL(url).hostname); } catch { /* Ignore. */ }
  });
  chatView.webContents.on('will-navigate', (event, url) => {
    if (!isHttps(url)) event.preventDefault();
  });

  // HTTPS authentication popups stay sandboxed and share this separate profile.
  // Other popups are denied; remote pages never launch OS URLs automatically.
  chatView.webContents.setWindowOpenHandler(({ url }) => {
    if (!isHttps(url)) return { action: 'deny' };
    const hostname = new URL(url).hostname;
    if (AUTH_POPUP_HOSTS.has(hostname)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 680,
          height: 780,
          autoHideMenuBar: true,
          webPreferences: {
            partition: CHAT_PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true
          }
        }
      };
    }
    return { action: 'deny' };
  });
  void chatView.webContents.loadURL(CHAT_HOME).catch((error) => send('chat:error', error.message));
}

async function createWindow() {
  installIpc();
  uiStateFile = path.join(app.getPath('userData'), 'ui-state.json');
  uiState = loadUiState(uiStateFile);
  mainWindow = new BrowserWindow({
    width: uiState.bounds?.width ?? 1240,
    height: uiState.bounds?.height ?? 820,
    minWidth: 800,
    minHeight: 480,
    backgroundColor: '#10141d',
    autoHideMenuBar: true,
    title: 'Project Dock - M00',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('before-input-event', handleShortcuts);
  mainWindow.on('resize', resizeChat);
  mainWindow.on('maximize', resizeChat);
  mainWindow.on('unmaximize', resizeChat);
  // After Alt+Tab the OS may hand focus to the wrong webContents; restore the active one.
  mainWindow.on('focus', () => {
    if (activeMode === 'chat' && chatView && !chatView.webContents.isDestroyed()) chatView.webContents.focus();
    else if (mainWindow) mainWindow.webContents.focus();
  });
  mainWindow.on('close', persistUiState);
  mainWindow.on('closed', () => {
    stopClient();
    if (chatView && !chatView.webContents.isDestroyed()) chatView.webContents.close();
    chatView = undefined;
    mainWindow = undefined;
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  createChatView();
  if (uiState.lastMode === 'chat') switchMode('chat');
  else send('dock:mode', 'terminal');
}

if (hasInstanceLock) {
  app.whenReady().then(createWindow).catch((err) => {
    console.error('Project Dock M00 failed to start:', err);
    app.quit();
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopClient);


