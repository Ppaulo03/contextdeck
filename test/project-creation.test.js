'use strict';

// New conversation inside the workspace's Project (M01-I3B-3): the intent, its invalidation, and the association rules.
// The Project URLs are SYNTHETIC (see src/main/chat/project-identity.js for the status of the shape).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws, chatUrl } = require('./helpers/bindings-world');
const { createBindingsStore } = require('../src/main/chat-bindings/store');
const projectModel = require('../src/main/project-bindings/model');
const { createProjectBindings } = require('../src/main/project-bindings/service');
const { createProjectCreation } = require('../src/main/project-bindings/creation');

const PID = (c) => `g-p-${String(c).repeat(32)}`;
const pageUrl = (c, slug = 'bicho') => `https://chatgpt.com/g/${PID(c)}-${slug}/project`;
const convUrl = (c, n, slug = 'bicho') => `https://chatgpt.com/g/${PID(c)}-${slug}/c/${chatUrl(n).slice(-36)}`;
const WK = (id) => `contextdeck/${id}`;

function setup({ enabled = true, selected } = {}) {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')], selected });
  w.select('w1'); w.chats = bindMany(w, [1]);
  w.navigator.setMode('chat');
  const store = createBindingsStore({ file: path.join(w.root, 'project-bindings.json'), model: projectModel });
  w.projects = createProjectBindings({ store, session: w.session, bindings: w.bindings, observer: w.observer, selection: w.selection });
  w.creation = createProjectCreation({ session: w.session, navigator: w.navigator, bindings: w.bindings, projects: w.projects, selection: w.selection, enabled });
  w.linkProject = (c, ws_ = 'w1', extra = {}) => w.projects.link({ target: w.target(ws_), url: pageUrl(c), selectedAtOpen: w.sel.selected.workspaceId, targetChosen: true, ...extra });
  w.view = (id) => w.fake.views.find((v) => v.id === id);
  w.click = (ws_ = 'w1') => w.creation.start({ workspaceKey: WK(ws_) });
  w.settle = async (view, url) => { view.finishLoad(url); await w.clock.advance(6000); };
  w.chatCount = () => w.bindings.all().length;
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); } };

test('a workspace without a Project (or with the feature off) behaves exactly as before: the home page, nothing pending', () => run(async (w) => {
  const r = w.click();
  assert.equal(r.ok, true);
  assert.equal(w.view(r.viewId).loads[0], w.HOME);
  assert.equal(r.project, undefined);
  assert.deepEqual(w.creation.pending(), []);
}));

test('the feature switched off ignores an existing ProjectBinding', () => run(async (w) => {
  w.linkProject(1);
  const r = w.click();
  assert.equal(w.view(r.viewId).loads[0], w.HOME);
}, { enabled: false }));

test('with a Project: a NEW page opens on the Project page, scoped to the workspace, with a pending intent and nothing bound', () => run(async (w) => {
  w.linkProject(1);
  const before = w.chatCount();
  const r = w.click();
  assert.equal(r.ok, true);
  assert.deepEqual([w.view(r.viewId).loads, r.entry, r.project.projectId], [[pageUrl(1)], 'project-page', PID(1)]);
  assert.equal(w.manager.get(r.viewId).scope, WK('w1'));
  assert.equal(w.chatCount(), before, 'opening the Project page binds nothing');
  assert.deepEqual(w.creation.pending().map((p) => p.workspaceId), ['w1']);
  assert.equal(w.selectCalls.length, 0, 'no workspace.focus');
}));

test('the first message gives the page an id inside the Project: the conversation is bound to the ORIGIN workspace, same view', () => run(async (w) => {
  w.linkProject(1);
  const r = w.click();
  const v = w.view(r.viewId);
  await w.settle(v, pageUrl(1));
  w.creation.resolve();
  assert.equal(w.chatCount(), 1, 'still waiting: the Project page has no conversation id');
  v.navigate(convUrl(1, 7));
  w.creation.resolve();
  const b = w.bindings.lookup(chatUrl(7));
  assert.deepEqual([b.workspaceIdentity.workspaceId, b.origin, b.status], ['w1', 'project-new', 'linked']);
  assert.equal(b.url, convUrl(1, 7), 'the Project route is kept');
  assert.deepEqual(w.creation.getOutcome(r.viewId).code, 'bound');
  assert.deepEqual(w.creation.pending(), []);
  assert.equal(w.manager.list().length, 1, 'the same single view became the conversation');
  assert.equal(v.loads.length, 1, 'never reloaded');
  const tab = w.navigator.getState().tabs.find((t) => t.label === '(sem rótulo)');
  assert.equal(Boolean(tab && tab.loaded), true, 'it became the binding\'s own tab');
}));

test('a double click shows the same waiting page: no second view, no second intent', () => run(async (w) => {
  w.linkProject(1);
  const a = w.click();
  const b = w.click();
  assert.equal(b.viewId, a.viewId);
  assert.equal(b.reused, true);
  assert.equal(w.fake.views.length, 1);
  assert.equal(w.creation.pending().length, 1);
}));

test('simultaneous creations in two workspaces keep two independent intents and bind each to its own workspace', () => run(async (w) => {
  w.linkProject(1);
  w.select('w2');
  w.linkProject(2, 'w2');
  const a = w.click('w2');
  w.select('w1');
  const b = w.click('w1');
  assert.notEqual(a.viewId, b.viewId);
  assert.equal(w.creation.pending().length, 2);
  w.view(b.viewId).navigate(convUrl(1, 7));
  w.creation.resolve();
  assert.equal(w.bindings.lookup(chatUrl(7)).workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.creation.pending().length, 0, 'the w2 intent was dropped: its workspace is no longer the selected one');
  assert.equal(w.creation.getOutcome(a.viewId).code, 'context-changed');
  w.view(a.viewId).navigate(convUrl(2, 8, 'x'));
  w.creation.resolve();
  assert.equal(w.bindings.lookup(chatUrl(8)), null, 'late id of the abandoned creation: never bound');
}));

test('workspace changed before the id appears: the conversation is NOT bound to the new workspace nor to the old one', () => run(async (w) => {
  w.linkProject(1);
  const r = w.click();
  const v = w.view(r.viewId);
  await w.settle(v, pageUrl(1));
  w.select('w2');
  v.navigate(convUrl(1, 7));
  w.creation.resolve();
  assert.equal(w.bindings.lookup(chatUrl(7)), null);
  assert.equal(w.creation.getOutcome(r.viewId).code, 'context-changed');
  assert.equal(w.manager.get(r.viewId).scope, WK('w1'), 'the page stays a temporary conversation of its workspace: recoverable');
  assert.equal(w.selectCalls.length, 0, 'and Herdr was not touched to compensate');
  w.select('w1');
  w.creation.resolve();
  assert.equal(w.bindings.lookup(chatUrl(7)), null, 'coming back does not revive the intent');
  assert.ok(w.navigator.getState().temporaries.some((t) => t.viewId === r.viewId), 'listed so it can be bound by hand');
}));

test('the Project of the workspace changed while waiting: the intent is dropped', () => run(async (w) => {
  w.linkProject(1);
  const r = w.click();
  w.projects.link({ target: w.target('w1'), url: pageUrl(2), selectedAtOpen: 'w1', targetChosen: true, replace: true });
  w.view(r.viewId).navigate(convUrl(1, 7));
  w.creation.resolve();
  assert.equal(w.bindings.lookup(chatUrl(7)), null);
  assert.equal(w.creation.getOutcome(r.viewId).code, 'project-changed');
}));

test('unlinking or editing the Project while waiting also drops it', () => run(async (w) => {
  w.linkProject(1);
  const a = w.click();
  w.projects.unlink({ workspaceIdentity: w.target('w1') });
  w.view(a.viewId).navigate(convUrl(1, 7));
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(a.viewId).code, 'project-changed');
  assert.equal(w.bindings.lookup(chatUrl(7)), null);
}));

test('navigation away: another Project, a general chat, or another page never bind', () => run(async (w) => {
  w.linkProject(1);
  for (const [n, target, code] of [[7, convUrl(2, 7, 'other'), 'outside-project'], [8, chatUrl(8), 'outside-project'], [9, 'https://chatgpt.com/gpts', 'navigated-away']]) {
    const r = w.click();
    const v = w.view(r.viewId);
    v.navigate(target);
    w.creation.resolve();
    assert.equal(w.creation.getOutcome(r.viewId).code, code, target);
    assert.equal(w.bindings.lookup(chatUrl(n)), null, target);
    w.manager.setScope(r.viewId, null);                      // the page leaves the workspace so the next click makes a fresh one
  }
}));

test('an id that is already bound elsewhere is never taken: the intent ends, the existing binding is untouched', () => run(async (w) => {
  w.linkProject(1);
  w.select('w2');
  w.bindings.bind({ target: w.target('w2'), url: convUrl(1, 7), origin: 'url', selectedAtOpen: 'w2', targetChosen: true });
  w.select('w1');
  const r = w.click();
  w.view(r.viewId).navigate(convUrl(1, 7));
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'already-bound');
  assert.equal(w.bindings.lookup(chatUrl(7)).workspaceIdentity.workspaceId, 'w2');
}));

test('a destination that is only an estimate (selection followed Herdr) is not bound automatically; the page stays recoverable', () => run(async (w) => {
  w.linkProject(1);
  w.select('w1', 'herdr');
  const r = w.click();
  w.view(r.viewId).navigate(convUrl(1, 7));
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'refused:confirmation_required');
  assert.equal(w.bindings.lookup(chatUrl(7)), null);
  assert.ok(w.navigator.getState().temporaries.some((t) => t.viewId === r.viewId));
}));

test('a closed or destroyed page cancels its intent; late events change nothing', () => run(async (w) => {
  w.linkProject(1);
  const r = w.click();
  const v = w.view(r.viewId);
  v.destroy();
  v.emit('destroyed');
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'view-closed');
  assert.equal(w.creation.pending().length, 0);
  assert.equal(w.chatCount(), 1);
  w.creation.cancel(r.viewId);                                // idempotent
}));

test('a Project of an unverified or recreated workspace is not used silently: the plain flow runs and says why', () => run(async (w) => {
  w.linkProject(1);
  w.setWorkspaces([ws('w1', 'totally-other', 'D:/x'), ws('w2', 'app')]);
  const r = w.click();
  assert.equal(r.note, 'project-suspect');
  assert.equal(w.view(r.viewId).loads[0], w.HOME);
  assert.deepEqual(w.creation.pending(), []);
}));

test('existing conversations are untouched by linking a Project: no reload, no move, no new binding', () => run(async (w) => {
  const pick = w.navigator.selectBinding({ bindingId: w.chats[0].bindingId, workspaceKey: WK('w1') });
  const view = w.view(pick.viewId);
  view.finishLoad(w.chats[0].url);
  const before = JSON.stringify(w.read());
  w.linkProject(1);
  w.navigator.reconcile();
  assert.equal(JSON.stringify(w.read()), before);
  assert.equal(view.loads.length, 1);
  assert.equal(w.manager.get(view.id).scope, WK('w1'));
}));

test('the Project\'s conversation that cannot be bound stays in the workspace and is bindable through the normal I3A flow', () => run(async (w) => {
  w.linkProject(1);
  w.select('w1', 'herdr');
  const r = w.click();
  w.view(r.viewId).navigate(convUrl(1, 7));
  w.creation.resolve();
  w.select('w1', 'dock');
  const bound = w.bindings.bind({ target: w.target('w1'), url: convUrl(1, 7), origin: 'current-page', selectedAtOpen: 'w1' });
  assert.equal(bound.ok, true);
  w.navigator.reconcile();
  assert.equal(w.navigator.getState().tabs.some((t) => t.loaded && t.bindingId === bound.binding.bindingId), true);
}));
