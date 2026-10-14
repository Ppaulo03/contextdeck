'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerChatNavIpc, startChatNavPusher } = require('../src/main/ipc/chatnav');
const { createViewsWorld, bindMany } = require('./helpers/views-world');
const { ws } = require('./helpers/bindings-world');

const ui = { trusted: true };
const overlay = { overlay: true };
const stranger = { trusted: false };
const CHANNELS = ['chatnav:new', 'chatnav:open-unscoped', 'chatnav:resolve', 'chatnav:select', 'chatnav:select-temporary', 'chatnav:state', 'conflict:resolve'];

function setup({ ready = true } = {}) {
  const w = createViewsWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  w.select('w1');
  const bound = bindMany(w, [1, 2]);
  w.navigator.setMode('chat');
  const handlers = new Map();
  registerChatNavIpc({
    ipcMain: { handle: (c, fn) => { assert.ok(!handlers.has(c), `duplicate ${c}`); handlers.set(c, fn); } },
    trusted: (e) => e.trusted === true,           // the UI window only: the overlay and the remote page are not trusted here
    win: { getNavigator: () => (ready ? w.navigator : undefined) }
  });
  const call = (channel, args, sender = ui) => handlers.get(channel)(sender, args);
  return { w, bound, handlers, call, key: 'contextdeck/w1', done: () => { w.navigator.stop(); w.cleanup(); } };
}

test('exactly the navigation channels exist; strangers and the overlay get nothing and cause nothing', async () => {
  const t = setup();
  try {
    assert.deepEqual([...t.handlers.keys()].sort(), CHANNELS);
    for (const sender of [stranger, overlay]) {
      for (const channel of CHANNELS) {
        const r = await t.call(channel, { bindingId: t.bound[0].bindingId, workspaceKey: t.key, viewId: 'v1' }, sender);
        assert.ok(r === null || r.ok === false, channel);
        if (r) assert.equal(r.error.code, 'untrusted');
      }
    }
    assert.equal(t.w.fake.views.length, 0, 'no view was created');
  } finally { t.done(); }
});

test('select: opens the conversation of the stored binding (never an address from the renderer) and remembers it', async () => {
  const t = setup();
  try {
    const r = await t.call('chatnav:select', { bindingId: t.bound[1].bindingId, workspaceKey: t.key, confirm: false, url: 'https://evil.example/', method: 'workspace.focus' });
    assert.equal(r.ok, true);
    assert.deepEqual(t.w.fake.views[0].loads, [t.bound[1].url], 'the stored URL, nothing the caller said');
    assert.equal(t.w.last[t.key], t.bound[1].bindingId);
    assert.equal((await t.call('chatnav:state')).tabs[1].active, true);
  } finally { t.done(); }
});

test('malformed requests are refused in main without side effects', async () => {
  const t = setup();
  try {
    for (const channel of ['chatnav:select', 'chatnav:select-temporary', 'chatnav:new']) {
      for (const bad of [undefined, null, 'x', 7, [], true]) assert.equal((await t.call(channel, bad)).error.code, 'invalid_request', `${channel} ${JSON.stringify(bad)}`);
    }
    const id = t.bound[0].bindingId;
    for (const bad of [{ bindingId: id }, { workspaceKey: t.key }, { bindingId: 7, workspaceKey: t.key }, { bindingId: id, workspaceKey: 7 }, { bindingId: 'nope', workspaceKey: t.key }, { bindingId: id, workspaceKey: '../w1' }, { bindingId: id, workspaceKey: 'a b/w1' }, { bindingId: { toString: () => id }, workspaceKey: t.key }]) {
      assert.equal((await t.call('chatnav:select', bad)).error.code, 'invalid_request', JSON.stringify(bad));
    }
    for (const bad of [{ workspaceKey: t.key }, { viewId: 'v1' }, { viewId: 'x1', workspaceKey: t.key }, { viewId: ['v1'], workspaceKey: t.key }]) {
      assert.equal((await t.call('chatnav:select-temporary', bad)).error.code, 'invalid_request', JSON.stringify(bad));
    }
    assert.equal((await t.call('chatnav:new', { workspaceKey: 'nonsense' })).error.code, 'invalid_request');
    assert.equal(t.w.fake.views.length, 0);
  } finally { t.done(); }
});

test('rules of main still apply through IPC: stale workspace, binding of another workspace, suspect without confirmation', async () => {
  const t = setup();
  try {
    t.w.select('w2');
    assert.equal((await t.call('chatnav:select', { bindingId: t.bound[0].bindingId, workspaceKey: t.key })).error.code, 'context_changed');
    assert.equal((await t.call('chatnav:select', { bindingId: t.bound[0].bindingId, workspaceKey: 'contextdeck/w2' })).error.code, 'not_in_workspace');
    assert.equal((await t.call('chatnav:new', { workspaceKey: t.key })).error.code, 'context_changed');
    assert.equal(t.w.fake.views.length, 0);
    t.w.select('w1');
    t.w.setWorkspaces([ws('w1', 'other', 'D:\\x'), ws('w2', 'app')]);
    const r = await t.call('chatnav:select', { bindingId: t.bound[0].bindingId, workspaceKey: t.key, confirm: 'true' });
    assert.equal(r.error.code, 'confirmation_required', 'only the boolean true confirms');
    assert.equal((await t.call('chatnav:select', { bindingId: t.bound[0].bindingId, workspaceKey: t.key, confirm: true })).ok, true);
  } finally { t.done(); }
});

test('new conversation and the unscoped page go through the navigator', async () => {
  const t = setup();
  try {
    assert.equal((await t.call('chatnav:open-unscoped', undefined)).error.code, 'workspace_selected');
    const r = await t.call('chatnav:new', { workspaceKey: t.key });
    assert.equal(r.ok, true);
    assert.equal((await t.call('chatnav:select-temporary', { viewId: r.viewId, workspaceKey: t.key })).ok, true);
    t.w.select(null);
    assert.equal((await t.call('chatnav:open-unscoped')).ok, true);
  } finally { t.done(); }
});

test('before the window created the navigator, calls answer "not ready" instead of throwing', async () => {
  const t = setup({ ready: false });
  try {
    assert.equal(await t.call('chatnav:state'), null);
    assert.equal((await t.call('chatnav:select', { bindingId: t.bound[0].bindingId, workspaceKey: t.key })).error.code, 'not_ready');
    assert.equal((await t.call('chatnav:open-unscoped')).error.code, 'not_ready');
  } finally { t.done(); }
});

test('no channel can move Herdr, bind, or load an address: the module has no such capability', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'chatnav.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\('(electron|node:fs|fs|node:child_process|child_process)'\)|focusWorkspace|workspace\.focus|loadURL|\.bind\(|\.reassign|\.unbind|\.update\(|executeJavaScript/);
});

test('pusher: leading push, coalesced bursts, only changed content, silent after stop', () => {
  const sent = [];
  const timers = [];
  let state = { n: 1 };
  let t = 0;
  const pusher = startChatNavPusher({ getState: () => state, send: (c, d) => sent.push([c, d]), scheduler: { setTimeout: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; }, clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); } }, now: () => t, intervalMs: 100 });
  pusher.notify();
  assert.deepEqual(sent, [['chatnav:state', { n: 1 }]]);
  t = 10; pusher.notify(); pusher.notify();
  assert.equal(timers.length, 1);
  t = 120; timers.shift().fn();
  assert.equal(sent.length, 1, 'unchanged content is not re-sent');
  state = { n: 2 }; t = 300; pusher.notify();
  assert.equal(sent.length, 2);
  state = null; t = 500; pusher.notify();
  assert.equal(sent.length, 2, 'no state (not ready) sends nothing');
  pusher.stop();
  state = { n: 3 }; t = 900; pusher.notify();
  assert.equal(sent.length, 2);
});
