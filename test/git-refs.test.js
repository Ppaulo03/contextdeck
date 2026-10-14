'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const refsLib = require('../src/main/git/refs');
const { createGitContext } = require('../src/main/git/context');
const { createGitActions } = require('../src/main/git/actions');
const { sanitize, getRepoPrefs, repoKey } = require('../src/main/persistence/ui-state');

const G = ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
const run = (cwd, ...args) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8' });
const tmps = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmps.push(d); return d; }
test.after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function commit(dir, name, content = name) {
  fs.writeFileSync(path.join(dir, name), content + '\n');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', `add ${name}`);
}
function repo(branch, { commits = 2 } = {}) {
  const dir = tmp('dock-refs-');
  run(dir, 'init', '-q', '-b', branch);
  for (let i = 1; i <= commits; i++) commit(dir, `f${i}.txt`);
  return dir;
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const labels = (list) => list.map((o) => o.label);

function newContext(dir, state = sanitize(undefined)) {
  let saved = 0;
  const ctx = createGitContext({ state, persist: () => { saved++; }, suggestedDir: dir });
  return { ctx, state, saves: () => saved };
}

test('only main: base defaults to main, revision to HEAD', async () => {
  const dir = repo('main');
  const { ctx } = newContext(dir);
  const r = await ctx.loadRefs();
  assert.equal(r.ok, true);
  assert.deepEqual(labels(r.refs.local), ['main']);
  assert.equal(r.refs.head.branch, 'main');
  assert.equal(r.refs.head.detached, false);
  assert.equal(r.selection.base.label, 'main');
  assert.equal(r.selection.base.source, 'auto');
  assert.equal(r.selection.revision.value, 'HEAD');
  assert.equal(r.selection.revision.kind, 'head');
  assert.match(r.selection.revision.subject, /add f2\.txt/);
});

test('only dev: dev is chosen; a repo without dev/main requires an explicit base (never HEAD)', async () => {
  const dev = repo('dev');
  assert.equal((await newContext(dev).ctx.loadRefs()).selection.base.label, 'dev');
  const other = repo('trunk');
  const r = await newContext(other).ctx.loadRefs();
  assert.equal(r.selection.base, null);
  assert.match(r.selection.baseMessage, /selecione uma/);
  assert.equal(r.selection.revision.value, 'HEAD', 'revision still defaults to HEAD');
});

test('preference order: saved > dev > origin/dev > main > origin/main', async () => {
  const origin = repo('main');
  run(origin, 'branch', 'dev');
  const clone = tmp('dock-clone-');
  run(os.tmpdir(), 'clone', '-q', origin, clone);
  const before = await newContext(clone).ctx.loadRefs();
  assert.deepEqual(labels(before.refs.remote).sort(), ['origin/dev', 'origin/main']);
  assert.ok(!labels(before.refs.remote).includes('origin/HEAD'));
  assert.equal(before.selection.base.label, 'origin/dev', 'origin/dev is preferred over a local main');
  run(clone, 'branch', 'dev', 'origin/dev');
  assert.equal((await newContext(clone).ctx.loadRefs()).selection.base.label, 'dev');
  run(clone, 'branch', '-D', 'dev');
  assert.equal((await newContext(clone).ctx.loadRefs()).selection.base.label, 'origin/dev');
  run(clone, 'update-ref', '-d', 'refs/remotes/origin/dev');
  assert.equal((await newContext(clone).ctx.loadRefs()).selection.base.label, 'main', 'local main before origin/main');
  run(clone, 'branch', '-m', 'main', 'work');
  assert.equal((await newContext(clone).ctx.loadRefs()).selection.base.label, 'origin/main');
  const state = sanitize(undefined);
  const { ctx } = newContext(clone, state);
  assert.equal((await ctx.setRefs(undefined, { baseRef: 'origin/main' })).ok, true);
  assert.equal((await ctx.loadRefs()).selection.base.label, 'origin/main');
  assert.equal((await ctx.loadRefs()).selection.base.source, 'saved');
});

test('local, remote and tag options keep original spelling; lightweight and annotated tags; non-commit tags skipped', async () => {
  const origin = repo('main');
  const clone = tmp('dock-clone-');
  run(os.tmpdir(), 'clone', '-q', origin, clone);
  run(clone, 'branch', 'feature/Ação-1');
  run(clone, 'tag', 'v1.0');
  run(clone, 'tag', '-a', 'v2.0-rc', '-m', 'annotated');
  run(clone, 'tag', 'treetag', 'HEAD^{tree}');
  const r = await refsLib.discoverRefs(clone);
  assert.deepEqual(labels(r.local).sort(), ['feature/Ação-1', 'main']);
  const unicode = r.local.find((o) => o.label === 'feature/Ação-1');
  assert.equal(unicode.value, unicode.sha, 'unsafe names fall back to the commit hash as value');
  assert.equal(r.local.find((o) => o.label === 'main').value, 'refs/heads/main');
  assert.deepEqual(labels(r.tags).sort(), ['v1.0', 'v2.0-rc']);
  const annotated = r.tags.find((o) => o.label === 'v2.0-rc');
  assert.equal(annotated.sha, run(clone, 'rev-parse', 'HEAD').trim(), 'annotated tag is peeled to its commit');
  assert.equal(r.local.find((o) => o.current).label, 'main');
});

test('a branch and a tag with the same name stay distinguishable', async () => {
  const dir = repo('main');
  run(dir, 'branch', 'dev');
  commit(dir, 'later.txt');
  run(dir, 'tag', 'dev'); // tag "dev" -> newer commit than branch "dev"
  const r = await refsLib.discoverRefs(dir);
  const branch = r.local.find((o) => o.label === 'dev');
  const tag = r.tags.find((o) => o.label === 'dev');
  assert.equal(branch.value, 'refs/heads/dev');
  assert.equal(tag.value, 'refs/tags/dev');
  const clip = { text: [], writeText(t) { this.text.push(t); }, async writeFile() { return { ok: true }; } };
  const actions = createGitActions({ artifactsDir: tmp('dock-art-'), clipboard: clip });
  fs.writeFileSync(path.join(dir, 'f1.txt'), 'changed\n');
  const viaBranch = await actions.copyDiff(dir, branch.value);
  const viaTag = await actions.copyDiff(dir, tag.value);
  assert.equal(viaBranch.ok && viaTag.ok, true);
  assert.notEqual(clip.text[0], clip.text[1], 'each refname resolves to its own target');
});

test('detached HEAD is reported and HEAD revision still works', async () => {
  const dir = repo('main', { commits: 3 });
  run(dir, 'checkout', '-q', '--detach', 'HEAD~1');
  const { ctx } = newContext(dir);
  const r = await ctx.loadRefs();
  assert.equal(r.refs.head.detached, true);
  assert.equal(r.refs.head.branch, undefined);
  assert.equal(r.selection.revision.value, 'HEAD');
  assert.equal(r.selection.revision.short, r.refs.head.short);
  assert.equal(r.refs.commits[0].sha, r.refs.head.sha);
});

test('repository without commits: no options, no revision, clear messages', async () => {
  const dir = tmp('dock-empty-');
  run(dir, 'init', '-q', '-b', 'main');
  const { ctx } = newContext(dir);
  const r = await ctx.loadRefs();
  assert.equal(r.ok, true);
  assert.equal(r.refs.head.hasCommits, false);
  assert.deepEqual([r.refs.local, r.refs.remote, r.refs.tags, r.refs.commits], [[], [], [], []]);
  assert.equal(r.selection.base, null);
  assert.equal(r.selection.revision, null);
  assert.match(r.selection.revisionMessage, /sem commits/);
  assert.equal((await ctx.setRefs(undefined, { revision: 'HEAD' })).ok, false);
});

test('recent commits are capped at 30 and carry short sha, date and subject', async () => {
  const dir = repo('main', { commits: 1 });
  for (let i = 0; i < 34; i++) run(dir, 'commit', '-q', '--allow-empty', '-m', `empty ${i}`);
  const r = await refsLib.discoverRefs(dir);
  assert.equal(r.commits.length, 30);
  assert.equal(r.commits[0].subject, 'empty 33');
  assert.match(r.commits[0].short, /^[0-9a-f]{7,}$/);
  assert.match(r.commits[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.commits[0].decoration, /HEAD -> main/);
});

test('saved ref removed after persistence: invalid saved base is reported and never silently replaced by HEAD', async () => {
  const dir = repo('trunk');
  run(dir, 'branch', 'feature/x');
  const { ctx, state } = newContext(dir);
  assert.equal((await ctx.setRefs(undefined, { baseRef: 'feature/x' })).ok, true);
  assert.equal((await ctx.loadRefs()).selection.base.label, 'feature/x');
  run(dir, 'branch', '-D', 'feature/x');
  const r = await ctx.loadRefs();
  assert.equal(r.selection.base, null);
  assert.match(r.selection.baseMessage, /feature\/x.*nao existe mais/);
  assert.equal(getRepoPrefs(state, dir).baseRef, 'feature/x', 'stored pref is kept, only reported');
  run(dir, 'branch', 'dev');
  const r2 = await ctx.loadRefs();
  assert.equal(r2.selection.base.label, 'dev');
  assert.match(r2.selection.baseMessage, /nao existe mais.*Usando "dev"/);
  // A removed revision falls back to HEAD with a message.
  state.git.repos[repoKey(dir)].revision = 'deadbeefdead';
  const r3 = await ctx.loadRefs();
  assert.equal(r3.selection.revision.value, 'HEAD');
  assert.match(r3.selection.revisionMessage, /deadbeefdead/);
});

test('switching repositories: prefs are per repository and refs of another repo are refused', async () => {
  const a = repo('dev');
  const b = repo('main');
  const state = sanitize(undefined);
  state.git.repoDir = a;
  const { ctx } = newContext(a, state);
  assert.equal((await ctx.setRefs(undefined, { baseRef: 'dev' })).ok, true);
  const rootA = (await ctx.loadRefs()).root;

  state.git.repoDir = b; // user picks repository B
  const inB = await ctx.loadRefs();
  assert.deepEqual(labels(inB.refs.local), ['main']);
  assert.equal(inB.selection.base.label, 'main');
  assert.equal(getRepoPrefs(state, b).baseRef, undefined);
  assert.equal(getRepoPrefs(state, a).baseRef, 'dev');

  // The renderer still thinks repository A is active: main refuses to apply or run against B.
  const stale = await ctx.setRefs(rootA, { baseRef: 'dev' });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal((await ctx.activeRepo(rootA)).stale, true);
  assert.equal((await ctx.activeRepo(inB.root)).ok, true);
  assert.equal(getRepoPrefs(state, b).baseRef, undefined);
});

test('manual refs: invalid ones are rejected without being stored; HEAD~n, hashes and tags are accepted', async () => {
  const dir = repo('main', { commits: 4 });
  run(dir, 'tag', 'v1');
  const { ctx, state, saves } = newContext(dir);
  for (const bad of ['nope', '--all', 'a b', 'main;calc', 'main..HEAD', 'HEAD~99', '', 'x'.repeat(300)]) {
    const r = await ctx.setRefs(undefined, { revision: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
  }
  assert.equal(getRepoPrefs(state, dir).revision, undefined);
  assert.equal(saves(), 0);
  const head3 = run(dir, 'rev-parse', 'HEAD~3').trim();
  for (const good of ['HEAD~1', 'HEAD~3', head3, head3.slice(0, 8), 'v1']) {
    const r = await ctx.setRefs(undefined, { revision: good });
    assert.equal(r.ok, true, good);
  }
  const r = await ctx.setRefs(undefined, { revision: 'HEAD~1' });
  assert.equal(r.revision.kind, 'manual');
  assert.equal(r.revision.short, run(dir, 'rev-parse', '--short', 'HEAD~1').trim());
  const loaded = await ctx.loadRefs();
  assert.equal(loaded.selection.revision.value, 'HEAD~1');
});

test('selecting a previous commit exports exactly that commit', async () => {
  const dir = repo('main', { commits: 3 });
  const { ctx } = newContext(dir);
  const refs = (await ctx.loadRefs()).refs;
  const previous = refs.commits[1];
  assert.equal((await ctx.setRefs(undefined, { revision: previous.value })).ok, true);
  const clip = { text: [], files: [], writeText(t) { this.text.push(t); }, async writeFile(f) { this.files.push(f); return { ok: true }; } };
  const art = tmp('dock-art-');
  const actions = createGitActions({ artifactsDir: art, clipboard: clip });
  const shown = await actions.copyShow(dir, previous.value);
  assert.equal(shown.ok, true);
  assert.match(clip.text[0], /add f2\.txt/);
  assert.match(shown.message, new RegExp(previous.short));
  const zip = await actions.makeZip(dir, previous.value);
  assert.equal(zip.ok, true);
  assert.match(zip.message, new RegExp(previous.short));
  const bytes = fs.readFileSync(zip.zip.path);
  assert.ok(bytes.includes('f2.txt') && !bytes.includes('f3.txt'), 'archive holds the selected commit, not HEAD');
});

test('options update dynamically and discovery is read-only (no fetch, no refs/index changes)', async () => {
  const dir = repo('main');
  const { ctx } = newContext(dir);
  fs.writeFileSync(path.join(dir, 'f1.txt'), 'dirty\n');
  const snapshot = () => ({
    refs: run(dir, 'for-each-ref'),
    status: run(dir, 'status', '--porcelain'),
    index: sha256(path.join(dir, '.git', 'index')),
    head: run(dir, 'rev-parse', 'HEAD')
  });
  const before = snapshot();
  const first = await ctx.loadRefs();
  await ctx.setRefs(undefined, { revision: 'HEAD~1' });
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(dir, '.git', 'FETCH_HEAD')), false);
  assert.deepEqual(labels(first.refs.local), ['main']);

  run(dir, 'branch', 'release/1.0');
  run(dir, 'tag', 'v9');
  const second = await ctx.loadRefs();
  assert.deepEqual(labels(second.refs.local).sort(), ['main', 'release/1.0']);
  assert.deepEqual(labels(second.refs.tags), ['v9']);
});

test('ui-state: per-repository prefs, bounded, and files from M00-I2 are migrated', () => {
  const root = path.join(os.tmpdir(), 'MyRepo');
  const legacy = sanitize({ lastMode: 'chat', git: { repoDir: root, baseRef: 'main', revision: 'HEAD~2', lastZip: 'C:\\z.zip' } });
  assert.deepEqual(legacy.git.repos[repoKey(root)], { baseRef: 'main', revision: 'HEAD~2' });
  assert.equal(legacy.git.lastZip, 'C:\\z.zip');
  assert.equal(legacy.git.baseRef, undefined);
  const noRepo = sanitize({ git: { baseRef: 'main', revision: 'HEAD' } });
  assert.deepEqual(noRepo.git.repos, {}, 'global refs without a repository are dropped');
  const hostile = sanitize({ git: { repos: { 'c:\\r': { baseRef: '--x', revision: 'a b' } } } });
  assert.deepEqual(hostile.git.repos['c:\\r'], { baseRef: undefined, revision: undefined });
  const many = {};
  for (let i = 0; i < 80; i++) many[`c:\\r${i}`] = { baseRef: 'dev' };
  assert.equal(Object.keys(sanitize({ git: { repos: many } }).git.repos).length, 50);
});

test('workspace Git: Herdr directories resolve nested paths with spaces to distinct real roots', async () => {
  const parentA = tmp('dock-workspace-A-');
  const parentB = tmp('dock-workspace-B-');
  const a = path.join(parentA, 'same repo');
  const b = path.join(parentB, 'same repo');
  fs.mkdirSync(a); fs.mkdirSync(b);
  run(a, 'init', '-q', '-b', 'feature/a');
  run(b, 'init', '-q', '-b', 'feature/b');
  commit(a, 'a.txt'); commit(b, 'b.txt');
  const nested = path.join(a, 'src', 'nested folder');
  fs.mkdirSync(nested, { recursive: true });
  const state = sanitize(undefined);
  let selected = { session: 'contextdeck', connection: 'connected', selected: { workspaceId: 'w1' }, options: [{ id: 'w1', label: 'Alpha', directory: nested }] };
  const ctx = createGitContext({ state, persist() {}, suggestedDir: undefined, selection: { getState: () => selected }, session: 'contextdeck' });
  assert.equal((await ctx.activeRepo()).root, a);
  selected = { ...selected, selected: { workspaceId: 'w2' }, options: [{ id: 'w2', label: 'Beta', directory: b }] };
  assert.equal((await ctx.activeRepo()).root, b);
  const info = await require('../src/main/git/actions').createGitActions({ artifactsDir: tmp('dock-artifacts-'), clipboard: {} }).inspectRepo(b);
  assert.equal(info.name, 'same repo');
  assert.equal(info.branch, 'feature/b');
});

test('workspace Git: manual override wins visibly, persists per identity, and automatic mode restores Herdr', async () => {
  const a = repo('auto-branch');
  const b = repo('manual-branch');
  const state = sanitize(undefined);
  let saves = 0;
  let selected = { session: 'contextdeck', connection: 'connected', selected: { workspaceId: 'w1' }, options: [{ id: 'w1', label: 'Bicho', directory: a }] };
  const ctx = createGitContext({ state, persist: () => { saves++; }, selection: { getState: () => selected }, session: 'contextdeck' });
  assert.equal((await ctx.activeRepo()).source, 'herdr');
  await ctx.chooseRepo(b);
  assert.equal((await ctx.activeRepo()).root, b);
  assert.equal((await ctx.activeRepo()).source, 'manual');
  selected = { ...selected, connection: 'disconnected' };
  assert.equal((await ctx.activeRepo()).root, b, 'manual choice remains available while Herdr is disconnected');
  selected = { ...selected, connection: 'connected', selected: { workspaceId: 'w2' }, options: [{ id: 'w2', label: 'Other', directory: a }] };
  assert.equal((await ctx.activeRepo()).root, a, 'another workspace uses its own suggestion');
  selected = { ...selected, selected: { workspaceId: 'w1' }, options: [{ id: 'w1', label: 'Bicho', directory: a }] };
  assert.equal((await ctx.activeRepo()).root, b, 'switching back restores the manual choice');
  ctx.useAutomatic();
  assert.equal((await ctx.activeRepo()).root, a);
  assert.ok(saves >= 2);
});

test('workspace Git: choosing a folder is bound to the workspace where the picker opened', async () => {
  const a = repo('a');
  const b = repo('b');
  const manual = repo('manual');
  const state = sanitize(undefined);
  let selected = { session: 'contextdeck', connection: 'connected', selected: { workspaceId: 'w1' }, options: [{ id: 'w1', label: 'Alpha', directory: a }] };
  const ctx = createGitContext({ state, persist() {}, selection: { getState: () => selected }, session: 'contextdeck' });
  const openedFor = ctx.choice();
  selected = { ...selected, selected: { workspaceId: 'w2' }, options: [{ id: 'w2', label: 'Beta', directory: b }] };
  await ctx.chooseRepo(manual, openedFor);
  assert.equal((await ctx.activeRepo()).root, b, 'the new selection remains automatic');
  selected = { ...selected, selected: { workspaceId: 'w1' }, options: [{ id: 'w1', label: 'Alpha', directory: a }] };
  assert.equal((await ctx.activeRepo()).root, manual, 'the picker choice belongs to its opening workspace');
});

test('workspace Git: reused ID with changed evidence does not inherit an old manual repository', async () => {
  const oldRepo = repo('old');
  const newRepo = repo('new');
  const manual = repo('manual');
  const state = sanitize(undefined);
  let selected = { session: 'contextdeck', connection: 'connected', selected: { workspaceId: 'w9' }, options: [{ id: 'w9', label: 'Old name', directory: oldRepo }] };
  const ctx = createGitContext({ state, persist() {}, selection: { getState: () => selected }, session: 'contextdeck' });
  await ctx.chooseRepo(manual);
  selected = { ...selected, options: [{ id: 'w9', label: 'Recreated', directory: newRepo }] };
  assert.equal((await ctx.activeRepo()).root, newRepo);
  assert.equal((await ctx.activeRepo()).source, 'herdr');
});

test('workspace Git: manual association and repository refs survive ui-state restart', async () => {
  const workspaceRepo = repo('workspace');
  const chosen = repo('chosen');
  const folder = tmp('dock-state-restart-');
  const file = path.join(folder, 'ui-state.json');
  const identity = { session: 'contextdeck', connection: 'connected', selected: { workspaceId: 'w4' }, options: [{ id: 'w4', label: 'Bicho', directory: workspaceRepo }] };
  const firstState = sanitize(undefined);
  const first = createGitContext({ state: firstState, persist() {}, selection: { getState: () => identity }, session: 'contextdeck' });
  await first.chooseRepo(chosen);
  firstState.git.repos[repoKey(chosen)] = { baseRef: 'refs/heads/chosen', revision: 'HEAD' };
  require('../src/main/persistence/ui-state').saveUiState(file, firstState);
  const restored = require('../src/main/persistence/ui-state').loadUiState(file);
  const second = createGitContext({ state: restored, persist() {}, selection: { getState: () => identity }, session: 'contextdeck' });
  const repoInfo = await second.activeRepo();
  assert.equal(repoInfo.root, chosen);
  assert.equal(repoInfo.source, 'manual');
  assert.equal((await second.loadRefs()).selection.base.value, 'refs/heads/chosen');
});

test('workspace Git: a stale renderer root cannot redirect an operation after workspace switch', async () => {
  const a = repo('a');
  const b = repo('b');
  const state = sanitize(undefined);
  let selected = { session: 'contextdeck', connection: 'connected', selected: { workspaceId: 'w1' }, options: [{ id: 'w1', label: 'A', directory: a }] };
  const ctx = createGitContext({ state, persist() {}, selection: { getState: () => selected }, session: 'contextdeck' });
  selected = { ...selected, selected: { workspaceId: 'w2' }, options: [{ id: 'w2', label: 'B', directory: b }] };
  const result = await ctx.activeRepo(a);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
});

