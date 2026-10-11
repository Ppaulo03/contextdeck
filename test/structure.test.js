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
  for (const f of ['index.html', 'styles.css', 'terminal.bundle.js', 'terminal.bundle.css']) assert.ok(fs.existsSync(path.join(out, f)), f);
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs.sort(), ['styles.css', 'terminal.bundle.css', 'terminal.bundle.js']);
  for (const ref of refs) assert.ok(fs.existsSync(path.join(out, ref)), `index.html references ${ref}`);
  assert.doesNotMatch(html, /node_modules/);
  assert.match(html, /<title>ContextDeck<\/title>/);
  assert.match(fs.readFileSync(path.join(out, 'terminal.bundle.js'), 'utf8'), /\[ContextDeck\]/);
});

test('generated and local files are git-ignored; no build output or secrets are tracked in source dirs', () => {
  const ignore = read('.gitignore').split(/\r?\n/);
  for (const entry of ['node_modules/', 'dist/', 'config.json']) assert.ok(ignore.includes(entry), entry);
  assert.ok(!sourceFiles.some((f) => /bundle/.test(f)), 'no bundles inside src/');
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
  const allowed = new Set(['index.js', 'window.js', 'chat-view.js'].map((f) => path.join(SRC, 'main', f)).concat(path.join(SRC, 'preload', 'index.js')));
  const offenders = sourceFiles.filter((f) => !f.includes(`${path.sep}renderer${path.sep}`) && !allowed.has(f) && /require\('electron'\)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
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
});

// ---- IPC contract ------------------------------------------------------------------------------

const HANDLE_CHANNELS = [
  'clipboard:read', 'clipboard:write', 'dock:chat-home', 'dock:external-chat', 'dock:info', 'dock:layout',
  'dock:reload-chat', 'dock:switch', 'git:delete-zip', 'git:diff', 'git:pick-repo', 'git:refs', 'git:set-refs',
  'git:show', 'git:status', 'git:zip', 'pty:start'
];
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

function registerWithFakes(overrides = {}) {
  const { registerIpc } = require('../src/main/ipc');
  const ipc = fakeIpc();
  const calls = { switchMode: [], footer: [], write: [], resize: [], openExternal: [], start: [] };
  const win = {
    isTrusted: (event) => event.trusted === true,
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
    win, herdr, settings: { herdrSession: 'contextdeck', workingDirectory: undefined },
    uiState: require('../src/main/persistence/ui-state').sanitize(undefined), persist: () => {}, userDataDir
  });
  return { ...ipc, calls };
}

test('IPC: exactly the contract channels are registered, each once, with the same kind as before', () => {
  const { handlers, listeners } = registerWithFakes();
  assert.deepEqual([...handlers.keys()].sort(), HANDLE_CHANNELS);
  assert.deepEqual([...listeners.keys()].sort(), ON_CHANNELS);
});

test('IPC: preload channels all exist in main, and main only sends channels the preload listens to', () => {
  const preload = read('src', 'preload', 'index.js');
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  const sent = [...preload.matchAll(/ipcRenderer\.send\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...invoked].sort(), HANDLE_CHANNELS, 'every handler is reachable from the preload and vice versa');
  assert.deepEqual([...sent].sort(), ON_CHANNELS);
  const listened = new Set([...preload.matchAll(/listen\('([^']+)'/g)].map((m) => m[1]));
  const emitted = new Set(sourceFiles.filter((f) => f.includes(`${path.sep}main${path.sep}`)).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\bsend\('([a-z]+:[a-z-]+)'/g)].map((m) => m[1])));
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
  assert.deepEqual(calls, { switchMode: [], footer: [], write: [], resize: [], openExternal: [], start: [] });
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
  const offenders = sourceFiles.concat(path.join(SRC, 'renderer', 'index.html'), path.join(SRC, 'renderer', 'styles.css'))
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
