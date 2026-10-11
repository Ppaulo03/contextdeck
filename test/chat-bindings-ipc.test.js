'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerChatsIpc, startChatsPusher, pickTarget } = require('../src/main/ipc/chats');
const { createWorld, chatUrl, ID } = require('./helpers/bindings-world');

const ui = { trusted: true };
const overlay = { overlay: true };
const stranger = { trusted: false };   // e.g. the remote ChatGPT page: it has no preload, but main must not rely on that alone

function setup(opts = {}) {
  const world = createWorld(opts);
  const handlers = new Map();
  const notified = [];
  let url = chatUrl(1);
  registerChatsIpc({
    ipcMain: { handle: (c, fn) => { assert.ok(!handlers.has(c), `duplicate ${c}`); handlers.set(c, fn); } },
    trusted: (e) => e.trusted === true || e.overlay === true,
    win: { getChatUrl: () => url },
    bindings: world.bindings,
    notify: () => notified.push(1)
  });
  const call = (channel, args, sender = ui) => handlers.get(channel)(sender, args);
  const bindArgs = (extra = {}) => ({ source: 'current', target: world.target('w1'), selectedAtOpen: 'w1', label: 'a', ...extra });
  return { world, handlers, call, notified, bindArgs, setUrl: (u) => { url = u; } };
}

test('IPC: the five channels exist and each refuses strangers without side effects', async () => {
  const t = setup();
  try {
    assert.deepEqual([...t.handlers.keys()].sort(), ['chats:bind', 'chats:reassign', 'chats:state', 'chats:unbind', 'chats:update', 'projects:link', 'projects:unlink']);
    for (const channel of t.handlers.keys()) {
      const r = await t.call(channel, t.bindArgs({ bindingId: 'b_0000000000000001' }), stranger);
      assert.ok(r === null || r.ok === false, channel);
      if (r) assert.equal(r.error.code, 'untrusted');
    }
    assert.equal(fs.existsSync(t.world.file), false);
    assert.equal(t.notified.length, 0);
  } finally { t.world.cleanup(); }
});

test('IPC: both the UI window and the overlay panel may use them', async () => {
  const t = setup();
  try {
    assert.equal((await t.call('chats:bind', t.bindArgs(), ui)).ok, true);
    assert.equal((await t.call('chats:bind', t.bindArgs({ source: 'url', url: chatUrl(2) }), overlay)).ok, true);
    assert.equal((await t.call('chats:state', undefined, overlay)).bindings.length, 2);
  } finally { t.world.cleanup(); }
});

test('IPC bind current: the address comes from the ChatGPT view (main), never from the renderer', async () => {
  const t = setup();
  try {
    t.setUrl(chatUrl(3));
    const r = await t.call('chats:bind', t.bindArgs({ url: chatUrl(9), conversationKey: `c:${ID(9)}` }));
    assert.equal(r.binding.conversationKey, `c:${ID(3)}`, 'a smuggled url/key is ignored');
    assert.equal(r.binding.origin, 'current-page');
    t.setUrl('https://chatgpt.com/');
    assert.equal((await t.call('chats:bind', t.bindArgs())).error.code, 'identity_pending');
    t.setUrl('');
    assert.equal((await t.call('chats:bind', t.bindArgs())).error.code, 'invalid_url');
    t.setUrl('https://evil.example/c/' + ID(1));
    assert.equal((await t.call('chats:bind', t.bindArgs())).error.code, 'foreign_host');
  } finally { t.world.cleanup(); }
});

test('IPC bind by URL: validated; origin is recorded as url', async () => {
  const t = setup();
  try {
    const r = await t.call('chats:bind', t.bindArgs({ source: 'url', url: ` ${chatUrl(4)}?x=1 ` }));
    assert.deepEqual([r.ok, r.binding.origin, r.binding.url], [true, 'url', chatUrl(4)]);
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'http://chatgpt.com/c/' + ID(5), 'https://chatgpt.com.evil.example/c/' + ID(5), 'https://chatgpt.com/c/..%2f..%2fsecret', '\u0000', 'x'.repeat(5000)]) {
      const bad = await t.call('chats:bind', t.bindArgs({ source: 'url', url }));
      assert.equal(bad.ok, false, url.slice(0, 40));
    }
    assert.equal(t.world.read().bindings.length, 1);
  } finally { t.world.cleanup(); }
});

test('IPC malformed requests are rejected in main and write nothing', async () => {
  const t = setup();
  try {
    const garbage = [undefined, null, 'x', 7, [], true];
    for (const channel of ['chats:bind', 'chats:update', 'chats:unbind', 'chats:reassign']) {
      for (const g of garbage) assert.equal((await t.call(channel, g)).error.code, 'invalid_request', `${channel} ${JSON.stringify(g)}`);
    }
    for (const bad of [{ source: 'file' }, { source: 'url' }, { source: 'url', url: 7 }, { source: {} }, {}]) {
      assert.equal((await t.call('chats:bind', bad)).error.code, 'invalid_request', JSON.stringify(bad));
    }
    // Non-string label/role/target fields: refused or neutralised, never coerced.
    assert.equal((await t.call('chats:bind', t.bindArgs({ label: { toString: () => 'x' } }))).ok, true, 'a non-string label is treated as absent');
    assert.equal((await t.call('chats:bind', t.bindArgs({ source: 'url', url: chatUrl(2), role: 'review' }))).ok, true, 'a category sent by an old client is ignored');
    assert.equal('role' in t.world.read().bindings[1], false);
    for (const target of [null, 'w1', { session: 'contextdeck' }, { session: 7, workspaceId: 'w1' }, { workspaceId: 'w1' }]) {
      assert.equal((await t.call('chats:bind', t.bindArgs({ source: 'url', url: chatUrl(3), target }))).error.code, 'invalid_target', JSON.stringify(target));
    }
    assert.equal((await t.call('chats:bind', t.bindArgs({ source: 'url', url: chatUrl(3), selectedAtOpen: undefined }))).error.code, 'invalid_request');
    assert.equal((await t.call('chats:bind', t.bindArgs({ source: 'url', url: chatUrl(3), selectedAtOpen: 5 }))).error.code, 'invalid_request');
    const id = t.world.read().bindings[0].bindingId;
    assert.equal((await t.call('chats:update', { bindingId: id })).error.code, 'invalid_request');
    assert.equal((await t.call('chats:update', { bindingId: 7, label: 'x' })).error.code, 'invalid_request');
    assert.equal((await t.call('chats:update', { bindingId: id, label: 7 })).error.code, 'invalid_request');
    assert.equal((await t.call('chats:update', { bindingId: id, role: 'boss' })).error.code, 'invalid_request', 'no category is accepted by the update channel');
    assert.equal((await t.call('chats:unbind', { bindingId: { id } })).error.code, 'invalid_request');
    assert.equal((await t.call('chats:reassign', { bindingId: id })).error.code, 'confirmation_required');
    assert.equal(t.world.read().bindings.length, 2, 'only the two valid binds happened');
  } finally { t.world.cleanup(); }
});

test('IPC duplicate and conflict attempts are reported, not applied; reassignment needs its flag and a reviewed destination', async () => {
  const t = setup();
  try {
    const first = await t.call('chats:bind', t.bindArgs());
    assert.equal((await t.call('chats:bind', t.bindArgs())).error.code, 'already_bound');
    t.world.select('w2');
    const args = t.bindArgs({ target: t.world.target('w2'), selectedAtOpen: 'w2' });
    const conflict = await t.call('chats:bind', args);
    assert.equal(conflict.error.code, 'conflict');
    assert.equal(conflict.error.binding.bindingId, first.binding.bindingId);
    const move = { bindingId: first.binding.bindingId, target: t.world.target('w2'), selectedAtOpen: 'w2' };
    assert.equal((await t.call('chats:reassign', move)).error.code, 'confirmation_required');
    assert.equal((await t.call('chats:reassign', { ...move, confirmReassign: 1 })).error.code, 'confirmation_required');
    assert.equal((await t.call('chats:reassign', { ...move, selectedAtOpen: 'w1', confirmReassign: true })).error.code, 'context_changed');
    assert.equal(t.world.read().bindings[0].workspaceIdentity.workspaceId, 'w1');
    assert.equal((await t.call('chats:reassign', { ...move, confirmReassign: true })).ok, true);
    assert.equal(t.world.read().bindings[0].workspaceIdentity.workspaceId, 'w2');
  } finally { t.world.cleanup(); }
});

test('IPC: only successful writes notify the pusher; nothing else is reachable (no path, command or method forwarding)', async () => {
  const t = setup();
  try {
    await t.call('chats:bind', t.bindArgs());
    await t.call('chats:bind', t.bindArgs());           // duplicate: refused
    await t.call('chats:state');                        // read
    assert.equal(t.notified.length, 1);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc', 'chats.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /require\('(node:)?(fs|path|child_process)'\)|exec|spawn|workspace\.|session\.|focusWorkspace|select\(/);
    assert.deepEqual(pickTarget({ session: 's', workspaceId: 'w1', extra: 1 }), { session: 's', workspaceId: 'w1' }, 'extra fields are dropped');
  } finally { t.world.cleanup(); }
});

// ---- the pusher --------------------------------------------------------------------------------------------------

function manualScheduler() {
  const timers = [];
  return { timers, scheduler: { setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } } };
}

test('pusher: pushes only when the state changed, throttled, and stops cleanly', () => {
  const world = createWorld();
  try {
    const sent = [];
    const clock = { t: 0 };
    const { timers, scheduler } = manualScheduler();
    let url = chatUrl(1);
    const pusher = startChatsPusher({ bindings: world.bindings, getUrl: () => url, observer: { onChange: (l) => { world.observerOn = l; return () => { world.observerOn = null; }; } }, selection: { onChange: (l) => { world.selectionOn = l; return () => { world.selectionOn = null; }; } }, send: (c, d) => sent.push([c, d]), scheduler, now: () => clock.t, intervalMs: 150 });
    pusher.notify();
    assert.equal(sent.length, 1, 'leading push');
    assert.equal(sent[0][0], 'chats:state');
    assert.equal(sent[0][1].current.state, 'unbound');
    clock.t = 10;
    pusher.notify(); pusher.notify();
    assert.equal(timers.length, 1, 'bursts coalesce into one trailing flush');
    clock.t = 160; timers.shift().fn();
    assert.equal(sent.length, 1, 'unchanged state is not re-sent');
    world.bindings.bind(world.args(1));
    clock.t = 400; pusher.notify();
    assert.equal(sent.length, 2);
    assert.equal(sent[1][1].current.state, 'bound-here');
    url = chatUrl(2);
    clock.t = 800; pusher.notify();
    assert.equal(sent[2][1].current.state, 'unbound', 'navigation to another conversation is reflected');
    world.selectionOn();                                   // selection change reaches the pusher
    pusher.stop();
    assert.equal(world.observerOn, null);
    assert.equal(world.selectionOn, null, 'listeners removed');
    clock.t = 2000; pusher.notify();
    assert.equal(sent.length, 3, 'stopped: silent');
  } finally { world.cleanup(); }
});
