'use strict';

// Project bindings (M01-I3B-3): persistence, destination rules shared with the chat bindings, conflicts, recreated workspaces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createWorld, ws } = require('./helpers/bindings-world');
const { createBindingsStore } = require('../src/main/chat-bindings/store');
const projectModel = require('../src/main/project-bindings/model');
const { createProjectBindings } = require('../src/main/project-bindings/service');
const { projectsEnabled } = require('../src/main/projects-enabled');

const HEX = (c) => String(c).repeat(32);
const PID = (c) => `g-p-${HEX(c)}`;
const purl = (c, slug = 'bicho') => `https://chatgpt.com/g/${PID(c)}-${slug}/project`;
const code = (r) => (r.ok ? 'ok' : r.error.code);

function setup(opts) {
  const w = createWorld(opts);
  const file = path.join(w.root, 'project-bindings.json');
  const open = () => createBindingsStore({ file, model: projectModel });
  const store = open();
  const projects = createProjectBindings({ store, session: w.session, bindings: w.bindings, observer: w.observer, selection: w.selection });
  const pa = (c, extra = {}) => ({ target: w.target('w1'), url: purl(c), selectedAtOpen: 'w1', targetChosen: true, ...extra });
  return { ...w, wargs: w.args, file, open, store, projects, pa, readP: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
const run = (fn, opts) => { const t = setup(opts); try { return fn(t); } finally { t.cleanup(); } };

test('no file: starts empty and nothing is written until the first link', () => run((t) => {
  assert.deepEqual(t.projects.all(), []);
  assert.equal(t.store.info().status, 'missing');
  assert.equal(fs.existsSync(t.file), false);
  assert.equal(t.projects.forWorkspace(t.target('w1')), null);
}));

test('link: the record carries workspace identity, recovery metadata, Project id and a label from the slug', () => run((t) => {
  const r = t.projects.link(t.pa(1));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.record.projectId, r.record.label, r.record.status, r.record.workspaceIdentity], [PID(1), 'bicho', 'linked', { session: 'contextdeck', workspaceId: 'w1' }]);
  const disk = t.readP();
  assert.equal(disk.schema, 1);
  assert.deepEqual([disk.records.length, disk.records[0].workspace.label, disk.records[0].workspace.directory], [1, 'api', 'C:\\work\\api']);
  assert.doesNotMatch(JSON.stringify(disk), /cookie|token|password|credential/i);
}));

test('restart: the link is read back from disk', () => run((t) => {
  t.projects.link(t.pa(1, { label: 'Meu Bicho' }));
  const again = createProjectBindings({ store: t.open(), session: t.session, bindings: t.bindings, observer: t.observer, selection: t.selection });
  assert.deepEqual(again.all().map((r) => [r.projectId, r.label]), [[PID(1), 'Meu Bicho']]);
}));

test('disabling Projects preserves the file; default re-enable reads the previous link', () => run((t) => {
  const linked = t.projects.link(t.pa(1));
  assert.equal(linked.ok, true);
  const before = fs.readFileSync(t.file, 'utf8');

  const disabled = projectsEnabled({ CONTEXTDECK_PROJECTS: '0' }) ? createProjectBindings({ store: t.open(), session: t.session, bindings: t.bindings, observer: t.observer, selection: t.selection }) : null;
  assert.equal(disabled, null);
  assert.equal(fs.readFileSync(t.file, 'utf8'), before);

  assert.equal(projectsEnabled({}), true);
  const enabledAgain = createProjectBindings({ store: t.open(), session: t.session, bindings: t.bindings, observer: t.observer, selection: t.selection });
  assert.deepEqual(enabledAgain.all().map((r) => [r.projectId, r.workspaceIdentity.workspaceId]), [[PID(1), 'w1']]);
  assert.equal(fs.readFileSync(t.file, 'utf8'), before);
}));

test('only a Project URL is accepted: conversations, other hosts and unknown shapes are refused, nothing is written', () => run((t) => {
  for (const url of ['https://chatgpt.com/c/11111111-2222-4333-8444-555555555555', 'https://evil.example/g/' + PID(1) + '/project', 'https://chatgpt.com/g/g-p-abc-demo/project', 'nope']) {
    assert.equal(t.projects.link(t.pa(1, { url })).ok, false, url);
  }
  assert.equal(fs.existsSync(t.file), false);
}));

test('the destination rules are the chat bindings ones: estimate, moved selection, missing workspace, other session, disconnected', () => run((t) => {
  assert.equal(code(t.projects.link(t.pa(1, { targetChosen: false }))), 'ok', 'an explicit (dock) selection needs no extra flag');
  t.projects.unlink({ workspaceIdentity: t.target('w1') });
  t.select('w1', 'herdr');
  assert.equal(code(t.projects.link(t.pa(1, { targetChosen: false }))), 'confirmation_required', 'an estimate is not a choice');
  assert.equal(code(t.projects.link(t.pa(1, { selectedAtOpen: 'w2' }))), 'context_changed');
  assert.equal(code(t.projects.link(t.pa(1, { target: t.target('w9') }))), 'workspace_not_found');
  assert.equal(code(t.projects.link(t.pa(1, { target: t.target('w1', 'other') }))), 'session_mismatch');
  t.disconnect();
  assert.equal(code(t.projects.link(t.pa(1))), 'workspace_unavailable');
  t.connect();
  assert.equal(t.projects.all().length, 0);
  assert.equal(code(t.projects.link(t.pa(1))), 'ok');
}, { selected: { workspaceId: 'w1', origin: 'dock' } }));

test('a Project renamed in ChatGPT (same id, other slug) updates the same record and keeps createdAt', () => run((t) => {
  const first = t.projects.link(t.pa(1)).record;
  const second = t.projects.link(t.pa(1, { url: purl(1, 'bicho-novo-nome') }));
  assert.equal(second.ok, true);
  assert.equal(second.renamed, true);
  assert.equal(t.projects.all().length, 1);
  assert.deepEqual([second.record.projectId, second.record.createdAt === first.createdAt, second.record.url], [PID(1), true, purl(1, 'bicho-novo-nome')]);
}));

test('a workspace has one Project: another needs an explicit replace', () => run((t) => {
  t.projects.link(t.pa(1));
  const r = t.projects.link(t.pa(2));
  assert.equal(code(r), 'project_already_linked');
  assert.equal(r.error.record.projectId, PID(1));
  assert.equal(t.projects.forWorkspace(t.target('w1')).projectId, PID(1), 'nothing changed');
  assert.equal(code(t.projects.link(t.pa(2, { replace: true }))), 'ok');
  assert.equal(t.projects.forWorkspace(t.target('w1')).projectId, PID(2));
  assert.equal(t.projects.all().length, 1);
}));

test('a Project belongs to one workspace: linking it elsewhere is a conflict until moved explicitly', () => run((t) => {
  t.projects.link(t.pa(1));
  const elsewhere = t.pa(1, { target: t.target('w2') });
  const r = t.projects.link(elsewhere);
  assert.equal(code(r), 'project_conflict');
  assert.equal(r.error.record.workspaceIdentity.workspaceId, 'w1');
  assert.equal(t.projects.all()[0].workspaceIdentity.workspaceId, 'w1');
  assert.equal(code(t.projects.link({ ...elsewhere, move: true })), 'ok');
  assert.deepEqual(t.projects.all().map((x) => x.workspaceIdentity.workspaceId), ['w2']);
}, { selected: { workspaceId: 'w1', origin: 'dock' } }));

test('unlink removes only the Project link; chat bindings and everything else stay', () => run((t) => {
  const chat = t.bindings.bind(t.wargs(1, { targetChosen: true }));
  t.projects.link(t.pa(1));
  assert.equal(code(t.projects.unlink({ workspaceIdentity: t.target('w1') })), 'ok');
  assert.equal(t.projects.all().length, 0);
  assert.equal(t.bindings.list(t.target('w1')).length, 1);
  assert.equal(chat.ok, true);
  assert.equal(code(t.projects.unlink({ workspaceIdentity: t.target('w1') })), 'not_found');
  assert.equal(code(t.projects.unlink({ workspaceIdentity: { session: 'x' } })), 'invalid_target');
}));

test('linking a Project never touches the chat bindings file', () => run((t) => {
  t.bindings.bind(t.wargs(1, { targetChosen: true }));
  const before = fs.readFileSync(t.file.replace('project-bindings', 'chat-bindings'), 'utf8');
  t.projects.link(t.pa(3));
  assert.equal(fs.readFileSync(t.file.replace('project-bindings', 'chat-bindings'), 'utf8'), before);
}));

test('recreated workspace: the same id with another name and directory is suspect; the old Project is not silently reused', () => run((t) => {
  t.projects.link(t.pa(1));
  t.setWorkspaces([ws('w1', 'totally-other', 'D:/elsewhere'), ws('w2', 'app')]);
  assert.equal(t.projects.forWorkspace(t.target('w1')).status, 'suspect');
  assert.equal(code(t.projects.link(t.pa(1))), 'workspace_suspect', 'even the same Project needs the explicit confirmation');
  assert.equal(code(t.projects.link(t.pa(2))), 'project_already_linked');
  assert.equal(code(t.projects.link(t.pa(1, { replace: true }))), 'ok', 'the explicit re-confirmation');
  assert.equal(t.projects.forWorkspace(t.target('w1')).status, 'linked');
}));

test('orphan and unverified are reported, never guessed; a missing workspace is never a destination', () => run((t) => {
  t.projects.link(t.pa(1));
  t.disconnect();
  assert.equal(t.projects.forWorkspace(t.target('w1')).status, 'unverified');
  t.connect();
  t.setWorkspaces([ws('w2', 'app')]);
  assert.equal(t.projects.forWorkspace(t.target('w1')).status, 'orphan');
  assert.equal(t.projects.forWorkspace(t.target('w1')).workspaceLabel, 'api', 'the last known label stays visible');
}));

test('corrupt file: moved aside and kept, the store starts empty; a future schema is read-only; bad records are quarantined', () => run((t) => {
  fs.writeFileSync(t.file, '{not json');
  let s = t.open();
  assert.equal(s.info().status, 'recovered');
  assert.equal(fs.readdirSync(t.root).some((f) => f.startsWith('project-bindings.json.corrupt-')), true);
  fs.writeFileSync(t.file, JSON.stringify({ schema: 99, records: [] }));
  s = t.open();
  assert.deepEqual([s.info().status, s.info().writable], ['unsupported', false]);
  assert.equal(code(createProjectBindings({ store: s, session: t.session, bindings: t.bindings, observer: t.observer, selection: t.selection }).link(t.pa(1))), 'store_readonly');
  const good = { workspaceIdentity: t.target('w1'), workspace: { label: 'api', directory: 'x', seenAt: 5 }, projectId: PID(1), url: purl(1), label: 'a', createdAt: 1, updatedAt: 1 };
  fs.writeFileSync(t.file, JSON.stringify({ schema: 1, records: [good, { ...good, projectId: PID(2) }, { ...good, workspaceIdentity: t.target('w2') }, { ...good, workspaceIdentity: t.target('w2'), projectId: PID(1), url: purl(2) }, 'junk'] }));
  s = t.open();
  assert.equal(s.get().records.length, 1);
  assert.deepEqual(s.get().quarantine.map((q) => q.reason).sort(), ['duplicate-project', 'id-url-mismatch', 'id-url-mismatch', 'not-an-object'].sort());
  assert.equal(s.info().notice.code, 'entries_quarantined');
}));

test('write failure: reported, nothing changes in memory', () => run((t) => {
  const failing = { ...fs, writeFileSync: () => { throw new Error('disk full'); } };
  const store = createBindingsStore({ file: t.file, fs: failing, model: projectModel });
  const p = createProjectBindings({ store, session: t.session, bindings: t.bindings, observer: t.observer, selection: t.selection });
  assert.equal(code(p.link(t.pa(1))), 'write_failed');
  assert.equal(p.all().length, 0);
}));

test('current page: proposes the Project of a Project page or of a conversation inside it, and says who has it already', () => run((t) => {
  assert.equal(t.projects.describeCurrent('https://chatgpt.com/'), null);
  assert.equal(t.projects.describeCurrent(`https://chatgpt.com/g/${PID(1)}-bicho/c/11111111-2222-4333-8444-555555555555`).source, 'project-conversation');
  t.projects.link(t.pa(1));
  assert.deepEqual(t.projects.describeCurrent(purl(1, 'renamed')).linkedTo, { session: 'contextdeck', workspaceId: 'w1' });
  assert.equal(t.projects.getState({ url: purl(2) }).current.linkedTo, null);
}));
