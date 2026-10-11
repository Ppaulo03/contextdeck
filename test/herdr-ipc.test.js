'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startStatePusher, herdrState, registerHerdrIpc } = require('../src/main/ipc/herdr');

function fakeSources() {
  const listeners = { observer: new Set(), selection: new Set() };
  const mk = (name, state) => ({
    getState: () => state,
    onChange: (l) => { listeners[name].add(l); return () => listeners[name].delete(l); }
  });
  return {
    listeners,
    observer: mk('observer', { session: 's', connection: 'connected' }),
    selection: mk('selection', { mode: 'auto' }),
    fire: (name) => { for (const l of [...listeners[name]]) l(); }
  };
}

function clock() {
  let t = 0; const timers = [];
  return {
    now: () => t,
    scheduler: { setTimeout: (fn, ms) => { const x = { fn, at: t + ms }; timers.push(x); return x; }, clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); } },
    advance(ms) { t += ms; for (const x of timers.filter((y) => y.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); } },
    pending: () => timers.length
  };
}

test('herdrState combines observer and selection state', () => {
  const s = fakeSources();
  assert.deepEqual(herdrState(s.observer, s.selection), { session: 's', connection: 'connected', selection: { mode: 'auto' } });
});

test('state pusher: leading + trailing throttle across both sources, and stop() releases everything', () => {
  const s = fakeSources();
  const c = clock();
  const sent = [];
  const stop = startStatePusher({ observer: s.observer, selection: s.selection, send: (ch, d) => sent.push([ch, d]), intervalMs: 150, scheduler: c.scheduler, now: c.now });
  s.fire('observer');                      // leading edge: sent immediately
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'herdr:state');
  assert.deepEqual(sent[0][1].selection, { mode: 'auto' });
  for (let i = 0; i < 10; i++) { s.fire('observer'); s.fire('selection'); }   // a burst
  assert.equal(sent.length, 1, 'burst is held back');
  c.advance(149); assert.equal(sent.length, 1);
  c.advance(1);   assert.equal(sent.length, 2, 'one trailing message for the whole burst');
  c.advance(1000); assert.equal(sent.length, 2, 'nothing more without new changes');
  s.fire('selection'); assert.equal(sent.length, 3, 'after the interval the next change goes out immediately');
  s.fire('observer');
  assert.equal(c.pending(), 1);
  stop();
  assert.equal(c.pending(), 0, 'trailing timer cleared');
  assert.equal(s.listeners.observer.size + s.listeners.selection.size, 0, 'no listeners left');
  s.fire('observer'); c.advance(1000);
  assert.equal(sent.length, 3);
});

test('selection handler forwards only plain strings and denies strangers', async () => {
  const handlers = new Map();
  const calls = [];
  registerHerdrIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    trusted: (e) => e.ok === true,
    observer: { getState: () => ({}), refresh: async () => {} },
    selection: { getState: () => ({}), select: async (...a) => { calls.push(a); return { ok: true }; }, setMode: (m) => { calls.push(['mode', m]); return { ok: true }; } }
  });
  const denied = await handlers.get('herdr:select-workspace')({ ok: false }, { session: 's', workspaceId: 'w1' });
  assert.equal(denied.ok, false);
  assert.equal((await handlers.get('herdr:set-sync-mode')({ ok: false }, { mode: 'manual' })).ok, false);
  assert.equal(await handlers.get('herdr:state')({ ok: false }), null);
  assert.deepEqual(calls, []);
  await handlers.get('herdr:select-workspace')({ ok: true }, { session: 's', workspaceId: 'w1', command: 'workspace.close' });
  await handlers.get('herdr:select-workspace')({ ok: true }, { session: ['s'], workspaceId: { a: 1 } });
  assert.deepEqual(calls, [['s', 'w1'], [null, null]]);
});
