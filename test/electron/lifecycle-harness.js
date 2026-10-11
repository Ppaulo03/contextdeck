'use strict';

// Real-Electron harness for the view lifecycle (M01-I3C-1). NOT part of `npm test` (display + network):
//     npx electron test/electron/lifecycle-harness.js        writes <HARNESS_OUT>/lifecycle-report.json (default: <tmp>/contextdeck-harness-out)
// The real window, chat views, manager, navigator, observation hub, lifecycle, IPC and renderer against a THROWAWAY profile, logged-out
// chatgpt.com and a fake Herdr (no PTY client, no Herdr session). No message is ever sent: "responding" and "draft" are driven with the
// same synthetic signals as the status harness (the send/stop control's aria-label, the textarea value), and a page "is" its conversation
// through history.pushState (logged out, /c/<uuid> redirects to "/"). What it measures that mocks cannot:
//   - memory / processes / idle CPU with 1, 3, 5 and 10 views, Terminal active vs ChatGPT active;
//   - memory before and after suspending (right after, +3 s, +10 s), time to release, time to restore, switching time;
//   - that protected pages (responding, draft) are refused, that nothing is pushed to the UI at rest, and that no Herdr command is sent.
// METHOD AND LIMITS: see docs/validation/m01-i3c-1.md ("Medição"). Numbers from a logged-out profile are a LOWER bound for real, logged-in
// conversations (their pages are heavier), and Chromium may keep memory allocated after a view is destroyed.
// Exit codes (a harness that did not run must never look like a pass): 0 every check passed; 1 a check failed or an error was recorded;
// 2 too few checks ran; 3 timeout; 77 SKIPPED (no network to chatgpt.com); 78 BLOCKED (the main ContextDeck application is open).
const electron = require('electron');
const { app, webContents } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextdeck-lc-'));
app.setPath('userData', tmp);
const outDir = process.env.HARNESS_OUT || path.join(os.tmpdir(), 'contextdeck-harness-out');
fs.mkdirSync(outDir, { recursive: true });
const EXPECTED_MIN_CHECKS = 25;

function mainAppRunning() {
  if (process.platform !== 'win32') return null;
  try {
    const out = require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"], { encoding: 'utf8', timeout: 20000 });
    return out.split(/\r?\n/).filter(Boolean).map((l) => ({ pid: Number(l.slice(0, l.indexOf('|'))), cmd: l.slice(l.indexOf('|') + 1) }))
      .filter((p) => p.pid !== process.pid && !/--type=/.test(p.cmd) && !/harness|smoke-start/.test(p.cmd));
  } catch { return null; }
}
let current = null;
const finishWith = (code, extra = {}) => {
  const r = Object.assign(current || { steps: {}, checks: [], errors: [] }, extra, { exitCode: code });
  try { fs.writeFileSync(path.join(outDir, 'lifecycle-report.json'), JSON.stringify(r, null, 2)); } catch { /* Diagnostics only. */ }
  const failed = (r.checks || []).filter((c) => !c.ok).map((c) => c.name);
  console.log(`lifecycle-harness: exit ${code}; ${(r.checks || []).length - failed.length}/${(r.checks || []).length} checks passed${r.skipped ? '; SKIPPED: ' + r.skipped : ''}${r.blocked ? '; BLOCKED: ' + r.blocked : ''}${r.fatal ? '; FATAL: ' + r.fatal : ''}; report: ${path.join(outDir, 'lifecycle-report.json')}`);
  for (const f of failed) console.log(`  FAILED: ${f}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Best effort. */ }
  app.exit(code);
};
setTimeout(() => finishWith(3, { fatal: 'timeout: the harness did not finish in 12 minutes' }), 12 * 60 * 1000).unref();

const { createWindowController } = require(path.join(ROOT, 'src/main/window'));
const { registerIpc } = require(path.join(ROOT, 'src/main/ipc'));
const { createBindingsStore } = require(path.join(ROOT, 'src/main/chat-bindings/store'));
const { createChatBindings } = require(path.join(ROOT, 'src/main/chat-bindings/service'));
const { startChatsPusher } = require(path.join(ROOT, 'src/main/ipc/chats'));
const { startChatNavPusher } = require(path.join(ROOT, 'src/main/ipc/chatnav'));
const { sanitize } = require(path.join(ROOT, 'src/main/persistence/ui-state'));
const { PRELOAD, OVERLAY_PRELOAD, RENDERER_HTML, OVERLAY_HTML } = require(path.join(ROOT, 'src/main/paths'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = (n) => `${String(n).padStart(2, '0')}${String(n).padStart(2, '0')}${String(n).padStart(2, '0')}${String(n).padStart(2, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const round = (n, d = 1) => (n === null || n === undefined ? null : Number(n.toFixed(d)));
const progress = (m) => { try { fs.appendFileSync(path.join(outDir, 'lifecycle-progress.log'), `${new Date().toISOString().slice(11, 19)} ${m}\n`); } catch { /* Diagnostics only. */ } };

process.on('uncaughtException', (e) => progress(`UNCAUGHT ${(e && e.stack) || e}`));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const report = { electron: process.versions.electron, chromium: process.versions.chrome, platform: `${process.platform} ${os.release()}`, steps: {}, checks: [], errors: [] };
  current = report;
  const other = mainAppRunning();
  if (other && other.length) return finishWith(78, { blocked: `the main ContextDeck application is open (pid ${other.map((p) => p.pid).join(', ')}); close it and run again.` });
  try {
    const probe = await electron.net.fetch('https://chatgpt.com/', { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    report.networkProbe = probe.status;
  } catch (e) { return finishWith(77, { skipped: `chatgpt.com is not reachable from this machine (${e && e.message})` }); }
  const check = (name, ok, detail) => { report.lastCheck = name; report.checks.push({ name, ok: Boolean(ok), detail }); progress(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' :: ' + detail}`); };
  process.on('unhandledRejection', (e) => { report.errors.push(String((e && e.stack) || e)); progress(`UNHANDLED ${e}`); });

  // ---- fake Herdr + real bindings -----------------------------------------------------------------------------------------------
  const workspaces = [{ id: 'w1', number: 1, label: 'api', directory: 'C:\\a' }, { id: 'w2', number: 2, label: 'app', directory: 'C:\\b' }];
  const listeners = new Set();
  const observer = { getState: () => ({ session: 'contextdeck', connection: 'connected', model: { workspaces, sessionFocus: null }, epoch: 1, syncCount: 1 }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, refresh: async () => {} };
  const sel = { mode: 'auto', selected: { workspaceId: 'w1', origin: 'dock' }, pending: null, observedId: 'w1', connection: 'connected', unavailableId: null, lastError: null };
  const fire = () => listeners.forEach((l) => l());
  const calls = { focus: 0 };
  const selection = { getState: () => ({ ...sel, options: workspaces }), onChange: (l) => { listeners.add(l); return () => listeners.delete(l); }, select: async () => { calls.focus += 1; return { ok: true }; }, setMode: () => ({ ok: true }) };
  const bindFile = path.join(tmp, 'chat-bindings.json');
  const bindings = createChatBindings({ store: createBindingsStore({ file: bindFile }), session: 'contextdeck', observer, selection });
  const url = (n) => `https://chatgpt.com/c/${uuid(n)}`;
  const bind = (ws, n, label) => {
    const r = bindings.bind({ target: { session: 'contextdeck', workspaceId: ws }, url: url(n), origin: 'url', label, role: 'general', selectedAtOpen: sel.selected.workspaceId, confirmTarget: true });
    if (!r.ok) throw new Error(`bind ${label}: ${JSON.stringify(r.error)}`);
    return r.binding;
  };
  const A = Array.from({ length: 10 }, (_, i) => bind('w1', i + 1, `A${i + 1}`));
  const B = [bind('w2', 21, 'B1'), bind('w2', 22, 'B2')];
  const bindingsBefore = fs.readFileSync(bindFile, 'utf8');

  // ---- the same wiring as src/main/index.js ----------------------------------------------------------------------------------------
  const sent = { nav: 0, chats: 0 };
  const uiState = sanitize(undefined);
  let win; let navPusher; let chatsPusher;
  win = createWindowController({
    uiState, uiStateFile: path.join(tmp, 'ui-state.json'), preloadPath: PRELOAD, overlayPreloadPath: OVERLAY_PRELOAD, rendererHtml: RENDERER_HTML, overlayHtml: OVERLAY_HTML,
    onClosed: () => { navPusher.stop(); chatsPusher.stop(); },
    onChatNavigated: () => chatsPusher.notify(),
    onNavChange: () => { navPusher.notify(); chatsPusher.notify(); },
    chats: { session: 'contextdeck', bindings, selection }
  });
  chatsPusher = startChatsPusher({ bindings, observer, selection, getUrl: () => win.getChatUrl(), extra: () => ({ lifecycle: win.getLifecycle() ? win.getLifecycle().byBinding() : {} }), send: (c, d) => { sent.chats += 1; win.send(c, d); } });
  navPusher = startChatNavPusher({ getState: () => win.getNavigator()?.getState(), send: (c, d) => { sent.nav += 1; win.send(c, d); } });
  registerIpc({ electron, win, herdr: { start: () => ({ ok: true }), isRunning: () => false, write() {}, resize() {}, stop() {} }, observer, selection, bindings, notifyChats: () => { chatsPusher.notify(); win.getNavigator()?.reconcile(); }, onUnbind: (key) => win.getNavigator().releaseConversation(key), activityIpc: { getPayload: () => null, directOpen: { open: async () => ({ ok: false }) }, notices: { dismiss() {}, getState: () => ({ items: [], more: 0 }) }, unbound: null }, settings: { herdrSession: 'contextdeck' }, uiState, persist() {}, userDataDir: tmp });
  await win.create();
  const ui = win.getWindow().webContents;
  ui.on('console-message', (_e, level, message) => { if (level >= 2) report.errors.push(`ui: ${message}`); });
  const nav = win.getNavigator();
  const lc = win.getLifecycle();
  const chatPages = () => webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith('https://chatgpt.com'));
  const key = (id) => `contextdeck/${id}`;
  const pick = (b, extra = {}) => nav.selectBinding({ bindingId: b.bindingId, workspaceKey: key(b.workspaceIdentity.workspaceId), ...extra });
  const waitFor = async (fn, ms = 20000, step = 50) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return Date.now(); await sleep(step); } return null; };
  const settled = async (count) => { await waitFor(() => chatPages().length >= count && chatPages().every((w) => !w.isLoading()), 40000); await sleep(800); };
  const tab = (b) => nav.getState().tabs.find((t) => t.bindingId === b.bindingId);
  const viewIdOf = (b) => nav.viewIdOfBinding(b.bindingId);
  const respondingOn = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('button[data-composer-submit]'); if (!b) return false; b.setAttribute('aria-label', 'Interromper geração'); return true; })()`);
  const respondingOff = (wc) => wc.executeJavaScript(`(() => { const b = document.querySelector('button[data-composer-submit]'); if (!b) return false; b.setAttribute('aria-label', 'Enviar mensagem'); return true; })()`);
  const draftSet = (wc, on) => wc.executeJavaScript(`(() => { const t = document.querySelector('textarea[data-octane-input], textarea[name=prompt], textarea'); if (!t) return false; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ${on ? "'rascunho'" : "''"}); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const bePage = (wc, n) => wc.executeJavaScript(`history.pushState({}, '', '/c/${uuid(n)}'); location.pathname`);
  const eligible = (b) => waitFor(() => { const id = viewIdOf(b); return id && lc.describe(id) && lc.describe(id).eligible; }, 45000, 250);
  const pages = {};

  // A sample: the resource report after letting CPU accumulate over `cpuMs` (the first getAppMetrics resets the interval).
  const sample = async (label, cpuMs = 3000) => {
    win.getResourceReport();
    await sleep(cpuMs);
    const r = win.getResourceReport();
    const row = { label, views: r.views, observers: r.observers, processes: r.totals.processes, allMB: r.totals.allWorkingSetMB, viewHosts: r.totals.viewHosts, viewHostsMB: r.totals.viewHostsMB, sharedHosts: r.totals.sharedHosts, allCpuPercent: r.totals.allCpuPercent, byType: r.totals.byType };
    (report.steps.samples ||= []).push(row);
    progress(`sample ${label}: ${row.allMB}MB all, ${row.viewHostsMB}MB hosts, ${row.processes} proc, cpu ${row.allCpuPercent}%`);
    return row;
  };

  // ---- 0. baseline: Terminal active, only the application's initial page ------------------------------------------------------------
  progress('start');
  await sleep(2500);
  report.steps.baseline = await sample('terminal-active-initial-page-only');

  // ---- 1. open conversations one by one: 1, 3, 5, 10 views, ChatGPT active ----------------------------------------------------------
  win.switchMode('chat');
  await sleep(800);
  const createMs = [];
  for (let i = 1; i <= 10; i++) {
    const t0 = process.hrtime.bigint();
    pick(A[i - 1]);
    await settled(1 + i);
    createMs.push(Number(process.hrtime.bigint() - t0) / 1e6 - 800);
    const wc = win.getChat().contents;
    pages[`A${i}`] = wc;
    await bePage(wc, i);
    await sleep(500);
    if ([1, 3, 5, 10].includes(i)) await sample(`chat-active-${i}-conversation-views`);
  }
  report.steps.createMs = { medianMs: round(median(createMs), 0), all: createMs.map((n) => Math.round(n)) };
  check('10 conversation views + the initial page = 11 ChatGPT pages', chatPages().length === 11, chatPages().length);
  check('one observer per loaded view', win.getObservationStats().observers === 11, JSON.stringify(win.getObservationStats()));
  const inv = lc.inventory();
  report.steps.inventory = inv.map((r) => ({ viewId: r.viewId, state: r.state, kind: r.kind, selected: r.selected, observed: r.observed, eligible: r.eligible, blockers: r.blockers }));
  check('the inventory sees 10 binding views + the initial page; exactly one selected', inv.filter((r) => r.kind === 'binding').length === 10 && inv.filter((r) => r.kind === 'pristine').length === 1 && inv.filter((r) => r.selected).length === 1, JSON.stringify(lc.summary()));
  check('the initial page and the selected view are never eligible', inv.filter((r) => r.kind === 'pristine' || r.selected).every((r) => !r.eligible));

  win.switchMode('terminal');
  await sleep(1500);
  await sample('terminal-active-10-conversation-views');
  win.switchMode('chat');
  await sleep(800);

  // ---- 2. switching time between loaded views -----------------------------------------------------------------------------------
  const switchMs = [];
  for (let i = 0; i < 60; i++) { const t0 = process.hrtime.bigint(); pick(A[i % 10]); switchMs.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  report.steps.switchMs = { count: switchMs.length, medianMs: round(median(switchMs), 3), maxMs: round(Math.max(...switchMs), 3), note: 'main-process time of selectBinding(); it does not include the compositor painting the page' };
  pick(A[0]);
  await sleep(1500);

  // ---- 3. protection: a response, then a draft, block the suspension -------------------------------------------------------------------
  const protect = async (label, on, off, reason) => {
    pick(A[0]); await sleep(300);
    await on(pages.A2);
    const seen = await waitFor(() => { const id = viewIdOf(A[1]); return id && lc.describe(id).reasons.includes(reason); }, 25000, 250);
    const r = await lc.suspend({ viewId: viewIdOf(A[1]) });
    check(`${label}: refused and the page is still alive`, seen && r.ok === false && r.error.reasons.includes(reason) && !pages.A2.isDestroyed(), JSON.stringify([seen, r.ok, r.error && r.error.reasons]));
    await off(pages.A2);
  };
  await protect('a response in progress', respondingOn, respondingOff, 'responding');
  await protect('an unsent draft', (wc) => draftSet(wc, true), (wc) => draftSet(wc, false), 'draft');
  check('every page still alive after the refusals', chatPages().length === 11);
  // The response that ended while A2 was hidden left attention pending: that alone blocks the suspension until the user visits it.
  const attentionSeen = await waitFor(() => { const id = viewIdOf(A[1]); return id && lc.describe(id).reasons.includes('attention'); }, 25000, 250);
  const rAtt = await lc.suspend({ viewId: viewIdOf(A[1]) });
  check('activity that ended unseen (attention pending) blocks the suspension, and the refusal does not clear it', attentionSeen && !rAtt.ok && rAtt.error.reasons.includes('attention') && tab(A[1]).activity && tab(A[1]).activity.attention === true, JSON.stringify([attentionSeen, rAtt.ok]));
  pick(A[1]); await sleep(600);                                    // a visit: the user looks at it
  pick(A[0]); await sleep(300);

  // ---- 4. suspension: memory before / after, release time ---------------------------------------------------------------------------------
  pick(A[0]);
  for (const b of [A[1], A[2], A[3], A[4], A[5]]) await eligible(b);
  const eligibleNow = [A[1], A[2], A[3], A[4], A[5]].filter((b) => lc.describe(viewIdOf(b)).eligible).length;
  check('idle, observed, draft-free background conversations become eligible (5 of 5)', eligibleNow === 5, eligibleNow);
  const before = await sample('before-suspending-5-of-10');
  const releases = [];
  for (const [i, b] of [A[1], A[2], A[3], A[4], A[5]].entries()) {
    const wc = pages[`A${i + 2}`];
    const t0 = process.hrtime.bigint();
    const r = await lc.suspend({ viewId: viewIdOf(b) });
    const gone = await waitFor(() => wc.isDestroyed(), 5000, 5);
    releases.push({ binding: b.label, ok: r.ok, judgeMs: r.ok ? r.timings.judgeMs : null, releaseMs: r.ok ? r.timings.releaseMs : null, untilDestroyedMs: gone ? round(Number(process.hrtime.bigint() - t0) / 1e6) : null });
  }
  report.steps.releases = releases;
  check('the 5 eligible conversations were suspended', releases.every((r) => r.ok), JSON.stringify(releases));
  check('their pages are destroyed (renderer closed)', releases.every((r) => r.untilDestroyedMs !== null));
  check('ChatGPT pages: 11 -> 6; observers follow', chatPages().length === 6 && win.getObservationStats().observers === 6, `${chatPages().length} ${JSON.stringify(win.getObservationStats())}`);
  const tabsAfter = nav.getState().tabs;
  check('suspended conversations stay in the strip, marked suspended, with no status claimed', [1, 2, 3, 4, 5].every((i) => tabsAfter[i].suspended && tabsAfter[i].activity === null && !tabsAfter[i].loaded));
  check('bindings file is byte-identical after suspending', fs.readFileSync(bindFile, 'utf8') === bindingsBefore);
  await sample('after-suspending-+0s', 1500);
  await sleep(2000);
  const after3 = await sample('after-suspending-+3s', 1500);
  await sleep(7000);
  const after10 = await sample('after-suspending-+10s', 3000);
  report.steps.suspendDelta = {
    viewHostsMB: { before: before.viewHostsMB, after3s: after3.viewHostsMB, after10s: after10.viewHostsMB },
    allMB: { before: before.allMB, after3s: after3.allMB, after10s: after10.allMB },
    processes: { before: before.processes, after10s: after10.processes },
    note: 'working set per process summed over distinct processes; shared pages are counted in each process, so read only the deltas'
  };

  // ---- 5. at rest: no pushes to the UI, no polling of suspended pages ----------------------------------------------------------------------
  await sleep(1500);
  const n0 = sent.nav; const c0 = sent.chats;
  const stats0 = win.getObservationStats();
  await sample('at-rest-with-suspended-conversations', 12000);
  report.steps.atRest = { navPushes: sent.nav - n0, chatsPushes: sent.chats - c0, observers: win.getObservationStats().observers, polls: win.getObservationStats().polls - stats0.polls };
  check('nothing is pushed to the UI while at rest (12 s)', sent.nav - n0 === 0 && sent.chats - c0 === 0, JSON.stringify(report.steps.atRest));
  check('suspended conversations are not polled (observers = live pages)', win.getObservationStats().observers === chatPages().length);

  // ---- 6. restoration -----------------------------------------------------------------------------------------------------------------------
  const pagesBefore = chatPages().length;
  const tR = process.hrtime.bigint();
  const rr = pick(A[1]);
  const wasLoading = tab(A[1]) ? tab(A[1]).loading : null;
  pick(A[1]); pick(A[1]);                                          // repeated requests: still one page
  await settled(pagesBefore + 1);
  const restoreMsWall = Number(process.hrtime.bigint() - tR) / 1e6 - 800;
  check('selecting a suspended conversation restores it (one new page, never two)', rr.ok && chatPages().length === pagesBefore + 1, `${rr.ok} ${pagesBefore} -> ${chatPages().length}`);
  check('the restored conversation showed a loading state', wasLoading === true, wasLoading);
  const restored = lc.inventory().find((r) => r.bindingId === A[1].bindingId);
  pages.A2 = win.getChat().contents;
  await bePage(pages.A2, 2);
  await sleep(700);
  report.steps.restore = { wallMs: Math.round(restoreMsWall), managerRestoreMs: restored ? restored.restoreMs : null, stateAfter: tab(A[1]) };
  check('restored: relation match, one view for the conversation, observer running again', tab(A[1]).relation === 'match' && nav._debugViews().filter((v) => v.expectedKey === `c:${uuid(2)}`).length === 1 && win.getObservationStats().observers === chatPages().length, JSON.stringify(tab(A[1])));
  check('restoring sent no Herdr command', calls.focus === 0, calls.focus);
  check('bindings file is still byte-identical', fs.readFileSync(bindFile, 'utf8') === bindingsBefore);

  // ---- 7. a residual page --------------------------------------------------------------------------------------------------------------------
  pick(A[0]); await sleep(300);
  const target = A[7];
  const targetKey = `c:${uuid(8)}`;
  bindings.unbind({ bindingId: target.bindingId });
  nav.releaseConversation(targetKey);
  nav.reconcile();
  const residualRow = () => lc.inventory().find((r) => r.kind === 'residual' && r.identity === 'durable');
  const residualId = residualRow() && residualRow().viewId;
  check('an unbound conversation\'s page remains as a residual page, reported by the inventory', Boolean(residualId));
  await waitFor(() => lc.describe(residualId) && lc.describe(residualId).eligible, 45000, 250);
  const rs = await lc.suspend({ viewId: residualId });
  check('an eligible residual page can be suspended and stays listed as suspended', rs.ok && nav.getUnbound().some((u) => u.viewId === residualId && u.suspended), JSON.stringify(rs));
  const opened = nav.openUnbound({ viewId: residualId });
  await settled(chatPages().length);
  check('opening it from the list restores it', opened.ok && nav.getUnbound().every((u) => !u.suspended), JSON.stringify(opened));

  // ---- 8. another workspace ------------------------------------------------------------------------------------------------------------------
  sel.selected = { workspaceId: 'w2', origin: 'dock' }; fire();
  pick(B[0]); await settled(chatPages().length + 1); pages.B1 = win.getChat().contents; await bePage(pages.B1, 21);
  pick(B[1]); await settled(chatPages().length + 1); pages.B2 = win.getChat().contents; await bePage(pages.B2, 22);
  await eligible(B[0]);
  const rb = await lc.suspend({ viewId: viewIdOf(B[0]) });
  check('a conversation of another workspace can be suspended while that workspace is selected', rb.ok, JSON.stringify(rb));
  sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();
  await waitFor(() => !chatPages().some((w) => w.getURL().endsWith('000000000021')), 4000, 50);   // closing a page is asynchronous
  const restoredByItself = webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith('https://chatgpt.com')).map((w) => w.getURL().slice(-12));
  const b1Tab = nav.getState().tabs.find((t) => t.bindingId === B[0].bindingId);
  check('switching workspace never restores a suspended conversation by itself', !restoredByItself.some((u) => u.endsWith('000000000021')) && !lc.inventory().some((r) => r.bindingId === B[0].bindingId && r.state !== 'suspended'), JSON.stringify({ restoredByItself, b1: lc.inventory().filter((r) => r.bindingId === B[0].bindingId), tabsInW1: nav.getState().tabs.length, b1Tab }));
  sel.selected = { workspaceId: 'w2', origin: 'dock' }; fire();
  pick(B[0], {}); await settled(chatPages().length + 1);
  check('and selecting it in its own workspace restores it', tab(B[0]) && tab(B[0]).loaded && !tab(B[0]).suspended);
  sel.selected = { workspaceId: 'w1', origin: 'dock' }; fire();

  // ---- 9. shutdown -------------------------------------------------------------------------------------------------------------------------------
  report.steps.finalSummary = lc.summary();
  const pagesNow = chatPages().length;
  win.getWindow().destroy();
  await sleep(1500);
  report.steps.shutdown = { before: pagesNow, after: chatPages().length };
  check('closing the window closes every ChatGPT view', chatPages().length === 0, JSON.stringify(report.steps.shutdown));
  check('no Herdr focus command was sent by any step', calls.focus === 0);
  report.errors = report.errors.filter((e) => !/Autofill|UnknownVizError/.test(e));
  const failed = report.checks.filter((c) => !c.ok).length;
  finishWith(report.errors.length || failed ? 1 : report.checks.length < EXPECTED_MIN_CHECKS ? 2 : 0);
});
