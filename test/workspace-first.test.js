'use strict';

// M01-I3B-3, workspace-first: a conversation opened IN a workspace belongs to that workspace; a conversation bound elsewhere is
// a conflict; passive events never bind; nothing is lost. Real bindings service, navigator, manager and adoption service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws, chatUrl } = require('./helpers/bindings-world');
const { createContextAdoption } = require('../src/main/chat-bindings/context-adoption');
const { createBindingsStore } = require('../src/main/chat-bindings/store');
const projectModel = require('../src/main/project-bindings/model');
const { createProjectBindings } = require('../src/main/project-bindings/service');
const { createProjectCreation } = require('../src/main/project-bindings/creation');
const { barModel } = require('../src/shared/chat-nav-view');
const { centerModel } = require('../src/shared/activity-view');
const { registerChatNavIpc } = require('../src/main/ipc/chatnav');

const WK = (id) => `contextdeck/${id}`;
const PID = 'g-p-6ac6503eb7e881919958af060b1297a5';
const PROJECT_HOME = `https://chatgpt.com/g/${PID}/project`;
const inProject = (n) => `https://chatgpt.com/g/${PID}-system-framework/c/${chatUrl(n).slice(-36)}`;

// w1 "api" (holds chat 1), w2 "app" (holds chat 4); chat tab showing, w1 selected by the user.
function setup(opts = {}) {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')], ...opts });
  w.select('w1'); w.A = bindMany(w, [1]);
  w.select('w2'); w.B = bindMany(w, [4]);
  w.select('w1');
  w.navigator.setMode('chat');
  w.adoption = createContextAdoption({ session: w.session, navigator: w.navigator, bindings: w.bindings, selection: w.selection });
  w.navigator.setNoteProvider((id) => w.adoption.noteOf(id));
  w.navigator.onChange(() => w.adoption.resolve());     // as in src/main/index.js
  w.view = (id) => w.fake.views.find((v) => v.id === id);
  w.newChat = (ws_ = 'w1') => { const r = w.navigator.newConversation({ workspaceKey: WK(ws_) }); assert.equal(r.ok, true); return w.view(r.viewId); };
  w.bound = (n, url) => w.bindings.lookup(url || chatUrl(n));
  w.fileBytes = () => fs.readFileSync(w.file, 'utf8');
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); } };

// ---- 1-2: a new conversation ---------------------------------------------------------------------------------------------------
test('Nova conversa in A: the page shows "Nova conversa" until an id appears, then the conversation is bound to A (same view)', () => run(async (w) => {
  const v = w.newChat();
  v.finishLoad(w.HOME);
  assert.equal(w.navigator.getState().temporaries[0].label, 'Nova conversa');
  assert.equal(w.bindings.all().length, 2, 'no id: nothing bound, no invented id');
  v.navigate(chatUrl(7));
  const b = w.bound(7);
  assert.deepEqual([b.workspaceIdentity.workspaceId, b.origin, b.status], ['w1', 'context', 'linked']);
  assert.equal(w.manager.get(v.id).expectedKey, `c:${chatUrl(7).slice(-36)}`);
  assert.equal(v.loads.length, 1, 'never reloaded');
  assert.equal(w.manager.list().length, 1, 'one view');
  assert.equal(w.navigator.getState().tabs.some((t) => t.loaded && t.bindingId === b.bindingId), true, 'it is a tab of A now');
}));

test('double click on Nova conversa: one page, one intent', () => run(async (w) => {
  const a = w.newChat(); const b = w.newChat();
  assert.equal(a, b);
  assert.equal(w.fake.views.length, 1);
}));

// ---- 3-6: an old conversation opened inside A ------------------------------------------------------------------------------------
test('an old unbound conversation opened (sidebar) in A\'s page on screen is bound to A', () => run(async (w) => {
  const v = w.newChat();
  v.finishLoad(w.HOME);
  v.navigate(chatUrl(8));                                           // the user clicked it in ChatGPT's sidebar
  assert.equal(w.bound(8).workspaceIdentity.workspaceId, 'w1');
}));

test('a conversation already bound to A is reused: no new binding, no second view', () => run(async (w) => {
  const v = w.newChat();
  v.navigate(w.A[0].url);
  assert.equal(w.bindings.all().length, 2);
  assert.equal(w.manager.get(v.id).expectedKey, w.A[0].conversationKey);
  assert.equal(w.fake.views.length, 1);
}));

test('a page that shows a conversation of A\'s binding via its own tab stays unique after reload and re-navigation', () => run(async (w) => {
  const r = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  v.finishLoad(w.A[0].url);
  v.finishLoad && v.navigate(w.A[0].url);
  v.navigate(w.A[0].url);
  assert.equal(w.bindings.all().length, 2);
  assert.equal(w.fake.views.length, 1);
}));

// ---- 7-10: conflicts ---------------------------------------------------------------------------------------------------------------
test('a conversation bound to B opened in A: never moved; a conflict is reported with where it lives', () => run(async (w) => {
  const v = w.newChat();
  const before = w.fileBytes();
  v.navigate(w.B[0].url);
  assert.equal(w.fileBytes(), before, 'binding untouched');
  const c = w.navigator.getState().conflict;
  assert.deepEqual([c.viewId, c.boundTo.id, c.boundTo.label, c.current.id, c.transferable, c.boundTo.openable], [v.id, 'w2', 'app', 'w1', true, true]);
  const banner = barModel(w.navigator.getState()).banner;
  assert.match(banner.text, /Esta conversa pertence ao workspace app \(w2\)\. Você está em api \(w1\)\./);
  assert.deepEqual(banner.actions.map((a) => a.action), ['go', 'transfer', 'back']);
  assert.equal(w.fake.views.length, 1, 'no duplicate view');
  assert.deepEqual(w.selectCalls, [], 'detecting the conflict does not switch workspace');
}));

test('transfer is explicit and uses the I3A reassignment; the view keeps its page', () => run(async (w) => {
  const v = w.newChat();
  v.navigate(w.B[0].url);
  const r = w.adoption.transfer({ viewId: v.id });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.bound(4, w.B[0].url).workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.navigator.getState().conflict, null);
  assert.equal(v.loads.length, 1);
}));

test('transfer only while the page\'s workspace is the selected one, and never for a conversation that is not bound', () => run(async (w) => {
  const v = w.newChat();
  v.navigate(w.B[0].url);
  w.select('w2');
  assert.equal(w.adoption.transfer({ viewId: v.id }).error.code, 'context_changed');
  assert.equal(w.bound(4, w.B[0].url).workspaceIdentity.workspaceId, 'w2');
  w.select('w1');
  const o = w.view(w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') }).viewId);
  w.navigator.setMode('terminal');
  o.navigate(chatUrl(5));                                           // hidden and not pending: passive, so unbound
  assert.equal(w.adoption.transfer({ viewId: o.id }).error.code, 'not_bound');
}));

test('Voltar: the page moves to the workspace the conversation belongs to; A shows what it showed before; the binding is unchanged', () => run(async (w) => {
  const first = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  const v = w.newChat();
  v.navigate(w.B[0].url);
  const r = w.adoption.back({ viewId: v.id });
  assert.equal(r.ok, true);
  assert.equal(w.manager.get(v.id).scope, WK('w2'));
  assert.equal(w.navigator.getState().conflict, null);
  assert.equal(w.bound(4, w.B[0].url).workspaceIdentity.workspaceId, 'w2');
  assert.equal(w.manager.getVisibleId(), first.viewId, 'the earlier conversation of A is back on screen');
  assert.equal(w.fake.views.length, 2, 'no view was destroyed or duplicated');
}));

test('a conflict with an orphan binding can be transferred but not opened', () => run(async (w) => {
  w.setWorkspaces([ws('w1', 'api')]);                              // w2 disappears: chat 4 is an orphan
  const v = w.newChat();
  v.navigate(w.B[0].url);
  const c = w.navigator.getState().conflict;
  assert.deepEqual([c.boundTo.status, c.boundTo.openable], ['orphan', false]);
  assert.deepEqual(barModel(w.navigator.getState()).banner.actions.map((a) => a.action), ['transfer', 'back']);
}));

// ---- 11-14: context captured at the click; passive events ---------------------------------------------------------------------------
test('created in A, switched to B before the id: bound to A, never to B; Herdr untouched', () => run(async (w) => {
  const v = w.newChat();
  v.finishLoad(w.HOME);
  w.select('w2');
  v.navigate(chatUrl(7));
  const b = w.bound(7);
  assert.equal(b.workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.navigator.getState().tabs.length, 1, 'B shows only its own conversations');
  assert.deepEqual(w.selectCalls, []);
  assert.equal(w.manager.get(v.id).scope, WK('w1'));
}));

test('Auto mode: the click is the intent even when the selection is only an estimate', () => run(async (w) => {
  w.select('w1', 'herdr');
  const v = w.newChat();
  v.navigate(chatUrl(7));
  assert.equal(w.bound(7).workspaceIdentity.workspaceId, 'w1');
}));

test('passive events never bind: a hidden page changing route, a reload, a redirect, a late event', () => run(async (w) => {
  const r = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  v.finishLoad(w.A[0].url);
  w.navigator.setMode('terminal');                                  // the page is not on screen
  v.navigate(chatUrl(8));                                           // route change nobody looked at
  assert.equal(w.bound(8), null, 'hidden, not pending: left alone');
  v.finishLoad(chatUrl(8));                                         // reload / late completion
  v.navigate(chatUrl(8));
  assert.equal(w.bound(8), null);
  assert.equal(w.adoption.pending().length, 0);
}));

test('a restored/started session has no pages: nothing to bind (views are created lazily)', () => run(async (w) => {
  assert.deepEqual(w.navigator.contextViews(), []);
  w.adoption.resolve();
  assert.equal(w.bindings.all().length, 2);
}));

// ---- 15-18: failures keep the page --------------------------------------------------------------------------------------------------------
test('a suspect workspace refuses the association: the page stays in A with a note and a retry that works after re-confirmation', () => run(async (w) => {
  const v = w.newChat();
  v.finishLoad(w.HOME);
  w.setWorkspaces([ws('w1', 'other', 'D:/x'), ws('w2', 'app')]);
  Object.assign(v.contents.signals, { draft: true });
  v.navigate(chatUrl(7));
  assert.equal(w.bound(7), null);
  const s = w.navigator.getState();
  assert.match(s.pending, /nao foi verificada/);
  assert.deepEqual(barModel(s).banner.actions.map((a) => a.action), ['retry']);
  assert.equal(w.manager.get(v.id).scope, WK('w1'), 'still reachable in its workspace');
  assert.equal(v.loads.length, 1);
  assert.equal(w.adoption.retry({ viewId: v.id }).ok, false);
  w.bindings.reassign({ bindingId: w.A[0].bindingId, target: w.target('w1'), selectedAtOpen: 'w1', confirmReassign: true });
  assert.equal(w.adoption.retry({ viewId: v.id }).ok, true);
  assert.equal(w.bound(7).workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.navigator.getState().pending, null);
}));

test('Herdr disconnected: the association waits (verifiable destination required) and completes by itself when it is back', () => run(async (w) => {
  const v = w.newChat();
  w.disconnect();
  v.navigate(chatUrl(7));
  assert.equal(w.bound(7), null);
  assert.match(w.navigator.getState().pending, /Sem conexao/);
  w.connect();
  w.adoption.resolve();
  assert.equal(w.bound(7).workspaceIdentity.workspaceId, 'w1', 'the pending creation still belongs to the workspace of the click');
}));

test('two pages showing the same new conversation: one binding, both pages kept', () => run(async (w) => {
  const a = w.newChat();
  a.navigate(chatUrl(7));
  const b = w.newChat();                                            // the first now has an id, so this is a second page
  assert.notEqual(a, b);
  b.navigate(chatUrl(7));
  assert.equal(w.bindings.all().filter((x) => x.conversationKey.endsWith(chatUrl(7).slice(-36))).length, 1);
  assert.equal(w.manager.duplicates().length, 1);
  assert.equal(w.fake.views.length, 2);
}));

test('drafts, activity and attention survive the association (same view)', () => run(async (w) => {
  const v = w.newChat();
  v.finishLoad(w.HOME);
  Object.assign(v.contents.signals, { draft: true });
  await w.clock.advance(6000);
  v.navigate(chatUrl(7));
  await w.clock.advance(6000);
  assert.equal(w.bound(7).status, 'linked');
  const g = w.navigator.getGlobalActivity();
  assert.equal(g.groups.find((x) => x.id === 'w1').items.some((i) => i.draft), true);
}));

// ---- 19-21: no permanent "Sem workspace" ----------------------------------------------------------------------------------------------------
test('the normal UI has no "Sem workspace" section: nothing unscoped exists after normal use', () => run(async (w) => {
  const v = w.newChat();
  v.navigate(chatUrl(7));
  assert.deepEqual(w.navigator.getGlobalActivity().unbound, []);
  const m = centerModel({ global: w.navigator.getGlobalActivity() });
  assert.equal(m.unbound, null);
  const strip = (f) => fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const center = strip('src/renderer/overlay/activity-center.js') + strip('src/shared/activity-view.js');
  assert.doesNotMatch(center, /Sem workspace/);
  assert.doesNotMatch(fs.readFileSync('src/shared/chat-nav-view.js', 'utf8'), /Sem workspace|Conversa não vinculada/);
}));

test('a page opened while NO workspace was selected stays reachable (listed only because it exists); opening it with a workspace selected puts it there', () => run(async (w) => {
  w.select(null);
  w.navigator.openUnscoped();
  const v = w.fake.views.at(-1);
  v.finishLoad(chatUrl(9));
  assert.equal(w.navigator.getUnbound().length, 1);
  assert.equal(centerModel({ global: w.navigator.getGlobalActivity() }).unbound.items.length, 1);
  w.select('w1');
  const r = w.navigator.openUnbound({ viewId: v.id ? w.manager.list().find((x) => x.scope === null).id : '' });
  assert.equal(r.ok, true);
  assert.equal(w.bound(9).workspaceIdentity.workspaceId, 'w1', 'opened by the user in A\'s context: bound to A');
  assert.equal(w.navigator.getUnbound().length, 0);
}));

// ---- 22-25: Projects ----------------------------------------------------------------------------------------------------------------------
function withProject(w) {
  const store = createBindingsStore({ file: path.join(w.root, 'project-bindings.json'), model: projectModel });
  w.projects = createProjectBindings({ store, session: w.session, bindings: w.bindings, observer: w.observer, selection: w.selection });
  w.creation = createProjectCreation({ session: w.session, navigator: w.navigator, projects: w.projects });
  assert.equal(w.projects.link({ target: w.target('w1'), url: PROJECT_HOME, selectedAtOpen: 'w1', targetChosen: true }).ok, true);
  w.projectBytes = () => fs.readFileSync(path.join(w.root, 'project-bindings.json'), 'utf8');
}

test('Project: Nova conversa opens the Project page in A; a conversation created there is bound to A; the ProjectBinding is untouched', () => run(async (w) => {
  withProject(w);
  const before = w.projectBytes();
  const r = w.creation.start({ workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  assert.deepEqual([v.loads, r.entry], [[PROJECT_HOME], 'project-page']);
  v.finishLoad(PROJECT_HOME);
  assert.equal(w.bindings.all().length, 2, 'opening the Project page binds nothing');
  v.navigate(inProject(7));
  assert.equal(w.bound(7, inProject(7)).workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.projectBytes(), before);
  assert.equal(w.bound(7, inProject(7)).url.includes(PID), true, 'the Project route is kept in the address');
}));

test('Project: an OLD conversation opened in that page is bound to A too (a local binding is not proof of creation in the Project)', () => run(async (w) => {
  withProject(w);
  const r = w.creation.start({ workspaceKey: WK('w1') });
  w.view(r.viewId).navigate(inProject(8));
  assert.equal(w.bound(8, inProject(8)).workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.bound(8, inProject(8)).origin, 'context', 'recorded as opened in context, not as created');
}));

test('Project: a conversation bound to B is a conflict, and Project creation switched in A->B keeps the origin', () => run(async (w) => {
  withProject(w);
  const r = w.creation.start({ workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  w.select('w2');
  v.navigate(inProject(7));
  assert.equal(w.bound(7, inProject(7)).workspaceIdentity.workspaceId, 'w1');
  const r2 = (w.select('w1'), w.creation.start({ workspaceKey: WK('w1') }));
  w.view(r2.viewId).navigate(w.B[0].url);
  assert.equal(w.navigator.getState().conflict.boundTo.id, 'w2');
}));

test('Project: a workspace without Project, or whose Project cannot be verified, uses the plain flow', () => run(async (w) => {
  withProject(w);
  w.select('w2');
  const plain = w.creation.start({ workspaceKey: WK('w2') });
  assert.equal(w.view(plain.viewId).loads[0], w.HOME);
  w.select('w1');
  w.setWorkspaces([ws('w1', 'other', 'D:/x'), ws('w2', 'app')]);
  const r = w.creation.start({ workspaceKey: WK('w1') });
  assert.equal(r.note, 'project-suspect');
  assert.equal(w.view(r.viewId).loads[0], w.HOME);
}));

// ---- 26-28: persistence, atomicity, IPC ------------------------------------------------------------------------------------------------------
test('persistence: an adopted binding is read back after a restart with its origin; the file stays valid', () => run(async (w) => {
  const v = w.newChat();
  v.navigate(chatUrl(7));
  const again = createBindingsStore({ file: w.file });
  assert.equal(again.info().status, 'ok');
  const b = again.get().bindings.find((x) => x.conversationKey.endsWith(chatUrl(7).slice(-36)));
  assert.deepEqual([b.workspaceIdentity.workspaceId, b.origin, b.label], ['w1', 'context', '']);
}));

test('a failed write leaves memory and disk unchanged and the page pending', () => run(async (w) => {
  const v = w.newChat();
  const real = fs.writeFileSync;
  const before = w.fileBytes();
  fs.writeFileSync = () => { throw new Error('disk full'); };
  try { v.navigate(chatUrl(7)); } finally { fs.writeFileSync = real; }
  assert.equal(w.fileBytes(), before);
  assert.equal(w.bound(7), null);
  assert.equal(w.adoption.noteOf(v.id) !== '', true);
  assert.equal(w.adoption.retry({ viewId: v.id }).ok, true, 'retry succeeds once writes work');
}));

test('adopt is not reachable from IPC: chatnav:resolve takes a page id and one of four actions, nothing else', async () => {
  const handlers = new Map(); const calls = [];
  registerChatNavIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, trusted: (e) => e.ui === true, win: { getNavigator: () => ({}) }, resolve: (a) => { calls.push(a); return { ok: true }; } });
  const call = (args, e = { ui: true }) => handlers.get('chatnav:resolve')(e, args);
  assert.equal((await call({ viewId: 'v3', action: 'retry', targetChosen: true, workspaceId: 'w9', url: 'https://evil.example' })).ok, true);
  assert.deepEqual(calls, [{ viewId: 'v3', action: 'retry' }], 'only the two picked fields reach main');
  for (const bad of [{ viewId: 'v3', action: 'adopt' }, { viewId: 'x', action: 'retry' }, { action: 'retry' }, { viewId: 'v3' }, null, 'x']) assert.equal((await call(bad)).error.code, 'invalid_request', JSON.stringify(bad));
  assert.equal((await call({ viewId: 'v3', action: 'retry' }, { ui: false })).error.code, 'untrusted');
  assert.equal(calls.length, 1);
  const adoption = fs.readFileSync('src/main/chat-bindings/context-adoption.js', 'utf8');
  assert.doesNotMatch(fs.readFileSync('src/main/ipc/chats.js', 'utf8') + fs.readFileSync('src/main/ipc/chatnav.js', 'utf8'), /\.adopt\(/);
  assert.match(adoption, /bindings\.adopt\(/);
});

// ---- 29: banner model and keyboard ------------------------------------------------------------------------------------------------------------------
test('banner model: transfer needs its own second click, pending offers one direct action, no banner otherwise', () => {
  const base = { workspace: { key: WK('w1'), id: 'w1', label: 'api', pending: false }, tabs: [], temporaries: [], empty: null, duplicates: 0, activeViewId: 'v1' };
  const conflict = { viewId: 'v1', boundTo: { id: 'w2', label: 'app', openable: true }, current: { id: 'w1', label: 'api' }, transferable: true };
  assert.equal(barModel({ ...base }).banner, null);
  const armed = barModel({ ...base, conflict }, null, true).banner.actions.find((a) => a.action === 'transfer');
  assert.deepEqual([armed.armed, armed.label], [true, 'Confirmar transferência']);
  assert.equal(barModel({ ...base, conflict }).banner.actions.find((a) => a.action === 'transfer').label, 'Transferir vínculo…');
  assert.deepEqual(barModel({ ...base, pending: 'Conversa ainda nao vinculada: x' }).banner.actions.map((a) => a.action), ['retry']);
});

// ---- unbinding the conversation that is open --------------------------------------------------------------------------------------------------
// What main does on chats:unbind (index.js): decline the key, then release the pages that show it.
const unbindOpen = (w, binding) => {
  w.bindings.unbind({ bindingId: binding.bindingId });
  w.adoption.decline(binding.conversationKey);
  return w.navigator.releaseConversation(binding.conversationKey);
};

test('unbinding the open conversation removes its tab and leaves the workspace; the page is kept, not destroyed or rebound', () => run(async (w) => {
  const r = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  v.finishLoad(w.A[0].url);
  Object.assign(v.contents.signals, { draft: true });
  assert.equal(unbindOpen(w, w.A[0]), 1);
  v.navigate(w.A[0].url);
  w.adoption.resolve();
  const s = w.navigator.getState();
  assert.deepEqual([s.tabs.length, s.temporaries.length], [0, 0], 'no tab, no chip in the workspace');
  assert.equal(w.bound(1, w.A[0].url), null, 'not bound again');
  assert.equal(w.manager.get(v.id).scope, null);
  assert.equal(w.manager.get(v.id).page !== 'destroyed', true);
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
  assert.equal(v.loads.length, 1);
  assert.equal(w.manager.getAttachedId(), null, 'the page is no longer on screen under this workspace');
  assert.equal(s.empty, 'no-conversations');
  assert.deepEqual(w.navigator.getUnbound().map((u) => u.viewId), [v.id], 'still reachable (exceptional list)');
}));

test('after unbinding, the workspace shows its other conversations again', () => run(async (w) => {
  w.bindings.bind({ target: w.target('w1'), url: chatUrl(2), origin: 'url', selectedAtOpen: 'w1', targetChosen: true });
  const other = w.bindings.lookup(chatUrl(2));
  w.navigator.selectBinding({ bindingId: other.bindingId, workspaceKey: WK('w1') });
  const r = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  w.view(r.viewId).finishLoad(w.A[0].url);
  unbindOpen(w, w.A[0]);
  assert.deepEqual(w.navigator.getState().tabs.map((t) => t.bindingId), [other.bindingId]);
}));

test('opening the released page again in a workspace is the user\'s act: it is bound again', () => run(async (w) => {
  const r = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  v.finishLoad(w.A[0].url);
  unbindOpen(w, w.A[0]);
  assert.equal(w.bound(1, w.A[0].url), null);
  assert.equal(w.navigator.openUnbound({ viewId: v.id }).ok, true);
  assert.equal(w.bound(1, w.A[0].url).workspaceIdentity.workspaceId, 'w1');
  assert.equal(w.manager.get(v.id).scope, WK('w1'));
}));

test('chats:unbind tells main which conversation was unbound, only on success', () => {
  const { registerChatsIpc } = require('../src/main/ipc/chats');
  const handlers = new Map(); const told = [];
  const bindings = { all: () => [{ bindingId: 'b_0000000000000001', conversationKey: 'c:abc' }], unbind: ({ bindingId }) => (bindingId === 'b_0000000000000001' ? { ok: true } : { ok: false, error: { code: 'binding_not_found' } }), getState: () => ({}) };
  registerChatsIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, trusted: () => true, win: { getChatUrl: () => '' }, bindings, notify: () => {}, onUnbind: (k) => told.push(k) });
  handlers.get('chats:unbind')({}, { bindingId: 'b_ffffffffffffffff' });
  assert.deepEqual(told, []);
  handlers.get('chats:unbind')({}, { bindingId: 'b_0000000000000001' });
  assert.deepEqual(told, ['c:abc']);
});
