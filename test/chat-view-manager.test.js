'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatViewManager, relation, REL } = require('../src/main/chat-views/manager');
const { createFakeViews } = require('./helpers/views-world');
const { chatUrl, projectUrl } = require('./helpers/bindings-world');
const rc = require('../src/main/chat/runtime-contract');

const setup = (options = {}) => {
  const fake = createFakeViews();
  const manager = createChatViewManager({ createView: fake.factory, host: fake.host, ...options });
  return { fake, manager, ops: () => fake.log.map((l) => l.slice(0, 2).join(':')) };
};
const flush = () => new Promise((r) => setImmediate(r));

test('nothing is created until asked; a view is created once, loads its address once, and starts as loading', () => {
  const { fake, manager } = setup();
  assert.equal(fake.views.length, 0);
  assert.equal(manager._size(), 0);
  const id = manager.create({ url: chatUrl(1), scope: 'contextdeck/w1', expectedKey: 'k1' });
  assert.equal(fake.views.length, 1);
  assert.deepEqual(fake.views[0].loads, [chatUrl(1)]);
  assert.equal(manager.get(id).page, 'loading');
  assert.equal(manager.get(id).relation, REL.LOADING);
  assert.equal(manager.getVisibleId(), null, 'creating does not show');
  assert.equal(fake.host.attached.size, 0);
});

test('showing a view attaches it only while the chat tab is showing; at most one view is attached, the old one is detached first', () => {
  const { fake, manager, ops } = setup();
  const a = manager.create({ url: chatUrl(1), scope: 's/w1' });
  const b = manager.create({ url: chatUrl(2), scope: 's/w1' });
  manager.show(a);
  assert.deepEqual([...fake.host.attached], [], 'terminal tab: logically visible but not attached');
  manager.setAttached(true);
  assert.deepEqual([...fake.host.attached], [a]);
  fake.log.length = 0;
  manager.show(b);
  assert.deepEqual(ops(), ['detach:' + a, 'attach:' + b, 'bounds:' + b], 'the previous view leaves before the next arrives');
  assert.deepEqual([...fake.host.attached], [b]);
  assert.equal(manager.isVisible(b), true);
  assert.equal(manager.isVisible(a), false);
});

test('hiding and re-showing never reloads, recreates or destroys: switching only attaches/detaches', async () => {
  const { fake, manager } = setup();
  const a = manager.create({ url: chatUrl(1), scope: 's/w1' });
  const b = manager.create({ url: chatUrl(2), scope: 's/w1' });
  fake.views[0].finishLoad(); fake.views[1].finishLoad();
  await flush();
  manager.setAttached(true);
  for (let i = 0; i < 20; i++) manager.show(i % 2 ? a : b);
  manager.setAttached(false);
  manager.setAttached(true);
  manager.hide();
  manager.show(a);
  assert.deepEqual(fake.views.map((v) => v.loads.length), [1, 1], 'each address was loaded exactly once');
  assert.equal(fake.log.some((l) => l[0] === 'destroy'), false);
  assert.equal(fake.views.length, 2, 'no view was recreated');
  assert.equal(manager.list().length, 2, 'both are still alive');
});

test('leaving the chat tab keeps the logical view; coming back re-attaches the same one', () => {
  const { fake, manager } = setup();
  const a = manager.create({ url: chatUrl(1), scope: 's/w1' });
  manager.setAttached(true);
  manager.show(a);
  manager.setAttached(false);
  assert.equal(fake.host.attached.size, 0);
  assert.equal(manager.getVisibleId(), a);
  manager.setAttached(true);
  assert.deepEqual([...fake.host.attached], [a]);
});

test('relation: derived from what the page SHOWS, never stored; a transient redirect heals by itself', () => {
  const { fake, manager } = setup();
  const key = `c:${chatUrl(1).slice(-36)}`;
  const id = manager.create({ url: chatUrl(1), scope: 's/w1', expectedKey: key });
  const view = fake.views[0];
  assert.equal(manager.get(id).relation, REL.LOADING);
  view.navigate(chatUrl(1));
  assert.equal(manager.get(id).relation, REL.MATCH);
  const epoch = manager.get(id).epoch;
  view.navigate('https://chatgpt.com/auth/redirect');       // transient page without identity
  assert.equal(manager.get(id).relation, REL.LEFT);
  assert.equal(manager.get(id).expectedKey, key, 'the expectation is not rewritten by an event');
  view.navigate(projectUrl(1));                              // same conversation through a project route
  assert.equal(manager.get(id).relation, REL.MATCH);
  assert.ok(manager.get(id).epoch > epoch, 'identity changes bump the epoch');
  view.navigate(chatUrl(2));
  assert.equal(manager.get(id).relation, REL.DIVERGED);
  assert.equal(manager.get(id).expectedKey, key);
  view.navigate('https://chatgpt.com/');
  assert.equal(manager.get(id).relation, REL.LEFT);
  assert.equal(relation({ expectedKey: null, identity: { state: 'pending' } }), REL.TEMPORARY);
  assert.equal(relation({ expectedKey: null, identity: { state: 'durable', key: 'x' } }), REL.ACQUIRED);
});

test('same URL again does not bump the epoch (only real identity changes do)', () => {
  const { fake, manager } = setup();
  const id = manager.create({ url: chatUrl(1), scope: 's/w1' });
  fake.views[0].navigate(chatUrl(1));
  const epoch = manager.get(id).epoch;
  fake.views[0].navigate(chatUrl(1) + '?model=x');
  assert.equal(manager.get(id).epoch, epoch);
});

test('page lifecycle follows events: ready, error on real failures, but an aborted navigation is not a failure', async () => {
  const { fake, manager } = setup();
  const id = manager.create({ url: chatUrl(1), scope: 's/w1' });
  fake.views[0].finishLoad();
  await flush();
  assert.equal(manager.get(id).page, 'ready');
  const bad = manager.create({ url: chatUrl(2), scope: 's/w1' });
  fake.views[1].failLoad({ errno: -3, code: 'ERR_ABORTED' });
  await flush();
  assert.equal(manager.get(bad).page, 'loading', 'ERR_ABORTED is not a failure');
  const real = manager.create({ url: chatUrl(3), scope: 's/w1' });
  fake.views[2].failLoad();
  await flush();
  assert.equal(manager.get(real).page, 'error');
  fake.views[0].emit('process-gone');
  assert.equal(manager.get(id).page, 'error');
});

test('a failed view is reloaded only when asked, once; a healthy view is never reloaded', async () => {
  const { fake, manager } = setup();
  const id = manager.create({ url: chatUrl(1), scope: 's/w1' });
  assert.equal(manager.reloadFailed(id, chatUrl(1)), false, 'still loading: nothing to retry');
  fake.views[0].failLoad();
  await flush();
  assert.equal(manager.reloadFailed(id, chatUrl(1)), true);
  assert.equal(fake.views[0].loads.length, 2);
  assert.equal(manager.get(id).page, 'loading');
  fake.views[0].finishLoad();
  await flush();
  assert.equal(manager.reloadFailed(id, chatUrl(1)), false, 'ready: not reloaded');
  assert.equal(fake.views[0].loads.length, 2);
});

test('late events are dropped: a load that finished for an older request, and anything after destruction', async () => {
  const { fake, manager } = setup();
  const id = manager.create({ url: chatUrl(1), scope: 's/w1' });
  fake.views[0].emit('loaded', { loadSeq: 99 });
  assert.equal(manager.get(id).page, 'loading', 'a completion for another load says nothing');
  fake.views[0].emit('loaded', { loadSeq: 1 });
  assert.equal(manager.get(id).page, 'ready');
  manager.setAttached(true);
  manager.show(id);
  fake.views[0].emit('destroyed');
  assert.equal(manager.getVisibleId(), null, 'a destroyed view is not visible any more');
  fake.views[0].navigate(chatUrl(2));
  fake.views[0].emit('loaded', {});
  assert.equal(manager.get(id), null, 'destroyed entries are removed, not retained as dead handles');
  assert.equal(manager.list().length, 0, 'destroyed views leave the list');
  assert.equal(manager.show(id), false);
});

test('findByKey follows identity: the view that shows a conversation, preferring the one opened for it; duplicates are reported, never destroyed', () => {
  const { fake, manager } = setup();
  const k1 = `c:${chatUrl(1).slice(-36)}`;
  const a = manager.create({ url: chatUrl(1), scope: 's/w1', expectedKey: k1 });
  const b = manager.create({ url: chatUrl(2), scope: 's/w1' });
  fake.views[0].navigate(chatUrl(1));
  fake.views[1].navigate(chatUrl(2));
  assert.equal(manager.findByKey(k1).id, a);
  assert.deepEqual(manager.duplicates(), []);
  fake.views[1].navigate(chatUrl(1));                          // b now shows the same conversation as a
  assert.equal(manager.findByKey(k1).id, a, 'the view opened for it wins');
  assert.deepEqual(manager.duplicates(), [{ key: k1, viewIds: [a, b] }]);
  assert.equal(manager.list().length, 2, 'both stay alive');
  assert.equal(fake.log.some((l) => l[0] === 'destroy'), false);
  assert.equal(manager.findByKey('c:nope'), null);
});

test('runtime context of a view: lifecycle, identity and epoch are live; the other dimensions are unknown and nothing is persisted', () => {
  const { fake, manager } = setup();
  const id = manager.create({ url: chatUrl(1), scope: 's/w1', expectedKey: 'k' });
  fake.views[0].navigate(chatUrl(1));
  const r = manager.runtimeOf(id);
  assert.equal(r.viewId, id);
  assert.equal(r.identity.state, 'durable');
  assert.equal(r.page.value, 'loading');
  assert.equal(r.page.source, 'navigation');
  assert.equal(r.generation.value, rc.GenerationState.UNKNOWN);
  assert.equal(r.draft.value, rc.DraftState.UNKNOWN);
  assert.equal(r.attention.value, rc.AttentionState.NONE);
  assert.ok(Object.isFrozen(r));
  assert.equal(manager.runtimeOf('nope'), null);
  assert.equal(r.generation.value === 'completed', false);
});

test('destroyAll closes every view once, detaches the visible one and silences the manager', () => {
  const { fake, manager } = setup();
  const a = manager.create({ url: chatUrl(1), scope: 's/w1' });
  manager.create({ url: chatUrl(2), scope: 's/w1' });
  manager.setAttached(true);
  manager.show(a);
  let changes = 0;
  manager.onChange(() => { changes += 1; });
  manager.destroyAll();
  changes = 0;                      // (observers learn of the closing through one final change)
  assert.deepEqual(fake.log.filter((l) => l[0] === 'destroy').map((l) => l[1]).sort(), fake.views.map((v) => v.id).sort());
  assert.equal(fake.host.attached.size, 0);
  assert.equal(manager._size(), 0);
  assert.equal(manager.create({ url: chatUrl(3), scope: 's/w1' }), null, 'nothing is created after shutdown');
  fake.views[0].navigate(chatUrl(9));
  assert.equal(changes, 0, 'late events from closed views change nothing');
});

test('suspension only reports success after a destroyed event or destroyed handle is confirmed', async () => {
  const { fake, manager } = setup({ destructionTimeoutMs: 10 });
  const id = manager.create({ url: chatUrl(7) });
  const view = fake.views[0];
  view.finishLoad(); await flush();
  view.destroy = () => { throw new Error('before destroy'); };
  let result = await manager.suspend(id, { url: chatUrl(7) });
  assert.equal(result.ok, false);
  assert.equal(manager.get(id).suspending, false);
  assert.equal(manager.list().length, 1);
  assert.equal(manager.suspendedList().length, 0);
  view.destroy = () => { view.emit('destroyed'); throw new Error('after destroy'); };
  result = await manager.suspend(id, { url: chatUrl(7) });
  assert.equal(result.ok, true);
  assert.equal(view.isDestroyed(), false, 'the event confirms native destruction even if the wrapper reports late');
  assert.equal(manager.get(id), null);
});

test('suspension rejects a live handle after timeout and preserves its managed entry', async () => {
  const { fake, manager } = setup({ destructionTimeoutMs: 10 });
  const id = manager.create({ url: chatUrl(8) });
  const view = fake.views[0];
  view.finishLoad(); await flush();
  view.destroy = () => new Promise(() => {});
  const result = await manager.suspend(id, { url: chatUrl(8) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'destroy_timeout');
  assert.ok(manager.get(id));
  assert.equal(manager.suspendedList().length, 0);
});

test('destroyed notifications may arrive asynchronously and more than once without leaving an orphan entry', async () => {
  const { fake, manager } = setup({ destructionTimeoutMs: 100 });
  const id = manager.create({ url: chatUrl(9) });
  const view = fake.views[0];
  view.finishLoad(); await flush();
  view.destroy = () => new Promise((resolve) => setTimeout(() => {
    view.emit('destroyed');
    view.emit('destroyed');
    resolve();
  }, 5));
  const result = await manager.suspend(id, { url: chatUrl(9) });
  assert.equal(result.ok, true);
  assert.equal(manager._size(), 0);
  assert.equal(manager.list().length, 0);
  assert.equal(manager.suspendedList().length, 1);
});

test('selection, duplicate suspension and shutdown during destruction cannot escape manager ownership', async () => {
  const { fake, manager } = setup({ destructionTimeoutMs: 100 });
  const url = chatUrl(1);
  const id = manager.create({ url, scope: 's/w1' });
  const view = fake.views[0];
  view.finishLoad(); await flush();
  let release;
  view.destroy = () => new Promise((resolve) => { release = resolve; });
  const first = manager.suspend(id, { url });
  assert.equal(manager.show(id), false, 'selection cannot attach a handle while its destruction is pending');
  assert.equal((await manager.suspend(id, { url })).code, 'busy');
  assert.equal(fake.views.length, 1);
  manager.destroyAll();
  view.emit('destroyed');
  release?.();
  assert.equal((await first).ok, false, 'closing the manager is not reported as a user suspension');
  assert.equal(manager.suspendedList().length, 0);
  assert.equal(manager._size(), 0);
});

test('the manager module is plain Node: no Electron, no persistence, no bindings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['manager.js', 'navigator.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'chat-views', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /require\('(electron|node:fs|fs)'\)|loadURL\(.*home|workspace\.focus|focusWorkspace|bindings\.(bind|update|unbind|reassign)|state-observer|state-detector/, f);
  }
});

test('a page that leaves its conversation right after finishing loading on it (SPA redirect) never "reached" it; one that leaves later did', async () => {
  let clock = 0;
  const fake = createFakeViews();
  const manager = createChatViewManager({ createView: fake.factory, host: fake.host, now: () => clock });
  const key = `c:${chatUrl(1).slice(-36)}`;
  const quick = manager.create({ url: chatUrl(1), scope: 's/w1', expectedKey: key });
  fake.views[0].navigate(chatUrl(1));
  clock = 250; fake.views[0].emit('loaded', {});
  assert.equal(manager.get(quick).reached, true);
  clock = 600; fake.views[0].navigate('https://chatgpt.com/');          // redirect 350 ms later
  assert.equal(manager.get(quick).reached, false);
  assert.equal(manager.findNeverReached(key).id, quick);
  const slow = manager.create({ url: chatUrl(2), scope: 's/w1', expectedKey: `c:${chatUrl(2).slice(-36)}` });
  fake.views[1].navigate(chatUrl(2));
  clock = 1000; fake.views[1].emit('loaded', {});
  clock = 1000 + 10000; fake.views[1].navigate('https://chatgpt.com/');  // the user pressed "new chat" 10 s later
  assert.equal(manager.get(slow).reached, true);
  assert.equal(manager.findNeverReached(`c:${chatUrl(2).slice(-36)}`), null);
});
