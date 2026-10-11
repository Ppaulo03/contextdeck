'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSettings, validateSettings, resolveExecutable } = require('../src/settings');

test('reads packaged config', () => {
  const cfg = loadSettings(path.join(__dirname, '..'));
  assert.equal(cfg.herdrSession, 'project-dock-m00');
  assert.equal(cfg.herdrExecutable, 'herdr.exe');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-exe-'));
  try {
    const exe = path.join(dir, 'fake-herdr.exe');
    fs.writeFileSync(exe, '');
    assert.equal(resolveExecutable('fake-herdr', { PATH: dir, PATHEXT: '.EXE;.CMD' }).toLowerCase(), exe.toLowerCase());
    assert.equal(resolveExecutable('fake-herdr.exe', { PATH: dir }), exe);
    assert.equal(resolveExecutable(exe, { PATH: '' }), exe);
    assert.equal(resolveExecutable('missing-herdr.exe', { PATH: dir }), undefined);
    assert.equal(resolveExecutable(path.join(dir, 'nope.exe'), { PATH: dir }), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
