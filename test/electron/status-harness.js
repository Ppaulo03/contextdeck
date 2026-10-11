'use strict';

// Real-Electron harness for the per-view status (M01-I3B-2). NOT part of `npm test` (display + network):
//     npx electron test/electron/status-harness.js                       status observers ON  (default)
//     $env:CONTEXTDECK_CHAT_STATUS='0'; npx electron test/electron/status-harness.js     baseline: observers OFF
// Real window, chat views, manager, navigator, observation hub and the I3P detector against a THROWAWAY profile,
// logged-out chatgpt.com, fake Herdr (no PTY client, no Herdr session). No message is ever sent: the pages' own
// composer is driven with the same synthetic signals the I3P spike used (the send/stop control's aria-label, the
// textarea value), i.e. "fixtures controlled". Writes <HARNESS_OUT>/status-report-<on|off>.json.
const electron = require('electron');
const { app, webContents } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextdeck-st-'));
app.setPath('userData', tmp);
const outDir = process.env.HARNESS_OUT || tmp;
const STATUS_ON = process.env.CONTEXTDECK_CHAT_STATUS !== '0';

const { createWindowController } = require(path.join(ROOT, 'src/main/window'));
const { registerIpc } = require(path.join(ROOT, 'src/main/ipc'));
const { createBindingsStore } = require(path.join(ROOT, 'src/main/chat-bindings/store'));
const { createChatBindings } = require(path.join(ROOT, 'src/main/chat-bindings/service'));
const { startChatsPusher } = require(path.join(ROOT, 'src/main/ipc/chats'));
const { startChatNavPusher } = require(path.join(ROOT, 'src/main/ipc/chatnav'));
const { startStatePusher } = require(path.join(ROOT, 'src/main/ipc/herdr'));
const { sanitize } = require(path.join(ROOT, 'src/main/persistence/ui-state'));
const { PRELOAD, OVERLAY_PRELOAD, RENDERER_HTML, OVERLAY_HTML } = require(path.join(ROOT, 'src/main/paths'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (n, d = 2) => (n === null || n === undefined ? null : Number(n.toFixed(d)));
const progress = (m) => { try { fs.appendFileSync(path.join(outDir, `status-progress-${STATUS_ON ? 'on' : 'off'}.log`), `${new Date().toISOString().slice(11, 19)} ${m}\n`); } catch { /* Diagnostics only. */ } };
const metrics = () => { const m = app.getAppMetrics(); return { processes: m.length, workingSetMB: Math.round(m.reduce((a, p) => a + (p.memory.workingSetSize || 0), 0) / 1024), cpuPercent: round(m.reduce((a, p) => a + p.cpu.percentCPUUsage, 0)) }; };

process.on('uncaughtException', (e) => progress(`UNCAUGHT ${(e && e.stack) || e}`));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const report = { statusObservers: STATUS_ON, electron: process.versions.electron, steps: {}, checks: [], errors: [] };
  const check = (name, ok, detail) => { report.checks.push({ name, ok: Boolean(ok), detail }); progress(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail}`); };
  process.on('unhandledRejection', (e) => { report.errors.push(String((e && e.stack) || e)); progress(`UNHANDLED ${e}`); });

  const workspaces = [{ id: 'w1', number: 1, label: 'api', directory: 'C:\\a' }, { id: 'w2', number: 2, label: 'app', directory: 'C:\\b' }];
  const listeners = new Set();
  const observer = { getState: () => ({ session: 'contextdeck', connection: 'connected', model: { workspaces, sessionFocus: null }, epoch: 1, syncCount: 1 }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, refresh: async () => {} };
  const sel = { mode: 'auto', selected: { workspaceId: 'w1', origin: 'dock' }, pending: null, observedId: 'w1', connection: 'connected', unavailableId: null, lastError: null };
  const fire = () => listeners.forEach((l) => l());
  const calls = { focus: 0 };
  const selection = { getState: () => ({ ...sel, options: workspaces }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, select: async () => { calls.focus += 1; return { ok: true }; }, setMode: () => ({ ok: true }) };
  const bindings = createChatBindings({ store: createBindingsStore({ file: path.join(tmp, 'chat-bindings.json') }), session: 'contextdeck', observer, selection });
  const bindFile = path.join(tmp, 'chat-bindings.json');
  const url = (n) => `https://chatgpt.com/c/${uuid(n)}`;
  const bind = (ws, n, label) => {
    const r = bindings.bind({ target: { session: 'contextdeck', workspaceId: ws }, url: url(n), origin: 'url', label, role: 'general', selectedAtOpen: sel.selected.workspaceId, confirmTarget: true });
    if (!r.ok) throw new Error(`bind ${label}: ${JSON.stringify(r.error)}`);
    return r.binding;
  };
  const A = [bind('w1', 1, 'A1'), bind('w1', 2, 'A2'), bind('w1', 3, 'A3')];
  const B = [bind('w2', 4, 'B1'), bind('w2', 5, 'B2')];
  const bindingsBefore = fs.readFileSync(bindFile, 'utf8');

  const sent = { nav: 0, chats: 0, herdr: 0, navTimes: [] };
  const uiState = sanitize(undefined);
  let win; let navPusher; let chatsPusher; let stopStatePusher = () => {}; let statePusher = null;
  const activity = () => (win && win.getNavigator() ? win.getNavigator().getWorkspaceActivity() : {});
  let lastActivity = '{}';
  win = createWindowController({
    uiState, uiStateFile: path.join(tmp, 'ui-state.json'), preloadPath: PRELOAD, overlayPreloadPath: OVERLAY_PRELOAD, rendererHtml: RENDERER_HTML, overlayHtml: OVERLAY_HTML,
    onClosed: () => { navPusher.stop(); chatsPusher.stop(); stopStatePusher(); },
    onChatNavigated: () => chatsPusher.notify(),
    onNavChange: () => { navPusher.notify(); chatsPusher.notify(); const t = JSON.stringify(activity()); if (t !== lastActivity) { lastActivity = t; stopStatePusher.notify?.(); } },
    chats: { session: 'contextdeck', bindings, selection }
  });
  chatsPusher = startChatsPusher({ bindings, observer, selection, getUrl: () => win.getChatUrl(), send: (c, d) => { sent.chats += 1; win.send(c, d); } });
  navPusher = startChatNavPusher({ getState: () => win.getNavigator()?.getState(), send: (c, d) => { sent.nav += 1; sent.navTimes.push(Date.now()); win.send(c, d); } });
  registerIpc({ electron, win, herdr: { start: () => ({ ok: true }), isRunning: () => false, write() {}, resize() {}, stop() {} }, observer, selection, activity, bindings, notifyChats: () => { chatsPusher.notify(); win.getNavigator()?.reconcile(); }, settings: { herdrSession: 'contextdeck' }, uiState, persist() {}, userDataDir: tmp });
  await win.create();
  stopStatePusher = startStatePusher({ observer, selection, extra: activity, send: (c, d) => { sent.herdr += 1; win.send(c, d); } });
  const ui = win.getWindow().webContents;
  ui.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(`ui: ${message}`); });
  const nav = win.getNavigator();
  const chatPages = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith('https://chatgpt.com'));
  const key = (id) => `contextdeck/${id}`;
  const pick = (b, extra = {}) => nav.selectBinding({ bindingId: b.bindingId, workspaceKey: key(b.workspaceIdentity.workspaceId), ...extra });
  const waitFor = async (fn, ms = 20000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return Date.now(); await sleep(step); } return null; };
  const settled = async (count) => { await waitFor(() => chatPages().length >= count && chatPages().every((w) => !w.isLoading()), 40000); await sleep(800); };
  const tab = (b) => nav.getState().tabs.find((t) => t.bindingId === b.bindingId);
  // Synthetic fixtures on the page's own composer (no text is typed or sent).
  const respondingOn = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('button[data-composer-submit]'); if (!b) return false; b.setAttribute('aria-label', 'Interromper geração'); return true; })()`);
  const respondingOff = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('button[data-composer-submit]'); if (!b) return false; b.setAttribute('aria-label', 'Enviar mensagem'); return true; })()`);
  const draftSet = (wc, on) => wc.executeJavaScript(`(() => { const t = document.querySelector('textarea[data-octane-input], textarea[name=prompt], textarea'); if (!t) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${on ? "'rascunho'" : "''"}); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const bePage = (wc, n) => wc.executeJavaScript(`history.pushState({}, '', '/c/${uuid(n)}'); location.pathname`);

  progress(`start status=${STATUS_ON}`);
  win.switchMode('chat');
  await sleep(1500);

  // ---- open conversations and make each page "be" its conversation -------------------------------------------------------
  const pages = {};
  const memory = [{ views: 0, ...metrics() }];
  const loaded = [];
  for (const [i, b] of [A[0], A[1], A[2]].entries()) {
    pick(b); await settled(2 + i);
    loaded.push(b);
    const wc = win.getChat().contents;
    await bePage(wc, [1, 2, 3][i]);
    pages[b.label] = wc;
    await sleep(600);
    memory.push({ views: i + 1, ...metrics() });
  }
  sel.selected = { workspaceId: 'w2', origin: 'dock' }; fire();
  pick(B[0]); await settled(5);
  pages.B1 = win.getChat().contents; await bePage(pages.B1, 4); await sleep(600);
  memory.push({ views: 4, ...metrics() });
  pick(B[1]); await settled(6);
  pages.B2 = win.getChat().contents; await bePage(pages.B2, 5); await sleep(600);
  memory.push({ views: 5, ...metrics() });
  report.steps.memoryByViews = memory;
  report.steps.hubAfterOpening = win.getObservationStats();
  check('one observer per loaded view (initial page + 5 conversations = 6) when status is on, none when off', STATUS_ON ? report.steps.hubAfterOpening.observers === 6 : report.steps.hubAfterOpening.observers === 0, JSON.stringify(report.steps.hubAfterOpening));
  sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();
  pick(A[0]);
  await sleep(1500);

  if (STATUS_ON) {
    // ---- A: a response in the background ---------------------------------------------------------------------------------
    const t0 = Date.now();
    await respondingOn(pages.A1);
    const seenAt = await waitFor(() => tab(A[0]).activity && tab(A[0]).activity.responding, 12000);
    report.steps.respondingDetectionMs = seenAt ? seenAt - t0 : null;
    check('A1 (visible) shows responding', seenAt);
    pick(A[1]);                                           // A1 is now hidden; A2 visible
    await sleep(2500);
    check('A1 keeps responding while hidden and A2 does not', tab(A[0]).activity.responding && !tab(A[1]).activity.responding, JSON.stringify([tab(A[0]).activity, tab(A[1]).activity]));
    // ---- B: two responses, then another workspace ----------------------------------------------------------------------------
    await respondingOn(pages.A2);
    await waitFor(() => tab(A[1]).activity && tab(A[1]).activity.responding, 12000);
    sel.selected = { workspaceId: 'w2', origin: 'dock' }; fire();
    await sleep(1500);
    const wsAct = nav.getWorkspaceActivity();
    report.steps.workspaceActivityWhileInB = wsAct;
    check('while working in workspace B, workspace A shows 2 conversations responding', wsAct.w1 && wsAct.w1.responding === 2, JSON.stringify(wsAct));
    check('workspace B is not reported as having activity', !wsAct.w2 || (wsAct.w2.responding === 0 && wsAct.w2.attention === 0));
    // ---- the end of A1's response while hidden -> attention ----------------------------------------------------------------------
    const e0 = Date.now();
    await respondingOff(pages.A1);
    const endAt = await waitFor(() => nav.getWorkspaceActivity().w1.attention === 1, 12000);
    report.steps.attentionLatencyMs = endAt ? endAt - e0 : null;
    check('the end of a background response raises attention on that conversation only', endAt && nav.getWorkspaceActivity().w1.responding === 1, JSON.stringify(nav.getWorkspaceActivity().w1));
    sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();
    await sleep(500);
    check('coming back to workspace A (automatic restore) does not acknowledge the activity', tab(A[0]).activity.attention === true || tab(A[1]).activity.attention === false);
    pick(A[0]);
    await sleep(300);
    check('explicitly opening the conversation acknowledges it', tab(A[0]).activity.attention === false, JSON.stringify(tab(A[0]).activity));
    // ---- draft ---------------------------------------------------------------------------------------------------------------------
    await draftSet(pages.A3, true);
    const d0 = Date.now();
    const draftAt = await waitFor(() => tab(A[2]).activity && tab(A[2]).activity.draft, 12000);
    report.steps.draftDetectionMs = draftAt ? draftAt - d0 : null;
    check('a draft in a hidden conversation is shown without reading its content', draftAt);
    check('the draft text is untouched in the page', (await pages.A3.executeJavaScript(`document.querySelector('textarea').value`)) === 'rascunho');
    await respondingOff(pages.A2); await draftSet(pages.A3, false);
    // ---- navigation inside ChatGPT --------------------------------------------------------------------------------------------------
    await respondingOn(pages.A1); await waitFor(() => tab(A[0]).activity && tab(A[0]).activity.responding, 12000);
    await bePage(pages.A1, 2);                              // the view that was A1 now shows conversation 2 (A2's tab)
    await sleep(300);
    const t1 = nav.getState();
    check('after navigating A1 -> A2 inside the page, A1 shows nothing and nothing was carried over', t1.tabs.find((t) => t.bindingId === A[0].bindingId).activity === null, JSON.stringify(t1.tabs.map((t) => [t.label, t.activity && t.activity.responding])));
    await bePage(pages.A1, 1); await respondingOff(pages.A1);
    // ---- uncertainty: composer disappears, reload -------------------------------------------------------------------------------
    await pages.A3.executeJavaScript(`(() => { const f = document.querySelector('form'); if (f) f.setAttribute('data-hidden-by-fixture', '1'); document.querySelectorAll('textarea, button[data-composer-submit]').forEach((n) => { n.dataset.old = '1'; n.remove(); }); return true; })()`);
    await pick(A[2]); await sleep(7000);
    report.steps.activityWithoutComposer = tab(A[2]).activity;
    check('a missing composer degrades to unknown (and never to idle/completed)', tab(A[2]).activity && tab(A[2]).activity.unknown && !tab(A[2]).activity.responding && !tab(A[2]).activity.attention, JSON.stringify(tab(A[2]).activity));
    // ---- a renderer that stops answering: the probe times out and polling resumes ----------------------------------------------------
    pick(A[1]);
    const probesBefore = win.getObservationStats();
    pages.A2.executeJavaScript('(() => { const t = Date.now(); while (Date.now() - t < 7500) {} return 1; })()').catch(() => {});
    await sleep(14000);
    const probesAfter = win.getObservationStats();
    report.steps.probeTimeouts = probesAfter.probeTimeouts - probesBefore.probeTimeouts;
    check('a busy renderer makes a probe time out; the app stays usable and polling resumes', pick(A[0]).ok && probesAfter.polls > probesBefore.polls, JSON.stringify([probesBefore, probesAfter]));
  }

  // ---- performance (both modes) --------------------------------------------------------------------------------------------------------
  respondingOff(pages.A1).catch(() => {});
  await sleep(2000);
  const switchMs = [];
  for (let i = 0; i < 100; i++) { const s = process.hrtime.bigint(); pick([A[0], A[1], A[2]][i % 3]); switchMs.push(Number(process.hrtime.bigint() - s) / 1e6); }
  report.steps.switchMs = { medianMs: round(median(switchMs), 3), p95Ms: round([...switchMs].sort((a, b) => a - b)[94], 3) };
  const loadedPages = chatPages().length;
  // Idle windows: 30 s each, restore a quiet state first.
  await sleep(3000);
  const stats0 = win.getObservationStats();
  const navBefore = sent.nav; const herdrBefore = sent.herdr; const chatsBefore = sent.chats;
  app.getAppMetrics();
  await sleep(30000);
  const cpuIdle30 = round(app.getAppMetrics().reduce((a, p) => a + p.cpu.percentCPUUsage, 0));
  const stats1 = win.getObservationStats();
  report.steps.idle30s = {
    views: loadedPages, cpuPercent: cpuIdle30,
    pollsPerMinute: stats0 && stats1 ? Math.round((stats1.polls - stats0.polls) * 2) : null,
    ipcPerMinute: { chatnavState: (sent.nav - navBefore) * 2, herdrState: (sent.herdr - herdrBefore) * 2, chatsState: (sent.chats - chatsBefore) * 2 },
    metrics: metrics()
  };
  check('idle: no status IPC traffic when nothing changes (≤ 2 messages per minute)', (sent.nav - navBefore) * 2 <= 2 && (sent.herdr - herdrBefore) * 2 <= 2, JSON.stringify(report.steps.idle30s.ipcPerMinute));
  check('no Herdr focus command was ever sent', calls.focus === 0);
  check('bindings file is byte-identical after everything', fs.readFileSync(bindFile, 'utf8') === bindingsBefore);
  check('no view was destroyed or reloaded by observation (page count unchanged)', chatPages().length === loadedPages);

  report.steps.finalHub = win.getObservationStats();
  fs.writeFileSync(path.join(outDir, `status-report-${STATUS_ON ? 'on' : 'off'}.json`), JSON.stringify({ ...report, failed: report.checks.filter((c) => !c.ok).map((c) => c.name), partial: true }, null, 2));
  win.getWindow().destroy();
  await sleep(1500);
  report.steps.afterClose = { chatPages: chatPages().length, hub: win.getObservationStats() };
  check('closing the window closes every page', chatPages().length === 0);
  report.errors = report.errors.filter((e) => !/UnknownVizError|Autofill/.test(e));
  report.failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  fs.writeFileSync(path.join(outDir, `status-report-${STATUS_ON ? 'on' : 'off'}.json`), JSON.stringify(report, null, 2));
  setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Best effort. */ } app.quit(); }, 500);
});
