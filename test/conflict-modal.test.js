'use strict';

// The conflict modal (M01-I3B-3): a page on screen shows a conversation that belongs to another workspace. A real modal, not a
// strip item: not dismissible, three decisions, main closes it. Also: "Voltar" returns to the page that was active before.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDocument, load } = require('./helpers/fake-dom');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws, chatUrl } = require('./helpers/bindings-world');
const { createContextAdoption } = require('../src/main/chat-bindings/context-adoption');
const { bannerOf } = require('../src/shared/chat-nav-view');
const { registerChatNavIpc } = require('../src/main/ipc/chatnav');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const WK = (id) => `contextdeck/${id}`;
const banner = (over = {}) => ({ kind: 'conflict', viewId: 'v3', text: 'Esta conversa pertence ao workspace app (w2). Você está em api (w1).', actions: [{ action: 'go', label: 'Ir para app', title: 'ir' }, { action: 'transfer', label: 'Transferir vínculo…', title: 'mover' }, { action: 'back', label: 'Voltar', title: 'voltar' }], ...over });

function mountOverlay() {
  const document = createDocument(['scrim', 'menu', 'menu-search', 'menu-list', 'menu-message', 'chats', 'chats-body', 'chats-message', 'chats-close', 'activity', 'activity-body', 'activity-message', 'activity-close', 'conflict', 'conflict-text', 'conflict-actions', 'conflict-message', 'notices']);
  for (const id of ['scrim', 'chats', 'chats-message', 'activity', 'activity-message', 'notices', 'conflict', 'conflict-message']) document.getElementById(id).hidden = true;
  let openCb; let pushCb; const calls = { resolve: [], close: 0 }; let result = { ok: true };
  const window = {
    innerWidth: 1200,
    overlay: {
      getState: async () => ({}), choose: async () => ({ ok: true }), close: async () => { calls.close += 1; },
      onOpen: (cb) => { openCb = cb; return () => {}; }, onState: () => () => {}, onChatsState: () => () => {}, onActivityState: () => () => {},
      onConflict: (cb) => { pushCb = cb; return () => {}; },
      activityState: async () => null, activityOpen: async () => ({ ok: false }), activityDismiss: async () => ({ ok: true }), activityOpenUnbound: async () => ({ ok: true }),
      chatsState: async () => null, chatsBind: async () => ({ ok: false }), chatsUpdate: async () => ({ ok: false }), chatsUnbind: async () => ({ ok: false }), chatsReassign: async () => ({ ok: false }),
      conflictResolve: async (a) => { calls.resolve.push(a); return result; }
    }
  };
  load(path.join(SRC, 'overlay', 'overlay.js'), { document, window });
  const get = (id) => document.getElementById(id);
  const collect = (root, out = []) => { for (const c of root.children) { out.push(c); collect(c, out); } return out; };
  return {
    document, calls, get, scrim: get('scrim'), panel: get('conflict'), message: get('conflict-message'),
    buttons: () => collect(get('conflict-actions')).filter((n) => n.tag === 'button'),
    open: async (b = banner()) => { await openCb({ kind: 'conflict', banner: b }); },
    push: (b) => pushCb({ banner: b }),
    click: async (n) => { await n.fire('click'); await new Promise((r) => setImmediate(r)); },
    key: (k, extra = {}) => document.fire('keydown', { key: k, ...extra }),
    setResult: (r) => { result = r; }
  };
}

test('the modal shows the sentence and the three decisions; the first button has the focus; the scrim covers the window', async () => {
  const o = mountOverlay();
  await o.open();
  assert.equal(o.panel.hidden, false);
  assert.equal(o.scrim.hidden, false);
  assert.equal(o.get('conflict-text').textContent, banner().text);
  assert.deepEqual(o.buttons().map((b) => b.textContent), ['Ir para app', 'Transferir vínculo…', 'Voltar']);
  assert.equal(o.document.activeElement, o.buttons()[0]);
  const html = fs.readFileSync(path.join(SRC, 'overlay', 'overlay.html'), 'utf8');
  assert.match(html, /id="conflict"[^>]*role="alertdialog"[^>]*aria-modal="true"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="conflict"'), html.indexOf('id="chats"')), /conflict-close|&times;/, 'no close button');
});

test('nothing dismisses it: Escape, a click outside and the overlay close path do nothing', async () => {
  const o = mountOverlay();
  await o.open();
  await o.key('Escape');
  await o.scrim.fire('mousedown', { target: o.scrim });
  assert.equal(o.panel.hidden, false);
  assert.equal(o.scrim.hidden, false);
  assert.equal(o.calls.close, 0, 'no close request ever reaches main');
  assert.deepEqual(o.calls.resolve, []);
});

test('Tab, Shift+Tab and the arrows stay between the buttons (focus never leaves the modal)', async () => {
  const o = mountOverlay();
  await o.open();
  const [go, transfer, back] = o.buttons();
  await o.key('Tab'); assert.equal(o.document.activeElement, transfer);
  await o.key('Tab'); assert.equal(o.document.activeElement, back);
  await o.key('Tab'); assert.equal(o.document.activeElement, go, 'wraps');
  await o.key('Tab', { shiftKey: true }); assert.equal(o.document.activeElement, back);
  await o.key('ArrowLeft'); assert.equal(o.document.activeElement, transfer);
});

test('go and back send exactly the page and the action; transfer needs a second click (the first one arms it)', async () => {
  const o = mountOverlay();
  await o.open();
  await o.click(o.buttons()[2]);
  assert.deepEqual(o.calls.resolve, [{ viewId: 'v3', action: 'back' }]);
  await o.click(o.buttons()[1]);
  assert.equal(o.calls.resolve.length, 1, 'armed, nothing sent');
  assert.equal(o.buttons()[1].textContent, 'Confirmar transferência');
  await o.click(o.buttons()[1]);
  assert.deepEqual(o.calls.resolve[1], { viewId: 'v3', action: 'transfer' });
  await o.click(o.buttons()[0]);
  assert.deepEqual(o.calls.resolve[2], { viewId: 'v3', action: 'go' });
});

test('a refused decision is shown inside the modal, which stays open for another choice', async () => {
  const o = mountOverlay();
  o.setResult({ ok: false, error: { code: 'context_changed', message: 'O workspace selecionado mudou. Revise a escolha.' } });
  await o.open();
  await o.click(o.buttons()[2]);
  assert.equal(o.message.textContent, 'O workspace selecionado mudou. Revise a escolha.');
  assert.equal(o.panel.hidden, false);
  assert.equal(o.buttons().every((b) => !b.disabled), true);
});

test('a push with another conflict re-renders in place; the armed transfer is forgotten when the page changes; text is never markup', async () => {
  const o = mountOverlay();
  await o.open();
  await o.click(o.buttons()[1]);
  o.push(banner({ viewId: 'v9', text: '<img src=x onerror=alert(1)> pertence a w5' }));
  assert.equal(o.get('conflict-text').textContent, '<img src=x onerror=alert(1)> pertence a w5');
  assert.equal(o.buttons()[1].textContent, 'Transferir vínculo…', 'not armed for the new page');
  assert.equal(o.get('conflict-text').children.length, 0);
});

// ---- main side -------------------------------------------------------------------------------------------------------------------

test('conflict:resolve is overlay-only, validated, and takes only go / transfer / back (retry stays on the strip channel)', async () => {
  const handlers = new Map(); const calls = [];
  registerChatNavIpc({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, trusted: (e) => e.ui === true, trustedOverlay: (e) => e.overlay === true, win: { getNavigator: () => ({}) }, resolve: (a) => { calls.push(a); return { ok: true }; } });
  const call = (args, e) => handlers.get('conflict:resolve')(e, args);
  assert.equal((await call({ viewId: 'v3', action: 'go', url: 'x', workspaceId: 'w9' }, { overlay: true })).ok, true);
  assert.deepEqual(calls, [{ viewId: 'v3', action: 'go' }]);
  assert.equal((await call({ viewId: 'v3', action: 'go' }, { ui: true })).error.code, 'untrusted');
  assert.equal((await call({ viewId: 'v3', action: 'go' }, {})).error.code, 'untrusted');
  for (const bad of [{ viewId: 'v3', action: 'retry' }, { viewId: 'v3', action: 'adopt' }, { viewId: '3', action: 'go' }, { action: 'go' }, null]) assert.equal((await call(bad, { overlay: true })).error.code, 'invalid_request', JSON.stringify(bad));
  assert.equal(calls.length, 1);
});

test('the window keeps the modal STATE-driven: shortcut swallowed, re-shown when closed by a resize, closed only when the conflict is gone', () => {
  const win = fs.readFileSync('src/main/window.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.match(win, /function syncConflict\(\)/);
  assert.match(win, /if \(conflictOpen\) \{ if \(input && input\.control/, 'the tab shortcut is swallowed while the modal is open');
  assert.match(win, /if \(conflictOpen && kind === 'conflict'\)/, 'closed by anything else -> shown again');
  assert.match(win, /navigator\.onChange\(\(state\) => \{ lastNavState = state; onNavChange\?\.\(\); syncConflict\(\); \}\)/);
  assert.match(win, /conflict && conflict\.kind === 'conflict'/);
});

// ---- "Voltar" goes to the page that was active before ---------------------------------------------------------------------------------------
test('Voltar returns to the page that was active before the conflicting one (not to the other workspace)', () => {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  try {
    w.select('w1'); const [c1, c2] = bindMany(w, [1, 2]);
    w.select('w2'); const [d] = bindMany(w, [4]);
    w.select('w1');
    w.navigator.setMode('chat');
    const adoption = createContextAdoption({ session: w.session, navigator: w.navigator, bindings: w.bindings, selection: w.selection });
    const v1 = w.navigator.selectBinding({ bindingId: c1.bindingId, workspaceKey: WK('w1') }).viewId;
    w.clock.t += 10;
    const v2 = w.navigator.selectBinding({ bindingId: c2.bindingId, workspaceKey: WK('w1') }).viewId;   // the last page active in w1
    w.clock.t += 10;
    const fresh = w.navigator.newConversation({ workspaceKey: WK('w1') }).viewId;
    w.fake.views.find((v) => v.id === fresh).navigate(d.url);                                           // a conversation of w2
    assert.equal(w.navigator.getState().conflict.viewId, fresh);
    w.clock.t += 10;
    assert.equal(adoption.back({ viewId: fresh }).ok, true);
    assert.equal(w.manager.getVisibleId(), v2, 'the page active before the conflict, in the same workspace');
    assert.equal(w.manager.get(fresh).scope, WK('w2'), 'the conflicting page waits in its own workspace');
    assert.equal(w.sel.selected.workspaceId, 'w1');
    assert.deepEqual(w.selectCalls, []);
    assert.notEqual(v1, v2);
  } finally { w.cleanup0(); }
});

test('Voltar from a tab that navigated away (sidebar click inside the same page) returns THAT page to its conversation', () => {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  try {
    w.select('w1'); const [c1] = bindMany(w, [1]);
    w.select('w2'); const [d] = bindMany(w, [4]);
    w.select('w1');
    w.navigator.setMode('chat');
    const adoption = createContextAdoption({ session: w.session, navigator: w.navigator, bindings: w.bindings, selection: w.selection });
    const id = w.navigator.selectBinding({ bindingId: c1.bindingId, workspaceKey: WK('w1') }).viewId;
    const view = w.fake.views.find((v) => v.id === id);
    view.finishLoad(c1.url);
    view.navigate(d.url);                                           // the user clicked a chat of w2 in the sidebar
    assert.equal(w.navigator.getState().conflict.viewId, id);
    assert.equal(adoption.back({ viewId: id }).how, 'history');
    assert.equal(w.navigator.getState().conflict, null);
    assert.equal(w.manager.get(id).identity.key, c1.conversationKey, 'the same page shows the conversation it had');
    assert.equal(w.manager.getVisibleId(), id, 'and it is still on screen: not the empty state');
    assert.equal(w.manager.get(id).scope, WK('w1'));
    assert.equal(w.fake.views.length, 1);
    assert.equal(w.bindings.lookup(d.url).workspaceIdentity.workspaceId, 'w2', 'the other binding is untouched');
  } finally { w.cleanup0(); }
});

test('the strip does not duplicate the modal: only a pending association is offered there', () => {
  const strip = fs.readFileSync('src/renderer/components/chat-strip.js', 'utf8');
  assert.match(strip, /model\.banner\.kind === 'pending'/);
  assert.equal(bannerOf({ conflict: { viewId: 'v1', boundTo: { id: 'w2', label: 'app', openable: true }, current: { id: 'w1', label: 'api' }, transferable: false } }).actions.map((a) => a.action).join(), 'go,back');
});

// ---- "Ir para <workspace>": the origin workspace also gets its "Voltar" --------------------------------------------------------------------------
test('Ir para: the origin page goes back first and waits, THEN the other workspace opens the conversation (never taking the page with it)', async () => {
  const { createDirectOpen } = require('../src/main/activity/direct-open');
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  try {
    w.select('w1'); const [c1] = bindMany(w, [1]);
    w.select('w2'); const [d] = bindMany(w, [4]);
    w.select('w1');
    w.navigator.setMode('chat');
    const adoption = createContextAdoption({ session: w.session, navigator: w.navigator, bindings: w.bindings, selection: w.selection, wait: () => new Promise((r) => setImmediate(r)) });
    const id = w.navigator.selectBinding({ bindingId: c1.bindingId, workspaceKey: WK('w1') }).viewId;
    const view = w.fake.views.find((v) => v.id === id);
    view.finishLoad(c1.url);
    // The user opened, in w1's page, the conversation that belongs to w2 (which already has its own page for it).
    const own = w.navigator.selectBinding({ bindingId: d.bindingId, workspaceKey: WK('w2') });
    void own;
    view.navigate(d.url);
    const directOpen = createDirectOpen({ session: w.session, selection: w.selection, navigator: { resolveActivityTarget: (a) => w.navigator.resolveActivityTarget(a), selectBinding: (a) => w.navigator.selectBinding(a), selectTemporary: (a) => w.navigator.selectTemporary(a) }, showChatTab: () => {}, getMode: () => 'chat' });
    const left = await adoption.leave({ viewId: id });
    assert.equal(left.ok, true);
    assert.equal(w.manager.get(id).identity.key, c1.conversationKey, 'the origin page is back on its own conversation');
    const opened = await directOpen.open({ workspaceId: 'w2', bindingId: d.bindingId });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    assert.equal(w.sel.selected.workspaceId, 'w2');
    assert.equal(w.manager.get(id).scope, WK('w1'), 'the origin page stayed in its workspace');
    assert.equal(w.manager.get(id).identity.key, c1.conversationKey);
    assert.equal(w.manager.duplicates().length, 0, 'no page left showing the conflicting conversation in w1');
    w.select('w1');
    assert.equal(w.navigator.getState().conflict, null, 'coming back: nothing conflicting is there');
    assert.equal(w.manager.getVisibleId(), id, 'and the tab is its old conversation');
  } finally { w.cleanup0(); }
});

test('Ir para: if the page does not leave the conversation, nothing else happens', async () => {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  try {
    w.select('w1'); const [c1] = bindMany(w, [1]);
    w.select('w2'); const [d] = bindMany(w, [4]);
    w.select('w1');
    w.navigator.setMode('chat');
    const adoption = createContextAdoption({ session: w.session, navigator: w.navigator, bindings: w.bindings, selection: w.selection, wait: () => new Promise((r) => setImmediate(r)), leaveTimeoutMs: 30 });
    const id = w.navigator.selectBinding({ bindingId: c1.bindingId, workspaceKey: WK('w1') }).viewId;
    const view = w.fake.views.find((v) => v.id === id);
    view.finishLoad(c1.url);
    view.navigate(d.url);
    view.goBack = () => true;                                       // the browser accepts the request but never navigates
    const r = await adoption.leave({ viewId: id });
    assert.equal(r.error.code, 'back_failed');
    assert.equal(w.sel.selected.workspaceId, 'w1');
    assert.deepEqual(w.selectCalls, []);
  } finally { w.cleanup0(); }
});
