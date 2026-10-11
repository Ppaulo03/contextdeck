'use strict';

// M01-I3B-3, block 2: no category, no confirmation checkbox, and what `targetChosen` can and cannot do.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createWorld, chatUrl, ws } = require('./helpers/bindings-world');
const { createBindingsStore } = require('../src/main/chat-bindings/store');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { createUnboundActions } = require('../src/main/activity/unbound');

const code = (r) => (r.ok ? 'ok' : r.error.code);
const withWorld = (opts, fn) => { const w = createWorld(opts); try { return fn(w); } finally { w.cleanup(); } };
const ESTIMATE = { selected: { workspaceId: 'w1', origin: 'herdr' } };

test('targetChosen satisfies ONLY the estimate rule: the other destination checks still run', () => withWorld(ESTIMATE, (w) => {
  const base = (extra) => w.args(1, { targetChosen: true, ...extra });
  assert.equal(code(w.bindings.bind(w.args(1))), 'confirmation_required', 'an estimate is not explicit by itself');
  assert.equal(code(w.bindings.bind(base({ target: w.target('w9') }))), 'workspace_not_found');
  assert.equal(code(w.bindings.bind(base({ target: w.target('w1', 'other-session') }))), 'session_mismatch');
  assert.equal(code(w.bindings.bind(base({ selectedAtOpen: 'w2' }))), 'context_changed', 'the selection moved after the choice');
  assert.equal(code(w.bindings.bind(base({ selectedAtOpen: undefined }))), 'invalid_request');
  assert.equal(code(w.bindings.bind(base({ url: 'https://evil.example/c/x' }))), 'foreign_host');
  w.sel.pending = { workspaceId: 'w2' };
  assert.equal(code(w.bindings.bind(base())), 'selection_pending');
  w.sel.pending = null;
  w.disconnect();
  assert.equal(code(w.bindings.bind(base())), 'workspace_unavailable', 'Herdr disconnected: unverified destinations are never written');
  w.connect();
  assert.equal(fs.existsSync(w.file), false, 'nothing was written by any refusal');
  assert.equal(code(w.bindings.bind(base())), 'ok');
}));

test('targetChosen is true-only: truthy values and strings are not a choice', () => withWorld(ESTIMATE, (w) => {
  for (const v of ['true', 1, {}, [], 'yes']) assert.equal(code(w.bindings.bind(w.args(1, { targetChosen: v }))), 'confirmation_required', String(v));
}));

test('targetChosen never overrides a conflict, nor the explicit reassignment rule', () => withWorld(ESTIMATE, (w) => {
  const first = w.bindings.bind(w.args(1, { targetChosen: true }));
  assert.equal(first.ok, true);
  assert.equal(code(w.bindings.bind(w.args(1, { target: w.target('w2'), targetChosen: true }))), 'conflict');
  assert.equal(code(w.bindings.bind(w.args(1, { targetChosen: true }))), 'already_bound');
  const move = { bindingId: first.binding.bindingId, target: w.target('w2'), selectedAtOpen: 'w1', targetChosen: true };
  assert.equal(code(w.bindings.reassign(move)), 'confirmation_required', 'moving needs its own explicit confirmation');
  assert.equal(code(w.bindings.reassign({ ...move, confirmReassign: true })), 'ok');
}));

test('suspect and orphan destinations: a choice does not turn them into verified ones', () => withWorld({}, (w) => {
  const b = w.bindings.bind(w.args(1)).binding;
  w.setWorkspaces([ws('w1', 'totally-other', 'D:/elsewhere'), ws('w2', 'app')]);       // same id, nothing in common
  assert.equal(w.bindings.list(w.target('w1'))[0].status, 'suspect');
  assert.equal(code(w.bindings.bind(w.args(2, { targetChosen: true }))), 'workspace_suspect', 'a flag cannot re-confirm a workspace');
  assert.equal(w.bindings.list(w.target('w1')).find((x) => x.bindingId === b.bindingId).status, 'suspect', 'and the recovery record was not rewritten');
  assert.equal(code(w.bindings.reassign({ bindingId: b.bindingId, target: w.target('w1'), selectedAtOpen: 'w1', confirmReassign: true })), 'ok', 'the explicit way to re-confirm');
  assert.equal(code(w.bindings.bind(w.args(2, { targetChosen: true }))), 'ok');
  w.setWorkspaces([ws('w1', 'totally-other', 'D:/elsewhere'), ws('w2', 'app')]);
  w.setWorkspaces([ws('w2', 'app')]);
  assert.equal(code(w.bindings.bind(w.args(3, { target: w.target('w1'), selectedAtOpen: 'w1', targetChosen: true }))), 'workspace_not_found', 'orphan workspace is not a destination');
  assert.equal(w.bindings.listOrphans().length, 2);
}));

test('no category: a new binding stores none, an old file with categories still loads and keeps them', () => withWorld({}, (w) => {
  const fresh = w.bindings.bind(w.args(1, { role: undefined }));
  assert.equal('role' in fresh.binding, false);
  assert.equal('role' in w.read().bindings[0], false);
  const doc = w.read();
  doc.bindings.push({ ...doc.bindings[0], bindingId: 'b_00000000000000aa', conversationKey: `c:${chatUrl(2).slice(-36)}`, url: chatUrl(2), role: 'review' });
  fs.writeFileSync(w.file, JSON.stringify(doc));
  const store = createBindingsStore({ file: w.file });
  assert.equal(store.info().status, 'ok');
  assert.equal(store.get().bindings.length, 2, 'nothing quarantined');
  assert.equal(store.get().bindings[1].role, 'review', 'the old category is preserved, only no longer shown');
  assert.equal(store.get().bindings[0].role, undefined);
}));

test('the binding survives a restart (store reloaded from disk)', () => withWorld({}, (w) => {
  const r = w.bindings.bind(w.args(1, { label: 'Code Review', targetChosen: true }));
  const again = createBindingsStore({ file: w.file });
  assert.deepEqual(again.get().bindings.map((b) => [b.bindingId, b.label, b.workspaceIdentity.workspaceId]), [[r.binding.bindingId, 'Code Review', 'w1']]);
}));

test('the panel/IPC source has no category control and no confirmation checkbox', () => {
  const panel = fs.readFileSync('src/renderer/overlay/chats-panel.js', 'utf8');
  assert.doesNotMatch(panel, /Categoria|roleSelect|chats-check|type = 'checkbox'|confirmed/);
  const ipc = fs.readFileSync('src/main/ipc/chats.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(ipc, /args\.role/);
});

// ---- with block 1: an unbound conversation -----------------------------------------------------------------------------

test('a refused bind leaves the unbound conversation listed with its view; a good one moves it', async () => {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  try {
    w.select('w1'); bindMany(w, [1]); w.select('w1');
    w.manager.create({ url: w.HOME, scope: null, pristine: true });
    w.navigator.setMode('chat');
    const actions = createUnboundActions({ session: w.session, bindings: w.bindings, navigator: w.navigator, showChatTab: () => {}, getMode: () => 'chat' });
    const { viewId } = actions.create();
    const view = w.fake.views.find((v) => v.id === viewId);
    view.finishLoad(chatUrl(9));
    Object.assign(view.contents.signals, { draft: true });
    await w.clock.advance(6000);
    w.disconnect();
    assert.equal(actions.bind({ viewId, workspaceId: 'w2', selectedAtOpen: 'w1' }).error.code, 'workspace_unavailable');
    assert.equal(w.navigator.getUnbound().length, 1, 'still there');
    w.connect();
    assert.equal(actions.bind({ viewId, workspaceId: 'w2', selectedAtOpen: 'w1' }).ok, true);
    assert.equal(w.navigator.getUnbound().length, 0);
    assert.equal(w.manager.get(viewId).scope, 'contextdeck/w2');
    assert.equal(view.loads.length, 1);
    assert.equal(w.navigator.getGlobalActivity().groups[0].items[0].draft, true, 'the draft indicator moved with the view');
  } finally { w.cleanup0(); }
});
