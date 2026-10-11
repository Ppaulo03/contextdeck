'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadUiState, saveUiState, sanitize } = require('../src/main/persistence/ui-state');

const DEFAULT_GIT = { repoDir: undefined, lastZip: undefined, repos: {} };

test('sanitize rejects unknown modes and absurd bounds', () => {
  assert.deepEqual(sanitize({ lastMode: 'evil', bounds: { width: 5, height: 5 } }), { lastMode: 'terminal', bounds: undefined, git: DEFAULT_GIT });
  assert.deepEqual(sanitize({ lastMode: 'chat', bounds: { width: 1200, height: 800 } }), { lastMode: 'chat', bounds: { width: 1200, height: 800 }, git: DEFAULT_GIT });
  assert.deepEqual(sanitize(null), { lastMode: 'terminal', bounds: undefined, git: DEFAULT_GIT });
});

test('sanitize keeps valid git preferences and drops unsafe ones', () => {
  const good = { repoDir: 'C:\\repo', lastZip: 'C:\\a\\x.zip', repos: { 'c:\\repo': { baseRef: 'main', revision: 'HEAD~1' } } };
  assert.deepEqual(sanitize({ git: good }).git, good);
  const bad = sanitize({ git: { repoDir: 5, baseRef: '--output=x', revision: 'a b', lastZip: '', repos: 7 } }).git;
  assert.deepEqual(bad, DEFAULT_GIT);
});

test('state round-trips (including git prefs) and tolerates missing or corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-ui-'));
  try {
    const file = path.join(dir, 'sub', 'ui-state.json');
    assert.equal(loadUiState(file).lastMode, 'terminal');
    assert.deepEqual(loadUiState(file).git, DEFAULT_GIT);
    const state = { lastMode: 'chat', bounds: { width: 1000, height: 700 }, git: { repoDir: 'C:\\r', lastZip: undefined, repos: { 'c:\\r': { baseRef: 'develop', revision: 'abc1234' } } } };
    saveUiState(file, state);
    assert.deepEqual(loadUiState(file), state);
    fs.writeFileSync(file, '{not json');
    assert.equal(loadUiState(file).lastMode, 'terminal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
