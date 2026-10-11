'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = require('../src/git');
const { createGitActions } = require('../src/git-actions');
const { decideShortcut } = require('../src/shortcuts');

const G = ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const run = (cwd, ...args) => execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8' });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// repo: commit1 (a.txt=one) <- dev ; commit2 (a.txt=two, b.txt) <- main/HEAD
function makeRepo() {
  const dir = tmp('dock-repo-');
  run(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  run(dir, 'add', '.'); run(dir, 'commit', '-q', '-m', 'first');
  run(dir, 'branch', 'dev');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
  run(dir, 'add', '.'); run(dir, 'commit', '-q', '-m', 'second');
  return dir;
}

function fakeClipboard({ failText = false, failFile = false } = {}) {
  const calls = { text: [], files: [] };
  return {
    calls,
    writeText(text) { if (failText) throw new Error('clipboard busy'); calls.text.push(text); },
    async writeFile(file) { calls.files.push(file); return failFile ? { ok: false, error: 'sem permissao' } : { ok: true }; }
  };
}

const rm = (...dirs) => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));

test('Ctrl+Tab: only a fresh keyDown toggles; repeat is swallowed; keyUp and other combos ignored', () => {
  const base = { control: true, alt: false, meta: false, shift: false, key: 'Tab', type: 'keyDown', isAutoRepeat: false };
  assert.equal(decideShortcut(base), 'toggle');
  assert.equal(decideShortcut({ ...base, isAutoRepeat: true }), 'swallow');
  assert.equal(decideShortcut({ ...base, type: 'keyUp' }), null);
  assert.equal(decideShortcut({ ...base, control: false }), null);
  assert.equal(decideShortcut({ ...base, alt: true }), null);
  assert.equal(decideShortcut({ ...base, key: '1' }), null);
  assert.equal(decideShortcut({ ...base, alt: true, key: '1' }), null, 'Ctrl+Alt+1 no longer a shortcut');
  assert.equal(decideShortcut({ ...base, alt: true, key: '2' }), null, 'Ctrl+Alt+2 no longer a shortcut');
  assert.equal(decideShortcut(undefined), null);
});

test('isSafeRef accepts normal refs and rejects option/injection shapes', () => {
  for (const ok of ['HEAD', 'HEAD~1', 'HEAD^', 'origin/dev', 'v1.0.0', 'feature/x-1', 'a1b2c3d', 'HEAD@{1}']) assert.equal(git.isSafeRef(ok), true, ok);
  for (const bad of ['', '-p', '--output=x', 'a b', 'dev;calc', 'a&&b', 'dev..main', '$(x)', 'x\ny', 'HEAD:file', 'a'.repeat(201), null, 5]) assert.equal(git.isSafeRef(bad), false, String(bad));
});

test('runGit receives arguments literally (no shell) and caps output', async () => {
  const dir = makeRepo();
  try {
    const marker = path.join(dir, 'pwned.txt');
    const r = await git.runGit(dir, ['rev-parse', '--verify', '--quiet', `dev & echo x > "${marker}"`]);
    assert.notEqual(r.code, 0);
    assert.equal(fs.existsSync(marker), false);
    const big = await git.runGit(dir, ['log', '-p'], { maxBytes: 10 });
    assert.equal(big.tooLarge, true);
  } finally { rm(dir); }
});

test('resolveRepoRoot: subfolder -> root; non-repo, missing, relative and empty are rejected', async () => {
  const dir = makeRepo();
  const plain = tmp('dock-plain-');
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    const ok = await git.resolveRepoRoot(path.join(dir, 'sub'));
    assert.equal(ok.ok, true);
    assert.equal(fs.realpathSync(ok.root).toLowerCase(), fs.realpathSync(dir).toLowerCase());
    assert.equal((await git.resolveRepoRoot(plain)).ok, false);
    assert.equal((await git.resolveRepoRoot(path.join(dir, 'nope'))).ok, false);
    assert.equal((await git.resolveRepoRoot(path.join(dir, 'a.txt'))).ok, false);
    assert.match((await git.resolveRepoRoot('relative/path')).error, /absoluto/);
    assert.match((await git.resolveRepoRoot('')).error, /nao configurado/);
    assert.equal((await git.resolveRepoRoot(undefined)).ok, false);
  } finally { rm(dir, plain); }
});

test('resolveCommit resolves branches/relative revs and rejects unknown or unsafe refs', async () => {
  const dir = makeRepo();
  try {
    const head = await git.resolveCommit(dir, 'HEAD');
    const prev = await git.resolveCommit(dir, 'HEAD~1');
    const dev = await git.resolveCommit(dir, 'dev');
    assert.match(head.sha, /^[0-9a-f]{40}$/);
    assert.equal(prev.sha, dev.sha);
    assert.notEqual(head.sha, dev.sha);
    assert.equal((await git.resolveCommit(dir, 'prod')).ok, false);
    assert.equal((await git.resolveCommit(dir, '--all')).ok, false);
    assert.equal((await git.resolveCommit(dir, 'dev; calc')).ok, false);
  } finally { rm(dir); }
});

test('copyDiff copies the real diff, ignores untracked files and leaves the repo untouched', async () => {
  const dir = makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');
    const statusBefore = run(dir, 'status', '--porcelain');
    const indexBefore = sha256(path.join(dir, '.git', 'index'));
    const clip = fakeClipboard();
    const actions = createGitActions({ artifactsDir: tmp('dock-art-'), clipboard: clip });
    const r = await actions.copyDiff(dir, 'dev');
    assert.equal(r.ok, true, r.error);
    assert.equal(clip.calls.text.length, 1);
    assert.match(clip.calls.text[0], /^diff --git a\/a\.txt b\/a\.txt/m);
    assert.match(clip.calls.text[0], /\+three/);
    assert.match(clip.calls.text[0], /b\.txt/, 'files added since dev appear');
    assert.doesNotMatch(clip.calls.text[0], /untracked\.txt/);
    assert.equal(run(dir, 'status', '--porcelain'), statusBefore);
    assert.equal(sha256(path.join(dir, '.git', 'index')), indexBefore);
    assert.equal(run(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  } finally { rm(dir); }
});

test('copyDiff: empty diff and git errors never reach the clipboard', async () => {
  const dir = makeRepo();
  try {
    const clip = fakeClipboard();
    const actions = createGitActions({ artifactsDir: tmp('dock-art-'), clipboard: clip });
    const empty = await actions.copyDiff(dir, 'HEAD');
    assert.equal(empty.ok, false);
    assert.equal(empty.empty, true);
    const unknown = await actions.copyDiff(dir, 'nao-existe');
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /nao existe/);
    const notRepo = await actions.copyDiff(os.tmpdir(), 'HEAD');
    assert.equal(notRepo.ok, false);
    assert.equal((await actions.copyDiff(undefined, 'HEAD')).ok, false);
    assert.deepEqual(clip.calls.text, []);
  } finally { rm(dir); }
});

test('copyDiff reports clipboard failure instead of success', async () => {
  const dir = makeRepo();
  try {
    const actions = createGitActions({ artifactsDir: tmp('dock-art-'), clipboard: fakeClipboard({ failText: true }) });
    const r = await actions.copyDiff(dir, 'dev');
    assert.equal(r.ok, false);
    assert.match(r.error, /clipboard busy/);
  } finally { rm(dir); }
});

test('copyShow handles HEAD, HEAD~1 and hashes', async () => {
  const dir = makeRepo();
  try {
    const clip = fakeClipboard();
    const actions = createGitActions({ artifactsDir: tmp('dock-art-'), clipboard: clip });
    assert.equal((await actions.copyShow(dir, 'HEAD')).ok, true);
    assert.match(clip.calls.text[0], /second/);
    assert.equal((await actions.copyShow(dir, 'HEAD~1')).ok, true);
    assert.match(clip.calls.text[1], /first/);
    const hash = run(dir, 'rev-parse', 'HEAD').trim();
    assert.equal((await actions.copyShow(dir, hash.slice(0, 10))).ok, true);
    assert.equal((await actions.copyShow(dir, 'HEAD~9')).ok, false);
    assert.equal(clip.calls.text.length, 3);
  } finally { rm(dir); }
});

test('makeZip writes a unique ZIP outside the repo, copies it as a file and does not touch the repo', async () => {
  const dir = makeRepo();
  const art = tmp('dock-art-');
  try {
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'x\n');
    const statusBefore = run(dir, 'status', '--porcelain');
    const clip = fakeClipboard();
    const actions = createGitActions({ artifactsDir: art, clipboard: clip });
    const one = await actions.makeZip(dir, 'HEAD');
    const two = await actions.makeZip(dir, 'HEAD');
    assert.equal(one.ok, true, one.error);
    assert.notEqual(one.zip.path, two.zip.path, 'names are unique');
    assert.equal(path.dirname(one.zip.path), art);
    assert.deepEqual(clip.calls.files, [one.zip.path, two.zip.path]);
    const bytes = fs.readFileSync(one.zip.path);
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    assert.ok(bytes.includes('a.txt') && bytes.includes('b.txt'));
    assert.ok(!bytes.includes('untracked.txt'), 'untracked files are not archived');
    assert.equal(one.zip.size, bytes.length);
    assert.ok(fs.existsSync(one.zip.path), 'ZIP stays on disk');
    assert.equal(run(dir, 'status', '--porcelain'), statusBefore);
    assert.equal((await actions.makeZip(dir, 'nao-existe')).ok, false);
  } finally { rm(dir, art); }
});

test('makeZip keeps the ZIP and reports honestly when the file clipboard fails', async () => {
  const dir = makeRepo();
  const art = tmp('dock-art-');
  try {
    const actions = createGitActions({ artifactsDir: art, clipboard: fakeClipboard({ failFile: true }) });
    const r = await actions.makeZip(dir, 'HEAD');
    assert.equal(r.ok, false);
    assert.match(r.error, /nao foi copiado como arquivo/);
    assert.ok(r.zip && fs.existsSync(r.zip.path));
  } finally { rm(dir, art); }
});

test('makeZip refuses an artifacts directory inside the repository', async () => {
  const dir = makeRepo();
  try {
    const actions = createGitActions({ artifactsDir: path.join(dir, 'zips'), clipboard: fakeClipboard() });
    const r = await actions.makeZip(dir, 'HEAD');
    assert.equal(r.ok, false);
    assert.match(r.error, /dentro do repositorio/);
    assert.equal(fs.existsSync(path.join(dir, 'zips')), false);
  } finally { rm(dir); }
});

test('deleteZip removes only the managed ZIP it is given', async () => {
  const dir = makeRepo();
  const art = tmp('dock-art-');
  const other = tmp('dock-other-');
  try {
    const actions = createGitActions({ artifactsDir: art, clipboard: fakeClipboard() });
    const made = await actions.makeZip(dir, 'HEAD');
    const keep = await actions.makeZip(dir, 'HEAD');

    // Foreign files with look-alike or arbitrary names are refused.
    const stranger = path.join(art, 'minha-pasta-importante.zip');
    fs.writeFileSync(stranger, 'x');
    const fake = path.join(other, path.basename(made.zip.path));
    fs.writeFileSync(fake, 'x');
    const repoFile = path.join(dir, 'a.txt');
    for (const target of [stranger, fake, repoFile, art, '', undefined, 'relative.zip', path.join(art, '..', path.basename(stranger))]) {
      assert.equal(actions.deleteZip(target).ok, false, String(target));
    }
    assert.ok(fs.existsSync(stranger) && fs.existsSync(fake) && fs.existsSync(repoFile));

    assert.equal(actions.deleteZip(made.zip.path).ok, true);
    assert.equal(fs.existsSync(made.zip.path), false);
    assert.ok(fs.existsSync(keep.zip.path), 'other generated ZIPs are untouched');
    const again = actions.deleteZip(made.zip.path);
    assert.equal(again.ok, false);
    assert.equal(again.missing, true);
  } finally { rm(dir, art, other); }
});
