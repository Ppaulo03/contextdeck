'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceObserver } = require('../src/main/herdr/workspace-observer');
const { HerdrApiError } = require('../src/main/herdr/api-client');
const fx = require('./helpers/herdr-fixtures');

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

// Deterministic world: manual clock + scheduler, fake locator and fake API connections.
function world({ session = 'contextdeck', workspaces = [[1, 'api'], [2, 'web']], focused = 1 } = {}) {
  let t = 1_000_000;
  const timers = [];
  let timerId = 0;
  const scheduler = {
    setTimeout: (fn, ms) => { const timer = { id: ++timerId, at: t + ms, ms, fn }; timers.push(timer); return timer.id; },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  const w = {
    session, current: { workspaces, focused }, now: () => t,
    locateResult: { socketPath: 'C:\\h\\herdr.sock', running: true },
    locateError: null, locateCalls: 0,
    apis: [], requestLog: [], snapshotError: null, snapshotDelay: null, subscribeError: null,
    delays: () => timers.map((x) => x.ms),
    pendingTimers: () => timers.length,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        await settle();
        const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        t = due.at;
        due.fn();
      }
      t = target;
      await settle();
    },
    setSnapshot(workspacesNext, focusedNext) { w.current = { workspaces: workspacesNext, focused: focusedNext }; },
    locate: async () => { w.locateCalls += 1; if (w.locateError) throw w.locateError; return w.locateResult; },
    createApi: ({ socketPath }) => {
      const api = {
        socketPath, handlers: null, closed: false, subscribeCalls: 0, requests: 0,
        async subscribe(types, handlers) {
          api.subscribeCalls += 1; api.types = types;
          if (w.subscribeError) throw w.subscribeError;
          w.requestLog.push('subscribe');
          api.handlers = handlers;
          return { close: () => { api.subscriptionClosed = true; } };
        },
        async request(method) {
          api.requests += 1; w.requestLog.push(method);
          if (w.snapshotError) throw w.snapshotError;
          if (w.snapshotDelay) await w.snapshotDelay;
          return fx.snapshotResult(w.current.workspaces, w.current.focused);
        },
        close() { api.closed = true; },
        emit: (event) => api.handlers.onEvent(event),
        drop: (error = null) => api.handlers.onClose(error)
      };
      w.apis.push(api);
      return api;
    }
  };
  w.observer = createWorkspaceObserver({ session, locate: w.locate, createApi: w.createApi, scheduler, now: w.now });
  return w;
}

test('discovery: subscribes first, then reads the authoritative snapshot, then reports connected', async () => {
  const w = world();
  const seen = [];
  w.observer.onChange((s) => seen.push(s.connection));
  w.observer.start();
  await settle();
  assert.deepEqual(w.requestLog, ['subscribe', 'session.snapshot'], 'subscription precedes the first read');
  const s = w.observer.getState();
  assert.equal(s.connection, 'connected');
  assert.deepEqual(s.model.workspaces.map((x) => x.id), ['w1', 'w2']);
  assert.equal(s.lastSync.reason, 'initial');
  assert.equal(s.syncCount, 1);
  assert.deepEqual(seen.slice(0, 2), ['connecting', 'connected']);
  assert.ok(w.apis[0].types.includes('workspace.focused') && w.apis[0].types.includes('workspace.renamed'));
  assert.equal(s.active.status, 'ambiguous');
  assert.equal(s.active.candidateId, 'w1');
  w.observer.stop();
});

test('duplicate events are coalesced into one re-read', async () => {
  const w = world();
  w.observer.start(); await settle();
  const base = w.apis[0].requests;
  for (let i = 0; i < 6; i++) w.apis[0].emit(fx.events.focused(2));
  w.setSnapshot([[1, 'api'], [2, 'web']], 2);
  assert.equal(w.observer.getState().eventCount, 6);
  await w.advance(2000);
  assert.equal(w.apis[0].requests, base + 1, 'six events, one read');
  assert.equal(w.observer.getState().active.candidateId, 'w2');
  assert.equal(w.observer.getState().lastSync.reason, 'event');
  w.observer.stop();
});

test('out-of-order events do not matter: state always comes from the latest snapshot', async () => {
  const w = world();
  w.observer.start(); await settle();
  // A "renamed" for a workspace arrives before its "created", and a stale "focused" arrives last.
  w.apis[0].emit(fx.events.renamed(3, 'late'));
  w.apis[0].emit(fx.events.created(3, 'late'));
  w.apis[0].emit(fx.events.focused(1));
  w.setSnapshot([[1, 'api'], [2, 'web'], [3, 'late']], 3);
  await w.advance(2000);
  const s = w.observer.getState();
  assert.deepEqual(s.model.workspaces.map((x) => [x.id, x.label]), [['w1', 'api'], ['w2', 'web'], ['w3', 'late']]);
  assert.equal(s.model.sessionFocus.workspaceId, 'w3', 'authoritative focus wins over the stale event');
  assert.deepEqual(s.lastEvent && s.lastEvent.type, 'workspace_focused', 'diagnostics still show arrival order');
  w.observer.stop();
});

test('lost events are repaired by the slow heartbeat re-read', async () => {
  const w = world();
  w.observer.start(); await settle();
  w.setSnapshot([[1, 'api'], [2, 'web'], [3, 'new']], 1); // no event is ever delivered
  await w.advance(30_000);
  assert.equal(w.observer.getState().model.workspaces.length, 2, 'no heartbeat yet, no aggressive polling');
  await w.advance(31_000);
  assert.equal(w.observer.getState().model.workspaces.length, 3);
  assert.equal(w.observer.getState().lastSync.reason, 'heartbeat');
  w.observer.stop();
});

test('removal and rename are reflected after the signal', async () => {
  const w = world({ workspaces: [[1, 'api'], [2, 'web'], [3, 'docs']], focused: 1 });
  w.observer.start(); await settle();
  w.apis[0].emit(fx.events.renamed(2, 'frontend'));
  w.setSnapshot([[1, 'api'], [2, 'frontend'], [3, 'docs']], 1);
  await w.advance(2000);
  assert.equal(w.observer.getState().model.workspaces[1].label, 'frontend');
  assert.equal(w.observer.getState().model.workspaces[1].id, 'w2', 'rename keeps the id');
  w.apis[0].emit(fx.events.closed(3));
  w.setSnapshot([[1, 'api'], [2, 'frontend']], 1);
  await w.advance(2000);
  assert.deepEqual(w.observer.getState().model.workspaces.map((x) => x.id), ['w1', 'w2']);
  w.setSnapshot([[1, 'api']], 1);
  w.apis[0].emit(fx.events.closed(2));
  await w.advance(2000);
  assert.equal(w.observer.getState().active.status, 'known', 'a single remaining workspace is a forced answer');
  assert.equal(w.observer.getState().active.workspaceId, 'w1');
  w.observer.stop();
});

test('events that arrive while the first read is in flight trigger a follow-up read', async () => {
  const w = world();
  let release;
  w.snapshotDelay = new Promise((r) => { release = r; });
  w.observer.start(); await settle();
  assert.equal(w.observer.getState().connection, 'connecting');
  w.apis[0].emit(fx.events.created(3, 'x'));
  w.setSnapshot([[1, 'api'], [2, 'web'], [3, 'x']], 1);
  w.snapshotDelay = null;
  release(); await settle();
  assert.equal(w.observer.getState().connection, 'connected');
  await w.advance(2000);
  assert.equal(w.observer.getState().model.workspaces.length, 3);
  assert.ok(w.apis[0].requests >= 2);
  w.observer.stop();
});

test('stream drop: marks disconnected, retries with backoff, resubscribes once and reconciles', async () => {
  const w = world();
  w.observer.start(); await settle();
  w.setSnapshot([[1, 'api'], [2, 'web'], [3, 'after-restart']], 2);
  w.apis[0].drop(new HerdrApiError('connection_failed', 'pipe broke'));
  await settle();
  let s = w.observer.getState();
  assert.equal(s.connection, 'disconnected');
  assert.equal(s.lastError.code, 'connection_failed');
  assert.equal(w.apis[0].closed, true);
  assert.equal(w.apis[0].subscriptionClosed, true);
  assert.deepEqual(w.delays(), [1000]);
  assert.equal(s.model.workspaces.length, 2, 'last known model is kept while disconnected');
  await w.advance(1000);
  s = w.observer.getState();
  assert.equal(s.connection, 'connected');
  assert.equal(s.model.workspaces.length, 3);
  assert.equal(s.lastSync.reason, 'reconnect');
  assert.equal(s.lastError, null);
  assert.equal(w.apis.length, 2);
  assert.equal(w.apis.filter((a) => !a.closed).length, 1, 'exactly one live API connection');
  w.observer.stop();
});

test('backoff doubles up to the cap and resets after a successful connection', async () => {
  const w = world();
  w.locateError = new HerdrApiError('connection_failed', 'down');
  w.observer.start(); await settle();
  const delays = [];
  for (let i = 0; i < 7; i++) {
    delays.push(...w.delays());
    await w.advance(w.delays()[0]);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  assert.equal(w.observer.getState().attempts > 0, true);
  w.locateError = null;
  await w.advance(15000);
  assert.equal(w.observer.getState().connection, 'connected');
  assert.equal(w.observer.getState().attempts, 0);
  w.apis[w.apis.length - 1].drop();
  await settle();
  assert.deepEqual(w.delays(), [1000], 'backoff restarts from the initial delay');
  w.observer.stop();
});

test('session unavailable: stopped session and missing session are surfaced with their codes', async () => {
  const w = world();
  w.locateResult = { socketPath: 'x', running: false };
  w.observer.start(); await settle();
  assert.equal(w.observer.getState().connection, 'disconnected');
  assert.equal(w.observer.getState().lastError.code, 'session_not_running');
  assert.equal(w.apis.length, 0, 'no connection attempt for a stopped session');
  w.locateError = Object.assign(new Error('no such session'), { code: 'session_not_found' });
  await w.advance(1000);
  assert.equal(w.observer.getState().lastError.code, 'session_not_found');
  w.locateError = null; w.locateResult = { socketPath: 'C:\\h\\herdr.sock', running: true };
  await w.advance(2000);
  assert.equal(w.observer.getState().connection, 'connected', 'recovers when the session starts');
  w.observer.stop();
});

test('communication failures: refused subscription and failing snapshot both end in disconnected + retry', async () => {
  const w = world();
  w.subscribeError = new HerdrApiError('subscription_failed', 'refused');
  w.observer.start(); await settle();
  assert.equal(w.observer.getState().lastError.code, 'subscription_failed');
  assert.equal(w.apis[0].closed, true);
  w.subscribeError = null; w.snapshotError = new HerdrApiError('timeout', 'slow');
  await w.advance(1000);
  assert.equal(w.observer.getState().connection, 'disconnected');
  assert.equal(w.observer.getState().lastError.code, 'timeout');
  assert.equal(w.apis.filter((a) => !a.closed).length, 0);
  w.snapshotError = null;
  await w.advance(2000);
  assert.equal(w.observer.getState().connection, 'connected');
  w.observer.stop();
});

test('no duplicate subscriptions: repeated start/refresh while connecting or connected never open a second stream', async () => {
  const w = world();
  w.observer.start(); w.observer.start();
  void w.observer.refresh();
  await settle();
  assert.equal(w.apis.length, 1);
  assert.equal(w.apis[0].subscribeCalls, 1);
  await w.observer.refresh();
  assert.equal(w.observer.getState().lastSync.reason, 'manual');
  assert.equal(w.apis.length, 1);
  w.observer.stop();
});

test('manual refresh while disconnected reconnects immediately instead of waiting for the backoff', async () => {
  const w = world();
  w.locateError = new Error('down');
  w.observer.start(); await settle();
  assert.equal(w.pendingTimers(), 1);
  w.locateError = null;
  await w.observer.refresh(); await settle();
  assert.equal(w.observer.getState().connection, 'connected');
  assert.deepEqual(w.delays(), [60_000], 'the pending retry was cancelled; only the heartbeat remains');
  assert.equal(w.apis.length, 1);
  w.observer.stop();
});

test('stop() releases everything: connections, subscription, timers, listeners; late callbacks are ignored', async () => {
  const w = world();
  const seen = [];
  w.observer.onChange((s) => seen.push(s.connection));
  w.observer.start(); await settle();
  w.apis[0].emit(fx.events.focused(2)); // leaves a debounce timer pending
  assert.ok(w.pendingTimers() >= 1);
  const api = w.apis[0];
  w.observer.stop();
  assert.equal(api.closed, true);
  assert.equal(api.subscriptionClosed, true);
  assert.equal(w.pendingTimers(), 0);
  assert.deepEqual(w.observer._resources(), { listeners: 0, hasSubscription: false, hasApi: false, timers: 0 });
  assert.equal(w.observer.getState().connection, 'stopped');
  const before = JSON.stringify(w.observer.getState());
  api.emit(fx.events.focused(1));   // late event from the dead connection
  api.drop(new Error('late'));
  await w.advance(120_000);
  assert.equal(JSON.stringify(w.observer.getState()), before);
  assert.equal(api.requests, 1, 'no reads after stop');
  assert.equal(seen[seen.length - 1], 'stopped');
  // Restartable.
  w.observer.start(); await settle();
  assert.equal(w.observer.getState().connection, 'connected');
  w.observer.stop();
  assert.equal(w.pendingTimers(), 0);
});

test('stopping while a connection attempt is in flight leaves nothing behind', async () => {
  const w = world();
  let release;
  w.locate = () => new Promise((r) => { release = () => r({ socketPath: 'C:\\h\\herdr.sock', running: true }); });
  const obs = createWorkspaceObserver({ session: 's', locate: w.locate, createApi: w.createApi, scheduler: { setTimeout: () => 0, clearTimeout() {} }, now: w.now });
  obs.start(); await settle();
  obs.stop();
  release(); await settle();
  assert.equal(w.apis.length, 0);
  assert.deepEqual(obs._resources(), { listeners: 0, hasSubscription: false, hasApi: false, timers: 0 });
});

test('onChange can be unsubscribed and protocol versions are reported', async () => {
  const w = world();
  let calls = 0;
  const off = w.observer.onChange(() => { calls += 1; });
  w.observer.start(); await settle();
  const after = calls;
  assert.ok(after > 0);
  off();
  w.apis[0].emit(fx.events.focused(2)); await w.advance(2000);
  assert.equal(calls, after);
  assert.equal(w.observer.getState().model.compatibility, 'tested');
  w.observer.stop();
});
