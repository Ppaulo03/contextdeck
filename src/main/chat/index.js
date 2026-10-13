'use strict';

const path = require('node:path');
const { createStateObserver } = require('./state-observer');
const { createDiagnosticsLog } = require('./diagnostics');
const { startTrace } = require('./trace');

const SUMMARY_MS = 30000;
const SNAPSHOT_DELAYS_MS = [3000, 20000];     // after a load / conversation change: SPA hydration, then a second look
const SNAPSHOT_LIMIT = 12;                    // per run: the log is evidence, not a stream

// Chat-state observation of ONE view's WebContents (the I3P detector and model, unchanged).
//   status mode (M01-I3B-2): `status: true`, used by the observation hub for every loaded view; reports the model through
//   `onChange` only when it meaningfully changes; no diagnostics log.
//   diagnostic mode: CONTEXTDECK_CHAT_OBSERVER=1; additionally logs to <userData>\diagnostics\chat-observer.jsonl (each
//   entry tagged with the view id):
//   transitions of the model, the shape of the send/stop controls when it changes, a summary every 30 s
//   (polls, lost/dropped results, how often each signal was true/false/unknown, how the composer was found)
//   and a sanitized structural snapshot of the page while the composer has not been found.
// Only indicators depend on it: no view lifecycle, binding, navigation or Herdr decision does. No message text is ever read out.
function startChatObservation({ contents, userDataDir, env = process.env, viewId = null, status = false, onChange: notify, phaseMs = 0, composerLog: sharedComposerLog = null, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval }) {
  const trace = env.CONTEXTDECK_CHAT_TRACE === '1';
  const composerTrace = env.CONTEXTDECK_COMPOSER_TRACE === '1';
  const diagnostics = env.CONTEXTDECK_CHAT_OBSERVER === '1' || trace;
  const composerLog = composerTrace ? (sharedComposerLog || createDiagnosticsLog({ file: path.join(userDataDir, 'diagnostics', 'composer-trace.jsonl'), tag: viewId, maxBytes: 4 * 1024 * 1024 })) : null;
  if (composerLog) composerLog.note({ type: 'trace-started', schema: 1, ...(sharedComposerLog ? { view: viewId } : {}) });
  if (!diagnostics && !status && !composerTrace) return null;
  if (!diagnostics) {
    return createStateObserver({
      contents, onChange: notify, phaseMs, setTimer, clearTimer, composerTrace,
      onProbe: composerLog ? (result) => composerLog.note({ type: 'probe', ...(sharedComposerLog ? { view: viewId } : {}), evidence: result.composerTrace, accepted: result.accepted === true,
        outcome: result.discarded || (result.signals ? 'ok' : 'signals-unavailable'), latencyMs: Number.isFinite(result.latencyMs) ? Math.max(0, Math.round(result.latencyMs * 10) / 10) : null }) : undefined
    });
  }
  const log = createDiagnosticsLog({ file: path.join(userDataDir, 'diagnostics', 'chat-observer.jsonl'), tag: viewId });
  let lastControls = '';
  let lastObs = { signals: null, at: null, dtMs: null, wide: null, busyCount: null };
  let composerSeen = false;
  let snapshots = 0;
  let timers = [];
  let counters = { composer: { t: 0, f: 0, n: 0 }, stop: { t: 0, f: 0, n: 0 }, draft: { t: 0, f: 0, n: 0 }, stopWide: { t: 0, f: 0, n: 0 }, busy: { t: 0, f: 0, n: 0 }, via: {} };

  const tally = (bucket, value) => { bucket[value === true ? 't' : value === false ? 'f' : 'n'] += 1; };

  function scheduleSnapshots(reason) {
    for (const delay of SNAPSHOT_DELAYS_MS) {
      const timer = setTimer(async () => {
        timers = timers.filter((t) => t !== timer);
        if (composerSeen || snapshots >= SNAPSHOT_LIMIT) return;
        snapshots += 1;
        const structure = await observer.snapshotStructure();
        log.note({ structure, reason, delayMs: delay });
      }, delay);
      timer.unref?.();
      timers.push(timer);
    }
  }

  const observer = createStateObserver({
    contents,
    diagnostic: true,
    composerTrace,
    phaseMs,
    onChange: (state, prev, event) => {
      log.transition(state, prev, event, { signals: lastObs.signals, dtMs: lastObs.dtMs, wide: lastObs.wide, busyCount: lastObs.busyCount });
      notify?.(state, prev, event);
      // Every load or conversation change starts a new search for the composer.
      if ((event.type === 'page-ready' || event.type === 'navigated') && state.page === 'ready') { composerSeen = false; scheduleSnapshots(event.type); }
    },
    onProbe: ({ signals, via, controls, form, wide, busyCount, accepted, discarded, latencyMs, composerTrace: composerEvidence }) => {
      if (composerLog) composerLog.note({ type: 'probe', ...(sharedComposerLog ? { view: viewId } : {}), evidence: composerEvidence, accepted: accepted === true,
        outcome: discarded || (signals ? 'ok' : 'signals-unavailable'), latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs * 10) / 10) : null });
      const at = Date.now();
      lastObs = { signals: signals || null, at, dtMs: lastObs.at === null ? null : at - lastObs.at, wide: wide || null, busyCount: busyCount ?? null };
      if (signals) { tally(counters.composer, signals.composer); tally(counters.stop, signals.stop); tally(counters.draft, signals.draft); tally(counters.stopWide, signals.stopWide); tally(counters.busy, signals.busy); if (signals.composer === true) composerSeen = true; }
      if (via) counters.via[via] = (counters.via[via] || 0) + 1;
      // The shape of the controls is logged only when it changes (this is how the stop state is discovered).
      const text = JSON.stringify([controls || [], form || []]);
      if (text !== lastControls) { lastControls = text; log.note({ controls, form }); }
    }
  });

  const summary = setRepeat(() => {
    const state = observer.getState();
    log.note({ summary: { ...observer.getStats(), counters, page: state.page, identity: state.identity.kind, generation: state.generation.reason } });
    counters = { composer: { t: 0, f: 0, n: 0 }, stop: { t: 0, f: 0, n: 0 }, draft: { t: 0, f: 0, n: 0 }, stopWide: { t: 0, f: 0, n: 0 }, busy: { t: 0, f: 0, n: 0 }, via: {} };
  }, SUMMARY_MS);
  summary.unref?.();

  // Discovery trace (CONTEXTDECK_CHAT_TRACE=1): its own file, because it is a stream and the transition log is evidence.
  const stopTrace = trace
    ? startTrace({ contents, log: createDiagnosticsLog({ file: path.join(userDataDir, 'diagnostics', 'chat-trace.jsonl'), tag: viewId, maxBytes: 40 * 1024 * 1024 }), setRepeat, clearRepeat, isVisible: () => observer.getState().visible })
    : null;

  const stop = observer.stop;
  observer.stop = () => {
    if (stopTrace) stopTrace();
    clearRepeat(summary);
    for (const t of timers) clearTimer(t);
    timers = [];
    stop();
  };
  log.note({ started: true, electron: process.versions.electron });
  return observer;
}

module.exports = { startChatObservation, SNAPSHOT_DELAYS_MS, SNAPSHOT_LIMIT };
