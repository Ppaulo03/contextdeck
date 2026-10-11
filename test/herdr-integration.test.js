'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceObserver } = require('../src/main/herdr/workspace-observer');
const { createWorkspaceSelection } = require('../src/main/herdr/workspace-selection');
const { startFakeHerdr } = require('./helpers/fake-herdr-server');
const fx = require('./helpers/herdr-fixtures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 4000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('condition not met: ' + cond); await sleep(15); } };

// Real api-client + real named pipe + the captured wire protocol, only the Herdr server is fake.
test('observer over a real pipe: discovery, change signal, server drop, reconnect, clean stop', { skip: process.platform !== 'win32' }, async () => {
  let workspaces = [[1, 'api'], [2, 'web']];
  let focused = 1;
  const server = await startFakeHerdr((method) => {
    if (method === 'events.subscribe') return { type: 'subscription_started' };
    if (method === 'session.snapshot') return fx.snapshotResult(workspaces, focused);
    if (method === 'ping') return fx.pong;
    throw Object.assign(new Error('unexpected ' + method), { code: 'unexpected' });
  });
  const observer = createWorkspaceObserver({
    session: 'contextdeck',
    locate: async () => ({ socketPath: server.name, running: true }),
    options: { debounceMs: 20, minSyncIntervalMs: 20, heartbeatMs: 60_000, backoffInitialMs: 40, backoffMaxMs: 120 }
  });
  try {
    observer.start();
    await until(() => observer.getState().connection === 'connected');
    assert.deepEqual(observer.getState().model.workspaces.map((w) => w.label), ['api', 'web']);
    assert.equal(server.subscriberCount(), 1);
    assert.deepEqual(server.received.map((r) => r.method), ['events.subscribe', 'session.snapshot'], 'subscribe first, then the authoritative read');

    workspaces = [[1, 'api'], [2, 'web'], [3, 'docs']]; focused = 3;
    server.publish(fx.events.created(3, 'docs'));
    await until(() => observer.getState().model.workspaces.length === 3);
    assert.equal(observer.getState().active.candidateId, 'w3');
    assert.equal(observer.getState().lastEvent.type, 'workspace_created');

    workspaces = [[1, 'api'], [2, 'web-renamed'], [3, 'docs']];
    server.dropConnections();                       // server/pipe goes away
    await until(() => observer.getState().connection === 'disconnected' || observer.getState().syncCount > 2);
    await until(() => observer.getState().connection === 'connected' && observer.getState().model.workspaces[1].label === 'web-renamed');
    assert.equal(observer.getState().lastSync.reason, 'reconnect');
    assert.equal(server.subscriberCount(), 1, 'exactly one live subscription after reconnecting');
  } finally {
    observer.stop();
  }
  await until(() => server.connectionCount() === 0);
  assert.deepEqual(observer._resources(), { listeners: 0, hasSubscription: false, hasApi: false, timers: 0, waiters: 0 });
  await server.close();
});

test('observer against a pipe that does not exist stays disconnected without leaking timers after stop', { skip: process.platform !== 'win32' }, async () => {
  const observer = createWorkspaceObserver({
    session: 's', locate: async () => ({ socketPath: 'contextdeck-test-missing-pipe', running: true }),
    options: { backoffInitialMs: 30, backoffMaxMs: 60 }
  });
  observer.start();
  await until(() => observer.getState().lastError && observer.getState().attempts >= 2);
  assert.equal(observer.getState().connection, 'disconnected');
  assert.equal(observer.getState().lastError.code, 'connection_failed');
  observer.stop();
  assert.deepEqual(observer._resources(), { listeners: 0, hasSubscription: false, hasApi: false, timers: 0, waiters: 0 });
});

test('selection over a real pipe: one focus command per user choice, TUI changes followed without commands, reconnect re-sends nothing', { skip: process.platform !== 'win32' }, async () => {
  const workspaces = [[1, 'api'], [2, 'web'], [3, 'docs']];
  let focused = 1;
  const focusRequests = [];
  let server;
  server = await startFakeHerdr((method, params) => {
    if (method === 'events.subscribe') return { type: 'subscription_started' };
    if (method === 'session.snapshot') return fx.snapshotResult(workspaces, focused);
    if (method === 'workspace.focus') {
      focusRequests.push(params);
      const number = Number(String(params.workspace_id).slice(1));
      if (!workspaces.some(([n]) => n === number)) throw Object.assign(new Error(`workspace ${params.workspace_id} not found`), { code: 'workspace_not_found' });
      focused = number;
      setTimeout(() => { for (const type of ['workspace_focused', 'tab_focused', 'pane_focused']) server.publish({ event: type, data: { type, workspace_id: params.workspace_id } }); }, 5);
      return { type: 'workspace_info', workspace: { workspace_id: params.workspace_id, focused: true } };
    }
    throw Object.assign(new Error('unexpected ' + method), { code: 'unexpected' });
  });
  const observer = createWorkspaceObserver({
    session: 'contextdeck', locate: async () => ({ socketPath: server.name, running: true }),
    options: { debounceMs: 20, minSyncIntervalMs: 20, heartbeatMs: 60_000, backoffInitialMs: 40, backoffMaxMs: 120 }
  });
  const prefs = { value: { mode: 'auto', lastWorkspace: null }, get() { return this.value; }, set(p) { Object.assign(this.value, p); } };
  const selection = createWorkspaceSelection({ session: 'contextdeck', observer, preferences: prefs });
  const picked = () => (selection.getState().selected || {}).workspaceId;
  try {
    selection.start(); observer.start();
    await until(() => selection.getState().connection === 'connected' && picked() === 'w1');

    const result = await selection.select('contextdeck', 'w3');
    assert.deepEqual(result, { ok: true, confirmed: true, observedId: 'w3' });
    assert.deepEqual(focusRequests, [{ workspace_id: 'w3' }]);
    assert.equal(picked(), 'w3');
    assert.equal(selection.getState().selected.origin, 'dock');

    focused = 2;                                                   // the user switches in the TUI
    for (const type of ['workspace_focused', 'tab_focused', 'pane_focused']) server.publish({ event: type, data: { type, workspace_id: 'w2' } });
    await until(() => picked() === 'w2');
    assert.equal(selection.getState().selected.origin, 'herdr');
    assert.equal(focusRequests.length, 1, 'following the TUI sent no command');

    assert.equal((await selection.select('contextdeck', 'w99')).error.code, 'workspace_not_found');
    assert.equal((await selection.select('wrong-session', 'w1')).error.code, 'session_mismatch');
    assert.equal(focusRequests.length, 1, 'refused selections never reach the server');

    server.dropConnections();
    await until(() => observer.getState().epoch >= 2);   // connection lost
    await until(() => selection.getState().connection === 'connected' && observer.getState().epoch >= 3);   // and re-established
    assert.equal(focusRequests.length, 1, 'a reconnect never replays a focus command');
    assert.equal(picked(), 'w2');
    assert.equal(server.subscriberCount(), 1);
    selection.stop(); observer.stop();
    await until(() => server.connectionCount() === 0);
    assert.deepEqual(observer._resources(), { listeners: 0, hasSubscription: false, hasApi: false, timers: 0, waiters: 0 });
    assert.deepEqual(selection._resources(), { listeners: 0, subscribed: false });
  } finally {
    selection.stop(); observer.stop();
    await server.close();   // always, so a failing assertion cannot leave the pipe server holding the process open
  }
});
