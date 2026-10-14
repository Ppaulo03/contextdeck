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

// ---- conversation activity rides on the Herdr state (M01-I3B-2) ---------------------------------------------------------

test('herdrState: without an activity source the shape is unchanged; with one, `activity` is added and read fresh each time', () => {
  const src = fakeSources();
  assert.deepEqual(Object.keys(herdrState(src.observer, src.selection)).sort(), ['connection', 'selection', 'session']);
  let counts = { w1: { responding: 1, attention: 0 } };
  const state = () => herdrState(src.observer, src.selection, () => counts);
  assert.deepEqual(state().activity, { w1: { responding: 1, attention: 0 } });
  counts = {};
  assert.deepEqual(state().activity, {});
});

test('the state pusher can be nudged by an activity change (notify), still throttled, and stop() silences it', () => {
  const src = fakeSources(); const c = clock(); const sent = [];
  let counts = {};
  const stop = startStatePusher({ ...src, extra: () => counts, send: (ch, d) => sent.push([ch, d]), scheduler: c.scheduler, now: c.now, intervalMs: 150 });
  stop.notify();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].activity, {});
  counts = { w2: { responding: 0, attention: 1 } };
  stop.notify(); stop.notify();
  assert.equal(sent.length, 1, 'inside the throttle window: one trailing push pending');
  c.advance(200);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1][1].activity, { w2: { responding: 0, attention: 1 } });
  stop();
  assert.equal(c.pending(), 0);
});

test('the Herdr IPC handlers return the activity too (UI window only; strangers still get nothing)', async () => {
  const handlers = new Map();
  const src = fakeSources();
  registerHerdrIpc({ ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, trusted: (e) => e.trusted === true, observer: { ...src.observer, refresh: async () => {} }, selection: src.selection, extra: () => ({ w1: { responding: 2, attention: 0 } }) });
  assert.deepEqual((await handlers.get('herdr:state')({ trusted: true })).activity, { w1: { responding: 2, attention: 0 } });
  assert.deepEqual((await handlers.get('herdr:refresh')({ trusted: true })).activity, { w1: { responding: 2, attention: 0 } });
  assert.equal(await handlers.get('herdr:state')({ trusted: false }), null);
});
