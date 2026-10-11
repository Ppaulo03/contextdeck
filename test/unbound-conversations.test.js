'use strict';

// M01-I3B-3, block 1: conversations that belong to no workspace ("Sem workspace").
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws, chatUrl } = require('./helpers/bindings-world');
const { createUnboundActions } = require('../src/main/activity/unbound');

const WK = (id) => `contextdeck/${id}`;
const RESPONDING = { stop: true };

// w1 "api" holds conversation 1; w2 "app" holds 4. The initial (pristine) page exists, as in the application.
function setup(opts = {}) {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')], ...opts });
  w.select('w1'); w.A = bindMany(w, [1]);
  w.select('w2'); w.B = bindMany(w, [4]);
  w.select('w1');
  w.pristineId = w.manager.create({ url: w.HOME, scope: null, pristine: true });
  w.navigator.setMode('chat');
  w.shown = [];
  const actions = createUnboundActions({
    session: w.session, bindings: w.bindings, navigator: w.navigator,
    showChatTab: () => { w.navigator.setMode('chat'); }, getMode: () => 'chat'
  });
  w.actions = actions;
  w.set = (view, signals) => Object.assign(view.contents.signals, signals);
  w.viewOf = (id) => w.fake.views.find((v) => v.id === id);
  // A conversation opened with no workspace: a blank page that later navigates to conversation `n`.
  w.openUnbound = async (n) => {
    const r = w.actions.create();
    assert.equal(r.ok, true);
    const view = w.viewOf(r.viewId);
    if (n) { view.finishLoad(chatUrl(n)); } else view.finishLoad(w.HOME);
    await w.clock.advance(6000);
    return view;
  };
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); } };

test('an unbound conversation is listed globally, with its states, whatever workspace or tab is selected', () => run(async (w) => {
  const v = await w.openUnbound(9);
  w.set(v, RESPONDING);
  await w.clock.advance(6000);
  w.navigator.setMode('terminal');
  w.select('w2');
  const g = w.navigator.getGlobalActivity();
  assert.equal(g.unbound.length, 1);
  assert.deepEqual([g.unbound[0].label, g.unbound[0].identity, g.unbound[0].responding, g.unbound[0].bindable], ['Conversa avulsa', 'durable', true, true]);
  assert.deepEqual(g.groups, [], 'it is not attributed to any workspace group');
  assert.equal(g.totals.responding, 1, 'it still counts in the global totals');
}));

test('an idle unbound conversation stays in the list: leaving the workspace, the tab or becoming idle removes nothing', () => run(async (w) => {
  const v = await w.openUnbound(9);
  w.set(v, { stop: false });
  await w.clock.advance(20000);
  w.select('w2'); w.select('w1'); w.navigator.setMode('terminal'); w.navigator.setMode('chat');
  const u = w.navigator.getUnbound();
  assert.equal(u.length, 1);
  assert.deepEqual([u[0].responding, u[0].attention, u[0].draft], [false, false, false]);
}));

test('a draft and a pending attention are kept and reported for an unbound conversation', () => run(async (w) => {
  const v = await w.openUnbound(9);
  w.set(v, { draft: true });
  await w.clock.advance(6000);
  assert.equal(w.navigator.getUnbound()[0].draft, true);
  assert.equal(w.viewOf(v.id).loads.length, 1, 'never reloaded');
}));

test('opening an unbound conversation reuses its view, shows it, and touches neither Herdr nor the bindings', () => run(async (w) => {
  const v = await w.openUnbound(9);
  w.pick = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  const views = w.fake.views.length;
  const before = JSON.stringify(w.read());
  const r = w.actions.open({ viewId: v.id });
  assert.equal(r.ok, true);
  assert.equal(r.viewId, v.id);
  assert.equal(w.fake.views.length, views, 'no new view');
  assert.equal(v.loads.length, 1, 'no reload');
  assert.deepEqual([...w.fake.host.attached], [v.id]);
  assert.deepEqual(w.selectCalls, [], 'no workspace.focus / selection');
  assert.equal(w.sel.selected.workspaceId, 'w1', 'Herdr context is unchanged');
  assert.equal(JSON.stringify(w.read()), before, 'nothing bound');
  const s = w.navigator.getState();
  assert.equal(s.visibleUnbound, true);
  assert.equal(s.workspace.id, 'w1');
}));

test('the bar says "Sem workspace" while an unbound conversation is shown, and goes back when another is chosen', () => run(async (w) => {
  const { barModel } = require('../src/shared/chat-nav-view');
  const v = await w.openUnbound(9);
  w.actions.open({ viewId: v.id });
  assert.equal(barModel(w.navigator.getState()).title, 'ChatGPT · Sem workspace');
  assert.match(barModel(w.navigator.getState()).workspaceTitle, /independente/);
  w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  assert.equal(w.navigator.getState().visibleUnbound, false);
  assert.match(barModel(w.navigator.getState()).title, /api/);
}));

test('an opened unbound conversation does not follow a change of the selected workspace', () => run(async (w) => {
  const v = await w.openUnbound(9);
  w.actions.open({ viewId: v.id });
  assert.equal(w.navigator.getVisibleUrl(), chatUrl(9));
  w.select('w2');
  assert.notEqual(w.fake.host.attached.has(v.id), true, 'the unbound page is not shown under another workspace');
  assert.equal(w.navigator.getUnbound().length, 1, 'but it is still listed and recoverable');
}));

test('a conversation without a durable id is kept under a runtime id and keeps one entry when the id appears', () => run(async (w) => {
  const v = await w.openUnbound(0);
  let u = w.navigator.getUnbound();
  assert.deepEqual([u.length, u[0].identity, u[0].bindable, u[0].label], [1, 'pending', false, 'Nova conversa']);
  assert.match(u[0].hint, /^#\d+$/);
  assert.equal(w.actions.bind({ viewId: v.id, workspaceId: 'w1', selectedAtOpen: 'w1' }).error.code, 'identity_pending');
  v.navigate(chatUrl(8));
  u = w.navigator.getUnbound();
  assert.deepEqual([u.length, u[0].viewId, u[0].identity, u[0].bindable], [1, v.id, 'durable', true], 'same entry, same view');
  assert.equal(v.loads.length, 1);
}));

test('the never-shown initial page is not listed as a conversation', () => run(() => {
  assert.deepEqual(setup().navigator.getUnbound(), []);
}));

test('binding later: validated by the I3A rules, the entry leaves "Sem workspace" and the view survives', () => run(async (w) => {
  const v = await w.openUnbound(9);
  w.set(v, RESPONDING);
  await w.clock.advance(6000);
  const r = w.actions.bind({ viewId: v.id, workspaceId: 'w2', label: 'avulsa', selectedAtOpen: 'w1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.binding.origin, 'current-page');
  assert.equal(w.navigator.getUnbound().length, 0);
  assert.equal(w.manager.get(v.id).scope, WK('w2'), 'the same view now lives in w2');
  assert.equal(v.loads.length, 1, 'no reload');
  assert.equal(w.navigator.getGlobalActivity().groups[0].id, 'w2');
  assert.equal(w.navigator.getGlobalActivity().groups[0].items[0].responding, true, 'observation kept');
  assert.deepEqual(w.selectCalls, [], 'binding does not move Herdr');
}));

test('binding is refused when the selection moved since the form was opened, nothing is written', () => run(async (w) => {
  const v = await w.openUnbound(9);
  const r = w.actions.bind({ viewId: v.id, workspaceId: 'w2', selectedAtOpen: 'w2' });
  assert.equal(r.error.code, 'context_changed');
  assert.equal(w.navigator.getUnbound().length, 1);
}));

test('a view that shows a conversation already bound is adopted by that binding, with its view', () => run(async (w) => {
  const v = await w.openUnbound(4);                         // w2 already holds conversation 4
  assert.equal(w.navigator.getUnbound().length, 0);
  assert.equal(w.manager.get(v.id).scope, WK('w2'));
  assert.equal(v.loads.length, 1);
}));

test('binding a conversation that was bound elsewhere in the meantime is a conflict (never silent)', () => run(async (w) => {
  const v = await w.openUnbound(9);
  const other = w.bindings.bind({ target: w.target('w2'), url: chatUrl(9), origin: 'url', selectedAtOpen: 'w1', targetChosen: true });
  assert.equal(other.ok, true);
  const r = w.actions.bind({ viewId: v.id, workspaceId: 'w1', selectedAtOpen: 'w1' });
  assert.equal(r.error.code, 'conflict');
  assert.equal(w.bindings.lookup(chatUrl(9)).workspaceIdentity.workspaceId, 'w2', 'the existing binding is untouched');
}));

test('binding to a missing, orphan-looking or unavailable destination keeps the I3A protections', () => run(async (w) => {
  const v = await w.openUnbound(9);
  assert.equal(w.actions.bind({ viewId: v.id, workspaceId: 'w9', selectedAtOpen: 'w1' }).error.code, 'workspace_not_found');
  w.disconnect();
  assert.equal(w.actions.bind({ viewId: v.id, workspaceId: 'w2', selectedAtOpen: 'w1' }).error.code, 'workspace_unavailable');
  assert.equal(w.navigator.getUnbound().length, 1);
  assert.equal(w.actions.bind({ viewId: 'v999', workspaceId: 'w1', selectedAtOpen: 'w1' }).error.code, 'view_not_found');
  assert.equal(w.actions.bind({ viewId: v.id, workspaceId: 7, selectedAtOpen: 'w1' }).error.code, 'invalid_target');
}));

test('a conversation of an orphan or suspect binding keeps its workspace scope: it is never turned into an unbound one', () => run(async (w) => {
  w.select('w2');
  const view = w.navigator.selectBinding({ bindingId: w.B[0].bindingId, workspaceKey: WK('w2') });
  w.viewOf(view.viewId).finishLoad(w.B[0].url);
  w.setWorkspaces([ws('w1', 'api')]);                       // w2 disappears: its binding is an orphan
  w.select('w1');
  assert.equal(w.bindings.all().find((b) => b.bindingId === w.B[0].bindingId).status, 'orphan');
  assert.equal(w.navigator.getUnbound().length, 0);
  assert.equal(w.manager.get(view.viewId).scope, WK('w2'));
}));

test('a blank unbound page can be created repeatedly without touching the initial page twice', () => run(async (w) => {
  const a = w.actions.create();
  const b = w.actions.create();
  assert.equal(a.viewId, w.pristineId, 'the initial page is handed over first, without navigating it');
  assert.notEqual(b.viewId, a.viewId);
  assert.equal(w.viewOf(a.viewId).loads.length, 1);
}));

test('unbound actions need the chat tab: they bring it up first', () => {
  const calls = [];
  const nav = { openUnbound: (a) => { calls.push(['open', a]); return { ok: true }; }, newUnbound: () => { calls.push(['new']); return { ok: true }; } };
  let mode = 'terminal';
  const actions = createUnboundActions({ session: 's', bindings: {}, navigator: nav, showChatTab: () => { mode = 'chat'; calls.push(['tab']); }, getMode: () => mode });
  actions.open({ viewId: 'v1' });
  assert.deepEqual(calls, [['tab'], ['open', { viewId: 'v1' }]]);
});
