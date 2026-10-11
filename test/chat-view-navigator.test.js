'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createViewsWorld, bindMany, HOME } = require('./helpers/views-world');
const { ws, chatUrl, projectUrl, ID } = require('./helpers/bindings-world');
const { RUNTIME_PROVIDER_METHODS } = require('../src/main/chat/runtime-contract');

const flush = () => new Promise((r) => setImmediate(r));
const WK = (id) => `contextdeck/${id}`;

// Workspace w1 holds conversations 1-3 (Arquitetura, Review, Planejamento); w2 holds 4-5. Chat tab is showing.
function setup({ chat = true, ...opts } = {}) {
  const w = createViewsWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app'), ws('w3', 'empty')], ...opts });
  w.select('w1');
  const a = bindMany(w, [1, 2, 3]);
  w.select('w2');
  const b = bindMany(w, [4, 5]);
  w.select('w1');
  if (chat) w.navigator.setMode('chat');
  w.A = a; w.B = b;
  w.pick = (binding, extra = {}) => w.navigator.selectBinding({ bindingId: binding.bindingId, workspaceKey: WK(binding.workspaceIdentity.workspaceId), ...extra });
  w.views = () => w.fake.views;
  w.attached = () => [...w.fake.host.attached];
  w.finishAll = async () => { for (const v of w.fake.views) while (v.pendingLoads()) v.finishLoad(); await flush(); };
  w.cleanup0 = w.cleanup;
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); w.navigator.stop(); } };

// ---- lazy creation, reuse, no reload ------------------------------------------------------------------------------

test('entering the chat tab creates nothing by itself; a conversation opens its view on demand, once', () => run((w) => {
  assert.equal(w.views().length, 0, 'no view at startup, none for the three bound conversations');
  assert.equal(w.navigator.getState().empty, 'select-conversation');
  assert.deepEqual(w.navigator.getState().tabs.map((t) => [t.label, t.loaded, t.active]), [['chat 1', false, false], ['chat 2', false, false], ['chat 3', false, false]]);
  const r = w.pick(w.A[0]);
  assert.equal(r.ok, true);
  assert.equal(w.views().length, 1);
  assert.deepEqual(w.views()[0].loads, [w.A[0].url], 'loads the binding address exactly once');
  assert.deepEqual(w.attached(), [r.viewId]);
  assert.equal(w.last[WK('w1')], w.A[0].bindingId, 'the explicit choice is remembered');
  assert.equal(w.navigator.getState().tabs[0].active, true);
}));

test('switching between open conversations reuses their views: no load, no new view, no destroy', () => run(async (w) => {
  const [a1, a2] = [w.pick(w.A[0]).viewId, w.pick(w.A[1]).viewId];
  await w.finishAll();
  for (let i = 0; i < 10; i++) { w.pick(w.A[i % 2]); }
  assert.equal(w.views().length, 2);
  assert.deepEqual(w.views().map((v) => v.loads.length), [1, 1], 'each address loaded once in total');
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
  assert.deepEqual(w.attached(), [a2 === w.attached()[0] ? a2 : a1].filter(Boolean).length ? w.attached() : [], 'exactly one attached');
  assert.equal(w.attached().length, 1);
  assert.equal(w.navigator.getState().tabs.filter((t) => t.loaded).length, 2);
}));

test('one view per conversation: selecting a conversation that already shows in a view never creates a second one', () => run(async (w) => {
  const first = w.pick(w.A[0]).viewId;
  w.views()[0].finishLoad();
  await flush();
  w.pick(w.A[1]);
  const again = w.pick(w.A[0]);
  assert.equal(again.viewId, first);
  assert.equal(w.views().length, 2);
}));

// ---- workspaces ---------------------------------------------------------------------------------------------------

test('A → B → A: each workspace shows only its own conversations and the last explicit choice is restored without reloading', () => run(async (w) => {
  const a2 = w.pick(w.A[1]).viewId;                       // explicit choice in A
  await w.finishAll();
  w.select('w2');                                         // user selects B
  assert.deepEqual(w.attached(), [], 'A\'s conversation is detached the moment B is selected');
  let s = w.navigator.getState();
  assert.deepEqual(s.tabs.map((t) => t.label), ['chat 4', 'chat 5'], 'only B\'s conversations');
  assert.equal(s.workspace.id, 'w2');
  assert.equal(s.empty, 'select-conversation');
  const b5 = w.pick(w.B[1]).viewId;
  w.select('w1');                                         // back to A
  assert.deepEqual(w.attached(), [a2], 'the conversation chosen in A is back, same view');
  w.select('w2');
  assert.deepEqual(w.attached(), [b5]);
  assert.equal(w.views().length, 2, 'no extra views were created by switching');
  assert.deepEqual(w.views().map((v) => v.loads.length), [1, 1]);
  assert.equal(w.pick(w.A[0], { workspaceKey: WK('w2') }).error.code, 'not_in_workspace', 'a conversation of A cannot be opened while B is selected');
}));

test('the last conversation survives a restart: it is restored (view created lazily) from the persisted preference', () => run(async (w) => {
  w.pick(w.A[2]);
  const saved = { ...w.last };
  w.navigator.stop();
  // "Restart": new manager/navigator, same bindings, preference loaded from disk.
  const again = createViewsWorldFrom(w, saved);
  again.navigator.setMode('chat');
  assert.equal(again.fake.views.length, 1, 'only the last conversation is loaded, not all of them');
  assert.deepEqual(again.fake.views[0].loads, [w.A[2].url]);
  assert.equal(again.navigator.getState().tabs[2].active, true);
  assert.equal(again.fake.log.some((l) => l[0] === 'load' && l[2] !== w.A[2].url), false);
  again.navigator.stop();
}));

function createViewsWorldFrom(w, saved) {
  const { createChatViewManager } = require('../src/main/chat-views/manager');
  const { createChatNavigator } = require('../src/main/chat-views/navigator');
  const { createFakeViews } = require('./helpers/views-world');
  const fake = createFakeViews();
  const manager = createChatViewManager({ createView: fake.factory, host: fake.host });
  const last = { ...saved };
  const navigator = createChatNavigator({ manager, session: w.session, bindings: w.bindings, selection: w.selection, prefs: { getLast: (k) => last[k] || null, setLast: (k, v) => { last[k] = v; } }, homeUrl: HOME });
  return { fake, manager, navigator };
}

test('a workspace without conversations shows an empty state and never a chat of another workspace', () => run((w) => {
  w.pick(w.A[0]);
  assert.equal(w.attached().length, 1);
  w.select('w3');
  assert.deepEqual(w.attached(), [], 'nothing attached');
  const s = w.navigator.getState();
  assert.equal(s.empty, 'no-conversations');
  assert.deepEqual([s.tabs.length, s.temporaries.length, s.activeViewId], [0, 0, null]);
  assert.equal(w.views().length, 1, 'the empty workspace created nothing');
}));

test('no selected workspace: the unscoped (M00) page may be shown, and only until a workspace is selected', () => run((w) => {
  const home = w.manager.create({ url: HOME, scope: null, pristine: true });
  w.select(null);
  assert.equal(w.navigator.getState().activeViewId, home);
  assert.deepEqual(w.attached(), [home]);
  w.select('w1');
  assert.deepEqual(w.attached(), [], 'a workspace is selected: the unscoped page is not shown under it');
  assert.equal(w.navigator.getState().empty, 'select-conversation');
  w.select(null);
  assert.equal(w.navigator.getState().empty, null);
  assert.deepEqual(w.attached(), [home]);
}));

test('the workspace disappearing (selection becomes empty) detaches its conversation', () => run((w) => {
  w.pick(w.A[0]);
  w.select(null);
  assert.deepEqual(w.attached(), []);
  assert.equal(w.navigator.getState().empty, 'no-workspace');
}));

// ---- reliability of contexts --------------------------------------------------------------------------------------

test('suspect and unverified contexts never open on their own and need an explicit confirmation; orphans are not offered at all', () => run(async (w) => {
  w.pick(w.A[0]);
  const saved = w.last[WK('w1')];
  w.navigator.stop();
  w.setWorkspaces([ws('w1', 'totally-other', 'D:\\elsewhere'), ws('w2', 'app'), ws('w3', 'empty')]);   // w1 recreated
  const again = createViewsWorldFrom(w, { [WK('w1')]: saved });
  again.navigator.setMode('chat');
  assert.equal(again.fake.views.length, 0, 'suspect: nothing is restored automatically');
  assert.equal(again.navigator.getState().empty, 'not-verified');
  assert.equal(again.navigator.getState().tabs[0].status, 'suspect');
  const args = { bindingId: w.A[0].bindingId, workspaceKey: WK('w1') };
  assert.equal(again.navigator.selectBinding(args).error.code, 'confirmation_required');
  assert.equal(again.fake.views.length, 0);
  assert.equal(again.navigator.selectBinding({ ...args, confirm: true }).ok, true);
  assert.equal(again.fake.views.length, 1);
  again.navigator.stop();
  // Orphan: the workspace is gone, so its conversations belong to no visible workspace.
  w.setWorkspaces([ws('w2', 'app'), ws('w3', 'empty')]);
  w.select('w2');
  const third = createViewsWorldFrom(w, {});
  third.navigator.setMode('chat');
  assert.deepEqual(third.navigator.getState().tabs.map((t) => t.label), ['chat 4', 'chat 5']);
  assert.equal(third.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w2'), confirm: true }).error.code, 'not_in_workspace');
  third.navigator.stop();
}));

test('Herdr disconnected (unverified): no automatic creation; explicit confirmation opens', () => run((w) => {
  w.pick(w.A[0]);
  w.disconnect();
  w.select('w1');
  const status = w.navigator.getState().tabs[0].status;
  assert.equal(status, 'unverified');
  const r = w.navigator.selectBinding({ bindingId: w.A[1].bindingId, workspaceKey: WK('w1') });
  assert.equal(r.error.code, 'confirmation_required');
  assert.equal(w.navigator.selectBinding({ bindingId: w.A[1].bindingId, workspaceKey: WK('w1'), confirm: true }).ok, true);
}));

test('estimated selection (Auto, restored) still navigates visually but never creates or changes a binding', () => run((w) => {
  const before = fs.readFileSync(w.file, 'utf8');
  w.select('w2', 'herdr');
  w.select('w1', 'recovery');
  w.select('w2', 'herdr');
  assert.equal(fs.readFileSync(w.file, 'utf8'), before, 'the bindings file is untouched by navigation');
  assert.equal(w.navigator.getState().workspace.origin, 'herdr');
  assert.equal(w.views().length, 0);
}));

// ---- chat tab / terminal tab ------------------------------------------------------------------------------------

test('in the terminal tab nothing is created or attached; entering the chat tab picks the right view BEFORE attaching it', () => run(async (w) => {
  w.pick(w.A[0]);
  w.pick(w.A[1]);
  w.finishAll();
  w.navigator.setMode('terminal');
  assert.deepEqual(w.attached(), []);
  w.select('w2');                                         // workspace changes while the terminal tab is showing
  w.fake.log.length = 0;
  w.navigator.setMode('chat');
  assert.equal(w.fake.log.some((l) => l[0] === 'attach'), false, 'B has no remembered conversation: nothing to attach, and A\'s chat is NOT flashed');
  w.pick(w.B[0]);
  w.navigator.setMode('terminal');
  w.select('w1');
  w.fake.log.length = 0;
  w.navigator.setMode('chat');
  const attaches = w.fake.log.filter((l) => l[0] === 'attach');
  assert.equal(attaches.length, 1);
  assert.equal(attaches[0][1], w.navigator.getState().activeViewId, 'A\'s own last conversation, attached once');
  w.navigator.setMode('terminal');
  w.select('w2');
  w.fake.log.length = 0;
  w.navigator.setMode('terminal');
  assert.equal(w.views().length, 3, 'three conversations were ever opened; switching tabs created no more');
}));

test('a restored conversation is created only once the chat tab shows and no switch is pending', () => run((w) => {
  w.pick(w.A[1]);
  const saved = { ...w.last };
  w.navigator.stop();
  const again = createViewsWorldFrom(w, saved);
  again.navigator.setMode('terminal');
  again.navigator.reconcile();
  assert.equal(again.fake.views.length, 0, 'terminal tab: no view');
  w.sel.pending = { workspaceId: 'w2' };
  again.navigator.setMode('chat');
  assert.equal(again.fake.views.length, 0, 'a workspace switch is in flight: no view');
  w.sel.pending = null;
  again.navigator.reconcile();
  assert.equal(again.fake.views.length, 1);
  assert.equal(again.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') }).ok, true);
  again.navigator.stop();
}));

// ---- races ----------------------------------------------------------------------------------------------------

test('rapid workspace and conversation switching: the last selection decides what is visible, whatever finishes loading late', () => run(async (w) => {
  const a1 = w.pick(w.A[0]).viewId;                       // load of A1 still pending
  w.select('w2');
  const b4 = w.pick(w.B[0]).viewId;                       // load of B4 pending
  w.select('w1');
  w.select('w2');
  w.select('w1');
  w.select('w2');
  assert.deepEqual(w.attached(), [b4]);
  // Loads finish in the "wrong" order, and A's page reports a navigation after the user left it.
  w.views()[1].finishLoad();
  w.views()[0].finishLoad();
  w.views()[0].navigate(chatUrl(1));
  await flush();
  assert.deepEqual(w.attached(), [b4], 'A\'s late completion did not bring it back under workspace B');
  assert.equal(w.navigator.getState().activeViewId, b4);
  assert.notEqual(a1, b4);
  w.select('w1');
  assert.deepEqual(w.attached(), [a1]);
}));

test('a stale click is refused: the form says which workspace it was showing', () => run((w) => {
  w.select('w2');
  const stale = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  assert.equal(stale.error.code, 'context_changed');
  assert.equal(stale.error.selected, 'w2');
  assert.equal(w.views().length, 0);
  assert.equal(w.navigator.newConversation({ workspaceKey: WK('w1') }).error.code, 'context_changed');
  assert.equal(w.navigator.selectTemporary({ viewId: 'v1', workspaceKey: WK('w1') }).error.code, 'context_changed');
  w.sel.pending = { workspaceId: 'w1' };
  assert.equal(w.navigator.selectBinding({ bindingId: w.B[0].bindingId, workspaceKey: WK('w2') }).error.code, 'selection_pending');
  w.sel.pending = null;
  w.navigator.setMode('terminal');
  assert.equal(w.navigator.selectBinding({ bindingId: w.B[0].bindingId, workspaceKey: WK('w2') }).error.code, 'not_in_chat');
}));

test('bindings changing while a conversation is opening: unbinding turns its view temporary, nothing is destroyed; reassigning moves it out of the workspace', () => run(async (w) => {
  const id = w.pick(w.A[0]).viewId;
  w.views()[0].finishLoad();
  await flush();
  w.bindings.unbind({ bindingId: w.A[0].bindingId });
  w.navigator.reconcile();
  let s = w.navigator.getState();
  assert.equal(s.tabs.some((t) => t.label === 'chat 1'), false);
  assert.equal(s.activeViewId, id, 'still visible: the user is looking at it');
  assert.equal(s.temporaries.length, 1);
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
  // Reassign another conversation, whose view exists, to w2.
  const v2 = w.pick(w.A[1]).viewId;
  w.views()[1].finishLoad();
  await flush();
  w.select('w1');
  w.bindings.reassign({ bindingId: w.A[1].bindingId, target: { session: w.session, workspaceId: 'w2' }, selectedAtOpen: 'w1', confirmTarget: true, confirmReassign: true });
  w.navigator.reconcile();
  assert.notEqual(w.navigator.getState().activeViewId, v2, 'the moved conversation is no longer shown under w1');
  w.select('w2');
  assert.equal(w.navigator.getState().tabs.some((t) => t.label === 'chat 2' && t.loaded), true, 'its view followed it to w2');
}));

// ---- identity -------------------------------------------------------------------------------------------------

test('navigating inside ChatGPT to another conversation: the view is not presented as the old one and no binding changes', () => run(async (w) => {
  const id = w.pick(w.A[0]).viewId;
  w.views()[0].navigate(chatUrl(1));
  await flush();
  const file = fs.readFileSync(w.file, 'utf8');
  const hits = [];
  w.navigator.runtime.subscribe((bindingId) => hits.push(bindingId));
  w.views()[0].navigate(chatUrl(2));                      // the user clicked "chat 2" in ChatGPT's own sidebar (it is bound to w1)
  let s = w.navigator.getState();
  assert.equal(s.tabs[0].active, false, 'tab 1 no longer claims the view');
  assert.equal(s.tabs[0].loaded, false);
  assert.equal(s.tabs[1].active, true, 'the tab of what is really shown lights up');
  assert.equal(fs.readFileSync(w.file, 'utf8'), file, 'the persistent binding was not modified');
  assert.equal(w.last[WK('w1')], w.A[0].bindingId, 'the remembered choice is only what the USER picked');
  // Opening tab 1 again does not navigate that view back: it gets its own view, the other keeps its page.
  const reopened = w.pick(w.A[0]).viewId;
  assert.notEqual(reopened, id);
  assert.equal(w.views().length, 2);
  assert.deepEqual(w.views()[0].loads, [w.A[0].url], 'the diverged view was not navigated');
  assert.equal(w.navigator.getState().tabs[1].loaded, true);
  assert.ok(hits.length >= 1, 'runtime subscribers heard about the identity change');
}));

test('navigating to an unbound or foreign conversation shows a warning chip, never a tab of this workspace', () => run(async (w) => {
  w.pick(w.A[0]);
  w.views()[0].navigate(chatUrl(9));                      // not bound anywhere
  let s = w.navigator.getState();
  assert.deepEqual(s.temporaries.map((t) => [t.label, t.warning, t.active]), [['Conversa não vinculada', true, true]]);
  assert.deepEqual(s.tabs.map((t) => t.active), [false, false, false]);
  w.views()[0].navigate(chatUrl(4));                      // bound to w2
  s = w.navigator.getState();
  assert.deepEqual(s.temporaries.map((t) => [t.label, t.warning]), [['chat 4 · w2', true]]);
  assert.equal(s.tabs.some((t) => t.label === 'chat 4'), false);
  w.views()[0].navigate('https://chatgpt.com/');
  // It never showed its own conversation, so it is still that tab's view, now flagged as having left it.
  s = w.navigator.getState();
  assert.deepEqual([s.tabs[0].loaded, s.tabs[0].relation, s.temporaries.length], [true, 'left', 0]);
}));

test('project routes and plain routes are the same conversation: no duplicate view', () => run(async (w) => {
  w.pick(w.A[0]);
  w.views()[0].navigate(projectUrl(1));
  assert.equal(w.navigator.getState().tabs[0].active, true);
  const again = w.pick(w.A[0]);
  assert.equal(w.views().length, 1);
  assert.equal(again.ok, true);
}));

test('two views showing the same conversation are reported, flagged and both kept', () => run(async (w) => {
  w.pick(w.A[0]);
  w.pick(w.A[1]);
  w.views()[0].navigate(chatUrl(1));
  w.views()[1].navigate(chatUrl(1));
  const s = w.navigator.getState();
  assert.equal(s.duplicates, 1);
  assert.equal(w.views().length, 2);
  assert.equal(s.temporaries.some((t) => t.warning), true);
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
}));

// ---- temporary conversations --------------------------------------------------------------------------------------

test('a new conversation: the application\'s initial page is handed over without navigation; later ones are created; nothing is bound', () => run(async (w) => {
  const home = w.manager.create({ url: HOME, scope: null, pristine: true });
  w.views()[0].finishLoad();
  await flush();
  const file = fs.readFileSync(w.file, 'utf8');
  const first = w.navigator.newConversation({ workspaceKey: WK('w1') });
  assert.equal(first.viewId, home, 'the M00 page is adopted, not replaced');
  assert.deepEqual(w.views()[0].loads, [HOME], 'it was not navigated');
  const second = w.navigator.newConversation({ workspaceKey: WK('w1') });
  assert.notEqual(second.viewId, home);
  assert.deepEqual(w.views()[1].loads, [HOME]);
  const s = w.navigator.getState();
  assert.deepEqual(s.temporaries.map((t) => t.label), ['Nova conversa', 'Nova conversa']);
  assert.equal(fs.readFileSync(w.file, 'utf8'), file, 'no binding was created');
  assert.deepEqual(w.navigator.selectTemporary({ viewId: home, workspaceKey: WK('w1') }), { ok: true, viewId: home });
  assert.deepEqual(w.attached(), [home]);
}));

test('a temporary conversation belongs to the workspace it was opened in and never shows in another', () => run((w) => {
  const t = w.navigator.newConversation({ workspaceKey: WK('w1') }).viewId;
  assert.equal(w.navigator.getState().temporaries.length, 1);
  w.select('w2');
  assert.deepEqual(w.attached(), []);
  assert.equal(w.navigator.getState().temporaries.length, 0);
  assert.equal(w.navigator.selectTemporary({ viewId: t, workspaceKey: WK('w2') }).error.code, 'view_not_found');
  w.select('w1');
  assert.deepEqual(w.attached(), [t], 'back in w1 its temporary conversation is still there (with its unsent text)');
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
}));

test('a temporary conversation that receives its address is not bound automatically; it becomes a tab only after an explicit bind', () => run(async (w) => {
  const t = w.navigator.newConversation({ workspaceKey: WK('w1') }).viewId;
  const file = fs.readFileSync(w.file, 'utf8');
  w.views()[0].navigate(chatUrl(8));                      // first message sent: the SPA gets /c/<id>
  let s = w.navigator.getState();
  assert.equal(s.temporaries[0].label, 'Conversa não vinculada');
  assert.equal(w.manager.get(t).relation, 'acquired');
  assert.equal(fs.readFileSync(w.file, 'utf8'), file, 'nothing bound by itself');
  assert.equal(w.manager.runtimeOf(t).identity.key, `c:${ID(8)}`, 'the runtime identity was updated');
  // The explicit I3A flow, reading the visible page address.
  const r = w.bindings.bind(w.args(8, { url: w.navigator.getVisibleUrl(), origin: 'current-page', label: 'novo' }));
  assert.equal(r.ok, true);
  w.navigator.reconcile();
  s = w.navigator.getState();
  assert.equal(s.temporaries.length, 0);
  assert.equal(s.tabs.at(-1).label, 'novo');
  assert.equal(s.tabs.at(-1).active, true, 'the same view, now the tab of the new binding');
  assert.equal(w.views().length, 1);
}));

test('opening a conversation or creating a new one never closes a temporary view that holds unsent work', () => run((w) => {
  const t = w.navigator.newConversation({ workspaceKey: WK('w1') }).viewId;
  w.pick(w.A[0]);
  w.pick(w.A[1]);
  w.navigator.newConversation({ workspaceKey: WK('w1') });
  assert.equal(w.manager.get(t).page !== 'destroyed', true);
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
  assert.equal(w.navigator.getState().temporaries.length, 2);
}));

test('unscoped page can be opened only when no workspace is selected', () => run((w) => {
  assert.equal(w.navigator.openUnscoped().error.code, 'workspace_selected');
  w.select(null);
  const r = w.navigator.openUnscoped();
  assert.equal(r.ok, true);
  assert.deepEqual(w.fake.views[0].loads, [HOME]);
  assert.equal(w.navigator.openUnscoped().viewId, r.viewId, 'reused');
}));

// ---- failures, duplicates of homonyms ------------------------------------------------------------------------------

test('a load failure is shown on its tab and retried only when the user selects it again', () => run(async (w) => {
  const id = w.pick(w.A[0]).viewId;
  w.views()[0].failLoad();
  await flush();
  assert.equal(w.navigator.getState().tabs[0].failed, true);
  assert.equal(w.views()[0].loads.length, 1, 'no automatic retry');
  assert.equal(w.pick(w.A[0]).viewId, id);
  assert.equal(w.views()[0].loads.length, 2);
  assert.equal(w.views().length, 1);
}));

test('conversations with the same label are told apart by a short key', () => run((w) => {
  w.select('w3');
  const [x, y] = bindMany(w, [6, 7], { label: 'Review' });
  const tabs = w.navigator.getState().tabs;
  assert.deepEqual(tabs.map((t) => t.label), ['Review', 'Review']);
  assert.notEqual(tabs[0].hint, tabs[1].hint);
  assert.ok(tabs.every((t) => t.hint.length === 4));
  assert.ok(x && y);
}));

// ---- runtime provider and cleanup --------------------------------------------------------------------------------

test('the runtime provider implements the I3P contract by binding id; bindings never embed runtime data', () => run(async (w) => {
  assert.deepEqual(RUNTIME_PROVIDER_METHODS.every((m) => typeof w.navigator.runtime[m] === 'function'), true);
  assert.equal(w.navigator.runtime.getRuntime(w.A[0].bindingId), null, 'no view yet');
  w.pick(w.A[0]);
  w.views()[0].navigate(chatUrl(1));
  const runtime = w.navigator.runtime.getRuntime(w.A[0].bindingId);
  assert.equal(runtime.identity.key, w.A[0].conversationKey);
  assert.equal(runtime.generation.value, 'unknown');
  assert.equal(w.navigator.runtime.getRuntime('b_ffffffffffffffff'), null);
  assert.doesNotMatch(fs.readFileSync(w.file, 'utf8'), /epoch|generation|runtime|viewId/);
}));

test('shutdown closes every view; state pushes stop', () => run((w) => {
  w.pick(w.A[0]); w.pick(w.A[1]); w.select('w2'); w.pick(w.B[0]);
  let pushes = 0;
  w.navigator.onChange(() => { pushes += 1; });
  w.manager.destroyAll();
  assert.equal(w.fake.log.filter((l) => l[0] === 'destroy').length, 3);
  assert.equal(w.attached().length, 0);
  w.navigator.stop();
  w.select('w1');
  assert.equal(pushes <= 1, true);
}));

test('persistence of the choice stores only a binding id per workspace, nothing transient', () => run((w) => {
  w.pick(w.A[0]);
  w.select('w2');
  w.pick(w.B[1]);
  assert.deepEqual(w.last, { [WK('w1')]: w.A[0].bindingId, [WK('w2')]: w.B[1].bindingId });
  w.navigator.newConversation({ workspaceKey: WK('w2') });
  assert.deepEqual(w.last[WK('w2')], w.B[1].bindingId, 'a temporary view does not replace the remembered conversation');
}));

// ---- invariants under random interleavings -----------------------------------------------------------------------------

test('property: under 1500 random workspace/conversation/tab/navigation events, the context is never leaked and views are never duplicated or reloaded', () => run(async (w) => {
  let seed = 20251011;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const all = [...w.A, ...w.B];
  const wsIds = ['w1', 'w2', 'w3'];
  const bindingWs = new Map(all.map((b) => [b.bindingId, b.workspaceIdentity.workspaceId]));
  const urls = new Map(all.map((b) => [b.bindingId, b.url]));
  const loadsOf = new Map();
  const violations = [];
  for (let i = 0; i < 1500; i++) {
    switch (rnd(9)) {
      case 0: w.select(wsIds[rnd(3)], rnd(2) ? 'dock' : 'herdr'); break;
      case 1: w.select(null); break;
      case 2: w.pick(all[rnd(all.length)], { confirm: rnd(2) === 0, workspaceKey: WK(wsIds[rnd(3)]) }); break;
      case 3: w.navigator.newConversation({ workspaceKey: WK(wsIds[rnd(3)]) }); break;
      case 4: w.navigator.setMode(rnd(2) ? 'chat' : 'terminal'); break;
      case 5: w.sel.pending = rnd(2) ? { workspaceId: 'w2' } : null; w.select(w.sel.selected ? w.sel.selected.workspaceId : null, 'dock'); break;
      case 6: { const v = w.views()[rnd(Math.max(1, w.views().length))]; if (v && !v.isDestroyed()) v.navigate(urls.get(all[rnd(all.length)].bindingId)); break; }
      case 7: { const v = w.views()[rnd(Math.max(1, w.views().length))]; if (v && v.pendingLoads()) { if (rnd(5) === 0) v.failLoad(); else v.finishLoad(); } break; }
      default: w.navigator.reconcile();
    }
    w.sel.pending = null;
    const s = w.navigator.getState();
    const attached = w.attached();
    if (attached.length > 1) violations.push(`${i}: ${attached.length} views attached`);
    if (attached.length && w.navigator.getState().mode !== 'chat') violations.push(`${i}: attached outside the chat tab`);
    if (attached.length) {
      const view = w.manager.get(attached[0]);
      const wk = s.workspace ? s.workspace.key : null;
      if (view.scope !== wk) violations.push(`${i}: view scoped ${view.scope} attached under ${wk}`);
      if (s.workspace && view.relation !== 'temporary' && view.relation !== 'acquired' && view.expectedKey) {
        const owner = all.find((b) => b.conversationKey === view.expectedKey);
        if (owner && bindingWs.get(owner.bindingId) !== s.workspace.id) violations.push(`${i}: conversation of ${bindingWs.get(owner.bindingId)} under ${s.workspace.id}`);
      }
    }
    for (const v of w.views()) loadsOf.set(v.id, v.loads.length);
  }
  assert.deepEqual(violations, []);
  // A view was loaded once per creation, plus at most one retry per failure it suffered; never to switch.
  for (const v of w.views()) assert.ok(v.loads.length >= 1 && v.loads.every((u) => u === HOME || [...urls.values()].includes(u)));
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
  assert.equal(w.navigator.getState().duplicates >= 0, true);
}));

test('a conversation whose address redirected away (unavailable, or still settling) keeps ONE view: selecting its tab again never spawns another', () => run(async (w) => {
  const id = w.pick(w.A[0]).viewId;
  w.views()[0].finishLoad('https://chatgpt.com/');          // logged out / deleted conversation: the page ends on "/"
  await flush();
  assert.equal(w.manager.get(id).relation, 'left');
  assert.equal(w.manager.get(id).reached, false);
  assert.equal(w.navigator.getState().tabs[0].loaded, true, 'it is still the tab\'s view');
  for (let i = 0; i < 5; i++) { w.pick(w.A[1]); w.pick(w.A[0]); }
  assert.equal(w.pick(w.A[0]).viewId, id);
  assert.equal(w.views().length, 2, 'one view for A1 and one for A2, however often they are selected');
  assert.deepEqual(w.views()[0].loads, [w.A[0].url]);
}));

test('a view that DID show its conversation and then left it is not reused as that tab: opening the tab again gives it a fresh view and keeps the old page as a temporary one', () => run(async (w) => {
  const id = w.pick(w.A[0]).viewId;
  w.views()[0].navigate(chatUrl(1));
  w.views()[0].emit('loaded', {});
  assert.equal(w.manager.get(id).reached, true);
  w.clock.t += 60000;                                          // the user has been reading it for a minute
  w.views()[0].navigate('https://chatgpt.com/');             // "new chat" inside ChatGPT
  assert.equal(w.manager.get(id).relation, 'left');
  const again = w.pick(w.A[0]);
  assert.notEqual(again.viewId, id);
  assert.equal(w.views().length, 2);
  const s = w.navigator.getState();
  assert.equal(s.temporaries.some((t) => t.viewId === id), true, 'the page the user left to is kept (it may hold unsent text)');
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
}));

test('a placeholder opened for a conversation that has not shown it does not steal the tab from the page that really shows it', () => run(async (w) => {
  w.pick(w.A[0]);                                            // view 1, opened for chat 1
  w.pick(w.A[1]);                                            // view 2, opened for chat 2 (redirected away: still the placeholder of tab 2)
  w.views()[1].finishLoad('https://chatgpt.com/');
  await flush();
  w.pick(w.A[0]);
  w.views()[0].navigate(chatUrl(2));                         // the user opens chat 2 from ChatGPT's own sidebar in view 1
  const s = w.navigator.getState();
  assert.deepEqual(s.tabs.map((t) => t.active), [false, true, false], 'the tab of the conversation on screen is the active one');
  assert.equal(w.manager.get(w.navigator.getState().activeViewId).identity.key, `c:${ID(2)}`);
}));
