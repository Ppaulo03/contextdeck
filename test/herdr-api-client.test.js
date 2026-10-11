'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiClient, HerdrApiError, pipeAddress, READ_ONLY_METHODS, SUBSCRIPTION_TYPES } = require('../src/main/herdr/api-client');
const { startFakeHerdr, SILENT } = require('./helpers/fake-herdr-server');
const fx = require('./helpers/herdr-fixtures');

const onWindows = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 2000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('condition not met'); await sleep(10); } };

test('pipe address follows the Windows transport and the allowlists are read-only', () => {
  assert.equal(pipeAddress('C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock', 'win32'), '\\\\.\\pipe\\C:\\Users\\u\\AppData\\Roaming\\herdr\\herdr.sock');
  assert.equal(pipeAddress('/tmp/h.sock', 'linux'), '/tmp/h.sock');
  assert.deepEqual([...READ_ONLY_METHODS].sort(), ['ping', 'session.snapshot', 'workspace.get', 'workspace.list']);
  for (const type of SUBSCRIPTION_TYPES) assert.match(type, /^(workspace|tab|pane)\./);
  assert.throws(() => createApiClient({}), /socketPath/);
});

test('mutating methods are refused before any connection is opened', async () => {
  let connections = 0;
  const api = createApiClient({ socketPath: 'x', connect: () => { connections += 1; throw new Error('must not connect'); } });
  for (const method of ['workspace.create', 'workspace.focus', 'workspace.close', 'workspace.rename', 'pane.send_text', 'server.stop', 'agent.prompt', 'client.window_title.set']) {
    await assert.rejects(api.request(method, {}), (e) => e instanceof HerdrApiError && e.code === 'method_not_allowed', method);
  }
  await assert.rejects(api.subscribe(['pane.output_matched'], {}), (e) => e.code === 'subscription_not_allowed');
  await assert.rejects(api.subscribe([], {}), (e) => e.code === 'subscription_not_allowed');
  assert.equal(connections, 0);
});

test('request/response over a real named pipe, including replies split across chunks', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method) => (method === 'ping' ? fx.pong : fx.snapshotResult([[1, 'a']], 1)));
  const api = createApiClient({ socketPath: server.name });
  try {
    assert.deepEqual(await api.request('ping'), fx.pong);
    assert.equal((await api.request('session.snapshot')).snapshot.workspaces[0].label, 'a');
    assert.equal(server.received[0].method, 'ping');
    assert.match(server.received[0].id, /^cd-\d+$/);
    assert.deepEqual(server.received[0].params, {});
    await until(() => api.openConnections() === 0);
  } finally { api.close(); await server.close(); }
});

test('errors: error envelope, unreachable pipe, timeout, invalid JSON, early close', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method, params, socket) => {
    if (method === 'workspace.get') throw Object.assign(new Error('workspace not found'), { code: 'workspace_not_found' });
    if (method === 'ping') return SILENT;
    if (method === 'workspace.list') { socket.write('this is not json\n'); return SILENT; }
    if (method === 'session.snapshot') { socket.destroy(); return SILENT; }
    return null;
  });
  const api = createApiClient({ socketPath: server.name, timeoutMs: 150 });
  try {
    await assert.rejects(api.request('workspace.get', { workspace_id: 'w9' }), (e) => e.code === 'workspace_not_found' && /not found/.test(e.message));
    await assert.rejects(api.request('ping'), (e) => e.code === 'timeout');
    await assert.rejects(api.request('workspace.list'), (e) => e.code === 'invalid_json');
    await assert.rejects(api.request('session.snapshot'), (e) => e.code === 'closed');
    await until(() => api.openConnections() === 0);
  } finally { api.close(); await server.close(); }
  const gone = createApiClient({ socketPath: 'contextdeck-test-does-not-exist', timeoutMs: 500 });
  await assert.rejects(gone.request('ping'), (e) => e.code === 'connection_failed' && e.details.cause === 'ENOENT');
  gone.close();
});

test('a reply split across several TCP-like chunks is reassembled', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method, params, socket) => {
    const line = JSON.stringify({ id: 'cd-1', result: fx.pong }) + '\n';
    const mid = Math.floor(line.length / 2);
    socket.write(line.slice(0, 7));
    setTimeout(() => socket.write(line.slice(7, mid)), 20);
    setTimeout(() => socket.write(line.slice(mid)), 40);
    return SILENT;
  });
  const api = createApiClient({ socketPath: server.name });
  try { assert.deepEqual(await api.request('ping'), fx.pong); } finally { api.close(); await server.close(); }
});

test('replies for other request ids are ignored', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method, params, socket) => { socket.write(`${JSON.stringify({ id: 'someone-else', result: { type: 'nope' } })}\n`); return fx.pong; });
  const api = createApiClient({ socketPath: server.name });
  try { assert.equal((await api.request('ping')).type, 'pong'); } finally { api.close(); await server.close(); }
});

test('subscription: acknowledged, streams events (duplicates preserved), closes once, no sockets left', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method) => (method === 'events.subscribe' ? { type: 'subscription_started' } : fx.pong));
  const api = createApiClient({ socketPath: server.name });
  const got = [];
  let closes = 0;
  try {
    const sub = await api.subscribe(['workspace.focused', 'workspace.renamed'], { onEvent: (e) => got.push(e), onClose: () => { closes += 1; } });
    assert.deepEqual(server.received[0].params.subscriptions, [{ type: 'workspace.focused' }, { type: 'workspace.renamed' }]);
    await until(() => server.subscriberCount() === 1);
    server.publish(fx.events.focused(2));
    server.publish(fx.events.focused(2));
    server.publish(fx.events.renamed(2, 'x'));
    await until(() => got.length === 3);
    assert.deepEqual(got.map((e) => e.event), ['workspace_focused', 'workspace_focused', 'workspace_renamed']);
    assert.equal(got[2].data.label, 'x');
    sub.close();
    await until(() => api.openConnections() === 0);
    await sleep(50);
    assert.equal(closes, 0, 'a client-initiated close is not reported as a drop');
  } finally { api.close(); await server.close(); }
});

test('subscription: server drop is reported exactly once; refused or unacknowledged subscriptions reject', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method) => ({ type: 'subscription_started' }));
  const api = createApiClient({ socketPath: server.name });
  const drops = [];
  try {
    await api.subscribe(['workspace.closed'], { onEvent() {}, onClose: (e) => drops.push(e) });
    server.dropConnections();
    await until(() => drops.length === 1);
    await sleep(50);
    assert.equal(drops.length, 1);
    assert.equal(drops[0], null);
  } finally { api.close(); await server.close(); }

  const refusing = await startFakeHerdr(() => { throw Object.assign(new Error('nope'), { code: 'subscription_failed' }); });
  const api2 = createApiClient({ socketPath: refusing.name });
  try { await assert.rejects(api2.subscribe(['workspace.closed'], {}), (e) => e.code === 'subscription_failed'); } finally { api2.close(); await refusing.close(); }

  const silent = await startFakeHerdr(() => SILENT);
  const api3 = createApiClient({ socketPath: silent.name, timeoutMs: 150 });
  try { await assert.rejects(api3.subscribe(['workspace.closed'], {}), (e) => e.code === 'timeout'); } finally { api3.close(); await silent.close(); }
});

test('close() destroys open connections and rejects later calls', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr(() => SILENT);
  const api = createApiClient({ socketPath: server.name, timeoutMs: 5000 });
  const pending = api.request('ping');
  await until(() => server.connectionCount() === 1);
  api.close();
  await assert.rejects(pending, (e) => e.code === 'closed');
  await until(() => server.connectionCount() === 0);
  await assert.rejects(api.request('ping'), (e) => e.code === 'client_closed');
  await assert.rejects(api.subscribe(['workspace.closed'], {}), (e) => e.code === 'client_closed');
  await server.close();
});

test('focusWorkspace: the only write; validated id, exact request, confirmed by Herdr, errors surfaced', { skip: !onWindows }, async () => {
  const server = await startFakeHerdr((method, params) => {
    if (method !== 'workspace.focus') throw Object.assign(new Error('unexpected ' + method), { code: 'unexpected' });
    if (params.workspace_id === 'w404') throw Object.assign(new Error('workspace w404 not found'), { code: 'workspace_not_found' });
    if (params.workspace_id === 'w7') return { type: 'ok' };                                       // wrong shape
    if (params.workspace_id === 'w8') return { type: 'workspace_info', workspace: { workspace_id: 'w9' } }; // someone else
    return { type: 'workspace_info', workspace: { workspace_id: params.workspace_id, label: 'x', focused: true } };
  });
  const api = createApiClient({ socketPath: server.name, timeoutMs: 300 });
  try {
    const info = await api.focusWorkspace('w3');
    assert.equal(info.workspace_id, 'w3');
    assert.deepEqual(server.received.map((r) => [r.method, r.params]), [['workspace.focus', { workspace_id: 'w3' }]]);
    await assert.rejects(api.focusWorkspace('w404'), (e) => e.code === 'workspace_not_found');
    await assert.rejects(api.focusWorkspace('w7'), (e) => e.code === 'unexpected_response');
    await assert.rejects(api.focusWorkspace('w8'), (e) => e.code === 'unexpected_response');
    const sent = server.received.length;
    for (const bad of ['', '../x', 'w1; calc', 'w 1', 'w'.repeat(80), null, undefined, 5, {}, ['w1']]) {
      await assert.rejects(api.focusWorkspace(bad), (e) => e.code === 'invalid_workspace_id', JSON.stringify(bad));
    }
    assert.equal(server.received.length, sent, 'invalid ids never reach the pipe');
    await assert.rejects(api.request('workspace.focus', { workspace_id: 'w3' }), (e) => e.code === 'method_not_allowed', 'the generic request() stays read-only');
    assert.equal(server.received.length, sent);
    await until(() => api.openConnections() === 0);
  } finally { api.close(); await server.close(); }
});

test('focusWorkspace: timeout, unreachable pipe and closed client', { skip: !onWindows }, async () => {
  const silent = await startFakeHerdr(() => SILENT);
  const api = createApiClient({ socketPath: silent.name, timeoutMs: 120 });
  try {
    await assert.rejects(api.focusWorkspace('w1'), (e) => e.code === 'timeout');
    api.close();
    await assert.rejects(api.focusWorkspace('w1'), (e) => e.code === 'client_closed');
  } finally { api.close(); await silent.close(); }
  const gone = createApiClient({ socketPath: 'contextdeck-test-no-such-pipe', timeoutMs: 300 });
  await assert.rejects(gone.focusWorkspace('w1'), (e) => e.code === 'connection_failed');
  gone.close();
});
