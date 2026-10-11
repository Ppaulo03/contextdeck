'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadUiState, saveUiState, sanitize } = require('../src/main/persistence/ui-state');

const DEFAULT_GIT = { repoDir: undefined, lastZip: undefined, repos: {} };
const DEFAULT_HERDR = { mode: 'auto', lastWorkspace: null };
const DEFAULT_CHAT = { last: {} };

test('sanitize rejects unknown modes and absurd bounds', () => {
  assert.deepEqual(sanitize({ lastMode: 'evil', bounds: { width: 5, height: 5 } }), { lastMode: 'terminal', bounds: undefined, git: DEFAULT_GIT, herdr: DEFAULT_HERDR, chat: DEFAULT_CHAT });
  assert.deepEqual(sanitize({ lastMode: 'chat', bounds: { width: 1200, height: 800 } }), { lastMode: 'chat', bounds: { width: 1200, height: 800 }, git: DEFAULT_GIT, herdr: DEFAULT_HERDR, chat: DEFAULT_CHAT });
  assert.deepEqual(sanitize(null), { lastMode: 'terminal', bounds: undefined, git: DEFAULT_GIT, herdr: DEFAULT_HERDR, chat: DEFAULT_CHAT });
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
    const state = { lastMode: 'chat', bounds: { width: 1000, height: 700 }, git: { repoDir: 'C:\\r', lastZip: undefined, repos: { 'c:\\r': { baseRef: 'develop', revision: 'abc1234' } } }, herdr: { mode: 'manual', lastWorkspace: { session: 'contextdeck', workspaceId: 'w4' } }, chat: { last: { 'contextdeck/w4': 'b_00000000000000aa' } } };
    saveUiState(file, state);
    assert.deepEqual(loadUiState(file), state);
    fs.writeFileSync(file, '{not json');
    assert.equal(loadUiState(file).lastMode, 'terminal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('herdr selector preferences: only valid explicit selections are kept, bound to their session', () => {
  const good = { mode: 'manual', lastWorkspace: { session: 'project-dock-m00', workspaceId: 'w12' } };
  assert.deepEqual(sanitize({ herdr: good }).herdr, good);
  assert.deepEqual(sanitize({ herdr: { mode: 'weird' } }).herdr, DEFAULT_HERDR, 'unknown modes fall back to auto');
  for (const bad of [
    { session: 'bad name;x', workspaceId: 'w1' }, { session: 'ok', workspaceId: '../x' }, { session: 'ok', workspaceId: 'w'.repeat(80) },
    { session: 5, workspaceId: 'w1' }, { session: 'ok' }, 'w1', null
  ]) assert.equal(sanitize({ herdr: { lastWorkspace: bad } }).herdr.lastWorkspace, null, JSON.stringify(bad));
  assert.deepEqual(sanitize({ herdr: 'junk' }).herdr, DEFAULT_HERDR);
});

test('files written before the workspace selector existed (M00-I3 / R00 shape) still load with defaults', () => {
  const legacy = { lastMode: 'chat', bounds: { width: 1241, height: 820 }, git: { repoDir: 'C:\\Users\\u\\repo', repos: { 'c:\\users\\u\\repo': { baseRef: 'refs/heads/main', revision: 'HEAD' } } } };
  const loaded = sanitize(legacy);
  assert.deepEqual(loaded.herdr, DEFAULT_HERDR);
  assert.equal(loaded.lastMode, 'chat');
  assert.equal(loaded.git.repos['c:\\users\\u\\repo'].baseRef, 'refs/heads/main');
});

test('last conversation per workspace (M01-I3B-1): only well-formed ids are kept, bounded, and older files without it load', () => {
  const good = { last: { 'contextdeck/w1': 'b_0123456789abcdef', 'lab/w2.3': 'b_fedcba9876543210' } };
  assert.deepEqual(sanitize({ chat: good }).chat, good);
  for (const bad of [null, 'x', 7, [], { last: [] }, { last: 'x' }, { last: { w1: 'b_0123456789abcdef' } }, { last: { 'contextdeck/w1': 'nope' } }, { last: { 'a b/w1': 'b_0123456789abcdef' } }, { last: { 'contextdeck/../w1': 'b_0123456789abcdef' } }, { last: { 'contextdeck/w1': 7 } }]) {
    assert.deepEqual(sanitize({ chat: bad }).chat, DEFAULT_CHAT, JSON.stringify(bad));
  }
  const many = {};
  for (let i = 0; i < 300; i++) many[`s/w${i}`] = `b_${String(i).padStart(16, '0')}`;
  assert.equal(Object.keys(sanitize({ chat: { last: many } }).chat.last).length, 100);
  // Files written by every earlier iteration (no `chat`) still load with the defaults.
  assert.deepEqual(sanitize({ lastMode: 'chat', herdr: { mode: 'manual' } }).chat, DEFAULT_CHAT);
  // The preference holds ids only: the bindings themselves are not duplicated in ui-state.json.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-ui-'));
  try {
    const file = path.join(dir, 'ui-state.json');
    saveUiState(file, { ...sanitize(undefined), chat: good });
    const text = fs.readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(text).chat, good);
    assert.doesNotMatch(text, /https:\/\/chatgpt|label|conversationKey/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
