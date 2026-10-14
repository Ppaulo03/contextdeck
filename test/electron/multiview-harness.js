'use strict';

// Real-Electron harness for the multi-view navigation (M01-I3B-1). NOT part of `npm test` (it needs a display and
// the network): run it with
//     npx electron test/electron/multiview-harness.js            (writes <tmp>/multiview-report.json, prints it)
// It drives the REAL window controller, chat views, manager, navigator, overlay and IPC against a THROWAWAY profile
// (CONTEXTDECK_USER_DATA-style temp folder, logged-out chatgpt.com, no login, no message is ever sent), with a fake
// Herdr (no PTY client is started, no Herdr session is touched). It measures and checks what mocks cannot:
//   - does hiding a view (detach) keep the page alive: same renderer process, no reload, timers/draft preserved?
//   - detach vs setVisible(false) on an attached view: do they behave differently?
//   - memory/process count with 1..4 conversation views, creation and switch times, idle CPU;
//   - invariants under hundreds of random workspace/conversation switches (never a view of another workspace
//     attached, never more than one attached, never a reload);
//   - shutdown closes every view.
const electron = require('electron');
const { app, webContents, WebContentsView } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextdeck-mv-'));
app.setPath('userData', tmp);
const outDir = process.env.HARNESS_OUT || tmp;
fs.mkdirSync(outDir, { recursive: true });

const { createWindowController } = require(path.join(ROOT, 'src/main/window'));
const { registerIpc } = require(path.join(ROOT, 'src/main/ipc'));
const { createBindingsStore } = require(path.join(ROOT, 'src/main/chat-bindings/store'));
const { createChatBindings } = require(path.join(ROOT, 'src/main/chat-bindings/service'));
const { startChatsPusher } = require(path.join(ROOT, 'src/main/ipc/chats'));
const { startChatNavPusher } = require(path.join(ROOT, 'src/main/ipc/chatnav'));
const { sanitize } = require(path.join(ROOT, 'src/main/persistence/ui-state'));
const { chatWebPreferences } = require(path.join(ROOT, 'src/main/web-preferences'));
const { CHAT_PARTITION } = require(path.join(ROOT, 'src/main/persistence/identity'));
const { PRELOAD, OVERLAY_PRELOAD, RENDERER_HTML, OVERLAY_HTML } = require(path.join(ROOT, 'src/main/paths'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : null; };
const mb = (kb) => Math.round(kb / 1024);
const round = (n, d = 2) => (n === null ? null : Number(n.toFixed(d)));

const progress = (m) => { try { fs.appendFileSync(path.join(outDir, 'progress.log'), `${new Date().toISOString().slice(11, 19)} ${m}
`); } catch { /* Diagnostics only. */ } };
process.on('uncaughtException', (e) => {
  process.exitCode = 1;
  progress(`UNCAUGHT ${e && e.stack}`);
  console.error('UNCAUGHT', e);
  app.quit(); // No success report is written; the caller treats a missing report as failure.
});

function metrics() {
  const m = app.getAppMetrics();
  return { processes: m.length, workingSetMB: mb(m.reduce((a, p) => a + (p.memory.workingSetSize || 0), 0)), cpuPercent: round(m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0)) };
}

async function cpuIdle(ms) {
  app.getAppMetrics();
  await sleep(ms);
  return round(app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0));
}

const trace = {};
app.on('web-contents-created', (_e, wc) => {
  const t0 = Date.now();
  const log = (what) => (trace[wc.id] ||= []).push(`${Date.now() - t0}ms ${what}`);
  wc.on('did-start-navigation', (_ev, u, inPlace, main) => { if (main) log(`start ${inPlace ? 'inplace ' : ''}${u.slice(0, 50)}`); });
  wc.on('did-navigate', (_ev, u) => log(`navigate ${u.slice(0, 50)}`));
  wc.on('did-navigate-in-page', (_ev, u, main) => { if (main !== false) log(`inpage ${u.slice(0, 50)}`); });
  wc.on('did-redirect-navigation', (_ev, u) => log(`redirect ${u.slice(0, 50)}`));
  wc.on('did-stop-loading', () => log('stop-loading'));
});
app.on('window-all-closed', () => {});   // the harness decides when to quit (closing the window is part of the test)
app.whenReady().then(async () => {
  progress('ready');
  const report = { electron: process.versions.electron, chromium: process.versions.chrome, steps: {}, checks: [], errors: [] };
  const startedAt = Date.now();
  const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); progress(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail}`); };
  process.on('unhandledRejection', (e) => { report.errors.push(String(e && e.stack || e)); console.error('UNHANDLED', e); });

  // ---- fake Herdr + real bindings ---------------------------------------------------------------------------------
  const workspaces = [{ id: 'w1', number: 1, label: 'api', directory: 'C:\\a' }, { id: 'w2', number: 2, label: 'app', directory: 'C:\\b' }, { id: 'w3', number: 3, label: 'vazio', directory: 'C:\\c' }];
  const listeners = new Set();
  const calls = { focus: 0, ptyStart: 0 };
  const observer = { getState: () => ({ session: 'contextdeck', connection: 'connected', model: { workspaces, sessionFocus: null }, epoch: 1, syncCount: 1 }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, refresh: async () => {} };
  const sel = { mode: 'auto', selected: { workspaceId: 'w1', origin: 'dock' }, pending: null, observedId: 'w1', connection: 'connected', unavailableId: null, lastError: null };
  const fire = () => listeners.forEach((l) => l());
  const selection = { getState: () => ({ ...sel, options: workspaces }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, select: async () => { calls.focus += 1; return { ok: true }; }, setMode: () => ({ ok: true }) };
  const bindings = createChatBindings({ store: createBindingsStore({ file: path.join(tmp, 'chat-bindings.json') }), session: 'contextdeck', observer, selection });
  const bindFile = path.join(tmp, 'chat-bindings.json');
  const url = (n) => `https://chatgpt.com/c/${uuid(n)}`;
  const bind = (ws, n, label) => {
    const r = bindings.bind({ target: { session: 'contextdeck', workspaceId: ws }, url: url(n), origin: 'url', label, role: 'general', selectedAtOpen: sel.selected ? sel.selected.workspaceId : null, confirmTarget: true });
    if (!r.ok) throw new Error(`bind ${label}: ${JSON.stringify(r.error)}`);
    return r.binding;
  };
  const A = [bind('w1', 1, 'Arquitetura'), bind('w1', 2, 'Review'), bind('w1', 3, 'Planejamento')];
  const B = [bind('w2', 4, 'Integração'), bind('w2', 5, 'Arquitetura')];
  const bindingsBefore = fs.readFileSync(bindFile, 'utf8');

  // ---- the real window stack ----------------------------------------------------------------------------------------
  const uiState = sanitize(undefined);
  let win; let navPusher; let chatsPusher;
  win = createWindowController({
    uiState, uiStateFile: path.join(tmp, 'ui-state.json'), preloadPath: PRELOAD, overlayPreloadPath: OVERLAY_PRELOAD, rendererHtml: RENDERER_HTML, overlayHtml: OVERLAY_HTML,
    onClosed: () => { navPusher.stop(); chatsPusher.stop(); },
    onChatNavigated: () => chatsPusher.notify(),
    onNavChange: () => { navPusher.notify(); chatsPusher.notify(); },
    chats: { session: 'contextdeck', bindings, selection }
  });
  chatsPusher = startChatsPusher({ bindings, observer, selection, getUrl: () => win.getChatUrl(), send: (c, d) => { win.send(c, d); win.sendToOverlay('overlay:chats-push', d); } });
  navPusher = startChatNavPusher({ getState: () => win.getNavigator()?.getState(), send: (c, d) => win.send(c, d) });
  registerIpc({ electron, win, herdr: { start: () => { calls.ptyStart += 1; return { ok: true }; }, isRunning: () => false, write() {}, resize() {}, stop() {} }, observer, selection, bindings, activityIpc: { getPayload: () => ({ global: {}, notices: { items: [], more: 0 } }), directOpen: { open: async () => ({ ok: false }) }, notices: { dismiss() {} }, unbound: null }, notifyChats: () => { chatsPusher.notify(); win.getNavigator()?.reconcile(); }, settings: { herdrSession: 'contextdeck' }, uiState, persist() {}, userDataDir: tmp });
  const t0 = Date.now();
  await win.create();
  report.steps.windowCreateMs = Date.now() - t0;
  const ui = win.getWindow().webContents;
  ui.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(`ui: ${message}`); });
  const nav = win.getNavigator();
  const chatContents = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith('https://chatgpt.com'));
  const attachedUrl = () => win.getChatUrl();
  const key = (id) => `contextdeck/${id}`;
  const pick = (binding, extra = {}) => nav.selectBinding({ bindingId: binding.bindingId, workspaceKey: key(binding.workspaceIdentity.workspaceId), ...extra });
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };
  // Every ChatGPT page has finished loading (and any redirect has settled).
  const settled = async (count) => { await waitFor(() => chatContents().length >= count && chatContents().every((w) => !w.isLoading()), 40000); await sleep(800); };

  // ---- 1. startup: exactly one ChatGPT page (the M00 page), nothing else ------------------------------------------------
  await waitFor(() => chatContents().length >= 1, 15000);
  await sleep(1500);
  report.steps.startupChatViews = chatContents().length;
  check('startup loads only the application\'s initial ChatGPT page', chatContents().length === 1, chatContents().length);
  report.steps.metrics0 = metrics();

  // ---- 2. chat tab with a workspace that has conversations but no remembered one: nothing created -----------------------
  win.switchMode('chat');
  await sleep(500);
  check('entering the chat tab creates no conversation view by itself', chatContents().length === 1 && nav.getState().empty === 'select-conversation', JSON.stringify(nav.getState().empty));
  check('no view is attached while the empty state is shown', win.getChat() === null);

  progress('section 3');
  // ---- 3. open conversations one by one: memory, processes, creation time ---------------------------------------------
  const loaded = async (n) => waitFor(() => { const s = nav.getState(); return s.tabs.some((t) => t.active && t.loaded && !t.loading) || false; }, 25000).then(() => n);
  const memory = [{ views: 0, ...metrics() }];
  const createMs = [];
  const opened = [];
  for (const [i, b] of [A[0], A[1], A[2]].entries()) {
    const start = process.hrtime.bigint();
    const r = pick(b);
    check(`open ${b.label}`, r.ok, JSON.stringify(r));
    await settled(2 + i);
    createMs.push(Number(process.hrtime.bigint() - start) / 1e6 - 800);
    opened.push(b);
    await sleep(1500);
    memory.push({ views: i + 1, ...metrics() });
  }
  nav.reconcile();
  win.getNavigator().getState();
  sel.selected = { workspaceId: 'w2', origin: 'dock' }; fire();
  const startB = process.hrtime.bigint();
  check('open B1', pick(B[0]).ok);
  await settled(5);
  createMs.push(Number(process.hrtime.bigint() - startB) / 1e6 - 800);
  await sleep(1500);
  memory.push({ views: 4, ...metrics() });
  report.steps.memoryByConversationViews = memory;
  report.steps.createMs = createMs.map((n) => Math.round(n));
  check('4 conversation views + the initial page = 5 ChatGPT pages', chatContents().length === 5, chatContents().length);

  // Logged out, a bound /c/<uuid> redirects to "/": make each page "be" its conversation the way the SPA does.
  const contentsOf = (b) => { const id = nav.getState().tabs.find((t) => t.bindingId === b.bindingId); return id; };
  const allViews = chatContents();
  const pushUrl = async (wc, n) => wc.executeJavaScript(`history.pushState({}, '', '/c/${uuid(n)}'); location.pathname`);

  report.steps.eventTrace = trace;
  report.steps.managerViews = nav._debugViews().map((v) => `${v.id} scope=${v.scope} exp=${v.expectedKey ? v.expectedKey.slice(2, 5) : null} id=${v.identity.state} rel=${v.relation} reached=${v.reached} page=${v.page}`);
  if (process.env.HARNESS_ONLY_TRACE) { fs.writeFileSync(path.join(outDir, 'multiview-report.json'), JSON.stringify(report, null, 2)); app.quit(); return; }
  progress('section 4');
  // ---- 4. marker / draft / timers in every page, then switch around and verify nothing was reloaded ------------------------
  const marked = [];
  for (const wc of allViews) {
    await wc.executeJavaScript(`(() => {
      window.__marker = Math.random();
      window.__ticks = 0; setInterval(() => { window.__ticks++; }, 100);
      window.__raf = 0; const loop = () => { window.__raf++; requestAnimationFrame(loop); }; requestAnimationFrame(loop);
      window.__mc = 0; window.__mcRun = true; const mc = new MessageChannel(); mc.port1.onmessage = () => { window.__mc++; if (window.__mcRun) mc.port2.postMessage(0); }; mc.port2.postMessage(0);
      const t = document.createElement('textarea'); t.id = '__draft'; t.value = 'rascunho ' + window.__marker; t.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;opacity:0.01'; document.body.appendChild(t);
      window.__t0 = performance.timeOrigin; return true; })()`);
    marked.push({ wc, pid: wc.getOSProcessId(), id: wc.id, marker: await wc.executeJavaScript('window.__marker'), origin: await wc.executeJavaScript('window.__t0') });
  }
  const navEvents = [];
  for (const wc of allViews) { wc.on('did-start-navigation', (_e, u, inPlace, main) => { if (main && !inPlace) navEvents.push(u); }); wc.on('did-start-loading', () => navEvents.push('loading')); }

  // Switching: A1 -> A2 -> A3 -> workspace B -> B1 -> back to A (restores the last choice) -> ...
  sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();
  const switchMs = [];
  const timed = (fn) => { const s = process.hrtime.bigint(); const r = fn(); switchMs.push(Number(process.hrtime.bigint() - s) / 1e6); return r; };
  for (let i = 0; i < 60; i++) timed(() => pick(A[i % 3]));
  const viewsBefore = chatContents().length;
  const snap = () => { const st = nav.getState(); return { pages: chatContents().map((w) => `${w.id}:${w.getURL().replace('https://chatgpt.com', '').slice(0, 20)}`), tabs: st.tabs.map((t) => [t.label, t.loaded, t.active, t.relation]), temporaries: st.temporaries.map((t) => [t.label, t.relation]) }; };
  report.steps.snapshotBeforeLoop = snap();
  const lastA = A[(60 - 1) % 3];
  sel.selected = { workspaceId: 'w2', origin: 'dock' }; fire();
  const attachedForB = nav.getState().activeViewId;
  check('B shows B\'s remembered conversation (B1), not a conversation of A', nav.getState().tabs.find((t) => t.active)?.bindingId === B[0].bindingId);
  sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();
  check('back in A: the last conversation is restored, same view', nav.getState().tabs.find((t) => t.active)?.bindingId === lastA.bindingId);
  for (let i = 0; i < 40; i++) { timed(() => pick(A[i % 3])); sel.selected = { workspaceId: i % 2 ? 'w1' : 'w2', origin: 'dock' }; fire(); }
  sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();
  await sleep(300);
  report.steps.snapshotAfterLoop = snap();
  report.steps.switchMs = { count: switchMs.length, medianMs: round(median(switchMs), 3), p95Ms: round(p95(switchMs), 3) };
  check('no view was created or destroyed by switching', chatContents().length === viewsBefore, `${viewsBefore} -> ${chatContents().length}`);

  const after = [];
  for (const m of marked) {
    if (m.wc.isDestroyed()) { after.push({ id: m.id, destroyed: true }); continue; }
    after.push({
      id: m.id, samePid: m.wc.getOSProcessId() === m.pid,
      sameMarker: (await m.wc.executeJavaScript('window.__marker')) === m.marker,
      sameOrigin: (await m.wc.executeJavaScript('window.__t0')) === m.origin && (await m.wc.executeJavaScript('performance.timeOrigin')) === m.origin,
      draft: await m.wc.executeJavaScript(`document.getElementById('__draft').value === 'rascunho ' + window.__marker`),
      ticks: await m.wc.executeJavaScript('window.__ticks'), raf: await m.wc.executeJavaScript('window.__raf'), mc: await m.wc.executeJavaScript('window.__mc'),
      loading: m.wc.isLoading()
    });
  }
  report.steps.afterSwitching = after;
  check('every page kept its renderer process', after.every((a) => a.samePid));
  check('no page was reloaded (marker and navigation origin unchanged)', after.every((a) => a.sameMarker && a.sameOrigin));
  check('drafts typed into hidden pages survived', after.every((a) => a.draft));
  check('no navigation or load event happened during the whole switching sequence', navEvents.length === 0, JSON.stringify(navEvents));

  progress('section 5');
  // ---- 5. what a hidden view keeps doing (detached views, as the manager uses) ----------------------------------------
  const probeBefore = []; for (const wc of allViews) probeBefore.push({ t: await wc.executeJavaScript('window.__ticks'), r: await wc.executeJavaScript('window.__raf'), m: await wc.executeJavaScript('window.__mc') });
  const visibleWc = win.getChat().contents;
  await sleep(5000);
  const hiddenRates = [];
  for (const [i, wc] of allViews.entries()) {
    const now = { t: await wc.executeJavaScript('window.__ticks'), r: await wc.executeJavaScript('window.__raf'), m: await wc.executeJavaScript('window.__mc') };
    hiddenRates.push({ visible: wc === visibleWc, timersPerSec: round((now.t - probeBefore[i].t) / 5, 1), rafPerSec: round((now.r - probeBefore[i].r) / 5, 1), messageChannelPerSec: Math.round((now.m - probeBefore[i].m) / 5) });
  }
  report.steps.detachedVsVisibleRates5s = hiddenRates;
  check('detached pages keep running timers and message-channel work', hiddenRates.filter((r) => !r.visible).every((r) => r.timersPerSec > 0.5 && r.messageChannelPerSec > 1000), JSON.stringify(hiddenRates.filter((r) => !r.visible)[0]));

  progress('section 6');
  // ---- 6. detach vs setVisible(false) on an attached view, on a scratch window ----------------------------------------------
  const { BrowserWindow } = electron;
  const scratch = new BrowserWindow({ width: 600, height: 400, show: true, webPreferences: { sandbox: true } });
  const mkView = async () => {
    const v = new WebContentsView({ webPreferences: chatWebPreferences(CHAT_PARTITION) });
    v.setBounds({ x: 0, y: 0, width: 600, height: 400 });
    await v.webContents.loadURL('https://chatgpt.com/');
    await v.webContents.executeJavaScript(`(() => { window.__ticks = 0; setInterval(() => { window.__ticks++; }, 100); window.__raf = 0; const loop = () => { window.__raf++; requestAnimationFrame(loop); }; requestAnimationFrame(loop); window.__mc = 0; const mc = new MessageChannel(); mc.port1.onmessage = () => { window.__mc++; mc.port2.postMessage(0); }; mc.port2.postMessage(0); const t = document.createElement('textarea'); t.id = '__draft'; t.value = 'draft'; document.body.appendChild(t); window.__o = performance.timeOrigin; return 1; })()`);
    return v;
  };
  const rates = async (v, ms) => { const wc = v.webContents; const g = async () => ({ t: await wc.executeJavaScript('window.__ticks'), r: await wc.executeJavaScript('window.__raf'), m: await wc.executeJavaScript('window.__mc') }); const a = await g(); await sleep(ms); const b = await g(); const s = ms / 1000; return { timersPerSec: round((b.t - a.t) / s, 1), rafPerSec: round((b.r - a.r) / s, 1), messageChannelPerSec: Math.round((b.m - a.m) / s) }; };
  const vVisible = await mkView(); const vDetached = await mkView(); const vHidden = await mkView();
  scratch.contentView.addChildView(vVisible);
  scratch.contentView.addChildView(vHidden); vHidden.setVisible(false);
  // vDetached is never added to the window (our mechanism: removeChildView); vVisible and vHidden are attached.
  await sleep(1500);
  report.steps.hideMechanisms5s = { attachedVisible: await rates(vVisible, 5000), attachedSetVisibleFalse: await rates(vHidden, 5000), detached: await rates(vDetached, 5000) };
  for (const [name, v] of [['attachedVisible', vVisible], ['attachedSetVisibleFalse', vHidden], ['detached', vDetached]]) {
    report.steps.hideMechanisms5s[name].draftKept = await v.webContents.executeJavaScript(`document.getElementById('__draft').value === 'draft'`);
    report.steps.hideMechanisms5s[name].sameOrigin = (await v.webContents.executeJavaScript('performance.timeOrigin')) === (await v.webContents.executeJavaScript('window.__o'));
  }
  // Re-attach the detached one and the hidden one: state must still be there.
  scratch.contentView.addChildView(vDetached); vHidden.setVisible(true);
  await sleep(500);
  report.steps.reattach = { detachedDraft: await vDetached.webContents.executeJavaScript(`document.getElementById('__draft').value`), hiddenDraft: await vHidden.webContents.executeJavaScript(`document.getElementById('__draft').value`) };
  check('re-attaching a detached view finds its page intact', report.steps.reattach.detachedDraft === 'draft');
  for (const v of [vVisible, vDetached, vHidden]) v.webContents.close();
  scratch.destroy();

  progress('section 7');
  // ---- 7. divergence inside ChatGPT: identity follows the page, bindings untouched ---------------------------------------------
  pick(A[0]);
  await settled(5);
  const wcA1 = win.getChat().contents;
  await pushUrl(wcA1, 1);
  await sleep(300);
  check('a page that is its conversation lights up its tab', nav.getState().tabs.find((t) => t.bindingId === A[0].bindingId).active);
  await pushUrl(wcA1, 2);
  await sleep(300);
  const s1 = nav.getState();
  check('navigating inside ChatGPT: the tab of what is really shown lights up, not the old one', s1.tabs.find((t) => t.bindingId === A[1].bindingId).active && !s1.tabs.find((t) => t.bindingId === A[0].bindingId).active, JSON.stringify(s1.tabs.map((t) => [t.label, t.active])));
  await pushUrl(wcA1, 9);
  await sleep(300);
  const s2 = nav.getState();
  check('navigating to an unbound conversation shows a warning chip, no tab', s2.temporaries.some((t) => t.active && t.warning) && s2.tabs.every((t) => !t.active), JSON.stringify(s2.temporaries));
  check('persistent bindings were not modified by any navigation', fs.readFileSync(bindFile, 'utf8') === bindingsBefore);

  progress('section 8');
  // ---- 8. randomized invariants --------------------------------------------------------------------------------------------
  let seed = 12345; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const wsIds = ['w1', 'w2', 'w3'];
  let newConvs = 0;
  let violations = []; const countsBefore = chatContents().length;
  for (let i = 0; i < 400; i++) {
    const op = rnd(5);
    if (op === 0) { sel.selected = { workspaceId: wsIds[rnd(3)], origin: rnd(2) ? 'dock' : 'herdr' }; fire(); }
    else if (op === 1) pick([...A, ...B][rnd(5)], { confirm: true });
    else if (op === 2) { if (newConvs < 6) { newConvs += 1; nav.newConversation({ workspaceKey: key(sel.selected.workspaceId) }); } }
    else if (op === 3) { win.switchMode(rnd(2) ? 'terminal' : 'chat'); }
    else { sel.pending = rnd(2) ? { workspaceId: 'w2' } : null; fire(); }
    const st = nav.getState();
    const attached = win.getChat();
    const mgrAttached = st.activeViewId && win.getMode() === 'chat' ? 1 : 0;
    if (attached && win.getMode() !== 'chat') violations.push(`${i}: attached in terminal mode`);
    if (attached && st.workspace) {
      const active = [...st.tabs, ...st.temporaries].find((t) => t.active);
      const isBound = st.tabs.some((t) => t.active);
      if (!active) violations.push(`${i}: a view is attached but nothing in the strip is active (${JSON.stringify(st.empty)})`);
      if (isBound) { const tab = st.tabs.find((t) => t.active); const b = [...A, ...B].find((x) => x.bindingId === tab.bindingId); if (b.workspaceIdentity.workspaceId !== st.workspace.id) violations.push(`${i}: conversation of ${b.workspaceIdentity.workspaceId} under ${st.workspace.id}`); }
    }
    if (!st.workspace && attached && st.empty) violations.push(`${i}: empty state with a view attached`);
    sel.pending = null;
  }
  sel.pending = null; sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire(); win.switchMode('chat');
  report.steps.randomOps = { ops: 400, violations, viewsCreatedByRandomOps: chatContents().length - countsBefore };
  check('400 random workspace/conversation/tab switches: no context leak, no stray attachment', violations.length === 0, violations.slice(0, 3).join(' | '));
  check('no Herdr focus command was ever sent by any navigation', calls.focus === 0);

  // ---- 9. idle CPU with every page loaded -------------------------------------------------------------------------------------
  report.steps.finalViews = chatContents().length;
  report.steps.metricsAllViews = metrics();
  // Stop the injected message-channel load generator: the idle CPU below must be the application's, not ours.
  for (const wc of allViews) { if (!wc.isDestroyed()) await wc.executeJavaScript('window.__mcRun = false; window.__ticks = 0; true'); }
  await sleep(1500);
  const growth = [];
  for (let i = 0; i < 5; i++) { growth.push(chatContents().length); await sleep(1000); }
  report.steps.viewCountDuringIdle = growth;
  report.steps.pageUrlsSample = chatContents().slice(0, 12).map((w) => `${w.id}:${w.getURL().slice(0, 60)}:${w.getType()}`);
  const st = nav.getState();
  report.steps.stateAfterRandom = { tabs: st.tabs.map((t) => [t.label, t.loaded, t.active, t.relation]), temporaries: st.temporaries.length, empty: st.empty, duplicates: st.duplicates };
  report.steps.idleCpuPercent10s = await cpuIdle(5000);

  // ---- 10. shutdown closes every view ---------------------------------------------------------------------------------------------
  const before = chatContents().length;
  win.getWindow().destroy();
  await sleep(1500);
  report.steps.shutdown = { chatPagesBefore: before, chatPagesAfter: chatContents().length };
  check('closing the window closes every ChatGPT view', chatContents().length === 0, JSON.stringify(report.steps.shutdown));
  report.errors = report.errors.filter((e) => !/Autofill|UnknownVizError/.test(e));
  report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  report.startedAt = new Date(startedAt).toISOString();
  report.durationMs = Date.now() - startedAt;
  report.exitCode = report.failed.length || report.errors.length ? 1 : 0;
  fs.writeFileSync(path.join(outDir, 'multiview-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, failed: report.failed, errors: report.errors.length, durationMs: report.durationMs, report: path.join(outDir, 'multiview-report.json'), steps: report.steps }, null, 1));
  process.exitCode = report.exitCode;
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Best effort. */ } app.quit(); }, 500);
});
