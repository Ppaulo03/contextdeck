'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBindingsStore } = require('../src/main/chat-bindings/store');
const model = require('../src/main/chat-bindings/model');
const { loadUiState, saveUiState } = require('../src/main/persistence/ui-state');
const { createWorld, chatUrl, ID } = require('./helpers/bindings-world');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-store-')); dirs.push(d); return d; };
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const good = (n = 1, extra = {}) => ({
  bindingId: `b_${String(n).padStart(16, '0')}`, conversationKey: `c:${ID(n)}`, url: chatUrl(n), label: `chat ${n}`, role: 'review', origin: 'url',
  workspaceIdentity: { session: 'contextdeck', workspaceId: 'w1' }, createdAt: 1, updatedAt: 2, ...extra
});
const doc = (bindings, extra = {}) => ({ schema: 1, contexts: {}, bindings, quarantine: [], ...extra });
const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

test('missing file: empty, writable, and the first save creates the file', () => {
  const file = path.join(tmp(), 'sub', 'chat-bindings.json');
  const store = createBindingsStore({ file });
  assert.deepEqual(store.info(), { status: 'missing', notice: null, writable: true });
  assert.equal(store.get().bindings.length, 0);
  store.save({ ...store.get(), bindings: [good(1)] });
  assert.equal(store.info().status, 'ok');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bindings.length, 1);
});

test('restart: what was saved is what loads, byte-for-byte equivalent data', () => {
  const file = path.join(tmp(), 'chat-bindings.json');
  const a = createBindingsStore({ file });
  const next = model.sanitizeData(doc([good(1), good(2, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w2' } })])).data;
  a.save(next);
  const b = createBindingsStore({ file });
  assert.deepEqual(b.get(), next);
  assert.deepEqual(b.info(), { status: 'ok', notice: null, writable: true });
});

test('atomic write: a failure while writing keeps the previous file intact and leaves no temp file', () => {
  const dir = tmp();
  const file = path.join(dir, 'chat-bindings.json');
  const store = createBindingsStore({ file });
  store.save({ ...store.get(), bindings: [good(1)] });
  const before = fs.readFileSync(file, 'utf8');
  const failing = { ...fs, writeFileSync: (f, ...rest) => { if (String(f).includes('.tmp-')) { fs.writeFileSync(f, '{"half', 'utf8'); throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } return fs.writeFileSync(f, ...rest); } };
  const flaky = createBindingsStore({ file, fs: failing });
  assert.throws(() => flaky.save({ ...flaky.get(), bindings: [] }), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'previous content untouched');
  assert.deepEqual(flaky.get().bindings.map((b) => b.bindingId), [good(1).bindingId], 'in-memory state unchanged');
  assert.deepEqual(fs.readdirSync(dir), ['chat-bindings.json'], 'no temp file left behind');
  const failingRename = { ...fs, renameSync: () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); } };
  const locked = createBindingsStore({ file, fs: failingRename });
  assert.throws(() => locked.save({ ...locked.get(), bindings: [] }), /locked/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['chat-bindings.json']);
});

test('corrupted JSON: the original is preserved aside, the store starts empty and says so; nothing is silently deleted', () => {
  const dir = tmp();
  const file = path.join(dir, 'chat-bindings.json');
  write(file, '{"schema":1,"bindings":[{"bindingId":');
  const store = createBindingsStore({ file, now: () => 1234 });
  assert.equal(store.info().status, 'recovered');
  assert.equal(store.info().notice.code, 'corrupt_preserved');
  assert.equal(store.info().writable, true);
  assert.equal(store.get().bindings.length, 0);
  const backup = store.info().notice.backup;
  assert.equal(path.basename(backup), 'chat-bindings.json.corrupt-1234');
  assert.equal(fs.readFileSync(backup, 'utf8'), '{"schema":1,"bindings":[{"bindingId":', 'the damaged bytes are kept');
  assert.equal(fs.existsSync(file), false);
  store.save({ ...store.get(), bindings: [good(1)] });
  assert.equal(store.info().status, 'recovered', 'the notice stays visible for the session');
  assert.ok(fs.existsSync(backup), 'backup survives later saves');
  assert.equal(createBindingsStore({ file }).info().status, 'ok');
});

test('wrong top-level shapes are treated like corruption (preserved, not parsed as data)', () => {
  for (const [name, value] of [['array', '[]'], ['null', 'null'], ['string', '"x"'], ['no schema', '{"bindings":[]}'], ['schema 0', '{"schema":0}'], ['schema text', '{"schema":"1"}'], ['empty file', '']]) {
    const dir = tmp();
    const file = path.join(dir, 'chat-bindings.json');
    write(file, value);
    const store = createBindingsStore({ file, now: () => 7 });
    assert.equal(store.info().status, 'recovered', name);
    assert.equal(fs.readFileSync(`${file}.corrupt-7`, 'utf8'), value, name);
  }
});

test('a UTF-8 BOM does not make a good file look corrupted', () => {
  const file = path.join(tmp(), 'chat-bindings.json');
  write(file, '\ufeff' + JSON.stringify(doc([good(1)])));
  assert.equal(createBindingsStore({ file }).info().status, 'ok');
});

test('invalid entries inside a good file are quarantined and kept in the file, valid ones load', () => {
  const dir = tmp();
  const file = path.join(dir, 'chat-bindings.json');
  const bad = [
    good(2, { bindingId: 'nope' }),
    good(3, { conversationKey: `c:${ID(4)}` }),               // key and URL disagree
    good(5, { url: 'https://evil.example/c/' + ID(5) }),
    good(6, { workspaceIdentity: { session: 'a/b', workspaceId: 'w1' } }),
    good(7, { role: 'boss' }),
    good(8, { createdAt: 'yesterday' }),
    good(9, { label: 'x'.repeat(81) }),
    'garbage', null, 42
  ];
  write(file, doc([good(1), ...bad, good(1, { bindingId: 'b_00000000000000ff' }), good(10, { bindingId: good(1).bindingId })]));
  const store = createBindingsStore({ file });
  assert.deepEqual(store.get().bindings.map((b) => b.conversationKey), [`c:${ID(1)}`]);
  assert.equal(store.info().status, 'ok');
  assert.equal(store.info().notice.code, 'entries_quarantined');
  assert.equal(store.info().notice.count, bad.length + 2);
  assert.equal(store.get().quarantine.length, bad.length + 2);
  assert.ok(store.get().quarantine.every((q) => q.reason && typeof q.raw === 'string'));
  store.save({ ...store.get() });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).quarantine.length, bad.length + 2, 'quarantine is persisted, not dropped on the next save');
});

test('quarantine is bounded', () => {
  const file = path.join(tmp(), 'chat-bindings.json');
  write(file, doc(Array.from({ length: 200 }, () => 'junk')));
  assert.equal(createBindingsStore({ file }).get().quarantine.length, model.LIMITS.quarantine);
});

test('schema migration: older documents are upgraded step by step, with a backup of the original first', () => {
  const dir = tmp();
  const file = path.join(dir, 'chat-bindings.json');
  const original = JSON.stringify({ schema: 1, contexts: {}, bindings: [good(1)], legacyField: true });
  write(file, original);
  const calls = [];
  const migrations = { 1: (d) => { calls.push(1); return { ...d, migrated: true }; }, 2: (d) => { calls.push(2); return d; } };
  const result = model.migrate(JSON.parse(original), { migrations, current: 3 });
  assert.equal(result.status, 'ok');
  assert.equal(result.doc.schema, 3);
  assert.equal(result.migratedFrom, 1);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(model.migrate({ schema: 3 }, { migrations, current: 3 }).migratedFrom, null, 'current schema: nothing to do');
  assert.equal(model.migrate({ schema: 1 }, { migrations: {}, current: 2 }).status, 'invalid', 'a gap in the chain is refused');
  // Through the store: the current schema is 1, so loading keeps the file and does not create a backup.
  const store = createBindingsStore({ file });
  assert.equal(store.info().status, 'ok');
  assert.equal(fs.readdirSync(dir).some((f) => f.includes('.bak-')), false);
});

test('a file from a newer ContextDeck is read-only and never overwritten', () => {
  const dir = tmp();
  const file = path.join(dir, 'chat-bindings.json');
  const future = JSON.stringify({ schema: 99, bindings: [{ anything: true }], newThing: 1 });
  write(file, future);
  const store = createBindingsStore({ file });
  assert.deepEqual([store.info().status, store.info().writable, store.info().notice.code], ['unsupported', false, 'future_schema']);
  assert.throws(() => store.save(model.emptyData()), (e) => e.code === 'store_readonly');
  assert.equal(fs.readFileSync(file, 'utf8'), future);
  assert.deepEqual(fs.readdirSync(dir), ['chat-bindings.json']);
});

test('an unreadable file (permissions, lock) is read-only and left alone', () => {
  const file = path.join(tmp(), 'chat-bindings.json');
  write(file, JSON.stringify(doc([good(1)])));
  const denied = { ...fs, readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const store = createBindingsStore({ file, fs: denied });
  assert.deepEqual([store.info().status, store.info().writable], ['unreadable', false]);
  assert.throws(() => store.save(model.emptyData()), (e) => e.code === 'store_readonly');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bindings.length, 1);
});

test('if a corrupted file cannot even be moved aside, the store stays read-only instead of overwriting it', () => {
  const file = path.join(tmp(), 'chat-bindings.json');
  write(file, '{broken');
  const noRename = { ...fs, renameSync: () => { throw new Error('locked'); } };
  const store = createBindingsStore({ file, fs: noRename });
  assert.deepEqual([store.info().status, store.info().writable, store.info().notice.code], ['unreadable', false, 'corrupt_not_preserved']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('existing preferences are untouched: ui-state.json keeps loading and saving independently', () => {
  const world = createWorld();
  try {
    const uiFile = path.join(world.root, 'ui-state.json');
    const legacy = { lastMode: 'chat', bounds: { width: 1300, height: 900 }, git: { repoDir: 'C:\\r', lastZip: 'C:\\z.zip', repos: {} }, herdr: { mode: 'manual', lastWorkspace: { session: 'contextdeck', workspaceId: 'w2' } } };
    fs.writeFileSync(uiFile, JSON.stringify(legacy), 'utf8');
    const before = fs.readFileSync(uiFile, 'utf8');
    world.bindings.bind(world.args(1));
    assert.equal(fs.readFileSync(uiFile, 'utf8'), before, 'bindings never write ui-state.json');
    const state = loadUiState(uiFile);
    saveUiState(uiFile, state);
    assert.equal(world.read().bindings.length, 1, 'ui-state saves never touch the bindings file');
    assert.equal(loadUiState(uiFile).herdr.mode, 'manual');
    assert.equal(loadUiState(uiFile).lastMode, 'chat');
    assert.equal(JSON.stringify(Object.keys(loadUiState(uiFile)).sort()), JSON.stringify(['bounds', 'chat', 'git', 'herdr', 'lastMode']), 'no bindings key leaked into the preferences');
    assert.deepEqual(loadUiState(uiFile).chat, { last: {} }, 'the only chat preference is the last conversation id per workspace');
  } finally { world.cleanup(); }
});

test('the file holds only durable facts: no messages, drafts, cookies or transient states', () => {
  const world = createWorld();
  try {
    world.bindings.bind(world.args(1, { label: 'Arquitetura' }));
    const text = fs.readFileSync(world.file, 'utf8');
    for (const forbidden of ['generation', 'responding', 'attention', 'draft', 'cookie', 'token', 'prompt', 'message']) assert.doesNotMatch(text, new RegExp(forbidden, 'i'), forbidden);
    const [binding] = world.read().bindings;
    assert.deepEqual(Object.keys(binding).sort(), ['bindingId', 'conversationKey', 'createdAt', 'label', 'origin', 'role', 'updatedAt', 'url', 'workspaceIdentity']);
  } finally { world.cleanup(); }
});
