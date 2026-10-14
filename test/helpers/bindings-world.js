'use strict';

// Fakes for the chat bindings tests: a Herdr observer and a workspace selection whose state the test mutates,
// a real store on a temporary directory, and the service wired to them. No Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBindingsStore } = require('../../src/main/chat-bindings/store');
const { createChatBindings } = require('../../src/main/chat-bindings/service');

const ID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const chatUrl = (n) => `https://chatgpt.com/c/${ID(n)}`;
const projectUrl = (n, project = 'g-p-abc123-demo') => `https://chatgpt.com/g/${project}/c/${ID(n)}`;

const ws = (id, label, directory = `C:\\work\\${label || id}`) => ({ id, number: Number(String(id).replace(/\D/g, '')) || null, label, directory });

function createWorld({ session = 'contextdeck', workspaces = [ws('w1', 'api'), ws('w2', 'app')], selected = { workspaceId: 'w1', origin: 'dock' }, dir, fsImpl, now } = {}) {
  const root = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'dock-bind-'));
  const file = path.join(root, 'chat-bindings.json');
  const observerListeners = new Set();
  const selectionListeners = new Set();
  const herdr = { connection: 'connected', workspaces };
  const sel = { selected, pending: null };
  const observer = {
    getState: () => ({ connection: herdr.connection, model: herdr.connection === 'connected' || herdr.model ? { workspaces: herdr.workspaces } : null, epoch: 1 }),
    onChange: (l) => { observerListeners.add(l); return () => observerListeners.delete(l); }
  };
  // `select` is the explicit user selection (the M01-I2 controller): by default it succeeds and the workspace becomes the
  // selected one (origin dock); a test replaces `selectImpl` to make it fail, wait, or settle somewhere else.
  const selectCalls = [];
  const world0 = { selectImpl: null };
  const selection = {
    getState: () => ({ selected: sel.selected, pending: sel.pending, options: herdr.workspaces }),
    onChange: (l) => { selectionListeners.add(l); return () => selectionListeners.delete(l); },
    select: async (s, workspaceId) => {
      selectCalls.push([s, workspaceId]);
      if (world0.selectImpl) return world0.selectImpl(s, workspaceId);
      sel.selected = { workspaceId, origin: 'dock' };
      selectionListeners.forEach((l) => l());
      return { ok: true, confirmed: true };
    }
  };
  let clock = 1000;
  let seq = 0;
  const tick = now || (() => (clock += 10));
  const store = createBindingsStore({ file, fs: fsImpl, now: tick });
  const bindings = createChatBindings({ store, session, observer, selection, now: tick, newId: () => `b_${String(++seq).padStart(16, '0')}` });
  return {
    root, file, store, bindings, herdr, sel, session, observer, selection, selectCalls, world0,
    setSelectImpl: (fn) => { world0.selectImpl = fn; },
    select: (workspaceId, origin = 'dock') => { sel.selected = workspaceId ? { workspaceId, origin } : null; selectionListeners.forEach((l) => l()); },
    setWorkspaces: (list) => { herdr.workspaces = list; observerListeners.forEach((l) => l()); },
    disconnect: () => { herdr.connection = 'disconnected'; observerListeners.forEach((l) => l()); },
    connect: () => { herdr.connection = 'connected'; observerListeners.forEach((l) => l()); },
    target: (workspaceId, s = session) => ({ session: s, workspaceId }),
    // The arguments of a normal, explicit bind to the currently selected workspace.
    args: (n, extra = {}) => ({ target: { session, workspaceId: sel.selected ? sel.selected.workspaceId : 'w1' }, url: chatUrl(n), origin: 'url', label: `chat ${n}`, role: 'general', selectedAtOpen: sel.selected ? sel.selected.workspaceId : null, ...extra }),
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

module.exports = { createWorld, ws, ID, chatUrl, projectUrl };
