'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, validateSettings } = require('../src/main/persistence/settings');
const { resolveExecutable } = require('../src/main/platform/executable');

const ROOT = path.join(__dirname, '..');
const tmpDirs = [];
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test('the versioned config.example.json is valid and loads on a fresh checkout (no config.json)', () => {
  const fresh = tmp('dock-cfg-');
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(fresh, 'config.example.json'));
  const cfg = loadSettings(fresh);
  assert.equal(cfg.herdrExecutable, 'herdr.exe');
  assert.equal(cfg.herdrSession, 'contextdeck');
});

test('a local config.json wins over the example and is preserved as-is (e.g. the M00 session name)', () => {
  const dir = tmp('dock-cfg-');
  fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(dir, 'config.example.json'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ herdrExecutable: 'C:\\h\\herdr.exe', herdrSession: 'project-dock-m00', workingDirectory: 'C:\\w' }));
  assert.deepEqual(loadSettings(dir), { herdrExecutable: 'C:\\h\\herdr.exe', herdrSession: 'project-dock-m00', workingDirectory: 'C:\\w' });
});

test('missing config files and invalid JSON fail loudly', () => {
  assert.throws(() => loadSettings(tmp('dock-cfg-')), /ENOENT/);
  const dir = tmp('dock-cfg-');
  fs.writeFileSync(path.join(dir, 'config.json'), '{nope');
  assert.throws(() => loadSettings(dir), SyntaxError);
});

test('config.json is git-ignored and config.example.json is not', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('config.json'));
  assert.ok(!ignore.includes('config.example.json'));
  assert.ok(ignore.includes('dist/'));
});

test('validates a safe session name', () => {
  assert.deepEqual(validateSettings({ herdrExecutable: 'herdr.exe', herdrSession: 'default_123' }), {
    herdrExecutable: 'herdr.exe', herdrSession: 'default_123', workingDirectory: undefined
  });
  assert.throws(() => validateSettings({ herdrExecutable: 'herdr.exe', herdrSession: 'bad name;rm' }), /herdrSession/);
  assert.throws(() => validateSettings({ herdrExecutable: '', herdrSession: 'default' }), /herdrExecutable/);
  assert.throws(() => validateSettings({ herdrExecutable: 'h', herdrSession: 'd', workingDirectory: 5 }), /workingDirectory/);
});

test('resolveExecutable finds bare names in PATH and explicit paths', () => {
  const dir = tmp('dock-exe-');
  const exe = path.join(dir, 'fake-herdr.exe');
  fs.writeFileSync(exe, '');
  assert.equal(resolveExecutable('fake-herdr', { PATH: dir, PATHEXT: '.EXE;.CMD' }).toLowerCase(), exe.toLowerCase());
  assert.equal(resolveExecutable('fake-herdr.exe', { PATH: dir }), exe);
  assert.equal(resolveExecutable(exe, { PATH: '' }), exe);
  assert.equal(resolveExecutable('missing-herdr.exe', { PATH: dir }), undefined);
  assert.equal(resolveExecutable(path.join(dir, 'nope.exe'), { PATH: dir }), undefined);
});
