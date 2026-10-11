'use strict';

const { createWorkspaceObserver } = require('../../src/main/herdr/workspace-observer');
const fx = require('./herdr-fixtures');

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

// Deterministic world: manual clock + scheduler, fake locator and fake API connections that behave
// like Herdr (a snapshot, an event stream and workspace.focus). Nothing here touches the network.
function world({ session = 'contextdeck', workspaces = [[1, 'api'], [2, 'web']], focused = 1 } = {}) {
  let t = 1_000_000;
  const timers = [];
  let timerId = 0;
  const scheduler = {
    setTimeout: (fn, ms) => { const timer = { id: ++timerId, at: t + ms, ms, fn }; timers.push(timer); return timer.id; },
    clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  const w = {
    session, current: { workspaces, focused }, now: () => t,
    locateResult: { socketPath: 'C:\\h\\herdr.sock', running: true },
    locateError: null, locateCalls: 0,
    apis: [], requestLog: [], snapshotError: null, snapshotDelay: null, subscribeError: null,
    focusCalls: [], focusError: null, focusDelay: null, afterFocus: null,
    delays: () => timers.map((x) => x.ms),
    pendingTimers: () => timers.length,
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        await settle();
        const due = timers.filter((x) => x.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        t = due.at;
        due.fn();
      }
      t = target;
      await settle();
    },
    setSnapshot(workspacesNext, focusedNext) { w.current = { workspaces: workspacesNext, focused: focusedNext }; },
    // What Herdr does when the user switches workspace in the TUI: state changes, then events are published.
    tuiSwitch(number) {
      w.current = { ...w.current, focused: number };
      const api = w.liveApi();
      if (api && api.handlers) for (const type of ['workspace_focused', 'tab_focused', 'pane_focused']) api.handlers.onEvent({ event: type, data: { type, workspace_id: `w${number}` } });
    },
    liveApi: () => w.apis.filter((a) => !a.closed).pop(),
    locate: async () => { w.locateCalls += 1; if (w.locateError) throw w.locateError; return w.locateResult; },
    createApi: ({ socketPath }) => {
      const api = {
        socketPath, handlers: null, closed: false, subscribeCalls: 0, requests: 0,
        async subscribe(types, handlers) {
          api.subscribeCalls += 1; api.types = types;
          if (w.subscribeError) throw w.subscribeError;
          w.requestLog.push('subscribe');
          api.handlers = handlers;
          return { close: () => { api.subscriptionClosed = true; } };
        },
        async request(method) {
          api.requests += 1; w.requestLog.push(method);
          if (w.snapshotError) throw w.snapshotError;
          // Like a real server, answer with the state at the time of the request, even if the reply is delayed.
          const result = fx.snapshotResult(w.current.workspaces, w.current.focused);
          if (w.snapshotDelay) await w.snapshotDelay;
          return result;
        },
        async focusWorkspace(id) {
          w.focusCalls.push(id); w.requestLog.push(`focus:${id}`);
          if (w.focusDelay) await w.focusDelay;
          if (w.focusError) throw w.focusError;
          const number = Number(String(id).slice(1));
          if (!w.current.workspaces.some(([n]) => n === number)) throw Object.assign(new Error(`workspace ${id} not found`), { code: 'workspace_not_found' });
          w.current = { ...w.current, focused: number };
          if (w.afterFocus) w.afterFocus();
          return { workspace_id: id };
        },
        close() { api.closed = true; },
        emit: (event) => api.handlers.onEvent(event),
        drop: (error = null) => api.handlers.onClose(error)
      };
      w.apis.push(api);
      return api;
    }
  };
  w.observer = createWorkspaceObserver({ session, locate: w.locate, createApi: w.createApi, scheduler, now: w.now });
  return w;
}

module.exports = { world, settle };
