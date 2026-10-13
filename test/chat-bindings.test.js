'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createWorld, ws, chatUrl, projectUrl, ID } = require('./helpers/bindings-world');

const withWorld = (opts, fn) => {
  const world = createWorld(opts);
  try { return fn(world); } finally { world.cleanup(); }
};
const code = (r) => (r.ok ? 'ok' : r.error.code);

// ---- one workspace, many conversations; identity of contexts ----------------------------------------------

test('a workspace can hold several conversations; each has its own id and label; no category is required', () => withWorld({}, (w) => {
  const a = w.bindings.bind(w.args(1, { label: ' Arquitetura  base ', role: undefined }));
  const b = w.bindings.bind(w.args(2, { label: 'Review', role: undefined }));
  const c = w.bindings.bind(w.args(3, { url: projectUrl(3), label: '', role: undefined }));
  assert.deepEqual([a.ok, b.ok, c.ok], [true, true, true]);
  assert.equal(a.binding.label, 'Arquitetura base', 'whitespace collapsed');
  assert.notEqual(a.binding.bindingId, b.binding.bindingId);
  assert.equal('role' in c.binding, false, 'new bindings carry no category');
  assert.equal('role' in w.read().bindings[2], false, 'and none is written to disk');
  assert.equal(c.binding.url, projectUrl(3), 'project route kept');
  const listed = w.bindings.list(w.target('w1'));
  assert.deepEqual(listed.map((x) => x.label), ['Arquitetura base', 'Review', '']);
  assert.ok(listed.every((x) => x.status === 'linked' && x.workspaceIdentity.workspaceId === 'w1'));
  assert.deepEqual(w.bindings.list(w.target('w2')), []);
}));

test('two workspaces with the same name are different contexts (identity is session + id, never the name)', () => withWorld({ workspaces: [ws('w1', 'app'), ws('w2', 'app')] }, (w) => {
  assert.ok(w.bindings.bind(w.args(1)).ok);
  w.select('w2');
  assert.ok(w.bindings.bind(w.args(2)).ok);
  assert.deepEqual(w.bindings.list(w.target('w1')).map((b) => b.conversationKey), [`c:${ID(1)}`]);
  assert.deepEqual(w.bindings.list(w.target('w2')).map((b) => b.conversationKey), [`c:${ID(2)}`]);
  assert.equal(Object.keys(w.read().contexts).length, 2);
}));

test('the same workspace id in different Herdr sessions is a different context; bindings of another session are preserved, not judged', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  // Hand-write a binding of another session that reuses "w1".
  const data = w.read();
  data.bindings.push({ ...data.bindings[0], bindingId: 'b_00000000000000aa', conversationKey: `c:${ID(2)}`, url: chatUrl(2), workspaceIdentity: { session: 'lab', workspaceId: 'w1' } });
  fs.writeFileSync(w.file, JSON.stringify(data));
  w.store.load();
  assert.deepEqual(w.bindings.list(w.target('w1')).map((b) => b.conversationKey), [`c:${ID(1)}`]);
  assert.deepEqual(w.bindings.list(w.target('w1', 'lab')).map((b) => [b.conversationKey, b.status]), [[`c:${ID(2)}`, 'other-session']]);
  assert.deepEqual(w.bindings.listOrphans(), [], 'another session is never reported as orphan');
  // Writing to the other session is refused.
  assert.equal(code(w.bindings.bind(w.args(3, { target: w.target('w1', 'lab') }))), 'session_mismatch');
}));

// ---- duplicates, conflicts, reassignment ---------------------------------------------------------------------

test('binding the same conversation twice is refused, also through another URL form of the same conversation', () => withWorld({}, (w) => {
  assert.ok(w.bindings.bind(w.args(1)).ok);
  const again = w.bindings.bind(w.args(1));
  assert.equal(code(again), 'already_bound');
  assert.equal(again.error.binding.label, 'chat 1');
  assert.equal(code(w.bindings.bind(w.args(1, { url: projectUrl(1) }))), 'already_bound', 'same id through a project route');
  assert.equal(code(w.bindings.bind(w.args(1, { url: chatUrl(1) + '?model=x#y' }))), 'already_bound');
  assert.equal(w.read().bindings.length, 1);
}));

test('a conversation bound elsewhere is a conflict: nothing changes until an explicit reassign', () => withWorld({}, (w) => {
  const first = w.bindings.bind(w.args(1));
  w.select('w2');
  const conflict = w.bindings.bind(w.args(1, { label: 'other' }));
  assert.equal(code(conflict), 'conflict');
  assert.equal(conflict.error.binding.workspaceIdentity.workspaceId, 'w1');
  assert.equal(conflict.error.binding.bindingId, first.binding.bindingId);
  assert.deepEqual(w.bindings.list(w.target('w2')), []);
  assert.equal(w.read().bindings[0].workspaceIdentity.workspaceId, 'w1');

  const base = { bindingId: first.binding.bindingId, target: w.target('w2'), selectedAtOpen: 'w2' };
  assert.equal(code(w.bindings.reassign({ ...base })), 'confirmation_required', 'no confirmation flag');
  assert.equal(code(w.bindings.reassign({ ...base, confirmReassign: 'yes' })), 'confirmation_required', 'truthy is not true');
  assert.equal(w.read().bindings[0].workspaceIdentity.workspaceId, 'w1', 'still untouched');

  const moved = w.bindings.reassign({ ...base, confirmReassign: true });
  assert.equal(moved.ok, true);
  assert.equal(moved.binding.workspaceIdentity.workspaceId, 'w2');
  assert.equal(moved.binding.bindingId, first.binding.bindingId, 'identity of the binding is stable');
  assert.equal(moved.binding.label, 'chat 1', 'label and category survive the move');
  assert.deepEqual(w.bindings.list(w.target('w1')), []);
  assert.equal(w.bindings.list(w.target('w2')).length, 1);
  assert.equal(w.bindings.reassign({ ...base, bindingId: 'b_ffffffffffffffff', confirmReassign: true }).error.code, 'binding_not_found');
}));

test('a legacy category passed by an old caller is still stored, validated and left alone by label edits', () => withWorld({}, (w) => {
  const { binding } = w.bindings.bind(w.args(1, { role: 'planning' }));
  assert.equal(binding.role, 'planning');
  assert.equal(w.bindings.bind(w.args(2, { role: 'boss' })).error.code, 'invalid_role');
  assert.equal(w.bindings.update({ bindingId: binding.bindingId, label: 'novo' }).binding.role, 'planning', 'editing the label keeps an existing category');
}));

test('labels can be changed; invalid values change nothing; unknown ids are reported', () => withWorld({}, (w) => {
  const { binding } = w.bindings.bind(w.args(1, { role: undefined }));
  const before = w.read();
  assert.equal(w.bindings.update({ bindingId: binding.bindingId, label: 'Novo\u0000 nome' }).binding.label, 'Novo nome');
  const both = w.bindings.update({ bindingId: binding.bindingId, label: 'x' });
  assert.equal(both.binding.label, 'x');
  assert.ok(w.read().bindings[0].updatedAt > before.bindings[0].updatedAt);
  assert.equal(w.read().bindings[0].createdAt, before.bindings[0].createdAt);
  assert.equal(w.read().bindings[0].url, before.bindings[0].url, 'metadata edits leave identity alone');
  const snapshot = fs.readFileSync(w.file, 'utf8');
  for (const bad of [{ label: 'y'.repeat(81) }, { label: 42 }, { role: 'boss' }, {}]) {
    assert.equal(w.bindings.update({ bindingId: binding.bindingId, ...bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(code(w.bindings.update({ bindingId: 'b_ffffffffffffffff', label: 'z' })), 'binding_not_found');
  assert.equal(fs.readFileSync(w.file, 'utf8'), snapshot, 'rejected edits did not write');
}));

test('unbinding removes only that binding; the others and the other workspaces stay', () => withWorld({}, (w) => {
  const a = w.bindings.bind(w.args(1)).binding;
  w.bindings.bind(w.args(2));
  w.select('w2');
  w.bindings.bind(w.args(3));
  assert.equal(w.bindings.unbind({ bindingId: a.bindingId }).ok, true);
  assert.deepEqual(w.bindings.list(w.target('w1')).map((b) => b.conversationKey), [`c:${ID(2)}`]);
  assert.equal(w.bindings.list(w.target('w2')).length, 1);
  assert.equal(code(w.bindings.unbind({ bindingId: a.bindingId })), 'binding_not_found');
  assert.equal(w.bindings.lookup(chatUrl(1)), null, 'it can be bound again later');
  assert.ok(w.bindings.bind(w.args(1)).ok);
  // The last binding of a workspace drops its recovery record too.
  for (const left of w.bindings.list(w.target('w2'))) w.bindings.unbind({ bindingId: left.bindingId });
  assert.deepEqual(Object.keys(w.read().contexts), ['contextdeck/w1']);
}));

test('limits are enforced with a message', () => withWorld({}, (w) => {
  const { LIMITS } = require('../src/main/chat-bindings/model');
  // Fill one workspace to its limit by writing a valid file, then reload.
  const bindings = Array.from({ length: LIMITS.perWorkspace }, (_, i) => ({
    bindingId: `b_${String(i + 5000).padStart(16, '0')}`, conversationKey: `c:${ID(1).slice(0, 24)}${String(i).padStart(12, '0')}`, url: `https://chatgpt.com/c/${ID(1).slice(0, 24)}${String(i).padStart(12, '0')}`,
    label: '', role: 'general', origin: 'url', workspaceIdentity: { session: 'contextdeck', workspaceId: 'w1' }, createdAt: 1, updatedAt: 1
  }));
  fs.writeFileSync(w.file, JSON.stringify({ schema: 1, contexts: { 'contextdeck/w1': { session: 'contextdeck', workspaceId: 'w1', label: 'api', directory: 'C:\\work\\api', seenAt: 1 } }, bindings, quarantine: [] }));
  w.store.load();
  assert.equal(w.store.get().bindings.length, LIMITS.perWorkspace);
  assert.equal(code(w.bindings.bind(w.args(9))), 'limit_reached');
  w.select('w2');
  assert.ok(w.bindings.bind(w.args(9)).ok, 'another workspace still has room');
  const moving = w.bindings.list(w.target('w2'))[0];
  assert.equal(code(w.bindings.reassign({ bindingId: moving.bindingId, target: w.target('w1'), selectedAtOpen: 'w2', confirmTarget: true, confirmReassign: true })), 'limit_reached', 'moving into a full workspace is refused too');
}));

// ---- identity of the conversation ------------------------------------------------------------------------------

test('a new chat or an unknown page cannot be bound: it must acquire a persistent identity first', () => withWorld({}, (w) => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com/?temporary-chat=true', 'https://chatgpt.com/g/g-p-abc123-demo/project']) {
    const r = w.bindings.bind(w.args(1, { url }));
    assert.equal(r.error.code, 'identity_pending', url);
    assert.match(r.error.message, /identidade persistente/);
  }
  for (const [url, expected] of [['not a url', 'invalid_url'], ['http://chatgpt.com/c/' + ID(1), 'insecure_protocol'], ['https://evil.example/c/' + ID(1), 'foreign_host'], ['https://chatgpt.com/share/x', 'not_a_conversation'], [undefined, 'invalid_url']]) {
    assert.equal(code(w.bindings.bind(w.args(1, { url }))), expected, String(url));
  }
  assert.equal(fs.existsSync(w.file), false, 'nothing was written');
}));

// ---- Herdr is the source of truth: validation of the destination ------------------------------------------------

test('workspace unavailable: Herdr disconnected, workspace gone, wrong session, malformed target', () => withWorld({}, (w) => {
  assert.equal(code(w.bindings.bind(w.args(1, { target: w.target('w9') }))), 'workspace_not_found');
  assert.equal(code(w.bindings.bind(w.args(1, { target: w.target('w1', 'other') }))), 'session_mismatch');
  for (const target of [null, undefined, 'w1', {}, { session: 'contextdeck' }, { session: 'contextdeck', workspaceId: 7 }, { session: 'x/y', workspaceId: 'w1' }, { session: 'contextdeck', workspaceId: '../w1' }]) {
    assert.equal(code(w.bindings.bind(w.args(1, { target }))), 'invalid_target', JSON.stringify(target));
  }
  w.disconnect();
  assert.equal(code(w.bindings.bind(w.args(1))), 'workspace_unavailable');
  assert.equal(code(w.bindings.reassign({ bindingId: 'b_ffffffffffffffff', target: w.target('w1'), selectedAtOpen: 'w1', confirmReassign: true })), 'binding_not_found');
  w.connect();
  assert.ok(w.bindings.bind(w.args(1)).ok, 'reconnected: works again');
}));

test('the form must say which workspace was selected when it opened (a missing answer is refused)', () => withWorld({}, (w) => {
  assert.equal(code(w.bindings.bind(w.args(1, { selectedAtOpen: undefined }))), 'invalid_request');
  assert.equal(code(w.bindings.bind(w.args(1, { selectedAtOpen: 3 }))), 'invalid_request');
  assert.equal(fs.existsSync(w.file), false);
}));

test('focus changed while the form was open: nothing is written to the old or the new workspace; reviewing fixes it', () => withWorld({}, (w) => {
  const args = w.args(1);                         // opened with w1 selected
  w.select('w2');                                 // Herdr/the user moved the focus meanwhile
  const refused = w.bindings.bind(args);
  assert.equal(refused.error.code, 'context_changed');
  assert.equal(refused.error.selected, 'w2');
  assert.equal(code(w.bindings.bind({ ...args, target: w.target('w2') })), 'context_changed', 'targeting the new one silently is refused as well');
  assert.equal(fs.existsSync(w.file), false, 'nothing written anywhere');
  const reviewed = w.bindings.bind({ ...args, target: w.target('w2'), selectedAtOpen: 'w2' });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.binding.workspaceIdentity.workspaceId, 'w2');
  // Same rule when the selection becomes empty (workspace removed under the selector).
  w.select(null);
  assert.equal(code(w.bindings.bind(w.args(2, { selectedAtOpen: 'w2', target: w.target('w2') }))), 'context_changed');
}));

test('a workspace switch in progress blocks writes', () => withWorld({}, (w) => {
  w.sel.pending = { workspaceId: 'w2' };
  assert.equal(code(w.bindings.bind(w.args(1))), 'selection_pending');
  w.sel.pending = null;
  assert.ok(w.bindings.bind(w.args(1)).ok);
}));

test('ambiguous focus: an estimated destination needs explicit confirmation; an explicit pick or a lone workspace does not', () => withWorld({ selected: { workspaceId: 'w1', origin: 'herdr' } }, (w) => {
  assert.equal(code(w.bindings.bind(w.args(1))), 'confirmation_required', 'followed the last Herdr focus: only an estimate');
  assert.equal(code(w.bindings.bind(w.args(1, { confirmTarget: 'true' }))), 'confirmation_required');
  assert.ok(w.bindings.bind(w.args(1, { confirmTarget: true })).ok);
  w.select('w1', 'recovery');
  assert.equal(code(w.bindings.bind(w.args(2))), 'confirmation_required', 'restored after restart: still an estimate');
  w.select('w1', 'dock');
  assert.ok(w.bindings.bind(w.args(2)).ok, 'the user picked it in ContextDeck');
  w.select('w2', 'dock');
  assert.equal(code(w.bindings.bind(w.args(3, { target: w.target('w1'), selectedAtOpen: 'w2' }))), 'confirmation_required', 'binding to a workspace other than the explicit one needs confirmation too');
  w.setWorkspaces([ws('w1', 'api')]);       // the same workspace, now alone in the session
  w.select('w1', 'herdr');
  assert.ok(w.bindings.bind(w.args(3)).ok, 'a session with a single workspace is not ambiguous');
}));

test('binding never changes Herdr or the selection: the service only reads them', () => withWorld({}, (w) => {
  const calls = [];
  const spy = (obj, name) => new Proxy(obj, { get: (t, p) => { calls.push(`${name}.${String(p)}`); return t[p]; } });
  const { createChatBindings } = require('../src/main/chat-bindings/service');
  const svc = createChatBindings({ store: w.store, session: 'contextdeck', observer: spy({ getState: () => ({ connection: 'connected', model: { workspaces: w.herdr.workspaces } }), onChange() {} }, 'observer'), selection: spy({ getState: () => ({ selected: { workspaceId: 'w1', origin: 'dock' }, pending: null }), onChange() {} }, 'selection') });
  svc.bind(w.args(1)); svc.getState({ url: chatUrl(1) }); svc.listOrphans();
  assert.deepEqual([...new Set(calls)].sort(), ['observer.getState', 'selection.getState']);
}));

// ---- orphans and recreated workspaces -----------------------------------------------------------------------------

test('removing a workspace in Herdr keeps its bindings: they become orphans and can be reassigned explicitly', () => withWorld({}, (w) => {
  const a = w.bindings.bind(w.args(1, { label: 'keep me' })).binding;
  w.bindings.bind(w.args(2));
  w.setWorkspaces([ws('w2', 'app')]);                     // w1 closed in Herdr
  w.select('w2');
  assert.deepEqual(w.bindings.listOrphans().map((b) => b.bindingId).sort(), w.bindings.list(w.target('w1')).map((b) => b.bindingId).sort());
  assert.equal(w.bindings.listOrphans().length, 2);
  assert.equal(w.read().bindings.length, 2, 'nothing deleted');
  assert.ok(w.bindings.listOrphans().every((b) => b.status === 'orphan' && b.workspaceLabel === 'api'), 'the old name is remembered for the user');
  // Adopting one orphan needs the explicit confirmation and a verified destination.
  const adopt = { bindingId: a.bindingId, target: w.target('w2'), selectedAtOpen: 'w2' };
  assert.equal(code(w.bindings.reassign(adopt)), 'confirmation_required');
  assert.equal(w.bindings.reassign({ ...adopt, confirmReassign: true }).binding.status, 'linked');
  assert.equal(w.bindings.listOrphans().length, 1);
  const second = w.bindings.listOrphans()[0];
  assert.equal(code(w.bindings.reassign({ bindingId: second.bindingId, target: w.target('w1'), selectedAtOpen: 'w2', confirmReassign: true })), 'workspace_not_found', 'cannot adopt into a workspace that does not exist');
}));

test('Herdr disconnected: bindings are unverified, never reported as orphans', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  w.disconnect();
  assert.deepEqual(w.bindings.list(w.target('w1')).map((b) => b.status), ['unverified']);
  assert.deepEqual(w.bindings.listOrphans(), []);
}));

test('renaming a workspace is retained but marked suspect until explicit reconfirmation', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  w.setWorkspaces([ws('w1', 'api-renamed', 'C:\\work\\api'), ws('w2', 'app')]);
  const [b] = w.bindings.list(w.target('w1'));
  assert.equal(b.status, 'suspect');
  assert.equal(w.read().contexts['contextdeck/w1'].label, 'api', 'old recovery label is retained');
  const confirmed = w.bindings.reassign({ bindingId: b.bindingId, target: w.target('w1'), selectedAtOpen: 'w1', confirmReassign: true });
  assert.equal(confirmed.binding.status, 'linked');
  assert.equal(w.read().contexts['contextdeck/w1'].label, 'api-renamed', 'explicit confirmation refreshes recovery metadata');
  assert.equal(w.read().bindings[0].workspaceIdentity.workspaceId, 'w1');
}));

test('same id, completely different workspace (recreated session): the binding is flagged suspect, never silently reused', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  w.setWorkspaces([ws('w1', 'totally-other', 'D:\\elsewhere'), ws('w2', 'app')]);
  const [b] = w.bindings.list(w.target('w1'));
  assert.equal(b.status, 'suspect');
  assert.equal(w.read().contexts['contextdeck/w1'].label, 'api', 'the old record is not overwritten by a suspect match');
  const state = w.bindings.getState({ url: chatUrl(1) });
  assert.equal(state.bindings[0].status, 'suspect');
  // The user can re-confirm by reassigning to that very workspace; then the record follows it.
  const ok = w.bindings.reassign({ bindingId: b.bindingId, target: w.target('w1'), selectedAtOpen: 'w1', confirmReassign: true });
  assert.equal(ok.binding.status, 'linked');
  assert.equal(w.read().contexts['contextdeck/w1'].label, 'totally-other');
}));

test('same id and name with a changed directory is suspect; a matching directory with a renamed label is also reconfirmed', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  w.setWorkspaces([ws('w1', 'api', 'D:\\elsewhere'), ws('w2', 'app')]);
  assert.equal(w.bindings.list(w.target('w1'))[0].status, 'suspect');
  w.setWorkspaces([ws('w1', 'api-renamed', 'C:\\work\\api'), ws('w2', 'app')]);
  assert.equal(w.bindings.list(w.target('w1'))[0].status, 'suspect');
}));

// ---- the indicator -----------------------------------------------------------------------------------------------

test('current page indicator: bound here, bound elsewhere, unbound, identity unknown', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  const at = (url) => w.bindings.describeCurrent(url);
  assert.equal(at(chatUrl(1)).state, 'bound-here');
  assert.equal(at(projectUrl(1)).state, 'bound-here', 'also through a project route');
  assert.equal(at(chatUrl(2)).state, 'unbound');
  w.select('w2');
  const elsewhere = at(chatUrl(1));
  assert.equal(elsewhere.state, 'bound-elsewhere');
  assert.equal(elsewhere.binding.workspaceIdentity.workspaceId, 'w1');
  for (const [url, reason] of [['https://chatgpt.com/', 'new'], ['https://chatgpt.com/share/x', 'not-a-conversation'], ['', 'no-page'], [null, 'no-page'], ['junk', 'invalid-url']]) {
    assert.deepEqual([at(url).state, at(url).reason], ['unknown', reason], String(url));
  }
  w.select(null);
  assert.equal(at(chatUrl(1)).state, 'bound-elsewhere', 'no selected workspace: it is not bound to "here"');
}));

test('state snapshot for the UI: compact, complete and free of transient data', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  const state = w.bindings.getState({ url: chatUrl(1) });
  assert.deepEqual(Object.keys(state).sort(), ['bindings', 'connection', 'current', 'pending', 'selected', 'session', 'store', 'workspaces']);
  assert.deepEqual(state.selected, { workspaceId: 'w1', origin: 'dock' });
  assert.equal('roles' in state, false);
  assert.doesNotMatch(JSON.stringify(state), /generation|responding|draft|attention/);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state, 'plain JSON');
}));

test('write failure: the operation reports it and nothing changes in memory or on disk', () => withWorld({}, (w) => {
  assert.ok(w.bindings.bind(w.args(1)).ok);
  const disk = fs.readFileSync(w.file, 'utf8');
  const original = w.store.save;
  w.store.save = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  assert.equal(code(w.bindings.bind(w.args(2))), 'write_failed');
  assert.equal(code(w.bindings.update({ bindingId: w.store.get().bindings[0].bindingId, label: 'new' })), 'write_failed');
  assert.equal(code(w.bindings.unbind({ bindingId: w.store.get().bindings[0].bindingId })), 'write_failed');
  w.store.save = original;
  assert.equal(w.store.get().bindings.length, 1);
  assert.equal(w.store.get().bindings[0].label, 'chat 1');
  assert.equal(fs.readFileSync(w.file, 'utf8'), disk);
}));

test('read-only store (future schema): every write is refused, reads still work', () => withWorld({}, (w) => {
  fs.writeFileSync(w.file, JSON.stringify({ schema: 99 }));
  w.store.load();
  assert.equal(code(w.bindings.bind(w.args(1))), 'store_readonly');
  assert.equal(w.bindings.getState().store.writable, false);
  assert.deepEqual(w.bindings.list(w.target('w1')), []);
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).schema, 99);
}));

test('restart: bindings survive a new store/service and still resolve against Herdr without any focus command', () => withWorld({}, (w) => {
  w.bindings.bind(w.args(1));
  w.bindings.bind(w.args(2));
  w.store.load();                                          // a "restart": reload from disk
  assert.equal(w.bindings.list(w.target('w1')).length, 2);
  assert.equal(w.bindings.describeCurrent(chatUrl(2)).state, 'bound-here');
}));
