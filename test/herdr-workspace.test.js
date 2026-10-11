'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, readWorkspaces, identifyActiveWorkspace } = require('../src/main/herdr/workspace-reader');
const { parseSessionList, createSessionLocator, SessionLocatorError } = require('../src/main/herdr/session-locator');
const { HerdrApiError } = require('../src/main/herdr/api-client');
const fx = require('./helpers/herdr-fixtures');

const fixedNow = () => 1234;

test('discovers workspaces with Herdr ids kept verbatim and the directory of the active tab pane', () => {
  const model = normalizeSnapshot(fx.snapshotResult([[1, 'api', 'C:\\work\\api'], [2, 'web', 'C:\\work\\web'], [5, 'docs']], 2), { session: 'contextdeck', now: fixedNow });
  assert.equal(model.session, 'contextdeck');
  assert.equal(model.serverVersion, '0.9.3');
  assert.equal(model.protocol, 22);
  assert.equal(model.compatibility, 'tested');
  assert.equal(model.syncedAt, 1234);
  assert.deepEqual(model.workspaces.map((w) => w.id), ['w1', 'w2', 'w5'], 'ids are opaque handles, not renumbered');
  assert.deepEqual(model.workspaces.map((w) => w.number), [1, 2, 5]);
  assert.deepEqual(model.workspaces.map((w) => w.directory), ['C:\\work\\api', 'C:\\work\\web', `${fx.HOME}\\p5`]);
  assert.equal(model.workspaces[0].directorySource, 'active_tab_pane_cwd');
  assert.deepEqual(model.sessionFocus, { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' });
  assert.deepEqual(model.workspaces.map((w) => w.sessionFocused), [false, true, false]);
  assert.equal(model.workspaces[0].activeTabId, 'w1:t1');
  assert.equal(model.workspaces[0].agentStatus, 'unknown');
});

test('workspaces with the same label stay distinct by id', () => {
  const model = normalizeSnapshot(fx.snapshotResult([[1, 'app', 'C:\\a'], [2, 'app', 'C:\\b'], [3, 'app', 'C:\\a']], 1));
  assert.equal(new Set(model.workspaces.map((w) => w.id)).size, 3);
  assert.deepEqual(model.workspaces.map((w) => w.label), ['app', 'app', 'app']);
  assert.equal(identifyActiveWorkspace(model).status, 'ambiguous');
});

test('optional and missing data are represented as null/defaults, never invented', () => {
  const raw = fx.snapshotResult([[1, 'a', null], [2, 'b', 'C:\\b']], null);
  delete raw.snapshot.workspaces[0].tab_count;
  delete raw.snapshot.workspaces[0].agent_status;
  raw.snapshot.workspaces[1].label = undefined;
  const model = normalizeSnapshot(raw);
  assert.equal(model.sessionFocus, null, 'no focus ids in the snapshot');
  assert.equal(model.workspaces[0].directory, null, 'workspace without a pane cwd');
  assert.equal(model.workspaces[0].directorySource, null);
  assert.equal(model.workspaces[0].tabCount, null);
  assert.equal(model.workspaces[0].agentStatus, 'unknown');
  assert.equal(model.workspaces[0].worktree, null);
  assert.equal(model.workspaces[1].label, '');
  const bare = normalizeSnapshot({ snapshot: { workspaces: [{ workspace_id: 'w9' }] } });
  assert.equal(bare.workspaces[0].id, 'w9');
  assert.equal(bare.protocol, null);
  assert.equal(bare.compatibility, 'untested');
  assert.equal(bare.workspaces[0].directory, null);
});

test('worktree metadata is passed through only when it is an object', () => {
  const raw = fx.snapshotResult([[1, 'a']], 1);
  raw.snapshot.workspaces[0].worktree = { branch: 'feature/x' };
  assert.deepEqual(normalizeSnapshot(raw).workspaces[0].worktree, { branch: 'feature/x' });
  raw.snapshot.workspaces[0].worktree = 'bogus';
  assert.equal(normalizeSnapshot(raw).workspaces[0].worktree, null);
});

test('unexpected shapes and entries without ids are rejected or dropped', () => {
  for (const bad of [null, undefined, {}, { snapshot: {} }, { snapshot: { workspaces: 'x' } }]) {
    assert.throws(() => normalizeSnapshot(bad), (e) => e instanceof HerdrApiError && e.code === 'unexpected_response');
  }
  const model = normalizeSnapshot({ snapshot: { protocol: 22, workspaces: [null, {}, { workspace_id: 3 }, { workspace_id: 'w1', label: 'ok' }] } });
  assert.deepEqual(model.workspaces.map((w) => w.id), ['w1']);
});

test('a newer protocol version is read but flagged untested', () => {
  assert.equal(normalizeSnapshot(fx.snapshotResult([[1, 'a']], 1, { protocol: 23, version: '0.10.0' })).compatibility, 'untested');
});

test('readWorkspaces uses a single read-only session.snapshot call', async () => {
  const calls = [];
  const model = await readWorkspaces({ request: async (m, p) => { calls.push([m, p]); return fx.snapshotResult([[1, 'a']], 1); } }, { session: 's' });
  assert.deepEqual(calls, [['session.snapshot', undefined]]);
  assert.equal(model.workspaces.length, 1);
});

// ---- who is visible in our client? -------------------------------------------------------------

test('active workspace: unknown without data or without workspaces', () => {
  assert.deepEqual(identifyActiveWorkspace(null), { status: 'unknown', workspaceId: null, candidateId: null, evidence: 'none', reason: 'no_data' });
  const empty = normalizeSnapshot({ snapshot: { protocol: 22, workspaces: [] } });
  assert.equal(identifyActiveWorkspace(empty).status, 'unknown');
  assert.equal(identifyActiveWorkspace(empty).reason, 'no_workspaces');
});

test('active workspace: known only when the session has exactly one workspace (forced answer)', () => {
  const one = normalizeSnapshot(fx.snapshotResult([[7, 'solo']], 7));
  assert.deepEqual(identifyActiveWorkspace(one), { status: 'known', workspaceId: 'w7', candidateId: null, evidence: 'only_workspace', reason: 'single_workspace_in_session' });
  const oneWithoutFocus = normalizeSnapshot(fx.snapshotResult([[7, 'solo']], null));
  assert.equal(identifyActiveWorkspace(oneWithoutFocus).status, 'known');
});

test('active workspace: with several workspaces the session focus is only a candidate (ambiguous), never known', () => {
  const model = normalizeSnapshot(fx.snapshotResult([[1, 'a'], [2, 'b'], [3, 'c']], 2));
  const active = identifyActiveWorkspace(model);
  assert.equal(active.status, 'ambiguous');
  assert.equal(active.workspaceId, null);
  assert.equal(active.candidateId, 'w2');
  assert.equal(active.evidence, 'session_focus_last_writer');
  assert.equal(active.reason, 'api_has_no_per_client_focus');
  const noFocus = identifyActiveWorkspace(normalizeSnapshot(fx.snapshotResult([[1, 'a'], [2, 'b']], null)));
  assert.equal(noFocus.status, 'ambiguous');
  assert.equal(noFocus.candidateId, null);
  const stale = normalizeSnapshot(fx.snapshotResult([[1, 'a'], [2, 'b']], 1));
  stale.sessionFocus.workspaceId = 'w99';
  assert.equal(identifyActiveWorkspace(stale).candidateId, null, 'a focus that points to a missing workspace is not offered');
});

// ---- session locator ---------------------------------------------------------------------------------------

const listJson = (sessions) => JSON.stringify({ sessions });
const entry = (name, running = true) => ({ default: name === 'default', name, running, session_dir: `C:\\d\\${name}`, socket_path: `C:\\d\\${name}\\herdr.sock` });

test('parseSessionList finds the named session, running or not', () => {
  assert.deepEqual(parseSessionList(listJson([entry('default'), entry('contextdeck')]), 'contextdeck'), { socketPath: 'C:\\d\\contextdeck\\herdr.sock', running: true });
  assert.equal(parseSessionList(listJson([entry('contextdeck', false)]), 'contextdeck').running, false);
});

test('parseSessionList: missing session and malformed output are explicit errors', () => {
  assert.throws(() => parseSessionList(listJson([entry('default')]), 'nope'), (e) => e instanceof SessionLocatorError && e.code === 'session_not_found');
  for (const bad of ['not json', '{}', '{"sessions":5}', listJson([{ name: 'x' }])]) {
    assert.throws(() => parseSessionList(bad, 'x'), (e) => e.code === 'invalid_output', bad);
  }
});

test('locator runs the CLI with an argument array and without HERDR_* variables', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-loc-'));
  const exe = path.join(dir, 'herdr.exe'); fs.writeFileSync(exe, '');
  process.env.HERDR_SOCKET_PATH = 'C:\\outer\\herdr.sock';
  try {
    const calls = [];
    const locate = createSessionLocator({ herdrExecutable: exe, exec: (file, args, opts, cb) => { calls.push({ file, args, env: opts.env }); cb(null, listJson([entry('s1')])); } });
    assert.deepEqual(await locate('s1'), { socketPath: 'C:\\d\\s1\\herdr.sock', running: true });
    assert.equal(calls[0].file, exe);
    assert.deepEqual(calls[0].args, ['session', 'list', '--json']);
    assert.ok(!Object.keys(calls[0].env).some((k) => k.toUpperCase().startsWith('HERDR_')));

    const failing = createSessionLocator({ herdrExecutable: exe, exec: (f, a, o, cb) => cb(Object.assign(new Error('boom'), { code: 'ENOENT' })) });
    await assert.rejects(failing('s1'), (e) => e.code === 'cli_failed');
    const missing = createSessionLocator({ herdrExecutable: path.join(dir, 'nope.exe'), exec: () => assert.fail('must not run') });
    await assert.rejects(missing('s1'), (e) => e.code === 'herdr_not_found');
  } finally { delete process.env.HERDR_SOCKET_PATH; fs.rmSync(dir, { recursive: true, force: true }); }
});
