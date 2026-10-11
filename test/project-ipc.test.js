'use strict';

// IPC of the Project links (M01-I3B-3): trusted callers only, the page address comes from main, off unless enabled.
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerChatsIpc } = require('../src/main/ipc/chats');

const URL_OK = `https://chatgpt.com/g/g-p-${'a'.repeat(32)}-x/project`;

function setup({ projects = true } = {}) {
  const handlers = new Map();
  const calls = { link: [], unlink: [], notified: 0 };
  const service = projects ? {
    link: (a) => { calls.link.push(a); return { ok: true }; },
    unlink: (a) => { calls.unlink.push(a); return { ok: true }; },
    getState: () => ({ records: [] })
  } : null;
  registerChatsIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    trusted: (e) => e.ok === true,
    win: { getChatUrl: () => URL_OK },
    bindings: { getState: () => ({ bindings: [] }) },
    notify: () => { calls.notified += 1; },
    projects: service
  });
  return { call: (c, args, e = { ok: true }) => handlers.get(c)(e, args), calls };
}
const base = { target: { session: 'contextdeck', workspaceId: 'w1' }, selectedAtOpen: 'w1' };

test('strangers get nothing and cause nothing', async () => {
  const t = setup();
  assert.equal((await t.call('projects:link', { ...base, source: 'current' }, {})).error.code, 'untrusted');
  assert.equal((await t.call('projects:unlink', base, {})).error.code, 'untrusted');
  assert.deepEqual([t.calls.link, t.calls.unlink], [[], []]);
});

test('"current" takes the address from main, never from the renderer; only picked fields reach the service', async () => {
  const t = setup();
  const r = await t.call('projects:link', { ...base, source: 'current', url: 'https://evil.example/', label: 'x', targetChosen: true, replace: true, move: 'yes', extra: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(t.calls.link[0], { target: base.target, url: URL_OK, label: 'x', selectedAtOpen: 'w1', confirmTarget: false, targetChosen: true, replace: true, move: false });
  assert.equal(t.calls.notified, 1, 'a successful write notifies the pusher');
});

test('"url" passes the typed address to the service (which validates it); other sources and shapes are refused', async () => {
  const t = setup();
  await t.call('projects:link', { ...base, source: 'url', url: URL_OK });
  assert.equal(t.calls.link[0].url, URL_OK);
  for (const bad of [{ ...base, source: 'file' }, { ...base, source: 'url' }, { ...base, source: 'url', url: 7 }, { ...base, source: 'current', label: 5 }, null, 'x', []]) {
    assert.equal((await t.call('projects:link', bad)).error.code, 'invalid_request', JSON.stringify(bad));
  }
  assert.equal(t.calls.link.length, 1);
});

test('unlink needs a well-formed workspace identity', async () => {
  const t = setup();
  assert.equal((await t.call('projects:unlink', { target: { session: 'contextdeck', workspaceId: 'w1' } })).ok, true);
  assert.deepEqual(t.calls.unlink, [{ workspaceIdentity: { session: 'contextdeck', workspaceId: 'w1' } }]);
  assert.equal((await t.call('projects:unlink', { target: 'w1' })).error.code, 'invalid_request');
});

test('switched off: the channels exist but do nothing', async () => {
  const t = setup({ projects: false });
  assert.equal((await t.call('projects:link', { ...base, source: 'current' })).error.code, 'projects_disabled');
  assert.equal((await t.call('projects:unlink', base)).error.code, 'projects_disabled');
  assert.equal(t.calls.notified, 0);
});

test('the feature is off by default and wired only behind CONTEXTDECK_PROJECTS=1', () => {
  const fs = require('node:fs');
  const index = fs.readFileSync('src/main/index.js', 'utf8');
  assert.match(index, /const projectsOn = process\.env\.CONTEXTDECK_PROJECTS === '1'/);
  assert.match(index, /projectsOn\s*\n?\s*\? createProjectBindings/);
  assert.match(index, /creation = projectsOn \? createProjectCreation/);
});
