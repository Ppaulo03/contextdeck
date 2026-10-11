'use strict';

// Guards the repository layout (R00): entrypoints, build output, resource paths, preload
// isolation, IPC registration and compatibility with data written by Project Dock M00.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const tmpDirs = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}
const sourceFiles = walk(SRC).filter((f) => f.endsWith('.js'));

// ---- entrypoints, scripts, paths ---------------------------------------------------------

test('package.json: ContextDeck identity, entrypoint and scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'contextdeck');
  assert.match(pkg.description, /ContextDeck/);
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `main ${pkg.main} exists`);
  assert.equal(pkg.main, 'src/main/index.js');
  assert.match(pkg.scripts.start, /npm run build/, 'start builds before launching');
  assert.match(pkg.scripts.start, /electron \./);
  assert.ok(pkg.scripts.build && pkg.scripts.test && pkg.scripts.check);
  assert.doesNotMatch(JSON.stringify(pkg), /project-dock|Project Dock|rebuild/i);
});

test('every source file is syntactically valid', () => {
  for (const file of [...sourceFiles, path.join(ROOT, 'scripts', 'build.js')]) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${path.relative(ROOT, file)}: ${r.stderr}`);
  }
});

test('resource paths point at existing sources and at the dist/ build output', () => {
  const paths = require('../src/main/paths');
  assert.equal(path.resolve(paths.PROJECT_ROOT), path.resolve(ROOT));
  assert.ok(fs.existsSync(paths.PRELOAD), 'preload exists');
  assert.equal(path.relative(ROOT, paths.RENDERER_HTML), path.join('dist', 'renderer', 'index.html'));
  assert.ok(fs.existsSync(path.join(SRC, 'renderer', 'index.html')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'main.js')) && !fs.existsSync(path.join(ROOT, 'preload.js')) && !fs.existsSync(path.join(ROOT, 'renderer')), 'old root entrypoints are gone');
});

test('build emits a self-contained renderer into the requested directory (dist/ layout)', () => {
  const out = path.join(tmp('dock-build-'), 'renderer');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js'), out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['index.html', 'overlay.html', 'overlay.css', 'styles.css', 'app.bundle.js', 'app.bundle.css', 'overlay.bundle.js']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const pages = { 'index.html': ['app.bundle.css', 'app.bundle.js', 'styles.css'], 'overlay.html': ['overlay.bundle.js', 'overlay.css', 'styles.css'] };
  for (const [page, expected] of Object.entries(pages)) {
    const html = fs.readFileSync(path.join(out, page), 'utf8');
    const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(refs.sort(), expected, page);
    for (const ref of refs) assert.ok(fs.existsSync(path.join(out, ref)), `${page} references ${ref}`);
    assert.doesNotMatch(html, /node_modules/);
  }
  assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /<title>ContextDeck<\/title>/);
  assert.match(fs.readFileSync(path.join(out, 'app.bundle.js'), 'utf8'), /\[ContextDeck\]/);
  // styles.css is one self-contained file: tokens, base, layout and components, with the @imports inlined.
  const css = fs.readFileSync(path.join(out, 'styles.css'), 'utf8');
  assert.doesNotMatch(css, /@import/);
  assert.match(css, /--bg-terminal:/);
  assert.match(css, /\.menu-item/);
  assert.match(css, /\.select\[aria-busy=["']?true["']?\]/);
});

test('generated and local files are git-ignored; no build output or secrets are tracked in source dirs', () => {
  const ignore = read('.gitignore').split(/\r?\n/);
  for (const entry of ['node_modules/', 'dist/', 'config.json']) assert.ok(ignore.includes(entry), entry);
  assert.ok(!sourceFiles.some((f) => /bundle/.test(f)), 'no bundles inside src/');
});

test('every element id a renderer script looks up exists in the page that loads it (a missing id would break the UI at load)', () => {
  const idsOf = (page) => new Set([...read('src', 'renderer', page).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const pages = { main: idsOf('index.html'), overlay: idsOf(path.join('overlay', 'overlay.html')) };
  const used = { main: new Set(), overlay: new Set() };
  for (const file of sourceFiles.filter((f) => f.includes(`${path.sep}renderer${path.sep}`))) {
    const text = fs.readFileSync(file, 'utf8');
    const bucket = file.includes(`${path.sep}overlay${path.sep}`) ? used.overlay : used.main;
    for (const [, id] of text.matchAll(/getElementById\('([^']+)'\)/g)) bucket.add(id);
    for (const [, id] of text.matchAll(/\$\('([^']+)'\)/g)) bucket.add(id);          // dom.js shorthand
  }
  assert.ok(used.main.size > 25 && used.overlay.size >= 5, 'sanity: the scan found the ids');
  assert.deepEqual([...used.main].filter((id) => !pages.main.has(id)), []);
  assert.deepEqual([...used.overlay].filter((id) => !pages.overlay.has(id)), []);
});

test('a workspace choice can only come from the menu overlay; the top bar component and state rendering never send one', () => {
  const overlay = read('src', 'renderer', 'overlay', 'overlay.js');
  assert.equal([...overlay.matchAll(/window\.overlay\.choose\(/g)].length, 1, 'a single call site');
  const choose = overlay.slice(overlay.indexOf('async function choose('), overlay.indexOf('function move('));
  assert.match(choose, /window\.overlay\.choose\(/);
  assert.match(choose, /if \(busy \|\| !m\.connected/);
  // Every call of choose() is a user gesture: a click on a row or Enter in the keydown handler.
  const callers = overlay.split('\n').filter((line) => /[^.\w]choose\(/.test(line) && !/async function choose/.test(line));
  assert.ok(callers.length >= 2);
  for (const line of callers) assert.match(line, /addEventListener\('click'|case 'Enter'/, line.trim());
  for (const file of ['components/workspace-selector.js', 'components/herdr-panel.js', 'components/herdr-store.js', 'app.js']) {
    assert.doesNotMatch(read('src', 'renderer', file), /herdrSelectWorkspace|overlay\.choose/, file);
  }
});

test('styles are token-driven: raw colors, layers and font stacks exist only in tokens.css', () => {
  const dir = path.join(SRC, 'renderer', 'styles');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css') && f !== 'tokens.css')) {
    const css = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${file}: raw hex color`);
    assert.doesNotMatch(css, /rgba?\(/, `${file}: raw rgb color`);
    assert.doesNotMatch(css, /z-index:\s*\d/, `${file}: literal z-index`);
    assert.doesNotMatch(css, /font-family:\s*(?!var\()\S/, `${file}: font stack outside tokens`);
  }
  assert.doesNotMatch(read('src', 'renderer', 'overlay', 'overlay.css'), /#[0-9a-fA-F]{3,8}\b|z-index:\s*\d/);
  const tokens = fs.readFileSync(path.join(dir, 'tokens.css'), 'utf8');
  for (const name of ['--bg-terminal', '--accent', '--space-4', '--radius-md', '--control-h', '--z-menu', '--duration-spin']) assert.match(tokens, new RegExp(`${name}:`));
  assert.ok(!fs.existsSync(path.join(SRC, 'renderer', 'styles.css')), 'the old monolithic stylesheet is gone');
  const components = fs.readFileSync(path.join(dir, 'components.css'), 'utf8');
  assert.match(components, /prefers-reduced-motion|var\(--duration-spin\)/);
  assert.match(fs.readFileSync(path.join(dir, 'base.css'), 'utf8'), /prefers-reduced-motion: reduce/);
});

test('renderer wiring: each bridge subscription is registered once (no duplicated listeners)', () => {
  const files = sourceFiles.filter((f) => f.includes(`${path.sep}renderer${path.sep}`) && !f.includes(`${path.sep}overlay${path.sep}`));
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // onOverlayClosed: the workspace selector and the chat indicator each restore focus to their own trigger (told apart by `kind`).
  const expected = { onHerdrState: 1, onMode: 1, onPtyData: 1, onPtyExit: 1, onFocusTerminal: 1, onChatStatus: 1, onChatHost: 1, onChatError: 1, onChatsState: 1, onChatNavState: 1, onOverlayClosed: 2 };
  for (const [name, count] of Object.entries(expected)) {
    assert.equal([...text.matchAll(new RegExp(`dock\\.${name}\\(`, 'g'))].length, count, `dock.${name}( is subscribed in ${count} place(s)`);
  }
  assert.equal([...text.matchAll(/chatsState\(\)/g)].length, 1, 'one initial chats state read (in the indicator)');
  assert.equal([...text.matchAll(/chatNavState\(\)/g)].length, 1, 'one initial navigation state read (in the strip)');
  assert.equal([...text.matchAll(/herdrState\(\)/g)].length, 1, 'one initial state read (in the store)');
  assert.equal([...text.matchAll(/new ResizeObserver\(/g)].length, 2, 'terminal root and footer');
});

test('required documentation exists and every relative markdown link resolves', () => {
  const required = ['README.md', 'AGENTS.md', 'config.example.json', 'docs/architecture.md', 'docs/roadmap.md', 'docs/development.md', 'docs/validation/m00.md', 'docs/decisions/0001-herdr-workspaces.md'];
  for (const f of required) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  const markdown = ['README.md', 'AGENTS.md', ...walk(path.join(ROOT, 'docs')).map((f) => path.relative(ROOT, f)).filter((f) => f.endsWith('.md'))];
  for (const file of markdown) {
    const dir = path.dirname(path.join(ROOT, file));
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const resolved = path.resolve(dir, target.split('#')[0]);
      assert.ok(fs.existsSync(resolved), `${file} -> ${target}`);
    }
  }
  assert.match(read('README.md'), /^# ContextDeck/m);
  assert.doesNotMatch(read('README.md'), /npm run rebuild|Project Dock - M00/);
});

// ---- layering ------------------------------------------------------------------------------

test('only the Electron-facing modules require "electron"; the rest stays unit-testable', () => {
  const allowed = new Set(['index.js', 'window.js', 'chat-view.js', 'overlay.js'].map((f) => path.join(SRC, 'main', f)).concat(path.join(SRC, 'preload', 'index.js'), path.join(SRC, 'preload', 'overlay.js')));
  const offenders = sourceFiles.filter((f) => !f.includes(`${path.sep}renderer${path.sep}`) && !allowed.has(f) && /require\('electron'\)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
  // Shared view-models are pure: no Electron, no Node built-ins, no imports from main/preload/renderer.
  for (const f of sourceFiles.filter((x) => x.includes(`${path.sep}shared${path.sep}`))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /require\('(electron|node:|fs|path|child_process)|require\('\.\.\/(main|preload|renderer)/, path.relative(ROOT, f));
  }
});

test('main-process modules never import from the renderer or preload, and vice versa', () => {
  for (const f of sourceFiles) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC, f);
    if (rel.startsWith('main')) assert.doesNotMatch(text, /require\('\.\.\/(\.\.\/)*(renderer|preload)/, rel);
    if (rel.startsWith('renderer')) assert.doesNotMatch(text, /require\(|from '\.\.\/main/, rel);
  }
});

// ---- isolation -------------------------------------------------------------------------------

test('web preferences: remote content is isolated and has no preload; only the UI window has one', () => {
  const wp = require('../src/main/web-preferences');
  const chat = wp.chatWebPreferences('persist:x');
  const popup = wp.authPopupWebPreferences('persist:x');
  const app = wp.appWebPreferences('C:\\p.js');
  for (const prefs of [chat, popup, app]) {
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.webSecurity, true);
  }
  assert.equal(chat.preload, undefined);
  assert.equal(popup.preload, undefined);
  assert.equal(chat.allowRunningInsecureContent, false);
  assert.equal(app.preload, 'C:\\p.js');
  assert.ok(Object.isFrozen(wp.ISOLATED));
});

test('chat view and popups take their preferences from web-preferences (no ad-hoc webPreferences)', () => {
  const chatSrc = fs.readFileSync(path.join(SRC, 'main', 'chat-view.js'), 'utf8');
  assert.match(chatSrc, /chatWebPreferences\(CHAT_PARTITION\)/);
  assert.match(chatSrc, /authPopupWebPreferences\(CHAT_PARTITION\)/);
  assert.doesNotMatch(chatSrc, /preload\s*:|nodeIntegration\s*:|webPreferences:\s*\{/);
  assert.match(fs.readFileSync(path.join(SRC, 'main', 'window.js'), 'utf8'), /appWebPreferences\(preloadPath\)/);
});

test('preload only bridges named functions through contextBridge and never exposes ipcRenderer', () => {
  const preload = read('src', 'preload', 'index.js');
  assert.deepEqual([...preload.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]), ['electron']);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('dock'/);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\b[^)]*\)/);
  assert.doesNotMatch(preload, /:\s*ipcRenderer\s*[,}]/);
  assert.doesNotMatch(preload, /require\('(fs|child_process|node:)/);
  // The overlay bridge is smaller still: only the menu's own channels, nothing else.
  const overlay = read('src', 'preload', 'overlay.js');
  assert.deepEqual([...overlay.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]), ['electron']);
  assert.match(overlay, /contextBridge\.exposeInMainWorld\('overlay'/);
  assert.doesNotMatch(overlay, /:\s*ipcRenderer\s*[,}]|require\('(fs|child_process|node:)/);
  const channels = [...overlay.matchAll(/ipcRenderer\.invoke\('([^']+)'|listen\('([^']+)'/g)].map((m) => m[1] || m[2]).sort();
  assert.deepEqual(channels, [...OVERLAY_ONLY, ...CHATS_CHANNELS, 'overlay:chats-push', 'overlay:open', 'overlay:state-push'].sort());
});

// ---- IPC contract ------------------------------------------------------------------------------

const HANDLE_CHANNELS = [
  'clipboard:read', 'clipboard:write', 'dock:chat-home', 'dock:external-chat', 'dock:info', 'dock:layout',
  'dock:reload-chat', 'dock:switch', 'git:delete-zip', 'git:diff', 'git:pick-repo', 'git:refs', 'git:set-refs',
  'herdr:refresh', 'herdr:select-workspace', 'herdr:set-sync-mode', 'herdr:state',
  'overlay:choose', 'overlay:close', 'overlay:open-chats-panel', 'overlay:open-workspace-menu', 'overlay:state',
  'chats:bind', 'chats:reassign', 'chats:state', 'chats:unbind', 'chats:update',
  'chatnav:new', 'chatnav:open-unscoped', 'chatnav:select', 'chatnav:select-temporary', 'chatnav:state',
  'git:show', 'git:status', 'git:zip', 'pty:start'
].sort();
// Chat bindings (M01-I3A): callable from the UI window AND from the overlay panel, never from the remote page.
const CHATS_CHANNELS = ['chats:bind', 'chats:reassign', 'chats:state', 'chats:unbind', 'chats:update'];
// What the local UI window may invoke vs what only the menu overlay may invoke (least privilege).
const OVERLAY_ONLY = ['overlay:choose', 'overlay:close', 'overlay:state'];
const ON_CHANNELS = ['pty:resize', 'pty:write'];

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    ipcMain: { handle: (c, fn) => { assert.ok(!handlers.has(c) && !listeners.has(c), `duplicate ${c}`); handlers.set(c, fn); }, on: (c, fn) => { assert.ok(!handlers.has(c) && !listeners.has(c), `duplicate ${c}`); listeners.set(c, fn); } }
  };
}

function fakeBindings(calls) {
  const record = (name) => (args) => { calls.chats.push([name, args]); return { ok: true }; };
  return { getState: (args) => { calls.chats.push(['state', args]); return { fake: true }; }, bind: record('bind'), update: record('update'), unbind: record('unbind'), reassign: record('reassign') };
}

function registerWithFakes(overrides = {}) {
  const { registerIpc } = require('../src/main/ipc');
  const ipc = fakeIpc();
  const calls = { switchMode: [], footer: [], write: [], resize: [], openExternal: [], start: [], refresh: 0, select: [], syncMode: [], openMenu: [], closeMenu: 0, chats: [], notified: 0 };
  const win = {
    isTrusted: (event) => event.trusted === true,
    isOverlay: (event) => event.overlay === true,
    openMenu: async (anchor, kind) => { calls.openMenu.push(kind ? [anchor, kind] : anchor); return true; },
    getChatUrl: () => 'https://chatgpt.com/c/11111111-2222-3333-4444-555555555555',
    closeMenu: () => { calls.closeMenu += 1; return true; },
    switchMode: (m) => calls.switchMode.push(m),
    setFooterHeight: (h) => calls.footer.push(h),
    getMode: () => 'terminal',
    getChat: () => ({ reload() {}, goHome() {} }),
    getWindow: () => undefined,
    ...overrides.win
  };
  const herdr = {
    start: (c, r) => { calls.start.push([c, r]); return { ok: true }; },
    isRunning: () => true,
    write: (t) => calls.write.push(t),
    resize: (c, r) => calls.resize.push([c, r])
  };
  const userDataDir = tmp('dock-ud-');
  const clipboard = { writeText: () => {}, readText: () => 'CLIP' };
  registerIpc({
    electron: { ipcMain: ipc.ipcMain, shell: { openExternal: (u) => calls.openExternal.push(u) }, clipboard, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } },
    win, herdr,
    observer: { getState: () => ({ session: 'contextdeck', connection: 'stopped' }), refresh: async () => { calls.refresh += 1; } },
    selection: {
      getState: () => ({ mode: 'auto' }),
      select: async (session, workspaceId) => { calls.select.push([session, workspaceId]); return { ok: true }; },
      setMode: (mode) => { calls.syncMode.push(mode); return { ok: true, mode }; }
    },
    bindings: fakeBindings(calls),
    notifyChats: () => { calls.notified += 1; },
    settings: { herdrSession: 'contextdeck', workingDirectory: undefined },
    uiState: require('../src/main/persistence/ui-state').sanitize(undefined), persist: () => {}, userDataDir
  });
  return { ...ipc, calls };
}

test('IPC: exactly the contract channels are registered, each once, with the same kind as before', () => {
  const { handlers, listeners } = registerWithFakes();
  assert.deepEqual([...handlers.keys()].sort(), HANDLE_CHANNELS);
  assert.deepEqual([...listeners.keys()].sort(), ON_CHANNELS);
});

test('IPC: Herdr channels are state/refresh plus the explicit selection and mode; no mutation beyond workspace.focus, no method forwarding', () => {
  const { handlers, listeners } = registerWithFakes();
  const herdrChannels = [...handlers.keys(), ...listeners.keys()].filter((c) => c.startsWith('herdr:'));
  assert.deepEqual(herdrChannels.sort(), ['herdr:refresh', 'herdr:select-workspace', 'herdr:set-sync-mode', 'herdr:state']);
  const preload = read('src', 'preload', 'index.js');
  assert.doesNotMatch(preload, /herdr[A-Za-z]*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send)\('(?!herdr:(state|refresh|select-workspace|set-sync-mode)')/);
  const apiClient = read('src', 'main', 'herdr', 'api-client.js');
  assert.match(apiClient, /READ_ONLY_METHODS = Object\.freeze\(\['ping', 'session\.snapshot', 'workspace\.list', 'workspace\.get'\]\)/);
  assert.match(apiClient, /FOCUS_METHOD = 'workspace\.focus'/);
  // Only api-client.js may name the focus method; nothing may name any other mutating method.
  const mainFiles = sourceFiles.filter((f) => f.includes(`${path.sep}main${path.sep}`));
  const namingFocus = mainFiles.filter((f) => /['"]workspace\.focus['"]/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(namingFocus, [path.join('src', 'main', 'herdr', 'api-client.js')]);
  for (const file of mainFiles.filter((f) => f.includes(path.join('main', 'herdr')) || f.includes(path.join('main', 'ipc')))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /['"]workspace\.(create|rename|close|move|move_block|report_metadata)['"]|['"]worktree\.[a-z_]+['"]|['"]tab\.(create|close|rename|move)['"]|['"]pane\.(send_text|send_keys|send_input|close|split)['"]|['"]agent\.(prompt|start|send_keys)['"]|['"]server\.[a-z_]+['"]/, path.relative(ROOT, file));
  }
  // The renderer cannot name a Herdr method either: it only sees the named bridge functions.
  assert.doesNotMatch(read('src', 'renderer', 'components', 'workspace-selector.js') + read('src', 'renderer', 'components', 'herdr-panel.js') + read('src', 'renderer', 'overlay', 'overlay.js'), /['"]workspace\.focus['"]|ipcRenderer/);
});

test('IPC: preload channels all exist in main, and main only sends channels the preload listens to', () => {
  const preload = read('src', 'preload', 'index.js');
  const overlayPreload = read('src', 'preload', 'overlay.js');
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  const overlayInvoked = [...overlayPreload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  const sent = [...preload.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set([...invoked, ...overlayInvoked])].sort(), HANDLE_CHANNELS, 'every handler is reachable from one of the two preloads and vice versa');
  assert.deepEqual([...overlayInvoked].sort(), [...OVERLAY_ONLY, ...CHATS_CHANNELS].sort(), 'the overlay bridge reaches only the menu channels and the chat bindings channels');
  assert.ok(invoked.every((c) => !OVERLAY_ONLY.includes(c)), 'the UI window bridge cannot reach the overlay-only channels');
  assert.deepEqual([...sent].sort(), ON_CHANNELS);
  const listened = new Set([...preload.matchAll(/listen\('([^']+)'/g), ...overlayPreload.matchAll(/listen\('([^']+)'/g)].map((m) => m[1]));
  const emitted = new Set(sourceFiles.filter((f) => f.includes(`${path.sep}main${path.sep}`)).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\b(?:send|sendToOverlay|status\?\.)\('([a-z]+:[a-z-]+)'/g)].map((m) => m[1])));
  assert.deepEqual([...emitted].sort(), [...listened].sort());
});

test('IPC: an untrusted sender is refused on every channel and triggers no side effects', async () => {
  const { handlers, listeners, calls } = registerWithFakes();
  const stranger = { trusted: false };
  const denied = (value) => value === false || value === null || value === '' || (value && value.ok === false);
  for (const [channel, fn] of handlers) {
    const result = await fn(stranger, { cols: 80, rows: 24, repoRoot: 'C:\\x', baseRef: 'dev', revision: 'HEAD', footerHeight: 100 }, 'payload');
    assert.ok(denied(result), `${channel} -> ${JSON.stringify(result)}`);
  }
  for (const fn of listeners.values()) await fn(stranger, 'text', { cols: 80, rows: 24 });
  assert.deepEqual(calls, { switchMode: [], footer: [], write: [], resize: [], openExternal: [], start: [], refresh: 0, select: [], syncMode: [], openMenu: [], closeMenu: 0, chats: [], notified: 0 });
});

test('IPC least privilege: the menu overlay can use only its own channels, and the UI window cannot use them', async () => {
  const { handlers, calls } = registerWithFakes();
  const denied = (value) => value === false || value === null || value === '' || (value && value.ok === false);
  const overlay = { overlay: true };
  const ui = { trusted: true };
  const anchor = { x: 10, y: 20, width: 200, height: 26 };
  for (const channel of handlers.keys()) {
    if (OVERLAY_ONLY.includes(channel)) {
      assert.ok(denied(await handlers.get(channel)(ui, { session: 's', workspaceId: 'w1' })), `${channel}: UI window refused`);
    } else if (CHATS_CHANNELS.includes(channel)) {
      continue;   // shared on purpose: covered by test/chat-bindings-ipc.test.js
    } else if (channel === 'overlay:open-workspace-menu' || channel === 'overlay:open-chats-panel') {
      assert.ok(denied(await handlers.get(channel)(overlay, anchor)), `${channel}: overlay refused`);
    } else {
      assert.ok(denied(await handlers.get(channel)(overlay, { session: 's', workspaceId: 'w1', repoRoot: 'x' })), `${channel}: overlay refused`);
    }
  }
  assert.deepEqual([calls.select, calls.openMenu, calls.closeMenu, calls.switchMode], [[], [], 0, []], 'nothing happened');
  // The right senders work; the anchor is validated.
  assert.deepEqual(await handlers.get('overlay:open-workspace-menu')(ui, anchor), { ok: true });
  for (const bad of [null, undefined, 'x', {}, { x: 1, y: 1, width: 1 }, { x: -1, y: 0, width: 1, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: 1e9, y: 0, width: 1, height: 1 }, { x: '1', y: 0, width: 1, height: 1 }]) {
    assert.equal((await handlers.get('overlay:open-workspace-menu')(ui, bad)).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(calls.openMenu, [anchor], 'only the valid anchor opened the menu');
  assert.deepEqual(await handlers.get('overlay:state')(overlay), { session: 'contextdeck', connection: 'stopped', selection: { mode: 'auto' } });
  await handlers.get('overlay:choose')(overlay, { session: 'contextdeck', workspaceId: 'w2', method: 'workspace.close' });
  await handlers.get('overlay:choose')(overlay, { session: ['x'], workspaceId: 9 });
  assert.deepEqual(calls.select, [['contextdeck', 'w2'], [null, null]]);
  assert.equal(await handlers.get('overlay:close')(overlay), true);
  assert.equal(calls.closeMenu, 1);
});

test('IPC: a trusted sender reaches the handlers and validation still applies', async () => {
  const { handlers, listeners, calls } = registerWithFakes();
  const ui = { trusted: true };
  assert.equal(await handlers.get('dock:switch')(ui, 'chat'), true);
  assert.equal(await handlers.get('dock:layout')(ui, { footerHeight: 120 }), true);
  assert.deepEqual(await handlers.get('dock:info')(ui), { sessionName: 'contextdeck', mode: 'terminal', chatHome: 'https://chatgpt.com/' });
  assert.equal(await handlers.get('clipboard:read')(ui), 'CLIP');
  assert.equal(await handlers.get('clipboard:write')(ui, 'x'.repeat(1024 * 1024 + 1)), false, 'oversized clipboard text is refused');
  await handlers.get('dock:external-chat')(ui);
  assert.deepEqual(calls.openExternal, ['https://chatgpt.com/']);
  await handlers.get('pty:start')(ui, { cols: 100, rows: 30 });
  assert.deepEqual(calls.start, [[100, 30]]);
  listeners.get('pty:write')(ui, 'ls\r');
  listeners.get('pty:write')(ui, 'x'.repeat(1024 * 1024 + 1));
  listeners.get('pty:write')(ui, { not: 'a string' });
  assert.deepEqual(calls.write, ['ls\r']);
  listeners.get('pty:resize')(ui, { cols: 120, rows: 40 });
  listeners.get('pty:resize')(ui, { cols: 5, rows: 40 });
  listeners.get('pty:resize')(ui, { cols: 'abc', rows: 40 });
  assert.deepEqual(calls.resize, [[120, 40]]);
  assert.deepEqual(calls.switchMode, ['chat']);
  assert.deepEqual(calls.footer, [120]);
  assert.deepEqual(await handlers.get('herdr:state')(ui), { session: 'contextdeck', connection: 'stopped', selection: { mode: 'auto' } });
  assert.deepEqual(await handlers.get('herdr:refresh')(ui), { session: 'contextdeck', connection: 'stopped', selection: { mode: 'auto' } });
  assert.equal(calls.refresh, 1);
  // Selection: only plain strings are forwarded; anything else becomes null for main to refuse.
  await handlers.get('herdr:select-workspace')(ui, { session: 'contextdeck', workspaceId: 'w2', method: 'workspace.close', extra: 1 });
  await handlers.get('herdr:select-workspace')(ui, { session: { x: 1 }, workspaceId: 7 });
  await handlers.get('herdr:select-workspace')(ui, undefined);
  assert.deepEqual(calls.select, [['contextdeck', 'w2'], [null, null], [null, null]], 'no extra fields, no method names, no non-strings reach the controller');
  assert.deepEqual(await handlers.get('herdr:set-sync-mode')(ui, { mode: 'manual' }), { ok: true, mode: 'manual' });
  assert.deepEqual(calls.syncMode, ['manual']);
  const git = await handlers.get('git:status')(ui);
  assert.equal(git.configured, false);
  assert.match(git.error, /nao configurado/);
});

// ---- compatibility with Project Dock M00 data ------------------------------------------------------

test('persistent identifiers are unchanged from Project Dock M00', () => {
  const id = require('../src/main/persistence/identity');
  assert.equal(id.USER_DATA_DIRNAME, 'Project Dock M00');
  assert.equal(id.CHAT_PARTITION, 'persist:project-dock-m00-chat');
  assert.equal(id.UI_STATE_FILE, 'ui-state.json');
  assert.equal(id.ARTIFACTS_DIRNAME, 'artifacts');
  assert.equal(id.CHAT_HOME, 'https://chatgpt.com/');
  assert.ok(Object.isFrozen(id));
  const index = fs.readFileSync(path.join(SRC, 'main', 'index.js'), 'utf8');
  assert.match(index, /setPath\('userData', userDataDir\)/);
  assert.ok(index.indexOf("setPath('userData'") < index.indexOf('requestSingleInstanceLock'), 'userData is pinned before the instance lock');
});

test('ContextDeck name appears in visible UI; the legacy name only survives in the persistent-ID module', () => {
  const offenders = sourceFiles.concat(path.join(SRC, 'renderer', 'index.html'), path.join(SRC, 'renderer', 'overlay', 'overlay.html'), ...fs.readdirSync(path.join(SRC, 'renderer', 'styles')).map((f) => path.join(SRC, 'renderer', 'styles', f)))
    .filter((f) => !f.endsWith(`${path.sep}identity.js`))
    .filter((f) => /Project Dock|project-dock/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
  assert.match(fs.readFileSync(path.join(SRC, 'main', 'window.js'), 'utf8'), /title: 'ContextDeck'/);
});

test('ui-state files written by every earlier iteration still load', () => {
  const { sanitize, repoKey } = require('../src/main/persistence/ui-state');
  const root = 'C:\\Users\\me\\Repo';
  // I1: only mode and size.
  assert.deepEqual(sanitize({ lastMode: 'chat', bounds: { width: 1000, height: 650 } }).bounds, { width: 1000, height: 650 });
  // I2: global git prefs next to repoDir.
  const i2 = sanitize({ lastMode: 'terminal', git: { repoDir: root, baseRef: 'dev', revision: 'HEAD~1', lastZip: 'C:\\ud\\artifacts\\dock-Repo-abc12345-20261010T120000-deadbeef.zip' } });
  assert.deepEqual(i2.git.repos[repoKey(root)], { baseRef: 'dev', revision: 'HEAD~1' });
  assert.match(i2.git.lastZip, /artifacts/);
  // I3: per-repository prefs.
  const i3 = sanitize({ lastMode: 'chat', git: { repoDir: root, lastZip: undefined, repos: { [repoKey(root)]: { baseRef: 'refs/heads/dev', revision: 'HEAD' } } } });
  assert.equal(i3.git.repos[repoKey(root)].baseRef, 'refs/heads/dev');
  // Garbage never throws.
  for (const junk of [null, 5, 'x', [], { git: 5 }, { git: { repos: [] } }]) assert.doesNotThrow(() => sanitize(junk));
});

test('a ZIP generated by M00 (same naming and folder) is still recognized and deletable', () => {
  const { createGitActions } = require('../src/main/git/actions');
  const id = require('../src/main/persistence/identity');
  const userData = tmp('dock-ud-');
  const artifacts = path.join(userData, id.ARTIFACTS_DIRNAME);
  fs.mkdirSync(artifacts);
  const legacyZip = path.join(artifacts, 'dock-project-dock-m00-4c9a8b16-20261010T210445-76d7e19d.zip');
  fs.writeFileSync(legacyZip, 'PK');
  const actions = createGitActions({ artifactsDir: artifacts, clipboard: {} });
  assert.equal(actions.deleteZip(legacyZip).ok, true);
  assert.equal(fs.existsSync(legacyZip), false);
});

// ---- M01-I3A guard rails -------------------------------------------------------------------------------------

test('M01-I3A: bindings never drive the page, the views, Herdr or the Chromium profile', () => {
  const files = [...walk(path.join(SRC, 'main', 'chat-bindings')), path.join(SRC, 'main', 'ipc', 'chats.js'), path.join(SRC, 'shared', 'chat-bindings-view.js')];
  assert.ok(files.length >= 5);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /loadURL|goHome|\.reload\(|focusWorkspace|workspace\.focus|webContents|WebContentsView|fromPartition|cookies|executeJavaScript|setPermission|\bselect\(/, path.relative(ROOT, f));
  }
  // No second chat view: exactly the ChatGPT view and the (idle-released) overlay create WebContentsViews.
  const creators = sourceFiles.filter((f) => /new WebContentsView\(/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f)).sort();
  assert.deepEqual(creators, [path.join('main', 'chat-view.js'), path.join('main', 'overlay.js')]);
  assert.equal([...fs.readFileSync(path.join(SRC, 'main', 'chat-view.js'), 'utf8').matchAll(/new WebContentsView\(/g)].length, 1);
  assert.equal([...fs.readFileSync(path.join(SRC, 'main', 'window.js'), 'utf8').matchAll(/createChatView\(/g)].length, 1, 'the chat view is created once');
  // The preference file knows about bindings only as opaque ids (the last conversation chosen per workspace).
  const prefs = read('src', 'main', 'persistence', 'ui-state.js').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual([...new Set((prefs.match(/binding\w*/gi) || []).map((m) => m.toLowerCase()))].sort(), ['binding_id_re']);
});

test('M01-I3A: the persistent identifiers that keep the login are unchanged and the bindings have a file of their own', () => {
  const id = require('../src/main/persistence/identity');
  assert.equal(id.CHAT_PARTITION, 'persist:project-dock-m00-chat');
  assert.equal(id.USER_DATA_DIRNAME, 'Project Dock M00');
  assert.equal(id.UI_STATE_FILE, 'ui-state.json');
  assert.equal(id.CHAT_BINDINGS_FILE, 'chat-bindings.json');
  assert.notEqual(id.CHAT_BINDINGS_FILE, id.UI_STATE_FILE);
  assert.ok(Object.isFrozen(id));
});

test('M01-I3A: the chat view only reports navigations; its permission and popup policy is untouched', () => {
  const chat = read('src', 'main', 'chat-view.js');
  assert.match(chat, /contents\.on\('did-navigate-in-page'/);
  assert.match(chat, /onEvent\?\.\('navigated', \{ url \}\)/);
  assert.match(chat, /requestingHost === 'chatgpt\.com'/);
  assert.match(chat, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(chat, /AUTH_POPUP_HOSTS/);
});

test('M01-I3A: documentation and decision record exist', () => {
  for (const f of ['docs/validation/m01-i3a.md', 'docs/decisions/0002-chat-bindings.md']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

// ---- M01-I3B-1 guard rails -------------------------------------------------------------------------------------

test('M01-I3B-1: ChatGPT views are created in one place, destroyed only on shutdown, and loaded only when created or retried', () => {
  const main = sourceFiles.filter((f) => f.includes(`${path.sep}main${path.sep}`));
  const code = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  // Destroying a view: the handle's destroy() is called by the manager's destroyAll() and nowhere else.
  const destroyers = main.filter((f) => /\.destroy\(\)/.test(code(f))).map((f) => path.relative(SRC, f)).sort();
  // (window.js: the overlay's own destroy; api-client.js: sockets. Neither touches a ChatGPT view.)
  assert.deepEqual(destroyers, [path.join('main', 'chat-views', 'manager.js'), path.join('main', 'herdr', 'api-client.js'), path.join('main', 'window.js')]);
  assert.match(code(path.join(SRC, 'main', 'window.js')).match(/.*\.destroy\(\).*/)[0], /overlay\.destroy\(\)/);
  const manager = code(path.join(SRC, 'main', 'chat-views', 'manager.js'));
  assert.equal([...manager.matchAll(/\.destroy\(\)/g)].length, 1, 'a single destroy call, inside destroyAll');
  assert.match(manager.slice(manager.indexOf('function destroyAll')), /e\.handle\.destroy\(\)/);
  const win = code(path.join(SRC, 'main', 'window.js'));
  assert.equal([...win.matchAll(/destroyAll\(\)/g)].length, 1, 'only when the window closes');
  assert.match(win, /mainWindow\.on\('closed'[\s\S]*manager\?\.destroyAll\(\)/);
  // Loading: the manager loads an address only in load() (creation and the retry of a FAILED view); the navigator never loads.
  assert.equal([...manager.matchAll(/\.loadURL\(/g)].length, 1);
  assert.doesNotMatch(code(path.join(SRC, 'main', 'chat-views', 'navigator.js')), /\.loadURL|\.reload\(|goHome|\.destroy\(|webContents|\bsession\./);
  // One partition for every view: no per-conversation partitions.
  const chatView = code(path.join(SRC, 'main', 'chat-view.js'));
  assert.equal([...chatView.matchAll(/chatWebPreferences\(CHAT_PARTITION\)/g)].length, 1);
  assert.doesNotMatch(chatView, /partition:\s*['"`]|randomUUID|Date\.now\(\).*partition/);
  assert.match(chatView, /sessionConfigured/);
});

test('M01-I3B-1: no pool, no eviction, no automatic suspension of views', () => {
  for (const f of walk(path.join(SRC, 'main', 'chat-views'))) {
    let text = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    if (path.basename(f) === 'observation.js') {
      // The status hub owns exactly ONE injected timer (the shared expiry sweep); observers own their poll timers.
      assert.equal([...text.matchAll(/\bsetTimer\(/g)].length, 1, 'one sweep timer in the hub');
      text = text.replace('setTimer = setTimeout, clearTimer = clearTimeout', '');
      // Observing never creates, loads, navigates or destroys a view.
      assert.doesNotMatch(text, /\.create\(|loadURL|\.reload\(|\.destroy\(\)|\.show\(|\.hide\(|setAttached|executeJavaScript|webContents|session\./);
    }
    assert.doesNotMatch(text, /MAX_VIEWS|poolSize|evict|\bLRU\b|setTimeout|setInterval|suspend|backgroundThrottling|lifecycleAdvice|setAudioMuted|\.close\(\)/, path.relative(ROOT, f));
  }
});

test('M01-I3B-1: the navigation channels are UI-window-only and never reach the remote page or the overlay bridge', () => {
  const overlayPreload = read('src', 'preload', 'overlay.js');
  assert.doesNotMatch(overlayPreload, /chatnav/);
  const ipc = read('src', 'main', 'ipc', 'index.js');
  assert.match(ipc, /registerChatNavIpc\(\{ ipcMain, trusted, win \}\)/, 'trusted = the UI window only (not the overlay)');
  assert.doesNotMatch(read('src', 'main', 'chat-view.js'), /ipcMain|ipcRenderer|preload\s*:/);
});

test('M01-I3B-1: documentation and decision record exist', () => {
  for (const f of ['docs/validation/m01-i3b-1.md', 'docs/decisions/0003-multi-view-navigation.md']) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});

// ---- M01-I3B-2 guard rails -------------------------------------------------------------------------------------

test('M01-I3B-2: observers stop before views are closed; the status is never persisted; no new IPC channel carries it', () => {
  const win = read('src', 'main', 'window.js').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(win.indexOf('hub?.stop()') >= 0 && win.indexOf('hub?.stop()') < win.indexOf('manager?.destroyAll()'), 'hub.stop() runs before destroyAll()');
  assert.match(win, /CONTEXTDECK_CHAT_STATUS !== '0'/);
  assert.equal([...win.matchAll(/createObservationHub\(/g)].length, 1, 'one hub');
  // Nothing about activity is written to disk.
  for (const f of ['src/main/persistence/ui-state.js', 'src/main/chat-bindings/model.js', 'src/main/chat-bindings/store.js']) {
    assert.doesNotMatch(read(...f.split('/')).replace(/^\s*\/\/.*$/gm, ''), /responding|attention|generation|activity/, f);
  }
  // The status travels on channels that already existed (named in HANDLE_CHANNELS) as plain data.
  const ipcFiles = ['chatnav.js', 'herdr.js'].map((f) => read('src', 'main', 'ipc', f));
  assert.ok(ipcFiles.every((t) => !/ipcMain\.handle\('(chatstatus|activity)/.test(t)));
  // The hub is the only consumer of the observer; the model never imports anything outside chat/ (pure).
  const hub = read('src', 'main', 'chat-views', 'observation.js');
  assert.match(hub, /require\('\.\.\/chat\/runtime-contract'\)/);
  assert.doesNotMatch(hub, /require\('(electron|node:fs|fs)'\)/);
});

test('M01-I3B-2: documentation exists', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/validation/m01-i3b-2.md')));
});
