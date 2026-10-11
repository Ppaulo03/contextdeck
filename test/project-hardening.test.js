'use strict';

// M01-I3B-3 hardening: the routes OBSERVED by a person on a logged-in account, and the rule that identifying the Project is not
// proof that a conversation was created.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseProjectUrl } = require('../src/main/chat/project-identity');
const { parseChatUrl } = require('../src/main/chat/conversation-identity');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws, chatUrl } = require('./helpers/bindings-world');
const { createBindingsStore } = require('../src/main/chat-bindings/store');
const projectModel = require('../src/main/project-bindings/model');
const { createProjectBindings } = require('../src/main/project-bindings/service');
const { createProjectCreation } = require('../src/main/project-bindings/creation');

// ---- observed on a real account (docs/validation/m01-i3b-3.md, "Observed routes") ----------------------------------------------
const ID = '6ac6503eb7e881919958af060b1297a5';
const HOME = `https://chatgpt.com/g/g-p-${ID}/project`;
const NEW_CHAT = `https://chatgpt.com/g/g-p-${ID}/project`;                                   // before the first message: identical to HOME
const CREATED = `https://chatgpt.com/g/g-p-${ID}-system-framework/c/6acbd981-c50c-83e9-b246-6c72298570e6`;
const OLD = `https://chatgpt.com/g/g-p-${ID}-system-framework/c/6ac6ed50-085c-83e9-a9cc-25be31a96299`;

test('observed: the Project home (no slug) is recognised and yields the 32-hex id', () => {
  const r = parseProjectUrl(HOME);
  assert.deepEqual([r.ok, r.projectId, r.slug, r.source, r.url], [true, `g-p-${ID}`, '', 'project-page', HOME]);
  assert.equal(parseProjectUrl(NEW_CHAT).projectId, `g-p-${ID}`);
});

test('observed: conversations inside the Project give the same Project id whatever the slug, and the UUID of any version', () => {
  for (const [url, uuid] of [[CREATED, '6acbd981-c50c-83e9-b246-6c72298570e6'], [OLD, '6ac6ed50-085c-83e9-a9cc-25be31a96299']]) {
    const p = parseProjectUrl(url);
    assert.deepEqual([p.ok, p.projectId, p.slug, p.source], [true, `g-p-${ID}`, 'system-framework', 'project-conversation'], url);
    const c = parseChatUrl(url);
    assert.deepEqual([c.ok, c.kind, c.conversationId, c.conversationKey], [true, 'project-conversation', uuid, `c:${uuid}`], url);
  }
  assert.equal(parseProjectUrl(HOME).projectId, parseProjectUrl(CREATED).projectId, 'same Project through different routes');
  assert.equal(parseProjectUrl(CREATED.replace('system-framework', 'another-slug-entirely')).projectId, `g-p-${ID}`, 'the slug text is not identity');
  assert.equal(parseChatUrl(OLD.replace('system-framework', 'zzz')).conversationKey, parseChatUrl(OLD).conversationKey);
});

test('observed: the new-chat URL cannot be told from the Project home, and a new and an old conversation cannot be told by URL', () => {
  assert.equal(NEW_CHAT, HOME);
  const shape = (u) => u.replace(/[0-9a-f]{8}-[0-9a-f-]{27}$/, '<uuid>');
  assert.equal(shape(CREATED), shape(OLD), 'the two conversation routes have exactly the same shape');
});

test('rejections stay strict with the real id: wrong length, other host, a conversation is not a Project page', () => {
  assert.equal(parseProjectUrl(`https://chatgpt.com/g/g-p-${ID.slice(1)}/project`).ok, false);
  assert.equal(parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}0/project`).ok, false);
  assert.equal(parseProjectUrl(`https://chatgpt.com.evil.example/g/g-p-${ID}/project`).ok, false);
  assert.equal(parseProjectUrl('https://chatgpt.com/c/6acbd981-c50c-83e9-b246-6c72298570e6').ok, false);
});

// ---- creation: identification is not proof ------------------------------------------------------------------------------------------
const WK = (id) => `contextdeck/${id}`;

function setup() {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  w.select('w1'); w.chats = bindMany(w, [1]);
  w.navigator.setMode('chat');
  const store = createBindingsStore({ file: path.join(w.root, 'project-bindings.json'), model: projectModel });
  w.projects = createProjectBindings({ store, session: w.session, bindings: w.bindings, observer: w.observer, selection: w.selection });
  w.evidence = false;
  w.creation = createProjectCreation({ session: w.session, navigator: w.navigator, bindings: w.bindings, projects: w.projects, selection: w.selection, evidence: () => w.evidence });
  w.navigator.setNoteProvider((id) => w.creation.noteFor(id));
  assert.equal(w.projects.link({ target: w.target('w1'), url: HOME, selectedAtOpen: 'w1', targetChosen: true }).ok, true);
  w.view = (id) => w.fake.views.find((v) => v.id === id);
  return w;
}
const run = async (fn) => { const w = setup(); try { await fn(w); } finally { w.cleanup0(); } };

test('opening the Project creates no conversation and no binding', () => run(async (w) => {
  const r = w.creation.start({ workspaceKey: WK('w1') });
  w.view(r.viewId).finishLoad(HOME);
  w.creation.resolve();
  assert.equal(w.view(r.viewId).loads[0], HOME);
  assert.equal(w.bindings.all().length, 1);
  assert.equal(w.creation.pending().length, 1, 'still waiting');
}));

test('an OLD conversation picked from the sidebar is NOT bound just because the Project id matches', () => run(async (w) => {
  const r = w.creation.start({ workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  v.finishLoad(HOME);
  v.navigate(OLD);                                          // the user clicks an old conversation of the Project
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'unconfirmed-origin');
  assert.equal(w.bindings.lookup(OLD), null, 'no ChatBinding');
  assert.equal(w.bindings.all().length, 1);
  assert.equal(w.manager.get(r.viewId).scope, WK('w1'), 'still on screen under the workspace it was opened from');
  const tab = w.navigator.getState().temporaries.find((t) => t.viewId === r.viewId);
  assert.match(tab.note, /nada comprova que foi criada agora/);
  assert.equal(w.fake.views.length, 1, 'view kept, not duplicated');
}));

test('the same URL transition for a real first message is ALSO left to the user while no verified evidence exists', () => run(async (w) => {
  const r = w.creation.start({ workspaceKey: WK('w1') });
  w.view(r.viewId).navigate(CREATED);
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'unconfirmed-origin');
  assert.equal(w.bindings.lookup(CREATED), null);
  // The explicit path: the normal I3A binding of the current page, destination chosen by the user.
  const b = w.bindings.bind({ target: w.target('w1'), url: CREATED, origin: 'current-page', selectedAtOpen: 'w1' });
  assert.equal(b.ok, true);
  w.navigator.reconcile();
  assert.equal(w.navigator.getState().tabs.some((t) => t.bindingId === b.binding.bindingId && t.loaded), true, 'the same view became its tab');
}));

test('with an injected evidence of a first send it is bound; the evidence alone never replaces the Project, workspace and Project-id checks', () => run(async (w) => {
  w.evidence = true;
  const ok = w.creation.start({ workspaceKey: WK('w1') });
  w.view(ok.viewId).navigate(CREATED);
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(ok.viewId).code, 'bound');
  const other = w.creation.start({ workspaceKey: WK('w1') });
  w.view(other.viewId).navigate(`https://chatgpt.com/g/g-p-${'f'.repeat(32)}-other/c/6ac6ed50-085c-83e9-a9cc-25be31a96299`);
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(other.viewId).code, 'outside-project', 'another Project: evidence or not, never bound');
}));

// ---- recovery of the temporary page ----------------------------------------------------------------------------------------------------
test('workspace changed: the page is released to "Sem workspace" with its view, draft and activity; nothing bound; Herdr untouched', () => run(async (w) => {
  const r = w.creation.start({ workspaceKey: WK('w1') });
  const v = w.view(r.viewId);
  v.finishLoad(HOME);
  Object.assign(v.contents.signals, { draft: true });
  await w.clock.advance(6000);
  w.select('w2');
  v.navigate(CREATED);
  w.creation.resolve();
  await w.clock.advance(6000);
  assert.equal(w.creation.getOutcome(r.viewId).code, 'context-changed');
  const u = w.navigator.getUnbound().find((x) => x.viewId === r.viewId);
  assert.ok(u, 'listed in Sem workspace');
  assert.deepEqual([u.bindable, u.draft], [true, true]);
  assert.equal(w.bindings.lookup(CREATED), null);
  assert.equal(w.selectCalls.length, 0);
  assert.equal(v.loads.length, 1, 'not reloaded');
  // It can be bound later through the block 1 flow, to the workspace the user picks.
  const { createUnboundActions } = require('../src/main/activity/unbound');
  const actions = createUnboundActions({ session: w.session, bindings: w.bindings, navigator: w.navigator, showChatTab: () => {}, getMode: () => 'chat' });
  assert.equal(actions.bind({ viewId: r.viewId, workspaceId: 'w1', selectedAtOpen: 'w2' }).ok, true);
  assert.equal(w.navigator.getUnbound().length, 0);
}));

test('navigating out of the Project while looking at it: the page stays on screen, now as an unbound conversation', () => run(async (w) => {
  const r = w.creation.start({ workspaceKey: WK('w1') });
  w.view(r.viewId).navigate(chatUrl(9));                   // a general chat
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'outside-project');
  assert.equal(w.navigator.getState().visibleUnbound, true);
  assert.equal(w.navigator.getUnbound().length, 1);
  assert.equal(w.manager.getAttachedId(), r.viewId, 'still attached: not hidden');
}));

test('an idle released page stays recoverable across tab and workspace changes', () => run(async (w) => {
  const r = w.creation.start({ workspaceKey: WK('w1') });
  w.view(r.viewId).navigate(chatUrl(9));
  w.creation.resolve();
  w.navigator.setMode('terminal'); w.select('w2'); w.select('w1'); w.navigator.setMode('chat');
  assert.deepEqual(w.navigator.getUnbound().map((u) => u.viewId), [r.viewId]);
}));

test('a binding\'s own page (suspect/orphan workspace) is never released to "Sem workspace"', () => run(async (w) => {
  const pick = w.navigator.selectBinding({ bindingId: w.chats[0].bindingId, workspaceKey: WK('w1') });
  w.setWorkspaces([ws('w1', 'other', 'D:/x'), ws('w2', 'app')]);
  assert.equal(w.navigator.releaseToUnbound(pick.viewId).error.code, 'bound_view');
  assert.equal(w.navigator.getUnbound().length, 0);
  assert.equal(w.navigator.releaseToUnbound('v999').error.code, 'view_not_found');
}));

test('a page whose conversation is already bound elsewhere moves to that binding, not to a second view', () => run(async (w) => {
  w.select('w2');
  const other = w.bindings.bind({ target: w.target('w2'), url: OLD, origin: 'url', selectedAtOpen: 'w2', targetChosen: true });
  w.select('w1');
  const r = w.creation.start({ workspaceKey: WK('w1') });
  w.view(r.viewId).navigate(OLD);
  w.creation.resolve();
  assert.equal(w.creation.getOutcome(r.viewId).code, 'already-bound');
  assert.equal(w.manager.get(r.viewId).scope, WK('w2'), 'adopted by the binding it belongs to');
  assert.equal(w.bindings.lookup(OLD).bindingId, other.binding.bindingId);
  assert.equal(w.fake.views.length, 1);
}));
