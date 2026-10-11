'use strict';

// Real-Electron harness for the global activity UX (M01-I3B-2H). NOT part of `npm test` (display + network):
//     npx electron test/electron/activity-harness.js          writes <HARNESS_OUT>/activity-report.json
// The real window, chat views, observation hub, navigator, overlay (center and notices), IPC and renderer, against a
// THROWAWAY profile, logged-out chatgpt.com and a fake Herdr (no PTY client, no Herdr session). No message is ever sent:
// "responding" and "draft" are driven with the I3P synthetic signals on the page's own composer (the send/stop control's
// aria-label, the textarea value). It checks what mocks cannot: the indicator in the real top bar on both tabs, the activity
// center and the notice cards in the real overlay, that notices do not take the keyboard, direct navigation across
// workspaces, and the cost of all of it.
const electron = require('electron');
const { app, webContents } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextdeck-act-'));
app.setPath('userData', tmp);
// The report must outlive the throwaway profile (which is deleted at the end): without HARNESS_OUT it goes to a fixed folder.
const outDir = process.env.HARNESS_OUT || path.join(os.tmpdir(), 'contextdeck-harness-out');
fs.mkdirSync(outDir, { recursive: true });
// Exit codes (a harness that did not run must never look like a pass): 0 every check passed; 1 a check failed or an error was
// recorded; 2 too few checks ran (it stopped early); 3 timeout; 77 SKIPPED with a stated reason (no network to chatgpt.com).
const EXPECTED_MIN_CHECKS = 20;
let current = null;
const finishWith = (code, extra = {}) => {
  const r = Object.assign(current || { steps: {}, checks: [], errors: [] }, extra, { exitCode: code });
  try { fs.writeFileSync(path.join(outDir, 'activity-report.json'), JSON.stringify(r, null, 2)); } catch { /* Diagnostics only. */ }
  const failed = (r.checks || []).filter((c) => !c.ok).map((c) => c.name);
  console.log(`activity-harness: exit ${code}; ${(r.checks || []).length - failed.length}/${(r.checks || []).length} checks passed${r.skipped ? '; SKIPPED: ' + r.skipped : ''}${r.fatal ? '; FATAL: ' + r.fatal : ''}; report: ${path.join(outDir, 'activity-report.json')}`);
  for (const f of failed) console.log(`  FAILED: ${f}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Best effort. */ }
  app.exit(code);
};
setTimeout(() => finishWith(3, { fatal: 'timeout: the harness did not finish in 9 minutes' }), 9 * 60 * 1000).unref();

const { createWindowController } = require(path.join(ROOT, 'src/main/window'));
const { registerIpc } = require(path.join(ROOT, 'src/main/ipc'));
const { createBindingsStore } = require(path.join(ROOT, 'src/main/chat-bindings/store'));
const { createChatBindings } = require(path.join(ROOT, 'src/main/chat-bindings/service'));
const { startChatsPusher } = require(path.join(ROOT, 'src/main/ipc/chats'));
const { startChatNavPusher } = require(path.join(ROOT, 'src/main/ipc/chatnav'));
const { startActivityPusher } = require(path.join(ROOT, 'src/main/ipc/activity'));
const { startStatePusher } = require(path.join(ROOT, 'src/main/ipc/herdr'));
const { createNoticeController } = require(path.join(ROOT, 'src/main/activity/notices'));
const { createDirectOpen } = require(path.join(ROOT, 'src/main/activity/direct-open'));
const { sanitize } = require(path.join(ROOT, 'src/main/persistence/ui-state'));
const { PRELOAD, OVERLAY_PRELOAD, RENDERER_HTML, OVERLAY_HTML } = require(path.join(ROOT, 'src/main/paths'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const round = (n, d = 2) => (n === null || n === undefined ? null : Number(n.toFixed(d)));
const progress = (m) => { try { fs.appendFileSync(path.join(outDir, 'activity-progress.log'), `${new Date().toISOString().slice(11, 19)} ${m}\n`); } catch { /* Diagnostics only. */ } };
const metrics = () => { const m = app.getAppMetrics(); return { processes: m.length, workingSetMB: Math.round(m.reduce((a, p) => a + (p.memory.workingSetSize || 0), 0) / 1024), cpuPercent: round(m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0)) }; };

process.on('uncaughtException', (e) => progress(`UNCAUGHT ${(e && e.stack) || e}`));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const report = { electron: process.versions.electron, steps: {}, checks: [], errors: [] };
  current = report;
  try {
    const probe = await electron.net.fetch('https://chatgpt.com/', { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    report.networkProbe = probe.status;
  } catch (e) { return finishWith(77, { skipped: `chatgpt.com is not reachable from this machine (${e && e.message}); the harness needs it to load real pages` }); }
  // Sanitized picture of every chat view when a check fails: structure only (ids, scope, identity state, relation, page
  // lifecycle, the SHAPE of the address with ids blanked), never page content.
  const shape = (u) => String(u || '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>').replace(/g-p-[0-9a-f]{32}/g, 'g-p-<id>').slice(0, 120);
  const snapshotViews = () => {
    try {
      const nav = win && win.getNavigator && win.getNavigator();
      const wcs = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith('https://chatgpt.com')).map((w) => ({ url: shape(w.getURL()), loading: w.isLoading() }));
      return { views: nav ? nav._debugViews().map((v) => ({ id: v.id, scope: v.scope, relation: v.relation, page: v.page, identity: v.identity.state, expected: Boolean(v.expectedKey), reached: v.reached, visible: v.visible })) : [], pages: wcs };
    } catch (e) { return { error: String(e && e.message) }; }
  };
  const check = (name, ok, detail) => { report.lastCheck = name; report.checks.push({ name, ok: Boolean(ok), detail, ...(ok ? {} : { diagnostics: snapshotViews() }) }); progress(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail + ' :: ' + JSON.stringify(snapshotViews())}`); };
  process.on('unhandledRejection', (e) => { report.errors.push(String((e && e.stack) || e)); progress(`UNHANDLED ${e}`); });

  // ---- fake Herdr + real bindings ------------------------------------------------------------------------------------------
  const workspaces = [{ id: 'w4', number: 4, label: 'Bicho', directory: 'C:\\a' }, { id: 'w7', number: 7, label: 'RelayPlane', directory: 'C:\\b' }];
  const listeners = new Set();
  const observer = { getState: () => ({ session: 'contextdeck', connection: 'connected', model: { workspaces, sessionFocus: null }, epoch: 1, syncCount: 1 }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, refresh: async () => {} };
  const sel = { mode: 'auto', selected: { workspaceId: 'w4', origin: 'dock' }, pending: null, observedId: 'w4', connection: 'connected', unavailableId: null, lastError: null };
  const fire = () => listeners.forEach((l) => l());
  const focusCalls = [];
  let failSelect = false;
  const selection = {
    getState: () => ({ ...sel, options: workspaces }),
    onChange: (l) => { listeners.add(l); return () => listeners.delete(l); },
    select: async (s, id) => { focusCalls.push(id); await sleep(30); if (failSelect) return { ok: false, error: { code: 'focus_failed', message: 'Herdr nao respondeu.' } }; sel.selected = { workspaceId: id, origin: 'dock' }; fire(); return { ok: true, confirmed: true }; },
    setMode: () => ({ ok: true })
  };
  const bindings = createChatBindings({ store: createBindingsStore({ file: path.join(tmp, 'chat-bindings.json') }), session: 'contextdeck', observer, selection });
  const bindFile = path.join(tmp, 'chat-bindings.json');
  const url = (n) => `https://chatgpt.com/c/${uuid(n)}`;
  const bind = (ws, n, label) => {
    const r = bindings.bind({ target: { session: 'contextdeck', workspaceId: ws }, url: url(n), origin: 'url', label, role: 'general', selectedAtOpen: sel.selected.workspaceId, confirmTarget: true });
    if (!r.ok) throw new Error(`bind ${label}: ${JSON.stringify(r.error)}`);
    return r.binding;
  };
  const A = [bind('w4', 1, 'Code Review'), bind('w4', 2, 'Arquitetura'), bind('w4', 3, 'Planejamento')];
  const B = [bind('w7', 4, 'Integração')];
  const bindingsBefore = fs.readFileSync(bindFile, 'utf8');

  // ---- the same wiring as src/main/index.js --------------------------------------------------------------------------------------
  const sent = { activity: 0, nav: 0, herdr: 0 };
  const uiState = sanitize(undefined);
  let win; let navPusher; let chatsPusher; let stopStatePusher = () => {};
  const notices = createNoticeController();
  const navigatorOf = () => win.getNavigator();
  const activity = () => (navigatorOf() ? navigatorOf().getWorkspaceActivity() : {});
  let lastActivity = '{}';
  const directOpen = createDirectOpen({ session: 'contextdeck', selection, navigator: { resolveActivityTarget: (a) => navigatorOf().resolveActivityTarget(a), selectBinding: (a) => navigatorOf().selectBinding(a), selectTemporary: (a) => navigatorOf().selectTemporary(a) }, showChatTab: () => win.switchMode('chat'), getMode: () => win.getMode() });
  const getActivityPayload = () => (navigatorOf() ? { global: navigatorOf().getGlobalActivity(), notices: notices.getState() } : null);
  const activityPusher = startActivityPusher({ getPayload: getActivityPayload, send: (p) => { sent.activity += 1; win.send('activity:state', p); win.sendToOverlay('overlay:activity-push', p); } });
  notices.onChange((s) => { win.setNotices(s.items.length + s.more); activityPusher.notify(); });
  win = createWindowController({
    uiState, uiStateFile: path.join(tmp, 'ui-state.json'), preloadPath: PRELOAD, overlayPreloadPath: OVERLAY_PRELOAD, rendererHtml: RENDERER_HTML, overlayHtml: OVERLAY_HTML,
    onClosed: () => { navPusher.stop(); chatsPusher.stop(); stopStatePusher(); activityPusher.stop(); notices.stop(); },
    onChatNavigated: () => chatsPusher.notify(),
    onNavChange: () => {
      navPusher.notify(); chatsPusher.notify();
      const t = JSON.stringify(activity());
      if (t !== lastActivity) { lastActivity = t; stopStatePusher.notify?.(); }
      const pending = new Set(navigatorOf().getGlobalActivity().groups.flatMap((g) => g.items.filter((i) => i.attention).map((i) => i.viewId)));
      notices.retain((n) => pending.has(n.viewId));
      activityPusher.notify();
    },
    chats: { session: 'contextdeck', bindings, selection, onAttention: (e) => notices.push(e) }
  });
  chatsPusher = startChatsPusher({ bindings, observer, selection, getUrl: () => win.getChatUrl(), send: (c, d) => { win.send(c, d); } });
  navPusher = startChatNavPusher({ getState: () => navigatorOf()?.getState(), send: (c, d) => { sent.nav += 1; win.send(c, d); } });
  registerIpc({ electron, win, herdr: { start: () => ({ ok: true }), isRunning: () => false, write() {}, resize() {}, stop() {} }, observer, selection, activity, activityIpc: { getPayload: getActivityPayload, directOpen, notices }, bindings, notifyChats: () => { chatsPusher.notify(); navigatorOf()?.reconcile(); }, settings: { herdrSession: 'contextdeck' }, uiState, persist() {}, userDataDir: tmp });
  await win.create();
  stopStatePusher = startStatePusher({ observer, selection, extra: activity, send: (c, d) => { sent.herdr += 1; win.send(c, d); win.sendToOverlay('overlay:state-push', d); } });
  const ui = win.getWindow().webContents;
  ui.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(`ui: ${message}`); });
  const nav = navigatorOf();
  const chatPages = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith('https://chatgpt.com'));
  const overlayWc = () => webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().endsWith('overlay.html'));
  const key = (id) => `contextdeck/${id}`;
  const pick = (b) => nav.selectBinding({ bindingId: b.bindingId, workspaceKey: key(b.workspaceIdentity.workspaceId) });
  const waitFor = async (fn, ms = 20000, step = 25) => { const end = Date.now() + ms; while (Date.now() < end) { let v; try { v = await fn(); } catch { v = false; } if (v) return Date.now(); await sleep(step); } return null; };
  const settled = async (count) => { await waitFor(() => chatPages().length >= count && chatPages().every((w) => !w.isLoading()), 40000); await sleep(800); };
  const domText = (id) => ui.executeJavaScript(`document.getElementById('${id}').textContent`);
  const indicator = () => ui.executeJavaScript(`(() => { const b = document.getElementById('activity-indicator'); const r = b.getBoundingClientRect(); return { text: document.getElementById('activity-text').textContent, w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 && getComputedStyle(b).display !== 'none', label: b.getAttribute('aria-label') }; })()`);
  const respondingOn = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('button[data-composer-submit]'); if (!b) return false; b.setAttribute('aria-label', 'Interromper geração'); return true; })()`);
  const respondingOff = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('button[data-composer-submit]'); if (!b) return false; b.setAttribute('aria-label', 'Enviar mensagem'); return true; })()`);
  const draftSet = (wc, on) => wc.executeJavaScript(`(() => { const t = document.querySelector('textarea[data-octane-input], textarea[name=prompt], textarea'); if (!t) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${on ? "'rascunho'" : "''"}); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  // Makes a logged-out page "be" conversation n. The logged-out SPA redirects an unavailable conversation back to "/" some time
  // after it booted (that delay depends on the network and on the session being cold: the first page of a run is the slowest),
  // so a single pushState can be silently undone. Condition-based, not a fixed sleep: assert the address, then require it to
  // survive until the SPA has demonstrably settled (the page is not loading and the address is unchanged across a navigation
  // event round-trip); if it was undone, assert again. The retries are reported (a harness property, never a product claim).
  const want = (n) => '/c/' + uuid(n);
  const bePage = async (wc, n) => {
    report.steps.pageRetries = report.steps.pageRetries || {};
    for (let attempt = 1; attempt <= 6; attempt++) {
      await wc.executeJavaScript("history.pushState({}, '', '" + want(n) + "'); location.pathname");
      // Wait for the address to still be the wanted one after the SPA had the chance to run (two idle frames of the page's own loop).
      const stable = await wc.executeJavaScript("new Promise((r) => setTimeout(() => r(location.pathname), 1500))");
      if (stable === want(n) && !wc.isLoading()) { report.steps.pageRetries[n] = attempt - 1; return true; }
    }
    report.steps.pageRetries[n] = 'gave up';
    return false;
  };
  // Before the checks that depend on it: a page that was moved away by the SPA is asserted again (and counted).
  const keepPages = async () => {
    for (const [n, wc] of [[1, pages['Code Review']], [2, pages.Arquitetura], [3, pages.Planejamento], [4, pages.B1]]) {
      if (wc && !wc.isDestroyed() && !(await wc.executeJavaScript('location.pathname')).startsWith('/c/')) { report.steps.reasserted = (report.steps.reasserted || 0) + 1; await bePage(wc, n); }
    }
  };

  progress('start');
  const base = metrics();
  win.switchMode('chat');
  await sleep(1200);

  // ---- three conversations loaded; each page "is" its conversation ----------------------------------------------------------------
  const pages = {};
  for (const [i, b] of A.entries()) { pick(b); await settled(2 + i); pages[b.label] = win.getChat().contents; check('page ' + (i + 1) + ' holds its conversation address', await bePage(pages[b.label], i + 1), JSON.stringify(report.steps.pageRetries)); }
  sel.selected = { workspaceId: 'w7', origin: 'dock' }; fire();
  pick(B[0]); await settled(5);
  pages.B1 = win.getChat().contents; check('page 4 holds its conversation address', await bePage(pages.B1, 4), JSON.stringify(report.steps.pageRetries));
  await keepPages();
  report.steps.beforeOverlay = metrics();

  // ---- A: activity of another workspace, with the Terminal tab on screen ------------------------------------------------------------
  win.switchMode('terminal');
  await sleep(600);
  const quiet = await indicator();
  check('indicator is visible on the Terminal tab, neutral, with a stable size', quiet.visible && quiet.w >= 90 && quiet.h > 0 && /Atividade/.test(quiet.text), JSON.stringify(quiet));
  const t0 = Date.now();
  await respondingOn(pages['Code Review']);
  const seen = await waitFor(async () => (await indicator()).text.includes('\u21BB1'), 15000);
  report.steps.indicatorUpdateMs = seen ? seen - t0 : null;
  const busy = await indicator();
  check('a response in ANOTHER workspace shows in the top bar while the Terminal tab is active', seen && /\u21BB1/.test(busy.text), JSON.stringify(busy));
  check('the indicator keeps its size when counts change', Math.abs(busy.w - quiet.w) <= 60 && busy.h === quiet.h, `${quiet.w} -> ${busy.w}`);
  await respondingOn(pages.B1); await respondingOn(pages.Arquitetura);
  check('three simultaneous responses are counted', await waitFor(async () => (await indicator()).text.includes('\u21BB3'), 15000), JSON.stringify(await indicator()));
  const wsAct = nav.getWorkspaceActivity();
  check('per-workspace counts agree with the global ones', wsAct.w4.responding === 2 && wsAct.w7.responding === 1, JSON.stringify(wsAct));

  // ---- B: the end of a response raises a notice that takes no focus --------------------------------------------------------------------
  report.steps.beforeNoticeFocus = { uiFocused: ui.isFocused() };
  await keepPages();
  const e0 = Date.now();
  await respondingOff(pages['Code Review']);
  const noticeAt = await waitFor(async () => { const o = overlayWc(); return o && (await o.executeJavaScript(`document.getElementById('notices').textContent`)).includes('Atividade para revisar'); }, 15000);
  report.steps.noticeLatencyMs = noticeAt ? noticeAt - e0 : null;
  const o = overlayWc();
  const noticeText = o ? await o.executeJavaScript(`document.getElementById('notices').textContent`) : '';
  check('the end of a background response shows an in-app notice naming workspace and conversation', /Bicho · w4 · Code Review/.test(noticeText), noticeText);
  check('the notice never says the response completed', !/conclu[ií]d/i.test(noticeText));
  check('the notice did not take the keyboard from the window the user was typing in', ui.isFocused() && !(o && o.isFocused()), JSON.stringify({ ui: ui.isFocused(), overlay: o && o.isFocused() }));
  check('the indicator shows the pending activity', (await indicator()).text.includes('\u25CF1'));
  const idleBefore = notices.getState();
  // Dismissing the notice does not acknowledge the attention.
  await o.executeJavaScript(`[...document.querySelectorAll('#notices .btn-icon')][0].click()`);
  await sleep(400);
  check('dismissing a notice keeps the activity pending', notices.getState().items.length === idleBefore.items.length - 1 && nav.getGlobalActivity().totals.attention === 1);

  // ---- C: the activity center over the Terminal tab ----------------------------------------------------------------------------------------
  const c0 = Date.now();
  await ui.executeJavaScript(`document.getElementById('activity-indicator').click()`);
  const centerAt = await waitFor(async () => { const ov = overlayWc(); return ov && (await ov.executeJavaScript(`!document.getElementById('activity').hidden && document.getElementById('activity-body').children.length > 0`)); }, 10000);
  report.steps.centerOpenMs = centerAt ? centerAt - c0 : null;
  const centerText = await overlayWc().executeJavaScript(`document.getElementById('activity-body').textContent`);
  report.steps.centerText = centerText;
  check('the center lists activity of every workspace, grouped by name and id', /Bicho · w4/.test(centerText) && /RelayPlane · w7/.test(centerText) && /Code Review/.test(centerText) && /Integração/.test(centerText), centerText);
  check('the center states the semantics in words', /Atividade para revisar/.test(centerText) && /Respondendo/.test(centerText) && !/conclu[ií]d/i.test(centerText));
  check('opening the center did not acknowledge anything', nav.getGlobalActivity().totals.attention === 1);
  await overlayWc().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  await overlayWc().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(600);
  check('Esc closes the center and gives focus back to the indicator', await ui.executeJavaScript(`document.getElementById('activity-indicator').getAttribute('aria-expanded') === 'false'`));

  // ---- D: direct navigation from the center, across workspaces -----------------------------------------------------------------------------
  const markers = {};
  for (const [name, wc] of Object.entries(pages)) { await wc.executeJavaScript('window.__m = Math.random(); true'); markers[name] = await wc.executeJavaScript('window.__m'); }
  const pagesBefore = chatPages().length;
  await ui.executeJavaScript(`document.getElementById('activity-indicator').click()`);
  await waitFor(async () => overlayWc() && (await overlayWc().executeJavaScript(`!document.getElementById('activity').hidden && document.querySelectorAll('#activity-body button[data-key]').length > 0`)), 10000);
  const d0 = Date.now();
  await overlayWc().executeJavaScript(`(() => { const b = [...document.querySelectorAll('#activity-body .act-item')].find((r) => r.textContent.includes('Code Review')); b.querySelector('button').click(); })()`);
  const openedAt = await waitFor(() => win.getMode() === 'chat' && sel.selected.workspaceId === 'w4' && nav.getState().tabs.find((t) => t.bindingId === A[0].bindingId && t.active), 10000);
  report.steps.directOpenMs = openedAt ? openedAt - d0 : null;
  check('direct open switched to the chat tab, the right workspace and the right conversation', openedAt, JSON.stringify({ mode: win.getMode(), ws: sel.selected.workspaceId }));
  check('exactly one explicit workspace command was sent (by that click)', focusCalls.length === 1 && focusCalls[0] === 'w4', JSON.stringify(focusCalls));
  await sleep(500);
  check('the visit acknowledged the activity', nav.getGlobalActivity().totals.attention === 0 && (await indicator()).text.includes('\u21BB'));
  const after = {};
  for (const [name, wc] of Object.entries(pages)) after[name] = wc.isDestroyed() ? 'destroyed' : await wc.executeJavaScript('window.__m');
  check('no conversation was reloaded or destroyed (markers intact, same page count)', Object.keys(markers).every((k) => after[k] === markers[k]) && chatPages().length === pagesBefore, JSON.stringify(after));
  check('the indicator is visible on the ChatGPT tab too', (await indicator()).visible);

  // ---- E: failure of the workspace command ----------------------------------------------------------------------------------------------------
  win.switchMode('terminal');
  sel.selected = { workspaceId: 'w7', origin: 'dock' }; fire();
  await respondingOff(pages.Arquitetura);
  await waitFor(() => nav.getGlobalActivity().totals.attention >= 1, 15000);
  failSelect = true;
  await ui.executeJavaScript(`document.getElementById('activity-indicator').click()`);
  await waitFor(async () => overlayWc() && (await overlayWc().executeJavaScript(`document.querySelectorAll('#activity-body button[data-key]').length > 0`)), 10000);
  const modeBefore = win.getMode();
  await overlayWc().executeJavaScript(`(() => { const r = [...document.querySelectorAll('#activity-body .act-item')].find((x) => x.textContent.includes('Arquitetura')); r.querySelector('button').click(); })()`);
  await sleep(1200);
  const failText = await overlayWc().executeJavaScript(`document.getElementById('activity-message').textContent`);
  check('a failed workspace command is reported and nothing is shown under the wrong context', /A conversa nao foi aberta/.test(failText) && win.getMode() === modeBefore && sel.selected.workspaceId === 'w7', failText);
  failSelect = false;
  await overlayWc().executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(400);

  // ---- F: narrow window ---------------------------------------------------------------------------------------------------------------------------
  win.getWindow().setSize(820, 600);
  await sleep(800);
  const narrow = await indicator();
  check('a narrow window keeps an accessible, compact indicator', narrow.visible && narrow.w <= 70 && narrow.label && narrow.label.length > 10, JSON.stringify(narrow));
  win.getWindow().setSize(1240, 820);
  await sleep(500);

  // ---- G: cost -----------------------------------------------------------------------------------------------------------------------------------------
  await draftSet(pages.Planejamento, true);
  await waitFor(async () => (await indicator()).text.includes('\u270E1'), 15000);
  const sendsBefore = { ...sent };
  app.getAppMetrics();
  await sleep(30000);
  const idle = app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0);
  report.steps.idle30s = { cpuPercent: round(idle), ipcPerMinute: { activity: (sent.activity - sendsBefore.activity) * 2, chatnav: (sent.nav - sendsBefore.nav) * 2, herdr: (sent.herdr - sendsBefore.herdr) * 2 }, metrics: metrics() };
  check('idle: no activity/status IPC when nothing changes', report.steps.idle30s.ipcPerMinute.activity <= 2 && report.steps.idle30s.ipcPerMinute.chatnav <= 2 && report.steps.idle30s.ipcPerMinute.herdr <= 2, JSON.stringify(report.steps.idle30s.ipcPerMinute));
  // Many states changing at once.
  const b0 = { ...sent }; const burst0 = Date.now();
  for (const wc of Object.values(pages)) { await respondingOn(wc); }
  await waitFor(async () => (await indicator()).text.includes('\u21BB4'), 15000);
  for (const wc of Object.values(pages)) { await respondingOff(wc); }
  await sleep(8000);
  report.steps.burst = { ms: Date.now() - burst0, activityPushes: sent.activity - b0.activity, navPushes: sent.nav - b0.nav };
  check('bindings are byte-identical after everything', fs.readFileSync(bindFile, 'utf8') === bindingsBefore);
  check('every page is still alive', chatPages().length === pagesBefore);
  report.steps.memory = { base, beforeOverlay: report.steps.beforeOverlay, afterOverlayUsed: metrics() };
  await sleep(35000);                                  // the overlay is released after its idle period
  report.steps.memory.afterOverlayRelease = metrics();
  report.steps.overlayReleased = !overlayWc();
  report.steps.focusCommands = focusCalls;

  win.getWindow().destroy();
  await sleep(1500);
  check('closing the window closes every page', chatPages().length === 0);
  report.errors = report.errors.filter((e) => !/UnknownVizError|Autofill/.test(e));
  report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  finishWith(report.failed.length || report.errors.length ? 1 : (report.checks.length < EXPECTED_MIN_CHECKS ? 2 : 0));
}).catch((e) => finishWith(1, { fatal: String((e && e.stack) || e) }));
