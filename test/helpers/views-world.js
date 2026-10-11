'use strict';

// Fakes for the chat view tests: views whose events and load completions the test controls, a host that records
// attach/detach order, and a navigator wired to the real bindings service (temporary directory, fake Herdr).
const { createChatViewManager } = require('../../src/main/chat-views/manager');
const { createChatNavigator } = require('../../src/main/chat-views/navigator');
const { createWorld, chatUrl } = require('./bindings-world');

function createFakeViews() {
  const views = [];
  const log = [];        // ['attach'|'detach'|'bounds'|'load'|'destroy', viewId, ...]
  const factory = ({ id, url, onEvent }) => {
    let current = '';
    let gone = false;
    const pending = [];
    const handle = {
      id, initialUrl: url, onEvent,
      loads: [],
      getUrl: () => current,
      loadURL: (u) => { handle.loads.push(u); log.push(['load', id, u]); return new Promise((resolve, reject) => pending.push({ resolve, reject, url: u })); },
      focus() { log.push(['focus', id]); },
      isDestroyed: () => gone,
      destroy() { gone = true; log.push(['destroy', id]); },
      // test controls
      navigate(u) { current = u; onEvent('navigated', { url: u }); },
      finishLoad(u) { const p = pending.shift(); if (p) { current = u || p.url; onEvent('navigated', { url: current }); p.resolve(); } },
      failLoad(error = { errno: -105, code: 'ERR_NAME_NOT_RESOLVED' }) { const p = pending.shift(); if (p) p.reject(error); },
      pendingLoads: () => pending.length,
      emit: (kind, payload) => onEvent(kind, payload)
    };
    views.push(handle);
    return handle;
  };
  const host = {
    attached: new Set(),
    attach: (h) => { host.attached.add(h.id); log.push(['attach', h.id]); },
    detach: (h) => { host.attached.delete(h.id); log.push(['detach', h.id]); },
    setBounds: (h) => { log.push(['bounds', h.id]); }
  };
  return { views, log, factory, host, byId: (id) => views.find((v) => v.id === id) };
}

const HOME = 'https://chatgpt.com/';

function createViewsWorld(opts = {}) {
  const world = createWorld(opts);
  const fake = createFakeViews();
  const clock = { t: 0 };                        // the manager's clock: tests advance it explicitly
  const manager = createChatViewManager({ createView: fake.factory, host: fake.host, now: () => clock.t });
  const last = {};                               // persisted last conversation per workspace (what ui-state.json holds)
  const prefs = { getLast: (wk) => last[wk] || null, setLast: (wk, id) => { last[wk] = id; } };
  const navigator = createChatNavigator({ manager, session: world.session, bindings: world.bindings, selection: world.selection, prefs, homeUrl: HOME });
  return { ...world, fake, manager, navigator, prefs, last, HOME, clock };
}

// Binds conversations 1..n to the selected workspace through the real service.
function bindMany(w, numbers, extra = {}) {
  return numbers.map((n) => {
    const r = w.bindings.bind(w.args(n, extra));
    if (!r.ok) throw new Error(`bind ${n}: ${JSON.stringify(r.error)}`);
    return r.binding;
  });
}

module.exports = { createViewsWorld, createFakeViews, bindMany, chatUrl, HOME };
