'use strict';

// Fakes for the chat view tests: views whose events and load completions the test controls, a host that records
// attach/detach order, and a navigator wired to the real bindings service (temporary directory, fake Herdr).
const { EventEmitter } = require('node:events');
const { createChatViewManager } = require('../../src/main/chat-views/manager');
const { createObservationHub } = require('../../src/main/chat-views/observation');
const { createStateObserver } = require('../../src/main/chat/state-observer');
const { createChatNavigator } = require('../../src/main/chat-views/navigator');
const { createWorld, chatUrl } = require('./bindings-world');

function createFakeViews() {
  const views = [];
  const log = [];        // ['attach'|'detach'|'bounds'|'load'|'destroy', viewId, ...]
  const factory = ({ id, url, onEvent }) => {
    let current = '';
    let gone = false;
    const pending = [];
    // What the status observer sees: a WebContents-like emitter. `signals` is what the probe answers (the test edits it).
    const contents = new EventEmitter();
    contents.url = ''; contents.loading = false;
    contents.getURL = () => contents.url;
    contents.isLoading = () => contents.loading;
    contents.isDestroyed = () => gone;
    contents.signals = { composer: true, stop: false, turnActions: false, error: false, interrupted: null, draft: false };
    contents.probes = 0;
    contents.hang = false;       // the probe never answers
    contents.probeError = null;
    contents.probeGate = null;   // a promise the probe waits for (to resolve results late / out of order)
    contents.executeJavaScriptInIsolatedWorld = async () => {
      contents.probes += 1;
      if (contents.hang) return new Promise(() => {});
      if (contents.probeError) throw contents.probeError;
      const reply = { ...contents.signals };
      if (contents.probeGate) await contents.probeGate;
      return reply;
    };
    const history = [];
    const handle = {
      id, initialUrl: url, onEvent, contents,
      loads: [],
      history,
      canGoBack: () => !gone && history.length > 1,
      goBack: () => { if (gone || history.length < 2) return false; history.pop(); current = history[history.length - 1]; contents.url = current; onEvent('navigated', { url: current }); return true; },
      getUrl: () => current,
      loadURL: (u) => {
        handle.loads.push(u); log.push(['load', id, u]);
        contents.loading = true; contents.emit('did-start-loading'); contents.emit('did-start-navigation', {}, u, false, true);
        return new Promise((resolve, reject) => pending.push({ resolve, reject, url: u }));
      },
      focus() { log.push(['focus', id]); },
      isDestroyed: () => gone,
      destroy() { gone = true; log.push(['destroy', id]); contents.emit('destroyed'); },
      // test controls
      navigate(u, { inPage = true } = {}) {
        current = u; contents.url = u; history.push(u);
        onEvent('navigated', { url: u });
        if (inPage) contents.emit('did-navigate-in-page', {}, u, true); else contents.emit('did-navigate', {}, u);
      },
      finishLoad(u) {
        const p = pending.shift();
        if (!p) return;
        current = u || p.url; contents.url = current; history.push(current);
        onEvent('navigated', { url: current });
        contents.emit('did-navigate', {}, current);
        contents.loading = false; contents.emit('did-stop-loading');
        p.resolve();
      },
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

module.exports = { createViewsWorld, createStatusWorld, createFakeViews, createClock, bindMany, chatUrl, HOME };

// ---- status (M01-I3B-2): the real I3P observer on fake contents, virtual timers, a controllable clock ------------------
const flushAll = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// Virtual time: timers fire in order as the test advances the clock; Date.now() is the same clock, so the observer's
// "last answer" timestamps and the hub's expiry agree.
function createClock(start = 1_000_000) {
  const clock = { t: start, timers: [], realNow: Date.now };
  let id = 0;
  clock.setTimer = (fn, ms) => { const timer = { id: ++id, at: clock.t + ms, ms, fn, unref() {} }; clock.timers.push(timer); return timer; };
  clock.clearTimer = (timer) => { const i = clock.timers.indexOf(timer); if (i >= 0) clock.timers.splice(i, 1); };
  clock.advance = async (ms) => {
    const target = clock.t + ms;
    for (;;) {
      await flushAll();
      const due = clock.timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock.timers.splice(clock.timers.indexOf(due), 1);
      clock.t = due.at;
      due.fn();
    }
    clock.t = target;
    await flushAll();
  };
  Date.now = () => clock.t;
  clock.restore = () => { Date.now = clock.realNow; };
  return clock;
}

function createStatusWorld(opts = {}) {
  const clock = createClock();
  const world = createWorld(opts);
  const fake = createFakeViews();
  const manager = createChatViewManager({ createView: fake.factory, host: fake.host, now: () => clock.t });
  const started = [];                                    // every observer ever started
  const startObserver = opts.startObserver || (({ handle, onChange, phaseMs }) => {
    const observer = createStateObserver({ contents: handle.contents, onChange, phaseMs, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    started.push({ viewId: handle.id, observer });
    return observer;
  });
  const hub = createObservationHub({ manager, startObserver, now: () => clock.t, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ttlMs: opts.ttlMs, sweepMs: opts.sweepMs });
  const last = {};
  const prefs = { getLast: (wk) => last[wk] || null, setLast: (wk, id) => { last[wk] = id; } };
  const navigator = createChatNavigator({ manager, session: world.session, bindings: world.bindings, selection: world.selection, prefs, homeUrl: HOME, activity: hub });
  hub.setInteractive(true);
  const cleanup = () => { navigator.stop(); hub.stop(); clock.restore(); world.cleanup(); };
  return { ...world, fake, manager, hub, navigator, prefs, last, HOME, clock, started, cleanup0: cleanup };
}
