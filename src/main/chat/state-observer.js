'use strict';

const { createState, reduce, PAGE, GEN } = require('./state-model');
const { WORLD_ID, probeSource, normalizeSignals } = require('./state-detector');

// Sequence bookkeeping alone (lastSeq) is not a change worth reporting.
const meaningful = (s) => JSON.stringify([s.epoch, s.page, s.identity, s.generation, s.draft, s.visible, s.attention]);

const DEFAULT_INTERVALS = Object.freeze({ respondingMs: 1000, visibleIdleMs: 2000, hiddenIdleMs: 5000 });

// Binds the pure model to one WebContents using only supported Electron mechanisms:
//  - navigation/lifecycle events (did-start-navigation, did-stop-loading, did-fail-load, did-navigate,
//    did-navigate-in-page, render-process-gone), registered once and removed exactly on stop();
//  - a timer-chained poll (never overlapping) of a boolean-only probe in an isolated world, only while the
//    page is ready. No DOM mutation observers, no preload, no IPC from the page, no network interception.
// onChange runs only when the model actually changed, never per poll.
function createStateObserver({ contents, onChange, intervals = DEFAULT_INTERVALS, diagnostic = false, onProbe, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let state = createState();
  let seq = 0;
  let timer;
  let stopped = false;
  const stats = { polls: 0, changes: 0, signalsLost: 0, lastLatencyMs: null };
  const source = probeSource({ diagnostic });

  function dispatch(event) {
    const next = reduce(state, event);
    if (next === state) return;
    const prev = state;
    state = next;
    if (meaningful(prev) === meaningful(next)) return;
    stats.changes += 1;
    onChange?.(next, prev, event);
    if (next.page !== prev.page || next.visible !== prev.visible || next.generation.state !== prev.generation.state) schedule();
  }

  const mainFrame = (isMainFrame) => isMainFrame !== false;
  const handlers = {
    // did-start-loading also fires for in-page (history.pushState) navigations in the real app; only a real
    // main-frame navigation starts a page load, otherwise the response in progress would be forgotten when a
    // new chat receives its durable URL.
    'did-start-navigation': (_event, _url, isInPlace, isMainFrame) => { if (mainFrame(isMainFrame) && !isInPlace) dispatch({ type: 'page-loading' }); },
    'did-stop-loading': () => {
      // The observer may be attached while the first load is already under way (the view starts loading on creation).
      if (state.page === PAGE.UNLOADED) dispatch({ type: 'page-loading' });
      const wasLoading = state.page === PAGE.LOADING;
      dispatch({ type: 'page-ready' });
      if (wasLoading) dispatch({ type: 'navigated', url: contents.getURL(), inPage: false });
    },
    'did-fail-load': (_event, code, _description, _url, isMainFrame) => { if (mainFrame(isMainFrame) && code !== -3) dispatch({ type: 'page-failed' }); },
    'did-navigate': (_event, url) => dispatch({ type: 'navigated', url, inPage: false }),
    'did-navigate-in-page': (_event, url, isMainFrame) => { if (mainFrame(isMainFrame)) dispatch({ type: 'navigated', url, inPage: true }); },
    'render-process-gone': () => dispatch({ type: 'page-crashed' })
  };
  for (const [name, handler] of Object.entries(handlers)) contents.on(name, handler);
  const onDestroyed = () => stop();
  contents.once('destroyed', onDestroyed);

  function interval() {
    if (state.generation.state === GEN.RESPONDING) return intervals.respondingMs;
    return state.visible ? intervals.visibleIdleMs : intervals.hiddenIdleMs;
  }

  function schedule() {
    clearTimer(timer);
    timer = undefined;
    if (stopped || state.page !== PAGE.READY) return;
    timer = setTimer(() => { timer = undefined; void poll(); }, interval());
    timer.unref?.();
  }

  async function poll() {
    if (stopped || state.page !== PAGE.READY || contents.isDestroyed()) return;
    const epoch = state.epoch;             // a result is only valid for the page/conversation it was requested on
    const mySeq = ++seq;
    const started = process.hrtime.bigint();
    stats.polls += 1;
    try {
      const raw = await contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: source }]);
      stats.lastLatencyMs = Number(process.hrtime.bigint() - started) / 1e6;
      const signals = normalizeSignals(raw);
      onProbe?.({ latencyMs: stats.lastLatencyMs, control: raw && raw.controlSignature });
      if (signals) dispatch({ type: 'signals', epoch, seq: mySeq, signals });
      else { stats.signalsLost += 1; dispatch({ type: 'signals-lost', epoch }); }
    } catch {
      stats.signalsLost += 1;
      dispatch({ type: 'signals-lost', epoch });
    }
    schedule();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimer(timer);
    timer = undefined;
    for (const [name, handler] of Object.entries(handlers)) contents.removeListener(name, handler);
    contents.removeListener('destroyed', onDestroyed);
    state = reduce(state, { type: 'page-destroyed' });
  }

  // A page that is loading, or finished loading, before the observer was attached.
  if (contents.isLoading()) {
    dispatch({ type: 'page-loading' });
  } else if (contents.getURL()) {
    dispatch({ type: 'page-loading' });
    dispatch({ type: 'page-ready' });
    dispatch({ type: 'navigated', url: contents.getURL(), inPage: false });
  }

  return {
    getState: () => state,
    getStats: () => ({ ...stats }),
    setVisible: (visible) => dispatch({ type: 'visibility', visible }),
    markViewed: () => dispatch({ type: 'viewed' }),
    pollNow: poll,
    stop
  };
}

module.exports = { createStateObserver, DEFAULT_INTERVALS };
